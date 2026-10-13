/**
 * Photo lane end to end: processPhoto() on every fixture class against a temp DB and temp /config
 * and /photos (docs/media-pipeline.md §8 "Assertions"), checked independently of the lane's own
 * verification with sharp and the exiftool CLI: canonical format per §1, rotation applied exactly
 * once, quadrant colours for all 8 orientations, ΔE2000 < 2 on colour patches, Display P3 tagging,
 * metadata kept, derivatives, and what happens to the source.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getConfig, type Config } from '#lib/server/config';
import { getDb } from '#lib/server/db';
import { detectFile } from '#lib/server/media/detect';
import * as paths from '#lib/server/paths';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import { MediaError } from '#lib/shared/errors';
import type { ErrorCode } from '#lib/shared/media-types';
import { freshDb, testEnv } from '../helpers/env';
import { deltaE2000, meanRgb, pixels, quadrantMeans, type Pixels } from '../helpers/photo-color';
import {
	FRAMES,
	HEIF_FIXTURES,
	OTHER_EXIF,
	PATCH,
	PATCHES,
	PATCHES_ACROSS,
	PHOTO_FIXTURES,
	QUAD,
	QUAD_EXIF,
	expectedQuadrants,
	storedPoint,
	type Rgb
} from '../helpers/photo-fixtures';
import { zeroItemData } from '../helpers/photo-heif';
import type { WorkerContext } from '../../src/worker/context';
import { endExiftool } from '../../src/worker/exiftool';
import { processPhoto } from '../../src/worker/photo';
import { decoderOrder, ffmpegImageTools, heifTools, type HeifTools } from '../../src/worker/photo/tools';

const CLIENT_MTIME_MS = Date.UTC(2023, 4, 5, 6, 7, 8);
const DEVICE = 'devicePPPPPPPPPPPPPPPP';

let albumId: number;
let heif: HeifTools;

beforeAll(async () => {
	freshDb();
	paths.ensureDirs();
	albumId = albums.create({ title: 'Photo tests', createdByName: 'Test', createdByDevice: DEVICE }).id;
	heif = await heifTools();
});

afterAll(async () => {
	await endExiftool();
});

const photo = (name: string) => path.join(PHOTO_FIXTURES, name);
const vendored = (name: string) => path.join(HEIF_FIXTURES, name);
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

interface Queued {
	id: string;
	/** Where the lane finds the source (.incoming/<token>). */
	src: string;
	/** The fixture it came from. */
	fixture: string;
}

/** Copies a fixture into .incoming/<token> and walks a row to 'processing' as intake + queue would. */
async function enqueue(file: string, clientMtimeMs: number | null = CLIENT_MTIME_MS): Promise<Queued> {
	const token = randomBytes(16).toString('base64url');
	const src = paths.incomingPath(token);
	fs.copyFileSync(file, src);
	const id = media.insertReceived({
		uploadToken: token,
		albumId,
		sourceName: path.basename(file),
		sourceSize: fs.statSync(src).size,
		clientMtimeMs,
		uploadedByName: 'Test',
		uploadedByDevice: DEVICE
	});
	const det = await detectFile(src);
	const queued = media.markQueued(id, {
		kind: det.kind ?? 'photo',
		sourceMime: det.mime,
		sourceExt: det.ext,
		sourceSha256: randomBytes(32).toString('hex'),
		estCostS: null
	});
	expect(queued).toEqual({ outcome: 'queued' });
	expect(media.claimForProcessing(id)?.status).toBe('processing');
	return { id, src, fixture: file };
}

/** Log lines of the most recent context(). */
let logs: string[] = [];

function context(over: Partial<Config> = {}): WorkerContext {
	logs = [];
	const line = (level: string) => (m: string, extra?: Record<string, unknown>) => logs.push(`${level} ${m} ${JSON.stringify(extra ?? {})}`);
	return {
		db: getDb(),
		config: { ...getConfig(), ...over },
		paths,
		lane: 'photo',
		progress: () => undefined,
		signal: new AbortController().signal,
		log: { info: line('INFO'), warn: line('WARN'), error: line('ERROR') }
	};
}

interface Converted extends Queued {
	row: media.MediaRow;
	canonical: string;
}

async function convert(file: string, opts: { config?: Partial<Config>; clientMtimeMs?: number | null } = {}): Promise<Converted> {
	const q = await enqueue(file, opts.clientMtimeMs);
	await processPhoto(q.id, context(opts.config));
	const row = media.getById(q.id)!;
	expect(row.status).toBe('ready');
	return { ...q, row, canonical: paths.libraryPath(q.id, row.canonical_ext!) };
}

