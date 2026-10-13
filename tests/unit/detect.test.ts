/**
 * detectFile(): routes from bytes only (docs/media-pipeline.md §2 "Detection"). Real files come
 * from tests/fixtures/{photo,heif}; brand and chunk edge cases use small synthetic headers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectFile, type DetectResult } from '#lib/server/media/detect';
import { testEnv } from '../helpers/env';
import { HEIF_FIXTURES, PHOTO_FIXTURES } from '../helpers/photo-fixtures';

const photo = (name: string) => detectFile(path.join(PHOTO_FIXTURES, name));
const heif = (name: string) => detectFile(path.join(HEIF_FIXTURES, name));

let n = 0;
function synthetic(bytes: Buffer | string): Promise<DetectResult> {
	const file = path.join(testEnv().root, `synthetic-${n++}`);
	fs.writeFileSync(file, bytes);
	return detectFile(file);
}

/** An ftyp box (plus padding so the file looks like a real ISOBMFF file). */
function ftyp(major: string, compatible: string[] = []): Buffer {
	const box = Buffer.alloc(16 + compatible.length * 4);
	box.writeUInt32BE(box.length, 0);
	box.write('ftyp', 4, 'latin1');
	box.write(major, 8, 'latin1');
	compatible.forEach((b, i) => box.write(b, 16 + i * 4, 'latin1'));
	return Buffer.concat([box, Buffer.alloc(64)]);
}

/** A RIFF/WEBP file made of the given chunks (fourcc + data). */
function webp(...chunks: [string, Buffer][]): Buffer {
	const body = Buffer.concat(
		chunks.map(([fourcc, data]) => {
			const h = Buffer.alloc(8);
			h.write(fourcc, 0, 'latin1');
			h.writeUInt32LE(data.length, 4);
			return Buffer.concat([h, data, Buffer.alloc(data.length & 1)]);
		})
	);
	const head = Buffer.alloc(12);
	head.write('RIFF', 0, 'latin1');
	head.writeUInt32LE(body.length + 4, 4);
	head.write('WEBP', 8, 'latin1');
	return Buffer.concat([head, body]);
}

function vp8x(flags: number): Buffer {
	const d = Buffer.alloc(10);
	d[0] = flags;
	return d;
}

/** VP8L header: 0x2f, then 14 bits width−1, 14 bits height−1, 1 bit alpha_is_used, 3 bits version. */
function vp8l(alpha: boolean): Buffer {
	const d = Buffer.alloc(16);
	d[0] = 0x2f;
	d.writeUInt32LE(((alpha ? 1 : 0) << 28) | (15 << 14) | 15, 1);
	return d;
}

