import { describe, expect, it } from 'vitest';
import {
	asciiFallback,
	cleanStem,
	contentDisposition,
	createNameAllocator,
	downloadName,
	isGenericStem,
	stampFor,
	stemOf,
	type NameSource
} from '#lib/server/filenames';

const base: NameSource = {
	source_name: 'IMG_1234.HEIC',
	canonical_ext: 'jpg',
	kind: 'photo',
	taken_at: '2024-07-04T11:22:31-07:00',
	taken_ms: Date.UTC(2024, 6, 4, 18, 22, 31),
	created_at: Date.UTC(2025, 0, 2, 3, 4, 5)
};

describe('downloadName', () => {
	it('keeps the stem and swaps in the canonical extension', () => {
		expect(downloadName(base)).toBe('IMG_1234.jpg');
		expect(downloadName({ ...base, source_name: 'IMG_5678.MOV', kind: 'video', canonical_ext: 'mp4' })).toBe(
			'IMG_5678.mp4'
		);
		expect(downloadName({ ...base, source_name: 'Screenshot.PNG', canonical_ext: 'png' })).toBe('Screenshot.png');
		expect(downloadName({ ...base, source_name: 'no-extension' })).toBe('no-extension.jpg');
		expect(downloadName({ ...base, source_name: 'party.final.heic' })).toBe('party.final.jpg');
	});

	it('never mentions HEIC or MOV', () => {
		for (const source_name of ['IMG_1.HEIC', 'IMG_1.heif', 'clip.MOV', 'x.avif']) {
			expect(downloadName({ ...base, source_name })).not.toMatch(/heic|heif|mov|avif/i);
		}
	});

	it('replaces generic names with a date-based one from the taken wall time', () => {
		for (const source_name of [
			'image.jpg',
			'image (3).jpeg',
			'tempImageAbCdEf.png',
			'blob',
			'upload',
			'',
			'...jpg',
			'6E1C5D3A-2B4F-4C1D-9E8F-0A1B2C3D4E5F.jpeg',
			'B84E8479-475C-4727-A4A4-B77AA9980897_1_105_c.jpeg'
		]) {
			expect(downloadName({ ...base, source_name }), source_name).toBe('Photo_2024-07-04_11-22-31.jpg');
		}
		expect(
			downloadName({ ...base, source_name: 'trim.4F2A9C1E-1234-4ABC-8DEF-0123456789AB.MOV', kind: 'video', canonical_ext: 'mp4' })
		).toBe('Video_2024-07-04_11-22-31.mp4');
		expect(downloadName({ ...base, source_name: 'video.mov', kind: 'video', canonical_ext: 'mp4' })).toBe(
			'Video_2024-07-04_11-22-31.mp4'
		);
	});

	it('falls back to taken_ms, then the upload time, in the server time zone', () => {
		const noWall = { ...base, source_name: 'image.jpg', taken_at: null };
		const d = new Date(base.taken_ms!);
		const pad = (n: number) => String(n).padStart(2, '0');
		const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
		expect(downloadName(noWall)).toBe(`Photo_${expected}.jpg`);
		expect(stampFor({ taken_at: null, taken_ms: null, created_at: base.created_at })).toMatch(/^2025-01-0[12]_\d\d-04-05$/);
		expect(stampFor({ taken_at: '2024-07-04 08:09', taken_ms: null, created_at: 0 })).toBe('2024-07-04_08-09-00');
	});

	it('makes names safe on every file system', () => {
		expect(cleanStem('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
		expect(cleanStem('  tab\there\u0007  ')).toBe('tabhere');
		expect(cleanStem('.hidden')).toBe('hidden');
		expect(cleanStem('trailing dots... ')).toBe('trailing dots');
		expect(cleanStem('CON')).toBe('_CON');
		expect(cleanStem('x'.repeat(150))).toHaveLength(100);
		expect(Array.from(cleanStem('😀'.repeat(120)))).toHaveLength(100); // never splits a surrogate pair
		expect(cleanStem('Café')).toBe('Café'); // NFC
		expect(downloadName({ ...base, source_name: 'Ünïcödé Party.HEIC' })).toBe('Ünïcödé Party.jpg');
	});

	it('recognises generic stems only', () => {
		expect(isGenericStem('IMG_1234')).toBe(false);
		expect(isGenericStem('Grandma birthday')).toBe(false);
		expect(isGenericStem('imagery')).toBe(false);
		expect(isGenericStem('image')).toBe(true);
		expect(isGenericStem('Video-2')).toBe(true);
	});

	it('takes the stem off the uploaded name', () => {
		expect(stemOf('beach.MOV')).toBe('beach');
		expect(stemOf('trim.4F2A.MOV')).toBe('trim.4F2A');
		expect(stemOf('C:\\Users\\jo\\IMG_1.HEIC')).toBe('IMG_1');
		expect(stemOf('.hidden')).toBe('.hidden');
		expect(stemOf('README')).toBe('README');
	});
});

describe('createNameAllocator', () => {
	it('numbers clashes "(2)", "(3)" ignoring case, and skips names already taken', () => {
		const take = createNameAllocator(['memories.txt']);
		expect(take('IMG_1.jpg')).toBe('IMG_1.jpg');
		expect(take('img_1.JPG')).toBe('img_1 (2).JPG');
		expect(take('IMG_1 (3).jpg')).toBe('IMG_1 (3).jpg');
		expect(take('IMG_1.jpg')).toBe('IMG_1 (4).jpg');
		expect(take('memories.txt')).toBe('memories (2).txt');
		expect(take('noext')).toBe('noext');
		expect(take('noext')).toBe('noext (2)');
	});
});

describe('contentDisposition', () => {
	it('writes an ASCII filename plus an RFC 5987 filename*', () => {
		expect(contentDisposition('attachment', 'IMG_1234.jpg')).toBe(
			`attachment; filename="IMG_1234.jpg"; filename*=UTF-8''IMG_1234.jpg`
		);
		expect(contentDisposition('inline', "Grandma's (1st) café*.jpg")).toBe(
			`inline; filename="Grandma's (1st) cafe*.jpg"; filename*=UTF-8''Grandma%27s%20%281st%29%20caf%C3%A9%2A.jpg`
		);
		expect(asciiFallback('日本 "x"\\.jpg')).toBe('__ _x__.jpg');
	});
});