/** The row, files and cache after a successful commit (independently of the lane's checks). */
async function expectCommitted(c: Converted, e: { ext: 'jpg' | 'png' | 'gif'; conversion: 'none' | 'transcode'; width: number; height: number }): Promise<void> {
	expect(logs.filter((l) => !l.startsWith('INFO'))).toEqual([]);
	const { row } = c;
	expect(row).toMatchObject({
		status: 'ready',
		conversion: e.conversion,
		canonical_ext: e.ext,
		width: e.width,
		height: e.height,
		upload_token: null,
		error_code: null,
		source_kept: e.conversion === 'transcode' ? 1 : 0
	});
	expect(fs.statSync(c.canonical).size).toBe(row.canonical_size);
	const meta = await sharp(c.canonical).metadata();
	expect(meta.format).toBe({ jpg: 'jpeg', png: 'png', gif: 'gif' }[e.ext]);

	// The source: passthrough → it *is* the canonical file; transcode → archived (KEEP_ORIGINALS).
	expect(fs.existsSync(c.src)).toBe(false);
	const archived = paths.originalsPath(c.id, row.source_ext!);
	if (e.conversion === 'none') {
		expect(sha(c.canonical)).toBe(sha(c.fixture));
		expect(fs.existsSync(archived)).toBe(false);
	} else {
		expect(sha(archived)).toBe(sha(c.fixture));
		expect(media.sourcePath(row)).toBe(archived);
	}

	// Derivatives: 2048 and 480 boxes, never enlarged.
	const long = Math.max(e.width, e.height);
	for (const [variant, box] of [['display', 2048], ['thumb', 480]] as const) {
		const d = await sharp(paths.cacheFile(c.id, variant)).metadata();
		expect(d.format).toBe('webp');
		expect(Math.max(d.width, d.height)).toBe(Math.min(box, long));
		expect(d.width >= d.height).toBe(e.width >= e.height);
	}
	expect(fs.existsSync(paths.tmpDir(c.id))).toBe(false);
	expect(fs.existsSync(paths.workDir(c.id))).toBe(false);
}

/** exiftool's view of a file (-n -G1). */
function exif(file: string): Record<string, unknown> {
	return (JSON.parse(execFileSync('exiftool', ['-j', '-n', '-G1', file], { encoding: 'utf8' })) as Record<string, unknown>[])[0];
}

function orientationOf(tags: Record<string, unknown>): number | undefined {
	return tags['IFD0:Orientation'] as number | undefined;
}

async function expectQuadrants(file: string | Pixels, orientation: number, maxDeltaE: number): Promise<void> {
	const px = typeof file === 'string' ? await pixels(file) : file;
	const got = quadrantMeans(px);
	const want = expectedQuadrants(orientation);
	for (const q of ['tl', 'tr', 'bl', 'br'] as const) {
		const de = deltaE2000(got[q], want[q]);
		expect(de, `${q}: got ${got[q].map(Math.round)} want ${want[q]} (ΔE ${de.toFixed(2)})`).toBeLessThan(maxDeltaE);
	}
}

/** Mean of each patch's central half against the source codes. */
async function expectPatches(file: string, opts: { asCoded?: boolean } = {}): Promise<number> {
	const px = await pixels(file, opts);
	let worst = 0;
	PATCHES.forEach((want, i) => {
		const x = (i % PATCHES_ACROSS) * PATCH + PATCH / 4;
		const y = Math.floor(i / PATCHES_ACROSS) * PATCH + PATCH / 4;
		const got = meanRgb(px, x, y, PATCH / 2, PATCH / 2);
		const de = deltaE2000(got, want);
		worst = Math.max(worst, de);
		expect(de, `patch ${i}: got ${got.map(Math.round)} want ${want} (ΔE ${de.toFixed(2)})`).toBeLessThan(2);
	});
	return worst;
}

/** 16-bit samples as stored (no orientation applied), 3 channels. */
async function samples16(file: string): Promise<{ data: Uint16Array; width: number; height: number }> {
	const { data, info } = await sharp(file).toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
	return { data: new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)), width: info.width, height: info.height };
}

function iccDescription(file: string): string | undefined {
	return exif(file)['ICC_Profile:ProfileDescription'] as string | undefined;
}

async function expectFailure(file: string, code: ErrorCode): Promise<MediaError> {
	const q = await enqueue(file);
	const err = await processPhoto(q.id, context()).then(
		() => null,
		(e: unknown) => e
	);
	expect(MediaError.is(err), `expected a MediaError, got ${String(err)}`).toBe(true);
	const me = err as MediaError;
	expect(me.code, me.detail).toBe(code);
	// Failures are reported, not written: the row is untouched, the source stays for the admin.
	expect(media.getById(q.id)?.status).toBe('processing');
	expect(sha(q.src)).toBe(sha(file));
	for (const ext of ['jpg', 'png', 'gif']) expect(fs.existsSync(paths.libraryPath(q.id, ext))).toBe(false);
	expect(fs.existsSync(paths.tmpDir(q.id))).toBe(false);
	expect(fs.existsSync(paths.workDir(q.id))).toBe(false);
	return me;
}

const W = QUAD.width;
const H = QUAD.height;