describe('detectFile: photos', () => {
	it('detects JPEG, including CMYK and greyscale', async () => {
		for (const f of ['o1.jpg', 'o6.jpg', 'cmyk.jpg', 'grey.jpg', 'p3.jpg']) {
			expect(await photo(f)).toEqual({ kind: 'photo', mime: 'image/jpeg', ext: 'jpg', subtype: 'jpeg' });
		}
	});

	it('detects PNG and APNG (acTL before IDAT)', async () => {
		expect(await photo('patches.png')).toEqual({ kind: 'photo', mime: 'image/png', ext: 'png', subtype: 'png' });
		expect(await photo('orient6.png')).toMatchObject({ kind: 'photo', subtype: 'png' });
		expect(await photo('anim.png')).toEqual({ kind: 'photo', mime: 'image/apng', ext: 'apng', subtype: 'png', animated: true });
	});

	it('detects GIF', async () => {
		expect(await photo('still.gif')).toEqual({ kind: 'photo', mime: 'image/gif', ext: 'gif', subtype: 'gif' });
		expect(await photo('anim.gif')).toMatchObject({ kind: 'photo', subtype: 'gif' });
	});

	it('reads the WebP flavour from its chunks', async () => {
		const base = { kind: 'photo', mime: 'image/webp', ext: 'webp', subtype: 'webp' };
		expect(await photo('lossy.webp')).toEqual({ ...base, lossless: false, alpha: false });
		expect(await photo('lossless.webp')).toEqual({ ...base, lossless: true, alpha: false });
		expect(await photo('alpha.webp')).toEqual({ ...base, lossless: false, alpha: true });
		expect(await photo('anim.webp')).toMatchObject({ ...base, animated: true });
	});

	it('handles synthetic WebP chunk layouts', async () => {
		expect(await synthetic(webp(['VP8L', vp8l(true)]))).toMatchObject({ lossless: true, alpha: true });
		expect(await synthetic(webp(['VP8L', vp8l(false)]))).toMatchObject({ lossless: true, alpha: false });
		// VP8X with an ICC chunk before the image data: the image chunk decides lossless.
		expect(await synthetic(webp(['VP8X', vp8x(0x20 | 0x10)], ['ICCP', Buffer.alloc(301)], ['ALPH', Buffer.alloc(9)], ['VP8 ', Buffer.alloc(30)]))).toMatchObject({
			lossless: false,
			alpha: true
		});
		expect(await synthetic(webp(['VP8X', vp8x(0)], ['VP8L', vp8l(false)]))).toMatchObject({ lossless: true, alpha: false });
		expect(await synthetic(webp(['VP8X', vp8x(0x12)], ['ANIM', Buffer.alloc(6)]))).toMatchObject({ animated: true, alpha: true });
	});

	it('routes HEIF and AVIF by brand', async () => {
		expect(await photo('o1.heic')).toEqual({ kind: 'photo', mime: 'image/heic', ext: 'heic', heif: true, subtype: 'heif', brand: 'heic' });
		for (const f of ['arrow.heic', 'zPug_3.heic', 'RGB_10__128x128.heif', 'RGBA_8__128x128.heif', 'heic-iphone7.heic']) {
			expect(await heif(f)).toMatchObject({ kind: 'photo', heif: true, subtype: 'heif', mime: 'image/heic' });
		}
		expect(await heif('example.avif')).toEqual({ kind: 'photo', mime: 'image/avif', ext: 'avif', heif: true, subtype: 'avif', brand: 'avif' });
		expect(await photo('gbr-lossless.avif')).toMatchObject({ kind: 'photo', subtype: 'avif', heif: true });
		// Broken HEIF files are still routed to heif-dec, which reports them as corrupt.
		expect(await heif('truncated.heic')).toMatchObject({ kind: 'photo', subtype: 'heif' });
		expect(await heif('corrupted.heic')).toMatchObject({ kind: 'photo', subtype: 'heif' });
	});

	it('handles synthetic ftyp brands', async () => {
		expect(await synthetic(ftyp('mif1', ['mif1', 'avif']))).toMatchObject({ kind: 'photo', subtype: 'avif', mime: 'image/avif', ext: 'avif' });
		expect(await synthetic(ftyp('mif1', ['mif1', 'heic']))).toMatchObject({ kind: 'photo', subtype: 'heif', mime: 'image/heic', ext: 'heic' });
		expect(await synthetic(ftyp('mif1', ['mif1', 'miaf']))).toMatchObject({ kind: 'photo', subtype: 'heif', mime: 'image/heif', ext: 'heif' });
		expect(await synthetic(ftyp('msf1', ['msf1', 'hevc']))).toMatchObject({ kind: 'photo', subtype: 'heif', mime: 'image/heic-sequence', animated: true });
		expect(await synthetic(ftyp('avis', ['avis', 'msf1']))).toMatchObject({ kind: 'photo', subtype: 'avif', animated: true });
		expect(await synthetic(ftyp('MiHE', ['MiHE', 'heic']))).toMatchObject({ kind: 'photo', subtype: 'heif' });
		// Unknown major brand: HEIF only if a compatible brand says so.
		expect(await synthetic(ftyp('xyz1', ['mif1', 'heic']))).toMatchObject({ kind: 'photo', subtype: 'heif', brand: 'xyz1' });
		expect(await synthetic(ftyp('dash', ['iso6', 'mp41']))).toMatchObject({ kind: 'video', mime: 'video/mp4' });
		expect(await synthetic(ftyp('crx ', ['crx ', 'isom']))).toEqual({ kind: 'photo', mime: 'image/x-canon-cr3', ext: 'cr3', subtype: 'raw', brand: 'crx ' });
	});

	it('detects TIFF, BMP, JPEG XL, JPEG 2000 and PSD', async () => {
		expect(await photo('quad.tif')).toEqual({ kind: 'photo', mime: 'image/tiff', ext: 'tif', subtype: 'tiff' });
		expect(await photo('quad.bmp')).toMatchObject({ kind: 'photo', subtype: 'bmp' });
		expect(await photo('quad.jxl')).toMatchObject({ kind: 'photo', subtype: 'jxl', mime: 'image/jxl' });
		expect(await photo('quad.jp2')).toMatchObject({ kind: 'photo', subtype: 'jp2', mime: 'image/jp2' });
		expect(await photo('quad.psd')).toMatchObject({ kind: 'photo', subtype: 'psd' });
	});

	it('detects TIFF-based RAW', async () => {
		expect(await photo('preview.dng')).toEqual({ kind: 'photo', mime: 'image/x-adobe-dng', ext: 'dng', subtype: 'raw' });
		const cr2 = Buffer.alloc(64);
		cr2.write('II', 0, 'latin1');
		cr2.writeUInt16LE(42, 2);
		cr2.writeUInt32LE(16, 4);
		cr2.write('CR', 8, 'latin1');
		expect(await synthetic(cr2)).toMatchObject({ kind: 'photo', subtype: 'raw', ext: 'cr2' });
		const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(64)]);
		expect(await synthetic(pad(Buffer.from('4949524f0800000018', 'hex')))).toMatchObject({ kind: 'photo', subtype: 'raw', ext: 'orf' });
		expect(await synthetic(pad(Buffer.from('494955001800000088e774d8', 'hex')))).toMatchObject({ kind: 'photo', subtype: 'raw', ext: 'rw2' });
		expect(await synthetic(pad(Buffer.from('FUJIFILMCCD-RAW 0201FF383501', 'latin1')))).toMatchObject({ kind: 'photo', subtype: 'raw', ext: 'raf' });
	});
});

