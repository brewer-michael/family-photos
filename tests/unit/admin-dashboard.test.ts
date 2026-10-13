/**
 * The admin overview (/admin) server code, called with minimal events: what the page loads (failed
 * uploads, email problems, the "made by an older version" count, the media tools check) and its
 * actions (Try again, Move to trash, Send test email, Resend, Delete all archived originals, Redo
 * them, Check again). Emails go to the outbox; the self-check and the wake-ups are stubbed.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendMail } from '#lib/server/mail';
import { originalsPath, outboxDir } from '#lib/server/paths';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import * as requests from '#lib/server/repo/requests';
import { wakeIntake } from '#lib/server/intake';
import { runSelfCheck, type SelfCheck } from '#lib/server/selfcheck';
import { actions, load } from '../../src/routes/admin/+page.server';
import { FakeCookies } from '../helpers/cookies';
import { freshDb, setEnv } from '../helpers/env';

const CHECK: SelfCheck = { ok: false, checkedAt: 1, problems: ['ffmpeg is missing.'], tools: { exiftool: '13.10' } };

vi.mock('#lib/server/intake', () => ({ wakeIntake: vi.fn(async () => {}) }));
vi.mock('#lib/server/queue', () => ({ wakeQueue: vi.fn() }));
vi.mock('#lib/server/selfcheck', () => ({
	getSelfCheck: vi.fn(() => CHECK),
	runSelfCheck: vi.fn(async () => ({ ...CHECK, ok: true, problems: [] }))
}));

const ADMIN = { role: 'admin', deviceId: 'deviceAAAAAAAAAAAAAAAA', name: 'Michael' } as const;
const FAMILY = { role: 'family', deviceId: 'deviceBBBBBBBBBBBBBBBB', name: 'Jo' } as const;
let seq = 0;

function event(locals: App.Locals, form?: Record<string, string>) {
	const url = new URL('http://localhost:3000/admin');
	return {
		locals,
		params: {},
		url,
		cookies: new FakeCookies().asCookies(),
		request: new Request(url, form ? { method: 'POST', body: new URLSearchParams(form) } : { method: 'GET' })
	} as never;
}

/** The parts of the page data these tests read (the route's own data type isn't importable here). */
interface Overview {
	failed: unknown[];
	storage: Record<string, unknown>;
	selfCheck: unknown;
	email: { problem: string | null; failedRequests: unknown[] };
}
const loadAs = async (locals: App.Locals) => (await load(event(locals))) as unknown as Overview;

function received(albumId: number, name = 'IMG_0001.HEIC'): string {
	return media.insertReceived({
		uploadToken: `tok${String(++seq).padStart(20, '0')}`,
		albumId,
		sourceName: name,
		sourceSize: 100,
		clientMtimeMs: null,
		uploadedByName: 'Aunt Linda',
		uploadedByDevice: 'deviceAAAAAAAAAAAAAAAA'
	});
}

function failed(albumId: number, name: string): string {
	const id = received(albumId, name);
	media.markFailed(id, 'corrupt', 'heif-dec: Invalid input');
	return id;
}

function ready(albumId: number, opts: { pipelineVersion?: number } = {}): string {
	const id = received(albumId);
	media.markQueued(id, { kind: 'photo', sourceMime: 'image/heic', sourceExt: 'heic', sourceSha256: `sha${++seq}`, estCostS: null });
	media.claimForProcessing(id);
	media.markReady(id, {
		conversion: 'transcode',
		canonicalExt: 'jpg',
		canonicalSize: 1,
		width: 1,
		height: 1,
		takenMs: 1,
		sourceKept: true,
		pipelineVersion: opts.pipelineVersion
	});
	const original = originalsPath(id, 'heic');
	fs.mkdirSync(path.dirname(original), { recursive: true });
	fs.writeFileSync(original, 'original bytes');
	return id;
}

async function thrown(fn: () => unknown): Promise<unknown> {
	try {
		await fn();
	} catch (e) {
		return e;
	}
	throw new Error('it did not throw');
}