describe('JPEG', () => {
	it.each([1, 2, 3, 4, 5, 6, 7, 8])('keeps the bytes of a JPEG with orientation %i; previews are upright', async (n) => {
		const c = await convert(photo(`o${n}.jpg`));
		const rotated = n >= 5;
		await expectCommitted(c, { ext: 'jpg', conversion: 'none', width: rotated ? H : W, height: rotated ? W : H });
		expect(orientationOf(exif(c.canonical))).toBe(n);
		await expectQuadrants(paths.cacheFile(c.id, 'display'), n, 3);
		await expectQuadrants(paths.cacheFile(c.id, 'thumb'), n, 3);
		expect(c.row).toMatchObject({
			taken_at: QUAD_EXIF.takenAt,
			taken_ms: QUAD_EXIF.takenMs + 123,
			gps_lat: QUAD_EXIF.gpsLat,
			gps_lon: QUAD_EXIF.gpsLon,
			gps_alt: QUAD_EXIF.gpsAlt
		});
	});

	it('keeps a greyscale JPEG as it is', async () => {
		const c = await convert(photo('grey.jpg'));
		await expectCommitted(c, { ext: 'jpg', conversion: 'none', width: W, height: H });
	});

	it('keeps a P3 JPEG with its Display P3 profile', async () => {
		const c = await convert(photo('p3.jpg'));
		await expectCommitted(c, { ext: 'jpg', conversion: 'none', width: W, height: H });
		expect(iccDescription(c.canonical)).toBe('Display P3');
		expect(iccDescription(paths.cacheFile(c.id, 'display'))).toBe('Display P3');
		await expectQuadrants(paths.cacheFile(c.id, 'display'), 1, 3);
	});

	it('converts a CMYK JPEG to an sRGB JPEG and keeps its EXIF', async () => {
		const c = await convert(photo('cmyk.jpg'));
		await expectCommitted(c, { ext: 'jpg', conversion: 'transcode', width: W, height: H });
		const m = await sharp(c.canonical).metadata();
		expect(m.space).toBe('srgb');
		expect(m.channels).toBe(3);
		// No CMYK profile in the source: the generic profile's round trip shifts saturated colours.
		await expectQuadrants(c.canonical, 1, 12);
		const t = exif(c.canonical);
		expect(t['ExifIFD:DateTimeOriginal']).toBe(QUAD_EXIF.dateTimeOriginal);
		expect(t['IFD0:Model']).toBe(QUAD_EXIF.model);
	});

	it('builds previews leniently for a JPEG with only a decoder warning, keeping its bytes', async () => {
		const src = fs.readFileSync(photo('o1.jpg'));
		const sos = src.indexOf(Buffer.from([0xff, 0xda]));
		const file = path.join(testEnv().root, 'warning.jpg');
		fs.writeFileSync(file, Buffer.concat([src.subarray(0, sos), Buffer.from('junk'), src.subarray(sos)])); // "extraneous bytes before marker"
		const c = await convert(file);
		expect(c.row).toMatchObject({ conversion: 'none', canonical_ext: 'jpg' });
		expect(sha(c.canonical)).toBe(sha(file));
		expect(logs.filter((l) => l.startsWith('WARN'))).toEqual([expect.stringContaining('building previews leniently')]);
		await expectQuadrants(paths.cacheFile(c.id, 'display'), 1, 3);
	});

	it('fails a truncated JPEG as corrupt', async () => {
		const file = path.join(testEnv().root, 'truncated.jpg');
		const src = fs.readFileSync(photo('o1.jpg'));
		fs.writeFileSync(file, src.subarray(0, src.length - 60));
		await expectFailure(file, 'corrupt');
	});

	it('refuses a photo over the pixel limit before decoding it', async () => {
		// The quadrant JPEG with its frame header (SOF0) claiming 20000×20000 (400 MP).
		const buf = Buffer.from(fs.readFileSync(photo('o1.jpg')));
		const sof = buf.indexOf(Buffer.from([0xff, 0xc0]));
		buf.writeUInt16BE(20000, sof + 5);
		buf.writeUInt16BE(20000, sof + 7);
		const file = path.join(testEnv().root, 'huge.jpg');
		fs.writeFileSync(file, buf);
		await expectFailure(file, 'too_large');
	});

	it('takes the JPEG route for a .heic that is really a JPEG', async () => {
		const c = await convert(photo('jpeg-labelled.heic'));
		await expectCommitted(c, { ext: 'jpg', conversion: 'none', width: W, height: H });
	});
});

