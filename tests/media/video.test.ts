/**
 * Video lane end to end: fixtures F1–F19 generated with the local ffmpeg into a temp dir, then
 * processVideo() against a temp DB and temp /config and /photos, asserting every "Verify and
 * commit" rule (docs/media-pipeline.md §3) independently of the lane's own checks.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { getConfig, type Config } from '#lib/server/config';
import { getDb } from '#lib/server/db';
import * as paths from '#lib/server/paths';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import { ffmpegCaps, parseRate, type FfmpegCaps, type FfprobeResult } from '#lib/server/media/probe';
import { MediaError } from '#lib/shared/errors';
import { PIPELINE_VERSION } from '#lib/shared/media-types';
import { freshDb, testEnv } from '../helpers/env';
import { APPLE, FIXTURES, UTC_ONLY_CREATION_TIME, makeFixture, missingEncoders, type FixtureId } from '../fixtures/video/fixtures';
import type { WorkerContext } from '../../src/worker/context';
import { processVideo } from '../../src/worker/video';

const APPLE_TAKEN_MS = Date.UTC(2024, 6, 4, 18, 22, 31);
const CLIENT_MTIME_MS = Date.UTC(2023, 4, 5, 6, 7, 8);
const MIME: Record<string, string> = {
	mov: 'video/quicktime', mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/vnd.avi',
	wmv: 'video/x-ms-asf', ts: 'video/mp2t', dv: 'video/x-dv'
};

let fixtureDir: string;
let albumId: number;
let caps: FfmpegCaps;

beforeAll(async () => {
	freshDb();
	fixtureDir = path.join(testEnv().root, 'fixtures');
	paths.ensureDirs();
	albumId = albums.create({ title: 'Video tests', createdByName: 'Test', createdByDevice: 'deviceTTTTTTTTTTTTTTTT' }).id;
	caps = await ffmpegCaps();
});

interface Queued {
	id: string;
	src: string;
	ext: string;
}

/** Copies a file into .incoming/<token> and walks a row to 'processing' as intake + queue would. */
function enqueue(file: string, opts: { clientMtimeMs?: number | null } = {}): Queued {
	const token = randomBytes(16).toString('base64url');
	const src = paths.incomingPath(token);
	fs.copyFileSync(file, src);
	const ext = path.extname(file).slice(1);
	const id = media.insertReceived({
		uploadToken: token,
		albumId,
		sourceName: path.basename(file),
		sourceSize: fs.statSync(src).size,
		clientMtimeMs: opts.clientMtimeMs === undefined ? CLIENT_MTIME_MS : opts.clientMtimeMs,
		uploadedByName: 'Test',
		uploadedByDevice: 'deviceTTTTTTTTTTTTTTTT'
	});
	expect(media.markQueued(id, { kind: 'video', sourceMime: MIME[ext], sourceExt: ext, sourceSha256: randomBytes(32).toString('hex'), estCostS: 1 })).toEqual({ outcome: 'queued' });
	expect(media.claimForProcessing(id)?.status).toBe('processing');
	return { id, src, ext };
}

/** Log lines of the most recent context(); expectCommitted() requires no warnings or errors. */
let logs: string[] = [];

function context(over: Partial<Config> = {}, signal: AbortSignal = new AbortController().signal) {
	const progress: number[] = [];
	logs = [];
	const line = (level: string) => (m: string, extra?: Record<string, unknown>) => logs.push(`${level} ${m} ${JSON.stringify(extra ?? {})}`);
	const ctx: WorkerContext = {
		db: getDb(),
		config: { ...getConfig(), ...over },
		paths,
		lane: 'video',
		progress: (pct) => progress.push(pct),
		signal,
		log: { info: line('INFO'), warn: line('WARN'), error: line('ERROR') }
	};
	return { ctx, progress };
}

function ffprobe(file: string): FfprobeResult {
	return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' })) as FfprobeResult;
}

function durationOf(file: string): number {
	return Number(ffprobe(file).format.duration);
}

function exifRead(file: string): Record<string, unknown> {
	return (JSON.parse(execFileSync('exiftool', ['-j', '-G1', '-a', '-n', file], { encoding: 'utf8' })) as Record<string, unknown>[])[0];
}