async function closedPort(): Promise<number> {
	const srv = net.createServer();
	await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
	const { port } = srv.address() as net.AddressInfo;
	await new Promise<void>((resolve) => srv.close(() => resolve()));
	return port;
}

const emls = () => (fs.existsSync(outboxDir()) ? fs.readdirSync(outboxDir()).filter((f) => f.endsWith('.eml')) : []);

let album: number;

beforeEach(() => {
	setEnv({ SMTP_HOST: undefined, SMTP_PORT: undefined, ADMIN_EMAIL: 'admin@example.com' });
	freshDb();
	fs.rmSync(outboxDir(), { recursive: true, force: true });
	vi.mocked(wakeIntake).mockClear();
	vi.mocked(runSelfCheck).mockClear();
	album = albums.create({ title: 'Beach', createdByName: 'Jo', createdByDevice: null }).id;
});

describe('load', () => {
	it('is for the admin only', async () => {
		expect(await thrown(() => load(event(FAMILY)))).toMatchObject({ status: 403 });
	});

	it('lists failed uploads with their problem, the older-version count (not the trash) and the self-check', async () => {
		const bad = failed(album, 'IMG_0002.HEIC');
		ready(album, { pipelineVersion: 0 });
		media.softDelete(ready(album, { pipelineVersion: 0 }), 'x');

		const data = await loadAs(ADMIN);
		expect(data.failed).toEqual([
			expect.objectContaining({ id: bad, name: 'IMG_0002.HEIC', by: 'Aunt Linda', album: 'Beach', problem: 'The file is damaged', hasSource: true })
		]);
		expect(data.storage).toMatchObject({ outdated: 1, trash: 1, deletableOriginals: 2 });
		expect(data.selfCheck).toEqual(CHECK);
		expect(data.email).toMatchObject({ to: 'admin@example.com', smtp: false, problem: null, failedRequests: [] });
	});

	it('says when the last email failed, and which removal-request emails need resending', async () => {
		setEnv({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(await closedPort()) });
		await expect(sendMail({ to: 'admin@example.com', subject: 'x', text: 'x' })).rejects.toThrow();
		setEnv({ SMTP_HOST: undefined, SMTP_PORT: undefined });
		expect((await loadAs(ADMIN)).email.problem).toMatch(/^The last email could not be sent: .*ECONNREFUSED/);

		const rid = requests.create({ mediaId: ready(album), requesterName: 'Cousin Sam', requesterDevice: 'deviceCCCCCCCCCCCCCCCC', reason: 'in_it' })
			.request.id;
		requests.setEmailStatus(rid, 'failed', 'connect ECONNREFUSED');
		await sendMail({ to: 'admin@example.com', subject: 'x', text: 'x' }); // email works again
		const { email } = await loadAs(ADMIN);
		expect(email.problem).toBe('The email about a removal request could not be sent.');
		expect(email.failedRequests).toEqual([{ id: rid, requester: 'Cousin Sam', error: 'connect ECONNREFUSED' }]);
	});
});

