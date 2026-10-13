/**
 * GET /api/status and POST /api/retry, called as route handlers with fake events.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as statusGET } from '../../src/routes/api/status/+server';
import { POST as retryPOST } from '../../src/routes/api/retry/+server';
import { getProgress, queuePosition, wakeQueue } from '#lib/server/queue';
import { wakeIntake } from '#lib/server/intake';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import { cacheFile } from '#lib/server/paths';
import type { Role } from '#lib/server/auth';
import type { Kind, MediaStatusDTO } from '#lib/shared/media-types';
import { freshDb } from '../helpers/env';

vi.mock('#lib/server/queue', () => ({ getProgress: vi.fn(), queuePosition: vi.fn(), wakeQueue: vi.fn() }));
vi.mock('#lib/server/intake', () => ({ wakeIntake: vi.fn(async () => {}) }));

const LINDA = 'deviceLindaAAAAAAAAAAA';
const SAM = 'deviceSamBBBBBBBBBBBBB';

interface Who {
	role: Role | null;
	deviceId: string | null;
}
const linda: Who = { role: 'family', deviceId: LINDA };
const sam: Who = { role: 'family', deviceId: SAM };
const admin: Who = { role: 'admin', deviceId: null };

let album: number;

type Handler = (event: never) => Response | Promise<Response>;

function event(who: Who, init: { url?: string; method?: string; body?: string; contentType?: string } = {}) {
	const url = new URL(init.url ?? 'http://localhost/api/status');
	const request = new Request(url, {
		method: init.method ?? 'GET',
		headers: init.contentType ? { 'content-type': init.contentType } : {},
		body: init.body
	});
	return { url, request, locals: { role: who.role, deviceId: who.deviceId, name: who.role ? 'Linda' : null } } as never;
}

async function status(who: Who, ids: string[] | string): Promise<{ code: number; body: unknown }> {
	const q = Array.isArray(ids) ? ids.join(',') : ids;
	const res = await (statusGET as Handler)(event(who, { url: `http://localhost/api/status?ids=${encodeURIComponent(q)}` }));
	expect(res.headers.get('cache-control')).toBe('no-store');
	return { code: res.status, body: await res.json() };
}

async function retry(who: Who, body: unknown, contentType = 'application/json'): Promise<{ code: number; body: { status?: string } }> {
	const res = await (retryPOST as Handler)(
		event(who, { url: 'http://localhost/api/retry', method: 'POST', body: JSON.stringify(body), contentType })
	);
	return { code: res.status, body: (await res.json()) as { status?: string } };
}

function item(opts: { device?: string; kind?: Kind | null; sha?: string } = {}): string {
	return media.insertReceived({
		uploadToken: randomBytes(16).toString('base64url'),
		albumId: album,
		sourceName: 'IMG_0001.JPG',
		sourceSize: 100,
		clientMtimeMs: null,
		uploadedByName: 'Someone',
		uploadedByDevice: opts.device ?? LINDA
	});
}

function queue(id: string, kind: Kind = 'photo', sha = randomBytes(32).toString('hex')): void {
	expect(media.markQueued(id, { kind, sourceMime: 'x/y', sourceExt: 'bin', sourceSha256: sha, estCostS: null }).outcome).toBe('queued');
}

function makeReady(id: string): void {
	queue(id);
	media.claimForProcessing(id);
	media.markReady(id, { conversion: 'none', canonicalExt: 'jpg', canonicalSize: 1, width: 1, height: 1, takenMs: 0, sourceKept: false });
}

function touchCache(id: string, variant: 'thumb' | 'poster'): void {
	fs.mkdirSync(path.dirname(cacheFile(id, variant)), { recursive: true });
	fs.writeFileSync(cacheFile(id, variant), 'webp');
}

beforeEach(() => {
	freshDb();
	vi.clearAllMocks();
	album = albums.create({ title: 'Lake trip', createdByName: null, createdByDevice: null }).id;
});

describe('GET /api/status', () => {
	it('reports each state with the facts the tiles need', async () => {
		const received = item();
		const queued = item();
		queue(queued, 'video');
		const processing = item();
		queue(processing, 'video');
		media.claimForProcessing(processing);
		touchCache(processing, 'poster');
		const ready = item();
		makeReady(ready);
		touchCache(ready, 'thumb');
		const sha = randomBytes(32).toString('hex');
		const original = item();
		queue(original, 'photo', sha);
		const dup = item();
		expect(media.markQueued(dup, { kind: 'photo', sourceMime: 'x/y', sourceSha256: sha, estCostS: null }).outcome).toBe('duplicate');
		const failed = item();
		media.markFailed(failed, 'unsupported', 'pdf');

		vi.mocked(getProgress).mockImplementation((id) => (id === processing ? { pct: 40, etaS: 300 } : undefined));
		vi.mocked(queuePosition).mockImplementation((id) => (id === queued ? 2 : undefined));

		const { code, body } = await status(linda, [received, queued, processing, ready, dup, failed]);
		expect(code).toBe(200);
		const byId = new Map((body as MediaStatusDTO[]).map((r) => [r.id, r]));
		expect(byId.get(received)).toEqual({ id: received, status: 'received', kind: null });
		expect(byId.get(queued)).toEqual({ id: queued, status: 'queued', kind: 'video', queuePos: 2 });
		expect(byId.get(processing)).toEqual({
			id: processing,
			status: 'processing',
			kind: 'video',
			pct: 40,
			etaS: 300,
			posterUrl: `/media/${processing}/poster`
		});
		expect(byId.get(ready)).toEqual({ id: ready, status: 'ready', kind: 'photo', posterUrl: `/media/${ready}/thumb?v=1` });
		expect(byId.get(dup)).toEqual({ id: dup, status: 'duplicate', kind: null, duplicateOf: original });
		expect(byId.get(failed)).toEqual({ id: failed, status: 'failed', kind: null, errorCode: 'unsupported' });
	});

	it("shows family members ready items and their own device's uploads only; the admin sees all", async () => {
		const mine = item({ device: LINDA });
		const theirs = item({ device: SAM });
		const theirsReady = item({ device: SAM });
		makeReady(theirsReady);
		const trashed = item({ device: LINDA });
		makeReady(trashed);
		media.softDelete(trashed, 'test');

		const ids = (r: { body: unknown }) => (r.body as MediaStatusDTO[]).map((x) => x.id).sort();
		expect(ids(await status(linda, [mine, theirs, theirsReady, trashed]))).toEqual([mine, theirsReady].sort());
		expect(ids(await status(sam, [mine, theirs, theirsReady]))).toEqual([theirs, theirsReady].sort());
		expect(ids(await status({ role: 'family', deviceId: null }, [mine, theirs, theirsReady]))).toEqual([theirsReady]);
		expect(ids(await status(admin, [mine, theirs, theirsReady, trashed]))).toEqual([mine, theirs, theirsReady, trashed].sort());
	});

	it('ignores malformed and unknown ids, and duplicates in the list', async () => {
		const id = item();
		const { code, body } = await status(linda, `${id},${id}, nope ,,01ARZ3NDEKTSV4RRFFQ69G5FAV,'; DROP TABLE media`);
		expect(code).toBe(200);
		expect((body as MediaStatusDTO[]).map((r) => r.id)).toEqual([id]);
		expect((await status(linda, '')).body).toEqual([]);
	});

	it('takes at most 100 ids', async () => {
		const ids = Array.from({ length: 101 }, () => item());
		expect((await status(linda, ids)).code).toBe(400);
		expect((await status(linda, ids.slice(0, 100))).code).toBe(200);
	});

	it('needs family access', async () => {
		expect((await status({ role: null, deviceId: LINDA }, [item()])).code).toBe(401);
	});
});

describe('POST /api/retry', () => {
	function failedItem(code: 'retryable' | 'unsupported', opts: { device?: string; kind?: Kind | null } = {}): string {
		const id = item({ device: opts.device });
		if (opts.kind) queue(id, opts.kind);
		media.markFailed(id, code, 'test');
		return id;
	}

	it("sends a retryable failure back through intake (no kind yet) or to its lane", async () => {
		const early = failedItem('retryable');
		expect(await retry(linda, { id: early })).toEqual({ code: 200, body: { status: 'received' } });
		expect(media.getById(early)!.status).toBe('received');
		expect(wakeIntake).toHaveBeenCalledTimes(1);

		const late = failedItem('retryable', { kind: 'video' });
		expect(await retry(linda, { id: late })).toEqual({ code: 200, body: { status: 'queued' } });
		expect(media.getById(late)!.attempts).toBe(0);
		expect(wakeQueue).toHaveBeenCalledTimes(1);
	});

	it('only lets the uploading device retry, and only retryable failures; the admin may retry anything failed', async () => {
		const samsRetryable = failedItem('retryable', { device: SAM });
		expect((await retry(linda, { id: samsRetryable })).code).toBe(403);
		expect((await retry({ role: 'family', deviceId: null }, { id: samsRetryable })).code).toBe(403);
		const unsupported = failedItem('unsupported');
		expect(await retry(linda, { id: unsupported })).toMatchObject({ code: 409, body: { status: 'failed' } });
		expect(await retry(admin, { id: unsupported })).toEqual({ code: 200, body: { status: 'received' } });
		expect(await retry(admin, { id: samsRetryable })).toEqual({ code: 200, body: { status: 'received' } });
	});

	it('refuses items that are not failed, unknown ids and bad requests', async () => {
		const ok = item();
		expect(await retry(linda, { id: ok })).toMatchObject({ code: 409, body: { status: 'received' } });
		expect((await retry(linda, { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })).code).toBe(404);
		expect((await retry(linda, { id: 'nope' })).code).toBe(400);
		expect((await retry(linda, ['x'])).code).toBe(400);
		expect((await retry(linda, { id: ok }, 'text/plain')).code).toBe(415);
		expect((await retry({ role: null, deviceId: LINDA }, { id: ok })).code).toBe(401);
		expect(wakeIntake).not.toHaveBeenCalled();
	});

	it('turns a retried item into a duplicate when the same bytes are live again', async () => {
		const sha = randomBytes(32).toString('hex');
		const first = item();
		queue(first, 'photo', sha);
		media.claimForProcessing(first);
		media.markFailed(first, 'retryable', 'flaky');
		const second = item();
		queue(second, 'photo', sha);
		expect(await retry(linda, { id: first })).toEqual({ code: 200, body: { status: 'duplicate' } });
		expect(wakeIntake).not.toHaveBeenCalled();
		expect(wakeQueue).not.toHaveBeenCalled();
	});
});
