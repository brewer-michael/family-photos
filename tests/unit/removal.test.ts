/**
 * Removal requests: stored first, then the admin email (outbox mode) with its subject, links,
 * escaping and inline JPEG made by ffmpeg from the cached preview; failures, resend and the
 * after-restart retry.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { simpleParser, type ParsedMail } from 'mailparser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ASKS_PER_HOUR,
	createRemovalRequest,
	EMAILS_PER_HOUR,
	emailThumbnail,
	HELD_BACK_ERROR,
	removalEmail,
	resendRemovalEmail,
	resetRemovalLimits,
	sendStuckRemovalEmails,
	THUMB_CID,
	THUMB_CONCURRENCY,
	THUMB_QUEUE_MAX
} from '#lib/server/removal';
import { getDb } from '#lib/server/db';
import { cacheFile, outboxDir } from '#lib/server/paths';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import * as requests from '#lib/server/repo/requests';
import type { Kind } from '#lib/shared/media-types';
import { freshDb, setEnv } from '../helpers/env';
import { actions as viewActions } from '../../src/routes/view/[id]/+page.server';

const ORIGIN = 'http://localhost:3000';
let seq = 0;

/** A ready item with a preview of `preview` px in the cache (display for photos, poster for videos). */
async function readyItem(albumId: number, opts: { kind?: Kind; preview?: [number, number] | null } = {}): Promise<string> {
	const kind = opts.kind ?? 'photo';
	const id = media.insertReceived({
		uploadToken: `tok${String(++seq).padStart(20, '0')}`,
		albumId,
		sourceName: kind === 'video' ? 'IMG_0001.MOV' : 'IMG_0001.HEIC',
		sourceSize: 1000,
		clientMtimeMs: null,
		uploadedByName: 'Uncle Bob',
		uploadedByDevice: 'deviceBBBBBBBBBBBBBBBB'
	});
	media.markQueued(id, { kind, sourceMime: 'x/y', sourceExt: kind === 'video' ? 'mov' : 'heic', sourceSha256: `sha${seq}`, estCostS: null });
	media.claimForProcessing(id);
	media.markReady(id, {
		conversion: 'transcode',
		canonicalExt: kind === 'video' ? 'mp4' : 'jpg',
		canonicalSize: 1000,
		width: 1600,
		height: 1200,
		takenAt: '2024-07-04T11:22:31-07:00',
		takenMs: Date.UTC(2024, 6, 4, 18, 22, 31),
		sourceKept: true
	});
	const preview = opts.preview === undefined ? [1600, 1200] : opts.preview;
	if (preview) {
		const file = cacheFile(id, kind === 'video' ? 'poster' : 'display');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		await sharp({ create: { width: preview[0], height: preview[1], channels: 3, background: '#c96f3b' } }).webp().toFile(file);
	}
	return id;
}

async function ask(mediaId: string, opts: { device?: string; details?: string } = {}): Promise<number> {
	const { id } = await createRemovalRequest({
		mediaId,
		requesterName: 'Aunt Linda',
		requesterDevice: opts.device ?? 'deviceAAAAAAAAAAAAAAAA',
		reason: opts.details ? 'other' : 'in_it',
		details: opts.details,
		origin: ORIGIN
	});
	return id;
}

/** Waits until the request's email is no longer pending and returns its row. */
async function settled(id: number) {
	await vi.waitFor(() => expect(requests.get(id)?.email_status).not.toBe('pending'), { timeout: 15_000 });
	return requests.get(id)!;
}

const outboxFiles = () => (fs.existsSync(outboxDir()) ? fs.readdirSync(outboxDir()).filter((f) => f.endsWith('.eml')).sort() : []);

async function onlyEmail(): Promise<ParsedMail> {
	const files = outboxFiles();
	expect(files).toHaveLength(1);
	return simpleParser(fs.readFileSync(path.join(outboxDir(), files[0])), { skipImageLinks: true });
}

async function closedPort(): Promise<number> {
	const srv = net.createServer();
	await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
	const { port } = srv.address() as net.AddressInfo;
	await new Promise<void>((resolve) => srv.close(() => resolve()));
	return port;
}

let album: number;

/** Waits until no request's email is still being sent (so none lands in the next test's database). */
async function allSettled(): Promise<void> {
	await vi.waitFor(
		() => expect(getDb().prepare(`SELECT COUNT(*) FROM deletion_requests WHERE email_status = 'pending'`).pluck().get()).toBe(0),
		{ timeout: 30_000 }
	);
}