describe('HEIF', () => {
	it.each([1, 2, 3, 4, 5, 6, 7, 8])('converts a HEIC with orientation %i to an upright JPEG, rotated once', async (n) => {
		const c = await convert(photo(`o${n}.heic`));
		const rotated = n >= 5;
		await expectCommitted(c, { ext: 'jpg', conversion: 'transcode', width: rotated ? H : W, height: rotated ? W : H });
		const t = exif(c.canonical);
		expect([undefined, 1]).toContain(orientationOf(t));
		const m = await sharp(c.canonical).metadata();
		expect([m.width, m.height]).toEqual([c.row.width, c.row.height]);
		await expectQuadrants(c.canonical, n, 3);
		await expectQuadrants(paths.cacheFile(c.id, 'display'), n, 3);
		// Date, place and camera survive in the canonical EXIF and in the row.
		expect(t['ExifIFD:DateTimeOriginal']).toBe(QUAD_EXIF.dateTimeOriginal);
		expect(t['ExifIFD:OffsetTimeOriginal']).toBe(QUAD_EXIF.offsetTimeOriginal);
		expect(t['Composite:GPSLatitude']).toBeCloseTo(QUAD_EXIF.gpsLat, 4);
		expect(t['Composite:GPSLongitude']).toBeCloseTo(QUAD_EXIF.gpsLon, 4);
		expect(t['IFD0:Make']).toBe(QUAD_EXIF.make);
		expect(t['IFD0:Model']).toBe(QUAD_EXIF.model);
		expect(t['XMP-x:XMPToolkit']).toBeUndefined();
		expect(c.row).toMatchObject({ taken_at: QUAD_EXIF.takenAt, gps_lat: QUAD_EXIF.gpsLat, gps_lon: QUAD_EXIF.gpsLon });
	});

	it('goes to the HEIF decoder for a .jpg that is really HEIC', async () => {
		const c = await convert(photo('heic-labelled.jpg'));
		await expectCommitted(c, { ext: 'jpg', conversion: 'transcode', width: W, height: H });
		expect(c.row.source_ext).toBe('heic');
		expect(fs.existsSync(paths.originalsPath(c.id, 'heic'))).toBe(true);
	});

	it('keeps the Display P3 profile of a P3 HEIC', async () => {
		const c = await convert(photo('p3.heic'));
		await expectCommitted(c, { ext: 'jpg', conversion: 'transcode', width: W, height: H });
		expect(iccDescription(c.canonical)).toBe('Display P3');
		await expectQuadrants(c.canonical, 1, 3);
	});

	it('decodes BT.709 limited-range colour exactly (ΔE2000 < 2)', async () => {
		const c = await convert(photo('bt709-limited.heic'));
		await expectCommitted(c, { ext: 'jpg', conversion: 'transcode', width: 192, height: 128 });
		expect(iccDescription(c.canonical)).toBeUndefined();
		await expectPatches(c.canonical);
	});

	it('tags a HEIC that is P3 only by its nclx box with Display P3 (ΔE2000 < 2 on the codes)', async () => {
		const c = await convert(photo('p3-nclx.heic'));
		await expectCommitted(c, { ext: 'jpg', conversion: 'transcode', width: 192, height: 128 });
		expect(iccDescription(c.canonical)).toBe('Display P3');
		expect(iccDescription(paths.cacheFile(c.id, 'display'))).toBe('Display P3');
		await expectPatches(c.canonical, { asCoded: true });
	});

	it('decodes a lossless GBR AVIF (ΔE2000 < 2)', async () => {
		const c = await convert(photo('gbr-lossless.avif'));
		await expectCommitted(c, { ext: 'jpg', conversion: 'transcode', width: 192, height: 128 });
		expect(c.row.source_ext).toBe('avif');
		await expectPatches(c.canonical);
	});

	it('decodes an AVIF', async () => {
		const c = await convert(vendored('example.avif'));
		await expectCommitted(c, { ext: 'jpg', conversion: 'transcode', width: 800, height: 533 });
	});

	it('converts the primary still of an AVIF image sequence (unsupported on libheif 1.17)', async () => {
		expect(await detectFile(photo('sequence.avif'))).toMatchObject({ kind: 'photo', subtype: 'avif', brand: 'avis', animated: true });
		const [major, minor] = (heif.version ?? '0.0').split('.').map(Number);
		if (path.basename(heif.decBin) === 'heif-convert' || major < 1 || (major === 1 && minor < 18)) {
			// heif-convert refuses every file whose main brand isn't heic/heix/avif/mif1/mif2.
			const e = await expectFailure(photo('sequence.avif'), 'unsupported');
			expect(e.detail).toMatch(/unsupported HEIF\/AVIF file type/);
			return;
		}
		const c = await convert(photo('sequence.avif'));
		await expectCommitted(c, { ext: 'jpg', conversion: 'transcode', width: 64, height: 48 });
		expect(c.row.source_ext).toBe('avif');
		const px = await pixels(c.canonical);
		expect(deltaE2000(meanRgb(px, 8, 8, 48, 32), FRAMES[0] as Rgb)).toBeLessThan(3);
	});

	it('converts an HLG (HDR) HEIC without tone mapping and logs that for the admin', async () => {
		const c = await convert(photo('hlg.heic'));
		expect(c.row).toMatchObject({ conversion: 'transcode', canonical_ext: 'jpg', width: 64, height: 48 });
		expect(logs.filter((l) => !l.startsWith('INFO'))).toEqual([expect.stringMatching(/^WARN .*HDR photo shown without tone mapping \(HLG\)/)]);
	});

	it('rotates an iPhone grid image with irot 270 and EXIF Orientation 6 exactly once', async () => {
		const c = await convert(vendored('arrow.heic'));
		await expectCommitted(c, { ext: 'jpg', conversion: 'transcode', width: 3024, height: 4032 });
		const t = exif(c.canonical);
		expect([undefined, 1]).toContain(orientationOf(t));
		expect(t['ICC_Profile:ProfileDescription']).toBe('Display P3');
		expect(t['IFD0:Model']).toBe('iPhone 8 Plus');
		expect(c.row.taken_at).toBe('2018-07-31T14:52:07');
		// The display copy keeps the profile and a date, never GPS; the thumbnail has no metadata.
		const d = exif(paths.cacheFile(c.id, 'display'));
		expect(d['ICC_Profile:ProfileDescription']).toBe('Display P3');
		expect(d['ExifIFD:DateTimeOriginal']).toBe('2018:07:31 14:52:07');
		expect(Object.keys(d).filter((k) => k.startsWith('GPS:') || k.startsWith('Composite:GPS'))).toEqual([]);
		const th = exif(paths.cacheFile(c.id, 'thumb'));
		expect(Object.keys(th).filter((k) => /^(IFD0|ExifIFD|GPS|ICC_Profile):/.test(k))).toEqual([]);
	});

	it('keeps date, place, camera and Display P3 of a real iPhone photo', async () => {
		const c = await convert(vendored('heic-iphone7.heic'));
		await expectCommitted(c, { ext: 'jpg', conversion: 'transcode', width: 4032, height: 3024 });
		expect(c.row.taken_at).toBe('2019-10-20T18:34:30+02:00');
		expect(c.row.taken_ms).toBe(Date.UTC(2019, 9, 20, 16, 34, 30, 130));
		expect(c.row.gps_lat).toBeCloseTo(38.0466417, 6);
		expect(c.row.gps_lon).toBeCloseTo(12.9944111, 6);
		const t = exif(c.canonical);
		expect(t['ExifIFD:DateTimeOriginal']).toBe('2019:10:20 18:34:30');
		expect(t['Composite:GPSLatitude']).toBeCloseTo(38.0466417, 6);
		expect(t['IFD0:Make']).toBe('Apple');
		expect(t['IFD0:Model']).toBe('iPhone 7');
		expect(t['ICC_Profile:ProfileDescription']).toBe('Display P3');
	});

	it('picks the primary image of a file with three (zPug_3: the 2nd)', async () => {
		const c = await convert(vendored('zPug_3.heic'));
		await expectCommitted(c, { ext: 'jpg', conversion: 'transcode', width: 64, height: 64 });
		// Reference decodes of every top-level image, by libheif itself.
		const dir = fs.mkdtempSync(path.join(testEnv().root, 'zpug-'));
		execFileSync(heif.decBin, ['--quiet', vendored('zPug_3.heic'), path.join(dir, 'ref.png')]);
		const got = await pixels(c.canonical);
		const diff = async (k: number) => {
			const ref = await pixels(path.join(dir, `ref-${k}.png`));
			if (ref.width !== got.width || ref.height !== got.height) return Infinity;
			let sum = 0;
			for (let i = 0; i < got.data.length; i++) sum += Math.abs(got.data[i] - ref.data[i]);
			return sum / got.data.length;
		};
		const [d1, d2, d3] = [await diff(1), await diff(2), await diff(3)];
		expect(d2, `mean abs diff vs image 2: ${d2}`).toBeLessThan(3);
		expect(d1).toBeGreaterThan(10);
		expect(d3).toBe(Infinity);
	});

	it('converts a 10-bit HEIF', async () => {
		const c = await convert(vendored('RGB_10__128x128.heif'));
		await expectCommitted(c, { ext: 'jpg', conversion: 'transcode', width: 128, height: 128 });
	});

	it('keeps transparency as PNG', async () => {
		const c = await convert(vendored('RGBA_8__128x128.heif'));
		await expectCommitted(c, { ext: 'png', conversion: 'transcode', width: 128, height: 128 });
		const m = await sharp(c.canonical).metadata();
		expect(m.hasAlpha).toBe(true);
		expect((await sharp(c.canonical).stats()).isOpaque).toBe(false);
	});

	it('fails a broken non-primary image as corrupt, keeping the source', async () => {
		const broken = path.join(testEnv().root, 'zPug_3-broken1.heic');
		zeroItemData(vendored('zPug_3.heic'), broken, 1);
		const e = await expectFailure(broken, 'corrupt');
		expect(e.retryable).toBe(false);
	});

	it('fails truncated and corrupted files as corrupt', async () => {
		await expectFailure(vendored('truncated.heic'), 'corrupt');
		await expectFailure(vendored('corrupted.heic'), 'corrupt');
	});

	it('gets the same pixels from every installed HEVC decoder that can decode a file', async () => {
		const decoders = decoderOrder(heif, 'hevc');
		if (decoders.length < 2) {
			console.warn(`skipped: only ${decoders.join(', ') || 'no'} HEVC decoder installed`);
			return;
		}
		const dir = fs.mkdtempSync(path.join(testEnv().root, 'decoders-'));
		const files = [
			...['o1.heic', 'o6.heic', 'p3.heic', 'bt709-limited.heic', 'p3-nclx.heic'].map(photo),
			...['arrow.heic', 'heic-iphone7.heic', 'zPug_3.heic', 'RGB_10__128x128.heif', 'RGBA_8__128x128.heif'].map(vendored)
		];
		for (const file of files) {
			const decoded: { decoder: string; px: Buffer }[] = [];
			for (const d of decoders) {
				const out = path.join(dir, `${path.basename(file, path.extname(file))}.${d}.png`);
				try {
					execFileSync(heif.decBin, ['-d', d, '--quiet', file, out], { stdio: 'pipe' });
				} catch (e) {
					// The lane falls back to the next decoder (e.g. libheif 1.17's ffmpeg plugin has no
					// monochrome or alpha support); only disagreement between decoders is a problem.
					console.warn(`${d} can't decode ${path.basename(file)} here: ${String((e as { stderr?: Buffer }).stderr ?? e).trim()}`);
					continue;
				}
				const outs = fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(out, '.png')));
				decoded.push({ decoder: d, px: Buffer.concat(await Promise.all(outs.sort().map((o) => sharp(path.join(dir, o)).raw().toBuffer()))) });
			}
			expect(decoded.length, `no decoder could decode ${path.basename(file)}`).toBeGreaterThan(0);
			for (const other of decoded.slice(1)) {
				let max = 0;
				for (let i = 0; i < decoded[0].px.length; i++) max = Math.max(max, Math.abs(decoded[0].px[i] - other.px[i]));
				expect(max, `${path.basename(file)}: ${decoded[0].decoder} vs ${other.decoder}`).toBeLessThanOrEqual(1);
			}
		}
	});
});