function streamHash(file: string, spec: string): string {
	return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', `0:${spec}`, '-c', 'copy', '-f', 'streamhash', '-hash', 'md5', '-'], { encoding: 'utf8' }).trim().split('=')[1];
}

/** Top-level box types, read independently of the lane's walker. */
function topBoxes(file: string): string[] {
	const buf = fs.readFileSync(file);
	const types: string[] = [];
	for (let p = 0; p < buf.length; ) {
		let size = buf.readUInt32BE(p);
		if (size === 1) size = Number(buf.readBigUInt64BE(p + 8));
		if (size === 0) size = buf.length - p;
		types.push(buf.toString('latin1', p + 4, p + 8));
		expect(size).toBeGreaterThanOrEqual(8);
		p += size;
		expect(p).toBeLessThanOrEqual(buf.length);
	}
	return types;
}

function fixture(id: FixtureId, skip: (note?: string) => never): string {
	const fx = FIXTURES[id];
	const missing = missingEncoders(fx);
	if (missing.length > 0) skip(`${id}: local ffmpeg lacks ${missing.join(', ')}`);
	return makeFixture(fx, fixtureDir);
}

interface Expectation {
	conversion: 'remux' | 'transcode';
	width: number;
	height: number;
	durationS: number;
	audio: boolean;
	kept: boolean;
	fps?: number;
	hdr?: boolean;
	slowmo?: boolean;
	audioDropped?: boolean;
}

/** Every "Verify and commit" rule, plus the row, cache files and source handling. */
async function expectCommitted(q: Queued, e: Expectation): Promise<{ row: media.MediaRow; out: string; raw: FfprobeResult }> {
	expect(logs.filter((l) => !l.startsWith('INFO'))).toEqual([]);
	const row = media.getById(q.id)!;
	const out = paths.libraryPath(q.id, 'mp4');
	expect(row).toMatchObject({
		status: 'ready',
		kind: 'video',
		conversion: e.conversion,
		canonical_ext: 'mp4',
		canonical_size: fs.statSync(out).size,
		width: e.width,
		height: e.height,
		hdr_tonemapped: e.hdr ? 1 : 0,
		audio_dropped: e.audioDropped ? 1 : 0,
		slowmo_retimed: e.slowmo ? 1 : 0,
		source_kept: e.kept ? 1 : 0,
		source_ext: q.ext,
		pipeline_version: PIPELINE_VERSION,
		upload_token: null,
		error_code: null
	});
	const tol = Math.max(0.1, 0.02 * e.durationS);
	expect(Math.abs(row.duration_ms! / 1000 - e.durationS)).toBeLessThanOrEqual(tol);
	expect(row.taken_ms).toEqual(expect.any(Number));

	// Work and tmp dirs are gone; poster and thumb exist at the right sizes.
	expect(fs.existsSync(paths.workDir(q.id))).toBe(false);
	expect(fs.existsSync(paths.tmpDir(q.id))).toBe(false);
	const poster = await sharp(paths.cacheFile(q.id, 'poster')).metadata();
	const thumb = await sharp(paths.cacheFile(q.id, 'thumb')).metadata();
	expect(poster).toMatchObject({ format: 'webp', width: e.width, height: e.height });
	expect(thumb.format).toBe('webp');
	expect(Math.max(thumb.width, thumb.height)).toBe(Math.min(480, Math.max(e.width, e.height)));

	// ffprobe: one h264 4:2:0 track, level ≤ 4.2; at most one AAC-LC ≤ 2 ch at 44.1/48 kHz; nothing else.
	const raw = ffprobe(out);
	const videos = raw.streams.filter((s) => s.codec_type === 'video');
	const audios = raw.streams.filter((s) => s.codec_type === 'audio');
	expect(raw.streams).toHaveLength(1 + (e.audio ? 1 : 0));
	expect(videos).toHaveLength(1);
	const v = videos[0];
	expect(v.codec_name).toBe('h264');
	expect(e.conversion === 'remux' ? ['yuv420p', 'yuvj420p'] : ['yuv420p']).toContain(v.pix_fmt);
	expect(v.level).toBeLessThanOrEqual(42);
	if (e.audio) {
		expect(audios[0]).toMatchObject({ codec_name: 'aac', profile: 'LC' });
		expect(audios[0].channels).toBeLessThanOrEqual(2);
		expect(['44100', '48000']).toContain(audios[0].sample_rate);
	}
	if (e.conversion === 'transcode') {
		expect(v).toMatchObject({ width: e.width, height: e.height, color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709' });
		expect(v.sample_aspect_ratio ?? '1:1').toBe('1:1');
		const sd = (v.side_data_list ?? []).map((d) => d.side_data_type);
		for (const t of ['Display Matrix', 'Mastering display metadata', 'Content light level metadata', 'DOVI configuration record']) expect(sd).not.toContain(t);
	}
	expect(Math.abs(Number(raw.format.duration) - e.durationS)).toBeLessThanOrEqual(tol);
	if (e.fps !== undefined) expect(parseRate(v.avg_frame_rate)).toBeCloseTo(e.fps, 0);

	// moov before mdat, also after the exiftool step.
	const boxes = topBoxes(out);
	expect(boxes[0]).toBe('ftyp');
	expect(boxes.indexOf('moov')).toBeGreaterThan(-1);
	expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));

	// Source: archived (lossy step + KEEP_ORIGINALS) or deleted.
	expect(fs.existsSync(q.src)).toBe(false);
	expect(fs.existsSync(paths.originalsPath(q.id, q.ext))).toBe(e.kept);
	return { row, out, raw };
}