/** POST /view/<id>?/askRemove as `device` from address `ip`. */
async function askOnPage(mediaId: string, device: string, ip: string) {
	const url = new URL(`http://localhost:3000/view/${mediaId}?/askRemove`);
	const event = {
		locals: { role: 'family', deviceId: device, name: 'Cousin Sam' },
		params: { id: mediaId },
		url,
		getClientAddress: () => ip,
		request: new Request(url, { method: 'POST', body: new URLSearchParams({ reason: 'blurry_or_duplicate' }) })
	};
	return (await viewActions.askRemove(event as never)) as { status?: number; data?: { remove: { error?: string } }; remove?: { sent?: boolean } };
}

beforeEach(() => {
	setEnv({ SMTP_HOST: undefined, SMTP_PORT: undefined, ADMIN_EMAIL: 'admin@example.com' });
	freshDb();
	resetRemovalLimits();
	fs.rmSync(outboxDir(), { recursive: true, force: true });
	album = albums.create({ title: 'Retreat <2023> & "friends"', createdByName: 'Jo', createdByDevice: null }).id;
});

describe('createRemovalRequest', () => {
	it('stores the request at once, then saves the email with subject, facts, links and a 600 px inline JPEG', async () => {
		const id = await readyItem(album);
		const rid = await ask(id, { details: 'My eyes are <closed> & "weird"' });
		expect(requests.get(rid)).toMatchObject({ media_id: id, status: 'pending' }); // stored before the email

		expect(await settled(rid)).toMatchObject({ email_status: 'saved', email_error: null });
		const mail = await onlyEmail();
		expect(mail.subject).toBe('Removal request: photo in "Retreat <2023> & "friends"" from Aunt Linda');
		expect(mail.to && !Array.isArray(mail.to) ? mail.to.text : '').toBe('admin@example.com');

		const viewUrl = `${ORIGIN}/view/${id}`;
		const reviewUrl = `${ORIGIN}/admin/requests/${rid}`;
		for (const body of [mail.text ?? '', mail.html || '']) {
			expect(body).toContain(viewUrl);
			expect(body).toContain(reviewUrl);
		}
		expect(mail.text).toContain('Why: Something else');
		expect(mail.text).toContain('Their words: My eyes are <closed> & "weird"');
		expect(mail.text).toContain('Album: Retreat <2023> & "friends"');
		expect(mail.text).toContain('Added by: Uncle Bob');
		expect(mail.text).toContain('Taken: July 4, 2024');
		expect(mail.text).toContain('Nothing has been removed yet.');

		// Every value is escaped in the HTML part.
		const html = mail.html || '';
		expect(html).not.toContain('<closed>');
		expect(html).not.toContain('<2023>');
		expect(html).toContain('My eyes are &lt;closed&gt; &amp; &quot;weird&quot;');
		expect(html).toContain('Retreat &lt;2023&gt; &amp; &quot;friends&quot;');
		expect(html).toContain(`src="cid:${THUMB_CID}"`);

		expect(mail.attachments).toHaveLength(1);
		const [pic] = mail.attachments;
		expect(pic.contentType).toBe('image/jpeg');
		expect(pic.cid).toBe(THUMB_CID);
		const meta = await sharp(pic.content).metadata();
		expect(meta.format).toBe('jpeg');
		expect([meta.width, meta.height]).toEqual([600, 450]);
		// Full range kept: the preview's #c96f3b comes out as itself, not washed out.
		const { channels } = await sharp(pic.content).stats();
		channels.slice(0, 3).forEach((c, i) => expect(Math.abs(c.mean - [0xc9, 0x6f, 0x3b][i])).toBeLessThan(4));
	});

	it("uses a video's poster and never enlarges a small one", async () => {
		const id = await readyItem(album, { kind: 'video', preview: [320, 240] });
		const rid = await ask(id);
		expect((await settled(rid)).email_status).toBe('saved');
		const mail = await onlyEmail();
		expect(mail.subject).toBe('Removal request: video in "Retreat <2023> & "friends"" from Aunt Linda');
		const meta = await sharp(mail.attachments[0].content).metadata();
		expect([meta.width, meta.height]).toEqual([320, 240]);
	});

	it('sends without a picture when there is no preview', async () => {
		const id = await readyItem(album, { preview: null });
		const rid = await ask(id);
		expect((await settled(rid)).email_status).toBe('saved');
		const mail = await onlyEmail();
		expect(mail.attachments).toHaveLength(0);
		expect(mail.html || '').not.toContain('cid:');
	});

	it('emails once per pending request (asking again from the same device sends nothing)', async () => {
		const id = await readyItem(album);
		const rid = await ask(id);
		await settled(rid);
		expect(await ask(id)).toBe(rid);
		await new Promise((r) => setTimeout(r, 200));
		expect(outboxFiles()).toHaveLength(1);
	});

	it('records a failed send, and "Resend" delivers it later', async () => {
		const id = await readyItem(album);
		setEnv({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(await closedPort()) });
		const rid = await ask(id);
		const failed = await settled(rid);
		expect(failed.email_status).toBe('failed');
		expect(failed.email_error).toMatch(/ECONNREFUSED/);

		setEnv({ SMTP_HOST: undefined, SMTP_PORT: undefined });
		expect(await resendRemovalEmail(rid)).toBe('saved');
		expect(requests.get(rid)).toMatchObject({ email_status: 'saved', email_error: null });
		expect(outboxFiles()).toHaveLength(1);
	});

	it('fails with a clear reason when ADMIN_EMAIL is not set', async () => {
		setEnv({ ADMIN_EMAIL: undefined });
		const id = await readyItem(album);
		const rid = await ask(id);
		expect(await settled(rid)).toMatchObject({ email_status: 'failed', email_error: expect.stringContaining('ADMIN_EMAIL') });
		expect(outboxFiles()).toEqual([]);
	});
});