describe('PNG and GIF', () => {
	it('keeps a PNG as it is', async () => {
		const c = await convert(photo('patches.png'));
		await expectCommitted(c, { ext: 'png', conversion: 'none', width: 192, height: 128 });
		// No date anywhere: the client's lastModified is used.
		expect(c.row).toMatchObject({ taken_at: null, taken_ms: CLIENT_MTIME_MS, gps_lat: null });
	});

	it('falls back to the upload time without any date', async () => {
		const c = await convert(photo('patches.png'), { clientMtimeMs: null });
		expect(c.row.taken_ms).toBe(c.row.created_at);
	});

	it('rotates a PNG with EXIF Orientation 6 losslessly', async () => {
		const c = await convert(photo('orient6.png'));
		await expectCommitted(c, { ext: 'png', conversion: 'transcode', width: H, height: W });
		const t = exif(c.canonical);
		expect([undefined, 1]).toContain(orientationOf(t));
		expect(t['ExifIFD:DateTimeOriginal']).toBe(QUAD_EXIF.dateTimeOriginal);
		const px = await pixels(c.canonical);
		expect([px.width, px.height]).toEqual([H, W]);
		await expectQuadrants(px, 6, 0.5);
	});

	it('rotates a 16-bit PNG with EXIF Orientation 6 losslessly, keeping all 16 bits', async () => {
		const c = await convert(photo('orient6-16bit.png'));
		await expectCommitted(c, { ext: 'png', conversion: 'transcode', width: 48, height: 64 });
		expect([undefined, 1]).toContain(orientationOf(exif(c.canonical)));
		const m = await sharp(c.canonical).metadata();
		expect([m.depth, m.channels]).toEqual(['ushort', 3]);
		const src = await samples16(photo('orient6-16bit.png'));
		const got = await samples16(c.canonical);
		expect(src.data.some((v) => v % 257 !== 0), 'the fixture uses the low byte').toBe(true);
		let mismatched = 0;
		for (let y = 0; y < got.height; y++) {
			for (let x = 0; x < got.width; x++) {
				const [sx, sy] = storedPoint(6, x, y, got.width, got.height);
				for (let ch = 0; ch < 3; ch++) {
					if (got.data[(y * got.width + x) * 3 + ch] !== src.data[(sy * src.width + sx) * 3 + ch]) mismatched++;
				}
			}
		}
		expect(mismatched).toBe(0);
	});

	it('keeps an APNG as it is; the thumbnail is its first frame', async () => {
		const c = await convert(photo('anim.png'));
		await expectCommitted(c, { ext: 'png', conversion: 'none', width: 64, height: 48 });
		const px = await pixels(paths.cacheFile(c.id, 'thumb'));
		expect(deltaE2000(meanRgb(px, 8, 8, 48, 32), FRAMES[0] as Rgb)).toBeLessThan(3);
	});

	it('keeps still and animated GIFs as they are', async () => {
		const still = await convert(photo('still.gif'));
		await expectCommitted(still, { ext: 'gif', conversion: 'none', width: W, height: H });
		const anim = await convert(photo('anim.gif'));
		await expectCommitted(anim, { ext: 'gif', conversion: 'none', width: 64, height: 48 });
		const px = await pixels(paths.cacheFile(anim.id, 'display'));
		expect(deltaE2000(meanRgb(px, 8, 8, 48, 32), FRAMES[0] as Rgb)).toBeLessThan(3);
	});
});