async function expectFailure(q: Queued, code: string, detail: RegExp, ctx = context().ctx): Promise<void> {
	try {
		await processVideo(q.id, ctx);
		expect.unreachable('processVideo should have failed');
	} catch (err) {
		expect(MediaError.is(err), String(err)).toBe(true);
		expect((err as MediaError).code).toBe(code);
		expect((err as MediaError).detail).toMatch(detail);
	}
	// Failures are reported, not written: the main process decides. The source stays for the admin.
	expect(media.getById(q.id)?.status).toBe('processing');
	expect(fs.existsSync(q.src)).toBe(true);
	expect(fs.existsSync(paths.libraryPath(q.id, 'mp4'))).toBe(false);
	expect(fs.existsSync(paths.workDir(q.id))).toBe(false);
	expect(fs.existsSync(paths.tmpDir(q.id))).toBe(false);
}

/** Average luma of the decoded frames (8-bit code values). */
function lumaAverage(file: string): number {
	const outText = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8' });
	const values = [...outText.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
	expect(values.length).toBeGreaterThan(0);
	return values.reduce((a, b) => a + b, 0) / values.length;
}

/** HDR sources need zscale: without it the item must fail as unsupported, never with wrong colours. */
async function hdrOrUnsupported(q: Queued): Promise<boolean> {
	if (caps.zscale && caps.tonemap) return true;
	await expectFailure(q, 'unsupported', /zscale|tonemap/);
	return false;
}

describe('video lane capabilities', () => {
	it('detects the ffmpeg features the lane relies on', ({ skip }) => {
		expect(caps.libx264).toBe(true);
		expect(caps.aac).toBe(true);
		expect(caps.sidedataTypes.has('MASTERING_DISPLAY_METADATA')).toBe(true);
		expect(caps.decoders.video.has('hevc')).toBe(true);
		const major = Number(/version n?(\d+)/.exec(caps.version)?.[1]);
		if (!(major >= 7)) skip(`${caps.version}: AMBIENT_VIEWING_ENVIRONMENT deletion needs ffmpeg 7.1 (CI checks it)`);
		expect(caps.sidedataTypes.has('AMBIENT_VIEWING_ENVIRONMENT')).toBe(true);
	});
});

describe('video lane: fixtures', () => {
	it('F1 4K60 HLG portrait: tone-mapped 1080×1920, AAC picked over 4-channel PCM, Apple date/place/id, Live Photo pairing', async ({ skip }) => {
		const q = enqueue(fixture('F1', skip));
		if (!(await hdrOrUnsupported(q))) return;
		// A ready photo with the same ContentIdentifier: the ≤ 4.5 s video becomes its Live Photo motion.
		const photo = enqueuePhoto(APPLE.contentId);
		await processVideo(q.id, context().ctx);
		const { row, out, raw } = await expectCommitted(q, { conversion: 'transcode', width: 1080, height: 1920, durationS: 1, fps: 60, audio: true, kept: true, hdr: true });
		expect(raw.streams[0].level).toBe(42);
		expect(raw.streams[1].channels).toBe(2);
		expect(row).toMatchObject({ taken_at: '2024-07-04T11:22:31-07:00', taken_ms: APPLE_TAKEN_MS, gps_lat: 37.3349, gps_lon: -122.009, gps_alt: 10, content_id: APPLE.contentId, live_photo_of: photo });
		const exif = exifRead(out);
		expect(exif['Keys:CreationDate']).toBe('2024:07:04 11:22:31-07:00');
		expect(String(exif['Keys:GPSCoordinates'])).toMatch(/^37\.3349 -122\.009 10/);
		expect(String(exif['UserData:GPSCoordinates'])).toMatch(/^37\.3349 -122\.009/);
		// ffmpeg wrote only creation_time (mvhd); the slow-mo key, timecode and other tags are gone.
		expect(raw.format.tags?.creation_time).toBe('2024-07-04T18:22:31.000000Z');
		expect(raw.format.tags?.timecode).toBeUndefined();
	});

	it('F2 PQ HDR10: tone-mapped with the MaxCLL peak, no mastering/light-level data in the SDR output', async ({ skip }) => {
		const q = enqueue(fixture('F2', skip));
		if (!(await hdrOrUnsupported(q))) return;
		await processVideo(q.id, context().ctx);
		const { row } = await expectCommitted(q, { conversion: 'transcode', width: 1280, height: 720, durationS: 1, fps: 30, audio: true, kept: true, hdr: true });
		// No date in the file: the client's lastModified, no local time.
		expect(row).toMatchObject({ taken_ms: CLIENT_MTIME_MS, taken_at: null, gps_lat: null });
	});

	it('F2w wide-gamut SDR: converted BT.2020 → BT.709 without tone mapping', async ({ skip }) => {
		const q = enqueue(fixture('F2w', skip));
		if (!caps.zscale) return expectFailure(q, 'unsupported', /zscale/);
		await processVideo(q.id, context().ctx);
		await expectCommitted(q, { conversion: 'transcode', width: 640, height: 360, durationS: 1, fps: 30, audio: true, kept: true });
		expect(logs.join('\n')).toMatch(/"colour":"wcg"/);
	});

	it('F3 H.264 remux: video and audio streams copied bit for bit, source deleted', async ({ skip }) => {
		const file = fixture('F3', skip);
		const before = [streamHash(file, 'v:0'), streamHash(file, 'a:0')];
		const q = enqueue(file);
		const { ctx, progress } = context();
		await processVideo(q.id, ctx);
		const { out } = await expectCommitted(q, { conversion: 'remux', width: 640, height: 360, durationS: 2, fps: 30, audio: true, kept: false });
		expect([streamHash(out, 'v:0'), streamHash(out, 'a:0')]).toEqual(before);
		expect(progress[0]).toBe(0);
		const exif = exifRead(out);
		expect(exif['Keys:CreationDate']).toBe('2024:07:04 11:22:31-07:00');
		expect(String(exif['UserData:GPSCoordinates'])).toMatch(/^37\.3349 -122\.009/);
	});

	it('F3r portrait H.264 remux: the rotation matrix is kept, sizes are as displayed', async ({ skip }) => {
		const q = enqueue(fixture('F3r', skip));
		await processVideo(q.id, context().ctx);
		const { raw } = await expectCommitted(q, { conversion: 'remux', width: 360, height: 640, durationS: 1, audio: true, kept: false });
		expect(raw.streams[0]).toMatchObject({ width: 640, height: 360 });
		expect(raw.streams[0].side_data_list?.find((d) => d.side_data_type === 'Display Matrix')?.rotation).toBe(-90);
	});

	it('F4 PCM sound: remux with the sound re-encoded to AAC, source archived', async ({ skip }) => {
		const file = fixture('F4', skip);
		const q = enqueue(file);
		await processVideo(q.id, context().ctx);
		const { out } = await expectCommitted(q, { conversion: 'remux', width: 640, height: 360, durationS: 1, audio: true, kept: true });
		expect(streamHash(out, 'v:0')).toBe(streamHash(file, 'v:0'));

		// Admin "Redo them": runs again from the archived original, which stays archived, while the
		// item stays ready (media.claimRedo).
		expect(media.markForReprocess(q.id)).toBe(true);
		expect(media.claimRedo(q.id)).toMatchObject({ status: 'ready', redo_state: 'running' });
		await processVideo(q.id, context().ctx);
		expect(media.getById(q.id)).toMatchObject({ status: 'ready', redo_state: null });
		await expectCommitted({ ...q, src: path.join(fixtureDir, 'gone') }, { conversion: 'remux', width: 640, height: 360, durationS: 1, audio: true, kept: true });
	});

	it('F5 4K30 H.264: transcoded down to 1920×1080 at level 4.0', async ({ skip }) => {
		const q = enqueue(fixture('F5', skip));
		await processVideo(q.id, context().ctx);
		const { raw } = await expectCommitted(q, { conversion: 'transcode', width: 1920, height: 1080, durationS: 1, fps: 30, audio: true, kept: true });
		expect(raw.streams[0].level).toBe(40);
	});

	it('F6 240 fps without the slow-motion intent: normal speed at 60 fps', async ({ skip }) => {
		const q = enqueue(fixture('F6', skip));
		await processVideo(q.id, context().ctx);
		const { row } = await expectCommitted(q, { conversion: 'transcode', width: 640, height: 360, durationS: 1, fps: 60, audio: true, kept: true });
		expect(row.slowmo_retimed).toBe(0);
	});

	it('F7 variable frame rate: frame timing passed through', async ({ skip }) => {
		const file = fixture('F7', skip);
		const q = enqueue(file);
		await processVideo(q.id, context().ctx);
		const { out } = await expectCommitted(q, { conversion: 'transcode', width: 640, height: 360, durationS: 3, audio: true, kept: true });
		const frames = (f: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());
		expect(frames(out)).toBe(frames(file));
	});

	it('F8 no sound: remux without an audio track; a UTC creation_time is an instant, not a local time', async ({ skip }) => {
		const q = enqueue(fixture('F8', skip));
		await processVideo(q.id, context().ctx);
		const { row, out, raw } = await expectCommitted(q, { conversion: 'remux', width: 640, height: 360, durationS: 1, audio: false, kept: false });
		expect(row).toMatchObject({ taken_at: null, taken_ms: Date.parse(UTC_ONLY_CREATION_TIME) });
		expect(raw.format.tags?.creation_time).toBe(UTC_ONLY_CREATION_TIME);
		// No local time and no place: nothing for the exiftool step to write.
		expect(exifRead(out)['Keys:CreationDate']).toBeUndefined();
	});

	it('F9 NTSC DV: deinterlaced, square pixels, 29.97 fps despite the bogus average rate', async ({ skip }) => {
		const file = fixture('F9', skip);
		const q = enqueue(file);
		await processVideo(q.id, context().ctx);
		await expectCommitted(q, { conversion: 'transcode', width: 640, height: 480, durationS: durationOf(file), fps: 29.97, audio: true, kept: true });
		expect(logs.join('\n')).toMatch(/"interlaced":true/);
	});

	it('F9b Dolby Vision profile 5: unsupported, source kept', async ({ skip }) => {
		const q = enqueue(fixture('F9b', skip));
		await expectFailure(q, 'unsupported', /Dolby Vision profile 5/);
	});

	it('F9c Dolby Vision 8.4: tone-mapped through its HLG base layer, plain SDR out', async ({ skip }) => {
		const file = fixture('F9c', skip);
		const dovi = ffprobe(file).streams[0].side_data_list?.find((d) => d.side_data_type === 'DOVI configuration record');
		expect(dovi).toMatchObject({ dv_profile: 8, dv_bl_signal_compatibility_id: 4 });
		const q = enqueue(file);
		if (!(await hdrOrUnsupported(q))) return;
		await processVideo(q.id, context().ctx);
		// expectCommitted also checks that no DOVI configuration record is left.
		await expectCommitted(q, { conversion: 'transcode', width: 640, height: 360, durationS: 1, fps: 30, audio: true, kept: true, hdr: true });
		expect(logs.join('\n')).toMatch(/"colour":"hdr"/);
	});

	it('F10 MJPEG in AVI (full range)', async ({ skip }) => {
		const q = enqueue(fixture('F10', skip));
		await processVideo(q.id, context().ctx);
		await expectCommitted(q, { conversion: 'transcode', width: 640, height: 480, durationS: 1, fps: 25, audio: true, kept: true });
	});

	it('F11 WMV', async ({ skip }) => {
		const file = fixture('F11', skip);
		const q = enqueue(file);
		await processVideo(q.id, context().ctx);
		await expectCommitted(q, { conversion: 'transcode', width: 320, height: 240, durationS: durationOf(file), audio: true, kept: true });
	});

	it('F12a VP9 + Opus in WebM', async ({ skip }) => {
		const file = fixture('F12a', skip);
		const q = enqueue(file);
		await processVideo(q.id, context().ctx);
		await expectCommitted(q, { conversion: 'transcode', width: 320, height: 240, durationS: durationOf(file), fps: 30, audio: true, kept: true });
	});

	it('F12b AV1', async ({ skip }) => {
		const q = enqueue(fixture('F12b', skip));
		await processVideo(q.id, context().ctx);
		await expectCommitted(q, { conversion: 'transcode', width: 320, height: 240, durationS: 1, fps: 30, audio: true, kept: true });
	});

	it('F14 MPEG-2 1080i with AC-3 5.1: deinterlaced, stereo AAC', async ({ skip }) => {
		const file = fixture('F14', skip);
		const q = enqueue(file);
		await processVideo(q.id, context().ctx);
		const { raw } = await expectCommitted(q, { conversion: 'transcode', width: 1920, height: 1080, durationS: durationOf(file), fps: 25, audio: true, kept: true });
		expect(raw.streams[0].field_order ?? 'progressive').toBe('progressive');
		expect(raw.streams[1].channels).toBe(2);
	});

	it('F15 ProRes HLG', async ({ skip }) => {
		const q = enqueue(fixture('F15', skip));
		if (!(await hdrOrUnsupported(q))) return;
		await processVideo(q.id, context().ctx);
		await expectCommitted(q, { conversion: 'transcode', width: 1280, height: 720, durationS: 1, fps: 25, audio: true, kept: true, hdr: true });
	});

	it('F16 SAR 4:3: shown 960×480 with square pixels', async ({ skip }) => {
		const q = enqueue(fixture('F16', skip));
		await processVideo(q.id, context().ctx);
		await expectCommitted(q, { conversion: 'transcode', width: 960, height: 480, durationS: 1, audio: true, kept: true });
	});

	it('F17 odd dimensions: rounded to even 322×242', async ({ skip }) => {
		const file = fixture('F17', skip);
		const q = enqueue(file);
		await processVideo(q.id, context().ctx);
		await expectCommitted(q, { conversion: 'transcode', width: 322, height: 242, durationS: durationOf(file), audio: true, kept: true });
	});

	it('F17t truncated recording (moov lost): corrupt, source kept, no retry loop', async ({ skip }) => {
		const q = enqueue(fixture('F17t', skip));
		await expectFailure(q, 'corrupt', /moov atom not found|Invalid data/);
	});

	it('F17f truncated fast-start file (media data cut): corrupt', async ({ skip }) => {
		const q = enqueue(fixture('F17f', skip));
		await expectFailure(q, 'corrupt', /./);
	});

	it('F18 240 fps slow motion (playback intent 0): retimed to 30 fps, about 16 s, with progress', async ({ skip }) => {
		const q = enqueue(fixture('F18', skip));
		const { ctx, progress } = context();
		await processVideo(q.id, ctx);
		const { raw } = await expectCommitted(q, { conversion: 'transcode', width: 640, height: 360, durationS: 16, fps: 30, audio: true, kept: true, slowmo: true });
		expect(Math.abs(Number(raw.streams[1].duration) - 16)).toBeLessThan(0.5);
		expect(Math.max(...progress)).toBeGreaterThan(0);
		expect(Math.max(...progress)).toBeLessThanOrEqual(99);
	});

	it('F19 tone-map regression: 75% HLG grey lands at luma 205–228, and the poster matches', async ({ skip }) => {
		const q = enqueue(fixture('F19', skip), { clientMtimeMs: null });
		if (!(await hdrOrUnsupported(q))) return;
		await processVideo(q.id, context().ctx);
		const { row, out } = await expectCommitted(q, { conversion: 'transcode', width: 320, height: 240, durationS: 1, audio: false, kept: true, hdr: true });
		const y = lumaAverage(out);
		expect(y).toBeGreaterThanOrEqual(205);
		expect(y).toBeLessThanOrEqual(228);
		// The poster went through the same chain: limited-range Y → full-range RGB grey.
		const { channels } = await sharp(paths.cacheFile(q.id, 'poster')).stats();
		const expected = ((y - 16) * 255) / 219;
		for (const c of channels.slice(0, 3)) expect(Math.abs(c.mean - expected)).toBeLessThan(4);
		// No date anywhere: upload time.
		expect(row.taken_ms).toBe(row.created_at);
	});
});

describe('video lane: guards and failure handling', () => {
	it('MAX_VIDEO_MINUTES: too long → too_large before any work', async ({ skip }) => {
		const q = enqueue(fixture('F3', skip));
		await expectFailure(q, 'too_large', /limit is/, context({ maxVideoSeconds: 1 }).ctx);
		expect(fs.existsSync(paths.cacheFile(q.id, 'poster'))).toBe(false);
	});

	it('KEEP_ORIGINALS=false deletes the source after a transcode', async ({ skip }) => {
		const q = enqueue(fixture('F16', skip));
		await processVideo(q.id, context({ keepOriginals: false }).ctx);
		await expectCommitted(q, { conversion: 'transcode', width: 960, height: 480, durationS: 1, audio: true, kept: false });
	});

	it('a row that stops being processing mid-job is not committed and leaves nothing in library/', async ({ skip }) => {
		const q = enqueue(fixture('F8', skip));
		const { ctx } = context();
		// 99 % is the heartbeat after the conversion; the main process requeues the row meanwhile.
		ctx.progress = (pct) => {
			if (pct === 99) media.requeue(q.id, 'test');
		};
		await expect(processVideo(q.id, ctx)).rejects.toMatchObject({ code: 'retryable', detail: expect.stringMatching(/no longer processing/) });
		expect(media.getById(q.id)?.status).toBe('queued');
		expect(fs.existsSync(paths.libraryPath(q.id, 'mp4'))).toBe(false);
		expect(fs.existsSync(paths.workDir(q.id))).toBe(false);
		expect(fs.existsSync(q.src)).toBe(true);
	});

	it('a missing upload fails as corrupt', async ({ skip }) => {
		const q = enqueue(fixture('F8', skip));
		fs.rmSync(q.src);
		await expect(processVideo(q.id, context().ctx)).rejects.toMatchObject({ name: 'MediaError', code: 'corrupt' });
	});

	it('cancel (ctx.signal) kills ffmpeg, cleans up and reports a retryable failure', async ({ skip }) => {
		const q = enqueue(fixture('F18', skip));
		const abort = new AbortController();
		const { ctx } = context({}, abort.signal);
		ctx.progress = (pct) => {
			if (pct > 0) abort.abort(new Error('cancelled'));
		};
		await expectFailure(q, 'retryable', /aborted/, ctx);
	});
});

/** A ready photo row with a ContentIdentifier (the photo half of a Live Photo). */
function enqueuePhoto(contentId: string): string {
	const id = media.insertReceived({
		uploadToken: randomBytes(16).toString('base64url'),
		albumId,
		sourceName: 'IMG_0001.HEIC',
		sourceSize: 1,
		clientMtimeMs: null,
		uploadedByName: 'Test',
		uploadedByDevice: 'deviceTTTTTTTTTTTTTTTT'
	});
	media.markQueued(id, { kind: 'photo', sourceMime: 'image/heic', sourceExt: 'heic', sourceSha256: randomBytes(32).toString('hex'), estCostS: null });
	media.claimForProcessing(id);
	media.markReady(id, { conversion: 'transcode', canonicalExt: 'jpg', canonicalSize: 1, width: 1, height: 1, takenMs: APPLE_TAKEN_MS, contentId, sourceKept: true });
	return id;
}
