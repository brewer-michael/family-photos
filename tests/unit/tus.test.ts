/**
 * The tus endpoint driven with plain Request objects (no HTTP server): session and ownership
 * checks, server-side metadata, space and size limits, finish → `received` row + X-Media-Id.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { RequestEvent } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tusHandler, parseCookies } from '#lib/server/uploads/tus';
import { ACCESS_COOKIE, DEVICE_COOKIE, accessValue, deviceValue } from '#lib/server/auth';
import { GiB, freeBytes } from '#lib/server/disk';
import { wakeIntake } from '#lib/server/intake';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import { incomingDir, incomingPath } from '#lib/server/paths';
import * as uploadRoute from '../../src/routes/api/upload/[...path]/+server';
import { freshDb } from '../helpers/env';

vi.mock('#lib/server/intake', () => ({ wakeIntake: vi.fn(async () => {}) }));
vi.mock('#lib/server/repo/media', async (importOriginal) => {
	const real = await importOriginal<typeof import('#lib/server/repo/media')>();
	return { ...real, insertReceived: vi.fn(real.insertReceived) };
});
vi.mock('#lib/server/disk', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/disk')>()),
	freeBytes: vi.fn()
}));

const ORIGIN = 'http://localhost:3000';
const LINDA = { d: 'deviceLindaAAAAAAAAAAA', n: 'Aunt Linda' };
const SAM = { d: 'deviceSamBBBBBBBBBBBBB', n: 'Cousin Sam' };

let album: number;

function cookie(device: { d: string; n: string } | null = LINDA, role: 'family' | 'admin' | null = 'family'): string {
	const parts: string[] = [];
	if (role) parts.push(`${ACCESS_COOKIE}=${accessValue(role)}`);
	if (device) parts.push(`${DEVICE_COOKIE}=${deviceValue(device)}`);
	return parts.join('; ');
}

function metadata(m: Record<string, string>): string {
	return Object.entries(m)
		.map(([k, v]) => `${k} ${Buffer.from(v, 'utf8').toString('base64')}`)
		.join(',');
}

async function call(method: string, path: string, opts: { headers?: Record<string, string>; body?: Uint8Array } = {}): Promise<Response> {
	const request = new Request(`${ORIGIN}${path}`, {
		method,
		headers: { 'Tus-Resumable': '1.0.0', ...opts.headers },
		body: opts.body ? new Uint8Array(opts.body) : undefined
	});
	return tusHandler.handle({ request } as unknown as RequestEvent);
}

async function create(
	size: number,
	opts: { cookie?: string; meta?: Record<string, string>; headers?: Record<string, string> } = {}
): Promise<Response> {
	return call('POST', '/api/upload', {
		headers: {
			'Upload-Length': String(size),
			'Upload-Metadata': metadata({ filename: 'IMG_0001.HEIC', lastModified: '1700000000000', albumId: String(album), ...opts.meta }),
			cookie: opts.cookie ?? cookie(),
			...opts.headers
		}
	});
}

const tokenOf = (res: Response) => res.headers.get('location')!.split('/').pop()!;

function patch(token: string, offset: number, body: Uint8Array, c = cookie()): Promise<Response> {
	return call('PATCH', `/api/upload/${token}`, {
		headers: { 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream', cookie: c },
		body
	});
}

const head = (token: string, c = cookie()) => call('HEAD', `/api/upload/${token}`, { headers: { cookie: c } });

beforeEach(() => {
	freshDb();
	vi.clearAllMocks();
	vi.mocked(freeBytes).mockResolvedValue(10_000 * GiB);
	album = albums.create({ title: 'Lake trip', createdByName: 'Linda', createdByDevice: LINDA.d }).id;
});

describe('route', () => {
	it('exports only POST, PATCH, HEAD and OPTIONS (GET/DELETE get SvelteKit 405s)', () => {
		expect(Object.keys(uploadRoute).sort()).toEqual(['HEAD', 'OPTIONS', 'PATCH', 'POST']);
	});
});

describe('creating an upload', () => {
	it('answers 201 with a relative Location and a random 128-bit token', async () => {
		const res = await create(10);
		expect(res.status).toBe(201);
		const location = res.headers.get('location')!;
		expect(location).toMatch(/^\/api\/upload\/[A-Za-z0-9_-]{22}$/);
		expect(res.headers.get('tus-resumable')).toBe('1.0.0');
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('access-control-allow-origin')).toBeNull();
		const other = await create(10);
		expect(tokenOf(other)).not.toBe(tokenOf(res));
	});

	it('stores the device and name from the cookies, never from the client', async () => {
		const res = await create(10, { meta: { device: SAM.d, name: 'Mallory', filename: '../../etc/passwd' } });
		const stored = JSON.parse(fs.readFileSync(`${incomingPath(tokenOf(res))}.json`, 'utf8')) as {
			metadata: Record<string, string | null>;
		};
		expect(stored.metadata).toEqual({
			filename: 'passwd',
			lastModified: '1700000000000',
			albumId: String(album),
			device: LINDA.d,
			name: LINDA.n
		});
	});

	it('drops a malformed lastModified', async () => {
		const res = await create(10, { meta: { lastModified: 'yesterday' } });
		const stored = JSON.parse(fs.readFileSync(`${incomingPath(tokenOf(res))}.json`, 'utf8')) as {
			metadata: Record<string, string | null>;
		};
		expect(stored.metadata.lastModified).toBeNull();
	});

	it('requires family access and a device with a name', async () => {
		expect((await create(10, { cookie: '' })).status).toBe(401);
		expect((await create(10, { cookie: cookie(LINDA, null) })).status).toBe(401);
		const nameless = await create(10, { cookie: cookie(null) });
		expect(nameless.status).toBe(403);
		expect(await nameless.text()).toBe('Please tell us your name first.');
		expect((await create(10, { cookie: cookie(LINDA, 'admin') })).status).toBe(201);
	});

	it('refuses albums that do not exist or were deleted', async () => {
		const missing = await create(10, { meta: { albumId: '99999' } });
		expect(missing.status).toBe(404);
		expect(await missing.text()).toBe("That album isn't here any more.");
		expect((await create(10, { meta: { albumId: 'abc' } })).status).toBe(404);
		albums.softDelete(album);
		expect((await create(10)).status).toBe(404);
	});

	it('refuses files over MAX_UPLOAD_GB with words for the uploader', async () => {
		const res = await create(50 * GiB + 1);
		expect(res.status).toBe(413);
		expect(await res.text()).toBe('This one is too big to send. The biggest file we can take is 50 GB.');
		expect((await create(50 * GiB)).status).toBe(201);
	});

	it('needs 2 × Upload-Length + 2 GiB free on /photos', async () => {
		const size = 5 * GiB;
		vi.mocked(freeBytes).mockResolvedValue(2 * size + 2 * GiB - 1);
		const res = await create(size);
		expect(res.status).toBe(413);
		expect(await res.text()).toBe("There isn't enough room left for this one. Please tell Michael.");
		vi.mocked(freeBytes).mockResolvedValue(2 * size + 2 * GiB);
		expect((await create(size)).status).toBe(201);
	});

	it('refuses empty files', async () => {
		expect((await create(10)).status).toBe(201); // the FileStore's folder exists from here on
		const before = fs.readdirSync(incomingDir()).length;
		const res = await create(0);
		expect(res.status).toBe(400);
		expect(await res.text()).toBe("That one isn't a photo or video.");
		expect(fs.readdirSync(incomingDir())).toHaveLength(before);
		expect(media.listReceived()).toEqual([]);
		expect(wakeIntake).not.toHaveBeenCalled();
	});

	it('requires Upload-Length (no deferred length)', async () => {
		const res = await call('POST', '/api/upload', {
			headers: { 'Upload-Defer-Length': '1', 'Upload-Metadata': metadata({ albumId: String(album) }), cookie: cookie() }
		});
		expect(res.status).toBe(400);
	});

	it('rejects X-HTTP-Method-Override', async () => {
		const res = await create(10, { headers: { 'X-HTTP-Method-Override': 'DELETE' } });
		expect(res.status).toBe(400);
	});
});

describe('sending and finishing', () => {
	it('stores the bytes, records a received item and answers with its media id', async () => {
		const bytes = randomBytes(1000);
		const token = tokenOf(await create(bytes.length));
		const first = await patch(token, 0, bytes.subarray(0, 400));
		expect(first.status).toBe(204);
		expect(first.headers.get('upload-offset')).toBe('400');
		expect(first.headers.get('x-media-id')).toBeNull();

		const mid = await head(token);
		expect(mid.status).toBe(200);
		expect(mid.headers.get('upload-offset')).toBe('400');
		expect(mid.headers.get('upload-length')).toBe('1000');
		expect(mid.headers.get('x-media-id')).toBeNull();
		expect(media.getByUploadToken(token)).toBeUndefined();

		const last = await patch(token, 400, bytes.subarray(400));
		expect(last.status).toBe(204);
		const id = last.headers.get('x-media-id')!;
		expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(fs.readFileSync(incomingPath(token)).equals(bytes)).toBe(true);
		expect(wakeIntake).toHaveBeenCalledTimes(1);

		const row = media.getById(id)!;
		expect(row).toMatchObject({
			status: 'received',
			upload_token: token,
			album_id: album,
			source_name: 'IMG_0001.HEIC',
			source_size: 1000,
			client_mtime_ms: 1_700_000_000_000,
			uploaded_by_name: LINDA.n,
			uploaded_by_device: LINDA.d
		});
	});

	it('tells a client resuming a finished upload which item it became', async () => {
		const bytes = randomBytes(64);
		const token = tokenOf(await create(bytes.length));
		const id = (await patch(token, 0, bytes)).headers.get('x-media-id');
		const res = await head(token);
		expect(res.status).toBe(200);
		expect(res.headers.get('x-media-id')).toBe(id);
		// A repeated final PATCH (lost response) finds the same item.
		const again = await patch(token, bytes.length, new Uint8Array(0));
		expect(again.status).toBe(204);
		expect(again.headers.get('x-media-id')).toBe(id);
		expect(media.listReceived()).toHaveLength(1);
	});

	it('keeps an upload whose album was deleted on the way, in that album, and logs it', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const bytes = randomBytes(100);
		const token = tokenOf(await create(bytes.length));
		albums.softDelete(album);
		const res = await patch(token, 0, bytes);
		expect(res.status).toBe(204);
		const id = res.headers.get('x-media-id')!;
		expect(media.getById(id)).toMatchObject({ status: 'received', album_id: album, upload_token: token });
		expect(wakeIntake).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^\\[upload\\] ${id} .*was deleted.*restoring the album brings it back`)));
		warn.mockRestore();
	});

	it('records a finished upload on the retry when the finish step failed', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const bytes = randomBytes(200);
		const token = tokenOf(await create(bytes.length));
		const busy = () => {
			throw new Error('database is locked');
		};
		vi.mocked(media.insertReceived).mockImplementationOnce(busy);
		const last = await patch(token, 0, bytes);
		expect(last.status).toBe(500);
		expect(media.getByUploadToken(token)).toBeUndefined();

		// tus-js-client retries with a HEAD; while the database is still busy, that fails too.
		vi.mocked(media.insertReceived).mockImplementationOnce(busy);
		const busyHead = await head(token);
		expect(busyHead.status).toBe(500);
		expect(busyHead.headers.get('upload-offset')).toBeNull();
		expect(media.getByUploadToken(token)).toBeUndefined();

		// The next HEAD records the item and answers like a normal finished upload.
		const res = await head(token);
		expect(res.status).toBe(200);
		expect(res.headers.get('upload-offset')).toBe('200');
		const id = res.headers.get('x-media-id')!;
		expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(media.getById(id)).toMatchObject({
			status: 'received',
			upload_token: token,
			album_id: album,
			source_size: 200,
			uploaded_by_device: LINDA.d,
			uploaded_by_name: LINDA.n
		});
		expect(wakeIntake).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${id}: recorded on the uploader's retry`));
		// Later HEADs find the same item.
		expect((await head(token)).headers.get('x-media-id')).toBe(id);
		expect(media.listReceived()).toHaveLength(1);
		// An unfinished upload is never recorded by a HEAD.
		const other = tokenOf(await create(10));
		expect((await head(other)).headers.get('x-media-id')).toBeNull();
		expect(media.getByUploadToken(other)).toBeUndefined();
		warn.mockRestore();
		error.mockRestore();
	});

	it('only lets the device that created an upload continue or inspect it', async () => {
		const bytes = randomBytes(100);
		const token = tokenOf(await create(bytes.length));
		const samHead = await head(token, cookie(SAM));
		expect(samHead.status).toBe(403);
		expect(samHead.headers.get('upload-offset')).toBeNull();
		expect((await patch(token, 0, bytes, cookie(SAM))).status).toBe(403);
		expect((await patch(token, 0, bytes, cookie(SAM, 'admin'))).status).toBe(403);
		expect((await head(token, '')).status).toBe(401);
		expect(fs.statSync(incomingPath(token)).size).toBe(0);
		expect((await patch(token, 0, bytes)).status).toBe(204);
	});

	it('answers 404 for unknown or malformed upload ids', async () => {
		expect((await head(randomBytes(16).toString('base64url'))).status).toBe(404);
		expect((await head('not-a-token')).status).toBe(404);
		expect((await patch('..%2F..%2Fapp.sqlite', 0, new Uint8Array(1))).status).toBe(404);
	});
});

describe('parseCookies', () => {
	it('reads name=value pairs, decoding values and keeping the first of duplicates', () => {
		const c = parseCookies('a=1; b="two"; c=x%20y; a=3; broken; =nameless; d=%E0%A4%A');
		expect(c.get('a')).toBe('1');
		expect(c.get('b')).toBe('two');
		expect(c.get('c')).toBe('x y');
		expect(c.get('d')).toBe('%E0%A4%A');
		expect(c.has('broken')).toBe(false);
		expect(parseCookies(null).size).toBe(0);
	});
});