describe('WebP', () => {
	it('converts a lossy WebP to JPEG and keeps its EXIF', async () => {
		const c = await convert(photo('lossy.webp'));
		await expectCommitted(c, { ext: 'jpg', conversion: 'transcode', width: W, height: H });
		await expectQuadrants(c.canonical, 1, 3);
		expect(exif(c.canonical)['ExifIFD:DateTimeOriginal']).toBe(QUAD_EXIF.dateTimeOriginal);
		expect(c.row.taken_at).toBe(QUAD_EXIF.takenAt);
	});

	it('converts a lossless WebP to PNG without changing a pixel', async () => {
		const c = await convert(photo('lossless.webp'));
		await expectCommitted(c, { ext: 'png', conversion: 'transcode', width: 192, height: 128 });
		const worst = await expectPatches(c.canonical);
		expect(worst).toBe(0);
	});

	it('converts a WebP with transparency to PNG', async () => {
		const c = await convert(photo('alpha.webp'));
		await expectCommitted(c, { ext: 'png', conversion: 'transcode', width: W, height: H });
		const { data, info } = await sharp(c.canonical).raw().toBuffer({ resolveWithObject: true });
		expect(info.channels).toBe(4);
		expect(data[((H / 2) * W + W / 2) * 4 + 3]).toBe(0);
		expect(data[3]).toBe(255);
	});

	it('converts an animated WebP to a GIF with the same frames', async () => {
		const c = await convert(photo('anim.webp'));
		await expectCommitted(c, { ext: 'gif', conversion: 'transcode', width: 64, height: 48 });
		const m = await sharp(c.canonical, { animated: true }).metadata();
		const src = await sharp(photo('anim.webp'), { animated: true }).metadata();
		expect(m.pages).toBe(FRAMES.length);
		expect(m.pages).toBe(src.pages);
		expect(m.delay).toEqual(src.delay);
		const { data, info } = await sharp(c.canonical, { animated: true }).raw().toBuffer({ resolveWithObject: true });
		FRAMES.forEach((rgb, i) => {
			const at = (i * 48 * 64 + 24 * 64 + 32) * info.channels;
			expect(deltaE2000([data[at], data[at + 1], data[at + 2]], rgb as Rgb), `frame ${i}`).toBeLessThan(3);
		});
	});
});

