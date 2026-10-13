import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ifRangeAllows, isAnimatedPng, noneMatch, parseRange, serveFile } from '#lib/server/serve';
import { testEnv } from '../helpers/env';

describe('parseRange', () => {
	const size = 1000;
	it('parses single byte ranges', () => {
		expect(parseRange('bytes=0-99', size)).toEqual({ start: 0, end: 99 });
		expect(parseRange('bytes=500-', size)).toEqual({ start: 500, end: 999 });
		expect(parseRange('bytes=900-5000', size)).toEqual({ start: 900, end: 999 }); // clamped
		expect(parseRange(' Bytes = 1 - 1 ', size)).toEqual({ start: 1, end: 1 });
	});

	it('parses suffix ranges', () => {
		expect(parseRange('bytes=-100', size)).toEqual({ start: 900, end: 999 });
		expect(parseRange('bytes=-5000', size)).toEqual({ start: 0, end: 999 });
	});

	it('reports unsatisfiable ranges (→ 416)', () => {
		expect(parseRange('bytes=1000-', size)).toBe('unsatisfiable');
		expect(parseRange('bytes=2000-3000', size)).toBe('unsatisfiable');
		expect(parseRange('bytes=-0', size)).toBe('unsatisfiable');
		expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
	});

	it('ignores what it does not handle (→ 200)', () => {
		for (const h of [null, '', 'bytes=', 'bytes=-', 'items=0-1', 'bytes=0-1,5-9', 'bytes=9-1', 'bytes=a-b', 'bytes=99999999999999999999-']) {
			expect(parseRange(h, size), String(h)).toBeNull();
		}
	});
});

describe('conditional headers', () => {
	const etag = '"01J0000000000000000000000A-1-file"';
	it('If-None-Match matches our tag, a list, W/ variants and *', () => {
		expect(noneMatch(etag, etag)).toBe(true);
		expect(noneMatch(`"other", ${etag}`, etag)).toBe(true);
		expect(noneMatch(`W/${etag}`, etag)).toBe(true);
		expect(noneMatch('*', etag)).toBe(true);
		expect(noneMatch('"other"', etag)).toBe(false);
		expect(noneMatch(null, etag)).toBe(false);
	});

	it('If-Range only allows the range with our exact strong ETag', () => {
		expect(ifRangeAllows(null, etag)).toBe(true);
		expect(ifRangeAllows(etag, etag)).toBe(true);
		expect(ifRangeAllows(`W/${etag}`, etag)).toBe(false);
		expect(ifRangeAllows('"stale"', etag)).toBe(false);
		expect(ifRangeAllows('Wed, 21 Oct 2015 07:28:00 GMT', etag)).toBe(false);
	});
});

describe('serveFile', () => {
	let file: string;
	const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
	const etag = '"abc-1-file"';
	const opts = () => ({
		path: file,
		contentType: 'image/jpeg',
		etag,
		lastModified: Date.UTC(2024, 6, 4, 18, 22, 31),
		cacheControl: 'private, max-age=31536000, immutable',
		disposition: 'attachment; filename="IMG_1.jpg"'
	});
	const req = (headers: Record<string, string> = {}, method = 'GET') =>
		new Request('http://x/media/abc/file', { method, headers });

	beforeAll(() => {
		file = path.join(testEnv().root, 'serve.bin');
		fs.writeFileSync(file, bytes);
	});

	it('200 with the whole file and every caching header', async () => {
		const res = (await serveFile(req(), opts()))!;
		expect(res.status).toBe(200);
		expect(Object.fromEntries(res.headers)).toMatchObject({
			'accept-ranges': 'bytes',
			'cache-control': 'private, max-age=31536000, immutable',
			'content-length': '1000',
			'content-type': 'image/jpeg',
			'content-disposition': 'attachment; filename="IMG_1.jpg"',
			etag,
			'last-modified': 'Thu, 04 Jul 2024 18:22:31 GMT',
			'x-content-type-options': 'nosniff'
		});
		expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
	});

	it('206 with Content-Range and exactly the requested bytes', async () => {
		const res = (await serveFile(req({ range: 'bytes=10-19' }), opts()))!;
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe('bytes 10-19/1000');
		expect(res.headers.get('content-length')).toBe('10');
		expect(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(10, 20))).toBe(true);

		const suffix = (await serveFile(req({ range: 'bytes=-3' }), opts()))!;
		expect(suffix.status).toBe(206);
		expect(suffix.headers.get('content-range')).toBe('bytes 997-999/1000');
		expect([...new Uint8Array(await suffix.arrayBuffer())]).toEqual([...bytes.subarray(997)]);
	});

	it('416 for an unsatisfiable range', async () => {
		const res = (await serveFile(req({ range: 'bytes=5000-' }), opts()))!;
		expect(res.status).toBe(416);
		expect(res.headers.get('content-range')).toBe('bytes */1000');
		expect(res.headers.get('content-disposition')).toBeNull();
	});

	it('If-Range: a matching ETag keeps the range, anything else sends the whole file', async () => {
		const ok = (await serveFile(req({ range: 'bytes=0-0', 'if-range': etag }), opts()))!;
		expect(ok.status).toBe(206);
		await ok.body?.cancel();
		const stale = (await serveFile(req({ range: 'bytes=0-0', 'if-range': '"old"' }), opts()))!;
		expect(stale.status).toBe(200);
		expect(stale.headers.get('content-length')).toBe('1000');
		await stale.body?.cancel();
	});

	it('304 for If-None-Match, without a body', async () => {
		const res = (await serveFile(req({ 'if-none-match': etag, range: 'bytes=0-1' }), opts()))!;
		expect(res.status).toBe(304);
		expect(res.headers.get('etag')).toBe(etag);
		expect(res.body).toBeNull();
	});

	it('HEAD sends the headers only', async () => {
		const res = (await serveFile(req({ range: 'bytes=0-9' }, 'HEAD'), opts()))!;
		expect(res.status).toBe(206);
		expect(res.headers.get('content-length')).toBe('10');
		expect(res.body).toBeNull();
	});

	it('null for a missing file', async () => {
		expect(await serveFile(req(), { ...opts(), path: path.join(testEnv().root, 'nope.bin') })).toBeNull();
	});

	it('stops reading when the client goes away', async () => {
		const ac = new AbortController();
		const res = (await serveFile(new Request('http://x/', { signal: ac.signal }), opts()))!;
		const reader = res.body!.getReader();
		ac.abort();
		// The stream ends (or errors) instead of hanging.
		await expect(
			(async () => {
				for (;;) if ((await reader.read()).done) return 'ended';
			})().catch(() => 'errored')
		).resolves.toMatch(/ended|errored/);
	});
});

describe('helpers', () => {
	it('spots animated PNGs (acTL before IDAT)', async () => {
		const chunk = (type: string, data = Buffer.alloc(0)) => {
			const len = Buffer.alloc(4);
			len.writeUInt32BE(data.length);
			return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
		};
		const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const dir = testEnv().root;
		const apng = path.join(dir, 'a.png');
		const still = path.join(dir, 's.png');
		fs.writeFileSync(apng, Buffer.concat([sig, chunk('IHDR', Buffer.alloc(13)), chunk('acTL', Buffer.alloc(8)), chunk('IDAT')]));
		fs.writeFileSync(still, Buffer.concat([sig, chunk('IHDR', Buffer.alloc(13)), chunk('IDAT'), chunk('IEND')]));
		expect(await isAnimatedPng(apng)).toBe(true);
		expect(await isAnimatedPng(still)).toBe(false);
		expect(await isAnimatedPng(path.join(dir, 'missing.png'))).toBe(false);
	});
});