describe('flood protection (anyone with the family code can ask)', () => {
	it(`lets one person ask ${ASKS_PER_HOUR} times an hour; then a friendly 429, and others can still ask`, async () => {
		const ids: string[] = [];
		for (let i = 0; i <= ASKS_PER_HOUR + 1; i++) ids.push(await readyItem(album, { preview: null }));
		// A new device id for every request (a cleared cookie) doesn't help: the address counts too.
		for (let i = 0; i < ASKS_PER_HOUR; i++) {
			expect(await askOnPage(ids[i], `device${String(i).padStart(18, '0')}`, '203.0.113.5'), `request ${i + 1}`).toEqual({
				remove: { sent: true }
			});
		}
		const refused = await askOnPage(ids[ASKS_PER_HOUR], 'deviceZZZZZZZZZZZZZZZZ', '203.0.113.5');
		expect(refused.status).toBe(429);
		expect(refused.data?.remove.error).toMatch(/^That's a lot of requests at once\. Please wait \d+ minutes? and try again, or tell Michael\.$/);
		expect(requests.listPending()).toHaveLength(ASKS_PER_HOUR);

		// Someone else (another address and device) is not affected.
		expect(await askOnPage(ids[ASKS_PER_HOUR + 1], 'deviceYYYYYYYYYYYYYYYY', '198.51.100.9')).toEqual({ remove: { sent: true } });
		await allSettled();
	});

	it(`emails at most ${EMAILS_PER_HOUR} requests an hour; the rest wait on the admin page, and one email says so`, async () => {
		const id = await readyItem(album, { preview: null });
		const asked: number[] = [];
		for (let i = 0; i < EMAILS_PER_HOUR + 3; i++) asked.push(await ask(id, { device: `device${String(i).padStart(18, '0')}` }));
		await allSettled();
		const statuses = asked.map((rid) => requests.get(rid)!);
		expect(statuses.slice(0, EMAILS_PER_HOUR).every((r) => r.email_status === 'saved')).toBe(true);
		for (const r of statuses.slice(EMAILS_PER_HOUR)) expect(r).toMatchObject({ email_status: 'failed', email_error: HELD_BACK_ERROR });

		// The notice is sent once, not once per held-back request.
		await vi.waitFor(() => expect(outboxFiles()).toHaveLength(EMAILS_PER_HOUR + 1));
		const mails = await Promise.all(outboxFiles().map((f) => simpleParser(fs.readFileSync(path.join(outboxDir(), f)))));
		const notices = mails.filter((m) => m.subject === 'More removal requests are waiting');
		expect(notices).toHaveLength(1);
		const [notice] = notices;
		expect(notice.text).toContain(`More than ${EMAILS_PER_HOUR} removal requests came in within an hour.`);
		expect(notice.text).toContain(`${ORIGIN}/admin`);

		// The admin's "Resend" still emails a held-back one.
		expect(await resendRemovalEmail(asked.at(-1)!)).toBe('saved');
	});

	it(`gives up on the picture rather than queue more than ${THUMB_QUEUE_MAX} for ffmpeg`, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-fake-ffmpeg-'));
		const bin = path.join(dir, 'ffmpeg');
		fs.writeFileSync(bin, `#!/bin/sh\necho run >> "${dir}/runs"\nsleep 0.05\nprintf picture\n`, { mode: 0o755 });
		const extra = 3;
		const ids: string[] = [];
		for (let i = 0; i < THUMB_CONCURRENCY + THUMB_QUEUE_MAX + extra; i++) ids.push(await readyItem(album, { preview: [8, 8] }));
		setEnv({ FFMPEG_BIN: bin });
		try {
			const pics = await Promise.all(ids.map((id) => emailThumbnail(id, 'photo')));
			expect(pics.filter((p) => p === null)).toHaveLength(extra);
			expect(fs.readFileSync(path.join(dir, 'runs'), 'utf8').trim().split('\n')).toHaveLength(THUMB_CONCURRENCY + THUMB_QUEUE_MAX);
		} finally {
			setEnv({ FFMPEG_BIN: undefined });
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('emailThumbnail', () => {
	it(`runs at most ${THUMB_CONCURRENCY} ffmpeg processes at once; the others wait their turn`, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-fake-ffmpeg-'));
		const bin = path.join(dir, 'ffmpeg');
		// Counts the copies running (one marker dir each) when it starts, then answers after a while.
		fs.writeFileSync(
			bin,
			`#!/bin/sh\nmkdir "${dir}/run.$$"\nls -d "${dir}"/run.* | wc -l >> "${dir}/counts"\nsleep 0.3\nrmdir "${dir}/run.$$"\nprintf picture\n`,
			{ mode: 0o755 }
		);
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) ids.push(await readyItem(album, { preview: [8, 8] }));
		setEnv({ FFMPEG_BIN: bin });
		try {
			const pics = await Promise.all(ids.map((id) => emailThumbnail(id, 'photo')));
			expect(pics.map((p) => p?.toString())).toEqual(Array(5).fill('picture'));
			const counts = fs.readFileSync(path.join(dir, 'counts'), 'utf8').trim().split('\n').map(Number);
			expect(counts).toHaveLength(5);
			expect(Math.max(...counts)).toBeLessThanOrEqual(THUMB_CONCURRENCY);
		} finally {
			setEnv({ FFMPEG_BIN: undefined });
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('sendStuckRemovalEmails', () => {
	it('sends emails a restart left pending, but not fresh or failed ones', async () => {
		const id = await readyItem(album);
		const now = Date.now();
		const old = requests.create({ mediaId: id, requesterName: 'Aunt Linda', requesterDevice: 'deviceCCCCCCCCCCCCCCCC', reason: 'in_it' }).request;
		const fresh = requests.create({ mediaId: id, requesterName: 'Cousin Sam', requesterDevice: 'deviceDDDDDDDDDDDDDDDD', reason: 'in_it' }).request;
		const failed = requests.create({ mediaId: id, requesterName: 'Uncle Bob', requesterDevice: 'deviceEEEEEEEEEEEEEEEE', reason: 'in_it' }).request;
		getDb().prepare('UPDATE deletion_requests SET created_at = ? WHERE id IN (?, ?)').run(now - 3600_000, old.id, failed.id);
		requests.setEmailStatus(failed.id, 'failed', 'earlier problem');

		expect(await sendStuckRemovalEmails(10 * 60_000, now)).toBe(1);
		expect(requests.get(old.id)?.email_status).toBe('saved');
		expect(requests.get(fresh.id)?.email_status).toBe('pending');
		expect(requests.get(failed.id)?.email_status).toBe('failed');
	});
});

describe('removalEmail', () => {
	it('is plain text and HTML without a picture part when there is no thumbnail', () => {
		const msg = removalEmail({
			to: 'admin@example.com',
			origin: ORIGIN,
			request: {
				id: 7,
				media_id: '01J00000000000000000000000',
				requester_name: 'Aunt Linda',
				requester_device: 'd',
				reason: 'wrong_album',
				details: null,
				status: 'pending',
				resolved_action: null,
				email_status: 'pending',
				email_error: null,
				created_at: Date.UTC(2026, 9, 13, 12),
				updated_at: 0,
				resolved_at: null,
				media_kind: 'photo',
				media_status: 'ready',
				media_deleted_at: null,
				source_name: 'IMG_1.HEIC',
				uploaded_by_name: 'Uncle Bob',
				album_id: 1,
				album_title: 'Beach'
			},
			item: { id: '01J00000000000000000000000', kind: 'photo', taken_at: null, taken_ms: null },
			thumb: null
		});
		expect(msg.subject).toBe('Removal request: photo in "Beach" from Aunt Linda');
		expect(msg.attachments).toEqual([]);
		expect(msg.text).toContain('Why: Wrong album');
		expect(msg.text).toContain('Taken: Unknown');
		expect(msg.text).not.toContain('Their words');
		expect(msg.html).not.toContain('<img');
	});
});