describe('TIFF, BMP, JPEG XL, JPEG 2000, PSD', () => {
	it('converts a TIFF to JPEG and copies its EXIF', async () => {
		const c = await convert(photo('quad.tif'));
		await expectCommitted(c, { ext: 'jpg', conversion: 'transcode', width: W, height: H });
		await expectQuadrants(c.canonical, 1, 3);
		const t = exif(c.canonical);
		expect(t['ExifIFD:DateTimeOriginal']).toBe(OTHER_EXIF.dateTimeOriginal);
		expect(t['IFD0:Make']).toBe(OTHER_EXIF.make);
		expect(t['IFD0:Model']).toBe(OTHER_EXIF.model);
		expect(c.row.taken_at).toBe(OTHER_EXIF.takenAt);
	});

	it.each([
		['quad.bmp', 'bmp', 'png', 64, 48],
		['quad.jxl', 'jxl', 'jpg', W, H],
		['quad.jp2', 'jp2', 'jpg', W, H],
		['quad.psd', 'psd', 'jpg', 64, 48]
	] as const)('decodes %s with ffmpeg', async (name, codec, ext, width, height) => {
		if (!(await ffmpegImageTools()).decodes[codec]) {
			console.warn(`skipped: this ffmpeg has no ${codec} decoder`);
			return;
		}
		const c = await convert(photo(name));
		await expectCommitted(c, { ext, conversion: 'transcode', width, height });
		await expectQuadrants(c.canonical, 1, 3);
	});
});

describe('RAW', () => {
	it('uses the largest embedded preview with the RAW tags', async () => {
		const c = await convert(photo('preview.dng'));
		// The 1600×1200 preview carries the DNG's Orientation 6: shown as 1200×1600.
		await expectCommitted(c, { ext: 'jpg', conversion: 'transcode', width: 1200, height: 1600 });
		const t = exif(c.canonical);
		expect(orientationOf(t)).toBe(6);
		expect(t['IFD0:Make']).toBe(OTHER_EXIF.make);
		expect(t['ExifIFD:DateTimeOriginal']).toBe(OTHER_EXIF.dateTimeOriginal);
		expect(c.row.taken_at).toBe(OTHER_EXIF.takenAt);
		expect(c.row.source_ext).toBe('dng');
		await expectQuadrants(paths.cacheFile(c.id, 'display'), 6, 3);
	});

	it('refuses a RAW whose preview is too small', async () => {
		await expectFailure(photo('small-preview.dng'), 'unsupported');
	});
});

describe('not photos', () => {
	it.each(['drawing.svg', 'not-a-photo.pdf', 'page.html', 'page-labelled.jpg'])('refuses %s as unsupported', async (name) => {
		await expectFailure(photo(name), 'unsupported');
	});
});

describe('sources and commits', () => {
	it('deletes a transcoded source when KEEP_ORIGINALS is off', async () => {
		const c = await convert(photo('o1.heic'), { config: { keepOriginals: false } });
		expect(c.row.source_kept).toBe(0);
		expect(fs.existsSync(c.src)).toBe(false);
		expect(fs.existsSync(paths.originalsPath(c.id, 'heic'))).toBe(false);
	});

	it('reprocesses from the archived original, replacing the library and cache files', async () => {
		const c = await convert(photo('o6.heic'));
		const before = fs.statSync(paths.cacheFile(c.id, 'thumb')).mtimeMs;
		expect(media.markForReprocess(c.id)).toBe(true);
		expect(media.claimForProcessing(c.id)?.status).toBe('processing');
		await processPhoto(c.id, context());
		const row = media.getById(c.id)!;
		expect(row).toMatchObject({ status: 'ready', source_kept: 1, width: H, height: W });
		expect(sha(paths.originalsPath(c.id, 'heic'))).toBe(sha(photo('o6.heic')));
		expect(fs.statSync(paths.cacheFile(c.id, 'thumb')).mtimeMs).toBeGreaterThanOrEqual(before);
	});

	it('does not commit (and puts a passthrough source back) when the row left processing', async () => {
		const q = await enqueue(photo('o1.jpg'));
		expect(media.requeue(q.id)).toBe(true);
		const err = await processPhoto(q.id, context()).then(
			() => null,
			(e: unknown) => e
		);
		expect(MediaError.is(err) && err.code).toBe('retryable');
		expect(sha(q.src)).toBe(sha(photo('o1.jpg')));
		expect(fs.existsSync(paths.libraryPath(q.id, 'jpg'))).toBe(false);
		expect(media.getById(q.id)?.status).toBe('queued');
	});

	it('never fails a committed item when the source cannot be archived', async () => {
		// An extension originals/ refuses: archiving fails after markReady(), which must only log.
		const q = await enqueue(photo('o1.heic'));
		getDb().prepare('UPDATE media SET source_ext = ? WHERE id = ?').run('he.ic', q.id);
		await processPhoto(q.id, context());
		expect(media.getById(q.id)).toMatchObject({ status: 'ready', source_kept: 0 });
		expect(logs.filter((l) => !l.startsWith('INFO'))).toEqual([expect.stringMatching(/^ERROR .*could not archive the source/)]);
	});

	it('fails cleanly when the source is gone', async () => {
		const q = await enqueue(photo('o1.jpg'));
		fs.rmSync(q.src);
		const err = await processPhoto(q.id, context()).then(
			() => null,
			(e: unknown) => e
		);
		expect(MediaError.is(err) && err.code).toBe('corrupt');
	});
});