describe('actions', () => {
	it('"Try again" queues a failed upload once; a second tap is refused', async () => {
		const id = failed(album, 'IMG_0003.HEIC');
		expect(await actions.retry(event(ADMIN, { id }))).toMatchObject({ section: 'failed', ok: true, message: 'Trying IMG_0003.HEIC again.' });
		expect(media.getById(id)?.status).toBe('received');
		expect(wakeIntake).toHaveBeenCalledTimes(1);
		expect(await actions.retry(event(ADMIN, { id }))).toMatchObject({ status: 409 });
		expect(await actions.retry(event(ADMIN, { id: 'nope' }))).toMatchObject({ status: 404 });
		expect(await thrown(() => actions.retry(event(FAMILY, { id })))).toMatchObject({ status: 403 });
	});

	it('"Move to trash" only takes failed uploads, and answers their removal requests', async () => {
		const ok = ready(album);
		expect(await actions.trashFailed(event(ADMIN, { id: ok }))).toMatchObject({ status: 409 });
		expect(media.getById(ok)?.deleted_at).toBeNull();

		const bad = failed(album, 'IMG_0004.HEIC');
		const rid = requests.create({ mediaId: bad, requesterName: 'Jo', requesterDevice: 'deviceCCCCCCCCCCCCCCCC', reason: 'other', details: 'Blank' }).request.id;
		expect(await actions.trashFailed(event(ADMIN, { id: bad }))).toMatchObject({ ok: true, message: 'IMG_0004.HEIC is in the trash now.' });
		expect(media.getById(bad)?.deleted_reason).toBe('Upload that did not work, removed by the admin');
		expect(requests.get(rid)).toMatchObject({ status: 'approved', resolved_action: 'removed' });
		expect(await actions.trashFailed(event(ADMIN, { id: bad }))).toMatchObject({ status: 404 });
	});

	it('"Send test email" saves it to the outbox, or says why it could not', async () => {
		expect(await actions.testEmail(event(ADMIN, {}))).toMatchObject({
			section: 'email',
			ok: true,
			message: expect.stringMatching(/^Test email saved as a file in /)
		});
		expect(emls()).toHaveLength(1);

		setEnv({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(await closedPort()) });
		expect(await actions.testEmail(event(ADMIN, {}))).toMatchObject({
			status: 502,
			data: { message: expect.stringMatching(/^The test email could not be sent: .*ECONNREFUSED/) }
		});
		setEnv({ SMTP_HOST: undefined, SMTP_PORT: undefined, ADMIN_EMAIL: undefined });
		expect(await actions.testEmail(event(ADMIN, {}))).toMatchObject({ status: 400 });
	});

	it('"Resend" sends a removal request email again', async () => {
		const rid = requests.create({ mediaId: ready(album), requesterName: 'Cousin Sam', requesterDevice: 'deviceCCCCCCCCCCCCCCCC', reason: 'in_it' })
			.request.id;
		requests.setEmailStatus(rid, 'failed', 'earlier problem');
		expect(await actions.resendEmail(event(ADMIN, { id: String(rid) }))).toMatchObject({ ok: true, message: expect.stringMatching(/^Saved as a file in /) });
		expect(requests.get(rid)).toMatchObject({ email_status: 'saved', email_error: null });
		expect(await actions.resendEmail(event(ADMIN, { id: '999' }))).toMatchObject({ status: 404 });
	});

	it('"Delete all archived originals" and "Redo them" report what they did', async () => {
		media.softDelete(ready(album, { pipelineVersion: 0 }), 'x');
		expect(await actions.reprocessOutdated(event(ADMIN, {}))).toMatchObject({ message: 'Nothing needs redoing.' });
		const old = ready(album, { pipelineVersion: 0 });
		expect(await actions.reprocessOutdated(event(ADMIN, {}))).toMatchObject({
			message: '1 item is being redone. They come back by themselves when ready.'
		});
		expect(media.getById(old)?.status).toBe('queued');

		ready(album); // the queued one keeps its original: it is being redone from it
		expect(await actions.deleteOriginals(event(ADMIN, {}))).toMatchObject({ section: 'storage', message: 'Deleted 2 archived originals and freed 200 bytes.' });
		expect(fs.existsSync(originalsPath(old, 'heic'))).toBe(true);
		expect(await actions.deleteOriginals(event(ADMIN, {}))).toMatchObject({ message: 'There were no archived originals to delete.' });
	});

	it('"Check again" runs the media tools check', async () => {
		expect(await actions.checkTools(event(ADMIN, {}))).toMatchObject({ section: 'tools', ok: true, message: 'Checked again: everything is in place.' });
		expect(runSelfCheck).toHaveBeenCalledTimes(1);
		expect(await thrown(() => actions.checkTools(event(FAMILY, {})))).toMatchObject({ status: 403 });
	});
});
