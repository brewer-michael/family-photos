/**
 * Upload endpoint against the built server: tus-js-client in Node (resumable 120 MB upload in
 * 50 MiB chunks), endpoint hardening, space/size limits and duplicate detection through intake.
 * Browser-independent, so it runs once (desktop project).
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { Upload } from 'tus-js-client';
import { FAMILY_CODE, e2eDir } from './helpers';
import { readRows, seedAlbum, seedMedia } from './seed';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const CHUNK = 50 * MiB;

test.skip(({ isMobile }) => isMobile, 'API checks run once, on the desktop project');

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const incomingFile = (token: string) => path.join(e2eDir(), 'photos', '.incoming', token);

/** Signs an API context in (family code + name) and returns its Cookie header. */
async function signIn(request: APIRequestContext, baseURL: string, name: string): Promise<string> {
	const headers = { origin: baseURL, accept: 'text/html' };
	expect((await request.post('/login', { form: { code: FAMILY_CODE }, headers, maxRedirects: 0 })).status()).toBe(303);
	expect((await request.post('/name', { form: { name }, headers, maxRedirects: 0 })).status()).toBe(303);
	const { cookies } = await request.storageState();
	return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

interface TusOptions {
	baseURL: string;
	cookie: string;
	albumId: number;
	filename?: string;
	uploadUrl?: string;
	/** Abort once this many bytes have been sent; resolves with the upload URL. */
	abortAfter?: number;
}

/** Runs tus-js-client like the browser does (plus the Origin header Node doesn't send by itself). */
function tus(data: Buffer, o: TusOptions): Promise<{ url: string; mediaId: string | null; aborted: boolean }> {
	return new Promise((resolve, reject) => {
		const upload = new Upload(data, {
			endpoint: `${o.baseURL}/api/upload`,
			uploadUrl: o.uploadUrl,
			chunkSize: CHUNK,
			retryDelays: [0, 500, 1000],
			headers: { Cookie: o.cookie, Origin: o.baseURL },
			metadata: { filename: o.filename ?? 'IMG_9999.MOV', lastModified: '1700000000000', albumId: String(o.albumId) },
			onProgress(sent) {
				if (o.abortAfter !== undefined && sent >= o.abortAfter && upload.url) {
					const url = upload.url;
					upload.abort().then(() => resolve({ url, mediaId: null, aborted: true }), reject);
				}
			},
			onSuccess({ lastResponse }) {
				resolve({ url: upload.url!, mediaId: lastResponse.getHeader('X-Media-Id') ?? null, aborted: false });
			},
			onError: reject
		});
		upload.start();
	});
}

const tusHeaders = (cookie: string, baseURL: string) => ({ cookie, origin: baseURL, 'tus-resumable': '1.0.0' });

async function statusOf(request: APIRequestContext, id: string): Promise<Record<string, unknown> | undefined> {
	const res = await request.get(`/api/status?ids=${id}`);
	expect(res.status()).toBe(200);
	return ((await res.json()) as Record<string, unknown>[])[0];
}

test('a 120 MB upload in 50 MiB chunks survives an abort, resumes and arrives byte-identical', async ({ request, baseURL }) => {
	test.setTimeout(120_000);
	const cookie = await signIn(request, baseURL!, 'Uncle Joe');
	const albumId = seedAlbum('Big video');
	const data = randomBytes(120 * MiB);

	// Stop in the middle of the second chunk, as a dropped connection would.
	const first = await tus(data, { baseURL: baseURL!, cookie, albumId, abortAfter: 70 * MiB });
	expect(first.aborted).toBe(true);
	const token = first.url.split('/').pop()!;
	expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
	const mid = await request.head(`/api/upload/${token}`, { headers: tusHeaders(cookie, baseURL!) });
	expect(mid.status()).toBe(200);
	const offset = Number(mid.headers()['upload-offset']);
	expect(offset).toBeGreaterThanOrEqual(CHUNK);
	expect(offset).toBeLessThan(data.length);
	expect(mid.headers()['upload-length']).toBe(String(data.length));
	expect(readRows('SELECT id FROM media WHERE upload_token = ?', token)).toEqual([]);

	const done = await tus(data, { baseURL: baseURL!, cookie, albumId, uploadUrl: first.url });
	expect(done.aborted).toBe(false);
	expect(done.url).toBe(first.url);
	const id = done.mediaId!;
	expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

	// Intake hashes the stored file; random bytes aren't media, so the source stays in .incoming.
	await expect.poll(async () => (await statusOf(request, id))?.status, { timeout: 30_000 }).toBe('failed');
	const [row] = readRows<{ source_sha256: string; source_size: number; error_code: string; uploaded_by_name: string }>(
		'SELECT source_sha256, source_size, error_code, uploaded_by_name FROM media WHERE id = ?',
		id
	);
	expect(row).toEqual({ source_sha256: sha(data), source_size: data.length, error_code: 'unsupported', uploaded_by_name: 'Uncle Joe' });
	const stored = fs.readFileSync(incomingFile(token));
	expect(stored.length).toBe(data.length);
	expect(stored.equals(data)).toBe(true);
});

test.describe('upload endpoint hardening', () => {
	let token = '';
	let cookie = '';

	test.beforeEach(async ({ request, baseURL }) => {
		cookie = await signIn(request, baseURL!, 'Aunt Linda');
		const albumId = seedAlbum('Hardening');
		const res = await request.post('/api/upload', {
			headers: {
				...tusHeaders(cookie, baseURL!),
				'upload-length': '1000',
				'upload-metadata': `filename ${Buffer.from('a.jpg').toString('base64')},albumId ${Buffer.from(String(albumId)).toString('base64')}`
			}
		});
		expect(res.status()).toBe(201);
		token = res.headers()['location'].split('/').pop()!;
	});

	test('GET and DELETE are 405, before and after the upload finishes', async ({ request, baseURL }) => {
		const headers = tusHeaders(cookie, baseURL!);
		for (const phase of ['partial', 'finished']) {
			expect((await request.get(`/api/upload/${token}`, { headers })).status(), phase).toBe(405);
			expect((await request.delete(`/api/upload/${token}`, { headers })).status(), phase).toBe(405);
			if (phase === 'partial') {
				const patch = await request.patch(`/api/upload/${token}`, {
					headers: { ...headers, 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' },
					data: randomBytes(1000)
				});
				expect(patch.status()).toBe(204);
				expect(patch.headers()['x-media-id']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
			}
		}
		expect(fs.existsSync(incomingFile(token))).toBe(true);
	});

	test('X-HTTP-Method-Override is refused', async ({ request, baseURL }) => {
		for (const method of ['GET', 'DELETE', 'PATCH']) {
			const res = await request.post(`/api/upload/${token}`, {
				headers: { ...tusHeaders(cookie, baseURL!), 'x-http-method-override': method }
			});
			expect(res.status(), method).toBe(400);
		}
	});

	test("another device can't look at or continue someone else's upload", async ({ playwright, baseURL }) => {
		const other = await playwright.request.newContext({ baseURL });
		try {
			const otherCookie = await signIn(other, baseURL!, 'Cousin Sam');
			const headers = tusHeaders(otherCookie, baseURL!);
			const head = await other.head(`/api/upload/${token}`, { headers });
			expect(head.status()).toBe(403);
			expect(head.headers()['upload-offset']).toBeUndefined();
			const patch = await other.patch(`/api/upload/${token}`, {
				headers: { ...headers, 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' },
				data: randomBytes(1000)
			});
			expect(patch.status()).toBe(403);
			expect(fs.statSync(incomingFile(token)).size).toBe(0);
		} finally {
			await other.dispose();
		}
		const signedOut = await playwright.request.newContext({ baseURL });
		try {
			expect((await signedOut.head(`/api/upload/${token}`, { headers: { 'tus-resumable': '1.0.0' } })).status()).toBe(401);
		} finally {
			await signedOut.dispose();
		}
	});
});

test.describe('limits', () => {
	const create = (request: APIRequestContext, baseURL: string, cookie: string, albumId: number, length: number) =>
		request.post('/api/upload', {
			headers: {
				...tusHeaders(cookie, baseURL),
				'upload-length': String(length),
				'upload-metadata': `filename ${Buffer.from('big.mov').toString('base64')},albumId ${Buffer.from(String(albumId)).toString('base64')}`
			}
		});

	test('a file over MAX_UPLOAD_GB is refused with 413', async ({ request, baseURL }) => {
		const cookie = await signIn(request, baseURL!, 'Aunt Linda');
		const res = await create(request, baseURL!, cookie, seedAlbum('Limits'), 50 * GiB + 1);
		expect(res.status()).toBe(413);
		expect(await res.text()).toBe('This one is too big to send. The biggest file we can take is 50 GB.');
	});

	test('an upload is refused with 413 when /photos lacks 2 × its size + 2 GiB', async ({ request, baseURL }) => {
		const s = fs.statfsSync(path.join(e2eDir(), 'photos'));
		const free = s.bavail * s.bsize;
		// Smallest size that no longer fits, if that is still under the 50 GiB cap.
		const size = Math.floor((free - 2 * GiB) / 2) + 64 * MiB;
		test.skip(size > 50 * GiB, `this machine has ${Math.round(free / GiB)} GiB free; can't exceed it below the 50 GiB cap`);
		const cookie = await signIn(request, baseURL!, 'Aunt Linda');
		const res = await create(request, baseURL!, cookie, seedAlbum('Low disk'), Math.max(size, 1));
		expect(res.status()).toBe(413);
		expect(await res.text()).toBe("There isn't enough room left for this one. Please tell Michael.");
	});

	test('a deleted album takes no uploads', async ({ request, baseURL }) => {
		const cookie = await signIn(request, baseURL!, 'Aunt Linda');
		const albumId = seedAlbum('Gone');
		const db = new Database(path.join(e2eDir(), 'config', 'app.sqlite'), { timeout: 10_000 });
		try {
			db.prepare('UPDATE albums SET deleted_at = ? WHERE id = ?').run(Date.now(), albumId);
		} finally {
			db.close();
		}
		const res = await create(request, baseURL!, cookie, albumId, 10);
		expect(res.status()).toBe(404);
	});
});

test('the same file uploaded into the same album again becomes a duplicate', async ({ request, baseURL }) => {
	const cookie = await signIn(request, baseURL!, 'Aunt Linda');
	const albumId = seedAlbum('Duplicates');
	const data = randomBytes(64 * 1024);
	// The album already has these bytes as a ready item (seeded, so no photo lane is needed).
	const existing = await seedMedia(albumId, { name: 'IMG_0001.JPG', takenAt: '2024-07-04T12:00:00' });
	const db = new Database(path.join(e2eDir(), 'config', 'app.sqlite'), { timeout: 10_000 });
	try {
		db.prepare('UPDATE media SET source_sha256 = ? WHERE id = ?').run(sha(data), existing);
	} finally {
		db.close();
	}

	const { url, mediaId } = await tus(data, { baseURL: baseURL!, cookie, albumId, filename: 'IMG_0001 copy.JPG' });
	expect(mediaId).toBeTruthy();
	await expect.poll(async () => (await statusOf(request, mediaId!))?.status, { timeout: 30_000 }).toBe('duplicate');
	expect(await statusOf(request, mediaId!)).toMatchObject({ status: 'duplicate', duplicateOf: existing });
	// The duplicate's upload is deleted.
	expect(fs.existsSync(incomingFile(url.split('/').pop()!))).toBe(false);
});