/** Peak resident memory of a decoder run: /proc/<pid>/status VmHWM (Linux), polled until it exits. */
function decoderPeakRss(cmd: string, args: string[]): Promise<{ ms: number; peakMb: number }> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const child = spawn(cmd, args, { stdio: 'ignore' });
		let peakKb = 0;
		const poll = setInterval(() => {
			try {
				const m = /VmHWM:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${child.pid}/status`, 'utf8'));
				if (m) peakKb = Math.max(peakKb, Number(m[1]));
			} catch {
				// exited between polls
			}
		}, 10);
		child.on('error', reject);
		child.on('close', (code) => {
			clearInterval(poll);
			if (code !== 0) reject(new Error(`${cmd} exited ${code}`));
			else resolve({ ms: Date.now() - started, peakMb: Math.round(peakKb / 1024) });
		});
	});
}

/**
 * Bundles tests/helpers/photo-perf-runner.ts with the worker's Vite config (our code bundled,
 * node_modules external) into `dir`; bare imports resolve through a node_modules link.
 */
async function buildPerfRunner(dir: string): Promise<string> {
	const { build } = await import('vite');
	await build({
		configFile: path.resolve('vite.worker.config.ts'),
		logLevel: 'error',
		build: {
			ssr: path.resolve('tests/helpers/photo-perf-runner.ts'),
			outDir: dir,
			emptyOutDir: false,
			sourcemap: false,
			rolldownOptions: { output: { entryFileNames: 'runner.js' } }
		}
	});
	fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'));
	return path.join(dir, 'runner.js');
}

/** processPhoto() for a claimed row in a fresh process started like the photo lane. */
function runIsolated(runner: string, id: string): Promise<{ ms: number; peakMb: number; idleMb: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['--max-old-space-size=512', runner, id], { stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
		child.stderr.on('data', (b: Buffer) => (err += b.toString('utf8')));
		child.on('error', reject);
		child.on('close', (code) => {
			if (code !== 0) return reject(new Error(`perf runner exited ${code}: ${err.trim().slice(-2000)}`));
			resolve(JSON.parse(out.trim().split('\n').at(-1)!) as { ms: number; peakMb: number; idleMb: number });
		});
	});
}

/**
 * Time and peak memory of one 12 MP and one 48 MP HEIC (docs/media-pipeline.md §8), each in a
 * fresh process so earlier tests can't raise the high-water mark. The synthetic photos are
 * encoded at -q 85, which gives about the size of a real iPhone HEIC (≈ 3 MB at 12 MP). The
 * numbers are printed, not asserted (see tests/media/README.md); only the time has a ceiling.
 */
describe('performance', () => {
	let runner: string | null = null;
	let encoders = '';
	beforeAll(async () => {
		try {
			encoders = execFileSync('heif-enc', ['--list-encoders'], { encoding: 'utf8' });
		} catch {
			// heif-enc missing
		}
		if (/x265/.test(encoders)) runner = await buildPerfRunner(fs.mkdtempSync(path.join(testEnv().root, 'perf-runner-')));
	});

	it.each([
		[12, 4000, 3000],
		[48, 8000, 6000]
	])('records time and peak memory for a %i MP HEIC', async (mp, width, height) => {
		if (!runner) {
			console.warn(`skipped: heif-enc with the x265 encoder is needed to build the ${mp} MP test image`);
			return;
		}
		const dir = fs.mkdtempSync(path.join(testEnv().root, `perf${mp}-`));
		// Smooth gradients with gentle waves: no flat areas, no noise (noise would make the file far
		// bigger than a real photo's).
		const raw = new Uint8ClampedArray(width * height * 3);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const i = (y * width + x) * 3;
				const wave = Math.sin(x / 37) * Math.cos(y / 53) * 40;
				raw[i] = (x * 200) / width + 30 + wave;
				raw[i + 1] = (y * 200) / height + 30 - wave;
				raw[i + 2] = 128 + Math.sin((x + y) / 23) * 60;
			}
		}
		await sharp(raw, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 1 }).toFile(path.join(dir, 'src.png'));
		const heic = path.join(dir, `${mp}mp.heic`);
		execFileSync('heif-enc', ['-q', '85', path.join(dir, 'src.png'), '-o', heic]);
		fs.rmSync(path.join(dir, 'src.png'));

		const decoder = decoderOrder(heif, 'hevc')[0];
		const dec = await decoderPeakRss(heif.decBin, ['-d', decoder, '--quiet', '--png-compression-level', '1', heic, path.join(dir, 'dec.png')]);
		const q = await enqueue(heic);
		const lane = await runIsolated(runner, q.id);
		const row = media.getById(q.id)!;
		expect(row).toMatchObject({ status: 'ready', conversion: 'transcode', canonical_ext: 'jpg', width, height });
		console.info(
			`[perf] ${mp} MP HEIC (${width}×${height}, ${(fs.statSync(heic).size / 1e6).toFixed(1)} MB): ` +
				`processPhoto ${(lane.ms / 1000).toFixed(1)} s, photo lane process peak RSS ${lane.peakMb} MB (idle ${lane.idleMb} MB); ` +
				`${path.basename(heif.decBin)} -d ${decoder} alone ${(dec.ms / 1000).toFixed(1)} s, peak RSS ${dec.peakMb} MB`
		);
		expect(lane.ms).toBeLessThan(mp === 48 ? 240_000 : 120_000);
	});
});