describe('detectFile: mislabelled files go by their bytes', () => {
	it('a .heic that is really a JPEG takes the JPEG route', async () => {
		expect(await photo('jpeg-labelled.heic')).toMatchObject({ kind: 'photo', subtype: 'jpeg', ext: 'jpg' });
	});

	it('a .jpg that is really HEIC goes to heif-dec', async () => {
		expect(await photo('heic-labelled.jpg')).toMatchObject({ kind: 'photo', subtype: 'heif', heif: true, ext: 'heic' });
	});

	it('a .jpg that is really a web page is rejected', async () => {
		expect(await photo('page-labelled.jpg')).toMatchObject({ kind: null, mime: 'text/html' });
	});
});

describe('detectFile: videos', () => {
	it('routes video brands to the video lane', async () => {
		expect(await synthetic(ftyp('qt  ', ['qt  ']))).toEqual({ kind: 'video', mime: 'video/quicktime', ext: 'mov', brand: 'qt  ' });
		expect(await synthetic(ftyp('isom', ['isom', 'iso2', 'avc1', 'mp41']))).toMatchObject({ kind: 'video', mime: 'video/mp4', ext: 'mp4' });
		expect(await synthetic(ftyp('mp42', ['mp42', 'isom']))).toMatchObject({ kind: 'video', ext: 'mp4' });
		expect(await synthetic(ftyp('M4V ', ['M4V ']))).toMatchObject({ kind: 'video', ext: 'm4v' });
		expect(await synthetic(ftyp('3gp4', ['3gp4']))).toMatchObject({ kind: 'video', mime: 'video/3gpp', ext: '3gp' });
		expect(await synthetic(ftyp('3g2a', ['3g2a']))).toMatchObject({ kind: 'video', ext: '3g2' });
		// A video brand wins even when a HEIF brand is listed as compatible.
		expect(await synthetic(ftyp('isom', ['isom', 'mif1']))).toMatchObject({ kind: 'video' });
	});

	it('routes non-ISOBMFF video containers by file-type', async () => {
		const ebml = Buffer.from('1a45dfa3010000000000001f4286810142f7810142f2810442f381084282847765626d', 'hex');
		expect(await synthetic(Buffer.concat([ebml, Buffer.alloc(64)]))).toMatchObject({ kind: 'video', ext: 'webm' });
	});
});

describe('detectFile: not photos or videos', () => {
	it('rejects PDF, HTML and SVG', async () => {
		expect(await photo('not-a-photo.pdf')).toEqual({ kind: null, mime: 'application/pdf', ext: 'pdf' });
		expect(await photo('page.html')).toEqual({ kind: null, mime: 'text/html', ext: 'html' });
		expect(await photo('drawing.svg')).toEqual({ kind: null, mime: 'image/svg+xml', ext: 'svg' });
		expect(await synthetic('﻿  <svg xmlns="http://www.w3.org/2000/svg"></svg>')).toMatchObject({ kind: null, mime: 'image/svg+xml' });
	});

	it('rejects empty and unknown files', async () => {
		expect(await synthetic(Buffer.alloc(0))).toEqual({ kind: null, mime: 'application/octet-stream', ext: 'bin' });
		expect(await synthetic(Buffer.from('just some text, nothing else'))).toEqual({ kind: null, mime: 'application/octet-stream', ext: 'bin' });
		expect(await synthetic(Buffer.alloc(5000, 0x5a))).toMatchObject({ kind: null });
	});

	it('rejects other recognised formats such as ICO and ZIP', async () => {
		const ico = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0]), Buffer.alloc(64)]);
		expect(await synthetic(ico)).toMatchObject({ kind: null, mime: 'image/x-icon' });
		const zip = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(64)]);
		expect(await synthetic(zip)).toMatchObject({ kind: null });
	});
});
