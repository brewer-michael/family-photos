import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ffprobeJson, type FfprobeResult } from '#lib/server/media/probe';
import { MediaError } from '#lib/shared/errors';
import { setEnv, testEnv } from '../helpers/env';
import {
	creationTimeFor,
	exifDate,
	exiftoolArgs,
	exiftoolTimeoutMs,
	gpsCoordinates,
	parseIso6709,
	parseLocalDate,
	resolveTaken,
	writeVideoMetadata,
	type Taken
} from '../../src/worker/video/metadata';
import { faststartProblem, topLevelBoxes } from '../../src/worker/video/mp4';
import { ProgressParser, hardCapMs, runConversion, toMediaError } from '../../src/worker/video/progress';
import { checkOutput } from '../../src/worker/video/verify';
import { RunError } from '../../src/worker/spawn';

describe('video metadata', () => {
	it('parses ISO 6709 in degrees, degrees-minutes and degrees-minutes-seconds', () => {
		expect(parseIso6709('+37.3349-122.0090+010.000/')).toEqual({ lat: 37.3349, lon: -122.009, alt: 10 });
		expect(parseIso6709('+48.8584+002.2945/')).toEqual({ lat: 48.8584, lon: 2.2945, alt: null });
		const dm = parseIso6709('+3720.094-12200.540/')!;
		expect(dm.lat).toBeCloseTo(37 + 20.094 / 60, 6);
		expect(dm.lon).toBeCloseTo(-(122 + 0.54 / 60), 6);
		const dms = parseIso6709('-334530.5+1510830.2/')!;
		expect(dms.lat).toBeCloseTo(-(33 + 45 / 60 + 30.5 / 3600), 6);
		expect(dms.lon).toBeCloseTo(151 + 8 / 60 + 30.2 / 3600, 6);
		expect(parseIso6709('+00.0000+000.0000/')).toBeNull();
		expect(parseIso6709('+95.0000+010.0000/')).toBeNull();
		expect(parseIso6709('somewhere')).toBeNull();
		expect(parseIso6709(null)).toBeNull();
	});

	it('parses Apple local dates with offsets', () => {
		expect(parseLocalDate('2024-07-04T11:22:31-0700')).toEqual({ local: '2024-07-04T11:22:31', utcMs: Date.UTC(2024, 6, 4, 18, 22, 31), offsetMin: -420 });
		expect(parseLocalDate('2024-07-04T11:22:31+05:30')?.offsetMin).toBe(330);
		expect(parseLocalDate('2024-07-04T18:22:31.000000Z')).toMatchObject({ offsetMin: 0, utcMs: Date.UTC(2024, 6, 4, 18, 22, 31) });
		expect(parseLocalDate('2024-07-04 11:22:31')?.offsetMin).toBeNull();
		expect(parseLocalDate('1904-01-01T00:00:00Z')).toBeNull();
		expect(parseLocalDate('1999-12-31T23:59:59Z')).toBeNull();
		expect(parseLocalDate('2024-13-04T11:22:31Z')).toBeNull();
		expect(parseLocalDate('garbage')).toBeNull();
	});

	it('date fallback: Apple creationdate → creation_time → client mtime → upload time', () => {
		const base = { creationDate: null, creationTime: null, clientMtimeMs: null, uploadedMs: Date.UTC(2025, 0, 2) };
		expect(resolveTaken({ ...base, creationDate: '2024-07-04T11:22:31-0700', creationTime: '2024-07-04T18:22:35.000000Z' })).toEqual({
			takenAt: '2024-07-04T11:22:31-07:00',
			takenMs: Date.UTC(2024, 6, 4, 18, 22, 31),
			offset: '-07:00'
		});
		// Apple date without an offset: local wall time, instant from creation_time.
		expect(resolveTaken({ ...base, creationDate: '2024-07-04T11:22:31', creationTime: '2024-07-04T18:22:31.000000Z' })).toEqual({
			takenAt: '2024-07-04T11:22:31',
			takenMs: Date.UTC(2024, 6, 4, 18, 22, 31),
			offset: null
		});
		// Apple date without an offset and no creation_time: the wall time in the server's zone.
		const prevTz = process.env.TZ;
		process.env.TZ = 'America/Chicago';
		try {
			expect(resolveTaken({ ...base, creationDate: '2024-07-04T18:00:00' })).toEqual({
				takenAt: '2024-07-04T18:00:00',
				takenMs: Date.UTC(2024, 6, 4, 23, 0, 0),
				offset: null
			});
		} finally {
			if (prevTz === undefined) delete process.env.TZ;
			else process.env.TZ = prevTz;
		}
		// creation_time alone is an instant, not a local time: taken_at stays null (readers use taken_ms
		// in the server's zone), so an evening clip west of UTC isn't shown on the next day.
		expect(resolveTaken({ ...base, creationTime: '2024-07-05T03:30:00.000000Z' })).toEqual({
			takenAt: null,
			takenMs: Date.UTC(2024, 6, 5, 3, 30),
			offset: null
		});
		// Unset camera clocks (1904/1970) fall through.
		expect(resolveTaken({ ...base, creationTime: '1970-01-01T00:00:00.000000Z', clientMtimeMs: Date.UTC(2023, 4, 5) })).toEqual({
			takenAt: null,
			takenMs: Date.UTC(2023, 4, 5),
			offset: null
		});
		expect(resolveTaken({ ...base, clientMtimeMs: 1000 })).toEqual({ takenAt: null, takenMs: base.uploadedMs, offset: null });
	});

	it('formats values for ffmpeg and exiftool', () => {
		expect(creationTimeFor(Date.UTC(2024, 6, 4, 18, 22, 31))).toBe('2024-07-04T18:22:31.000Z');
		expect(creationTimeFor(Date.UTC(1999, 0, 1))).toBeNull();
		expect(exifDate('2024-07-04T11:22:31-07:00')).toBe('2024:07:04 11:22:31-07:00');
		expect(gpsCoordinates({ lat: 37.3349, lon: -122.009, alt: 10 })).toBe('37.3349, -122.009, 10');
		expect(gpsCoordinates({ lat: 1 / 3, lon: 2, alt: null })).toBe('0.333333, 2');
	});
});

/** An executable shell script in the test's temp dir (a stand-in for ffmpeg/ffprobe/exiftool). */
function fakeTool(name: string, body: string): string {
	const f = path.join(testEnv().root, name);
	fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return f;
}

describe('exiftool step', () => {
	const taken: Taken = { takenAt: '2024-07-04T11:22:31-07:00', takenMs: Date.UTC(2024, 6, 4, 18, 22, 31), offset: '-07:00' };
	const gps = { lat: 37.3349, lon: -122.009, alt: 10 };
	const signal = new AbortController().signal;
	const saved = process.env.EXIFTOOL_PATH;
	afterEach(() => {
		if (saved === undefined) delete process.env.EXIFTOOL_PATH;
		else process.env.EXIFTOOL_PATH = saved;
	});
	const mp4 = () => {
		const f = path.join(testEnv().root, 'meta.mp4');
		fs.writeFileSync(f, Buffer.alloc(1024));
		return f;
	};

	it('allows 60 s plus 1 s per 10 MB, and enables large files', () => {
		expect(exiftoolTimeoutMs(0)).toBe(60_000);
		expect(exiftoolTimeoutMs(4_300_000_000)).toBe(490_000);
		expect(exiftoolArgs('/w/x.mp4', { 'Keys:CreationDate': '2024:07:04 11:22:31-07:00' })).toEqual([
			'-overwrite_original', '-api', 'QuickTimeUTC=1', '-api', 'LargeFileSupport=1', '-Keys:CreationDate=2024:07:04 11:22:31-07:00', '/w/x.mp4'
		]);
	});

	it('runs its own exiftool with the date and both GPS tags', async () => {
		const log = path.join(testEnv().root, 'exiftool-args.txt');
		process.env.EXIFTOOL_PATH = fakeTool('exiftool-ok', `printf '%s\\n' "$@" > '${log}'\necho '    1 image files updated'`);
		const file = mp4();
		await writeVideoMetadata(file, taken, gps, signal);
		expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([
			...exiftoolArgs(file, { 'Keys:CreationDate': '2024:07:04 11:22:31-07:00', 'Keys:GPSCoordinates': '37.3349, -122.009, 10', 'UserData:GPSCoordinates': '37.3349, -122.009, 10' })
		]);
	});

	it('skips exiftool when there is nothing to write', async () => {
		process.env.EXIFTOOL_PATH = path.join(testEnv().root, 'no-such-exiftool');
		await expect(writeVideoMetadata(mp4(), { takenAt: null, takenMs: 1, offset: null }, null, signal)).resolves.toBeUndefined();
	});

	it('maps exiftool failures to retryable', async () => {
		process.env.EXIFTOOL_PATH = fakeTool('exiftool-err', `echo 'Error: End of processing at large atom (LargeFileSupport not enabled)' >&2\nexit 1`);
		await expect(writeVideoMetadata(mp4(), taken, null, signal)).rejects.toMatchObject({ code: 'retryable', detail: expect.stringMatching(/LargeFileSupport/) });
		process.env.EXIFTOOL_PATH = fakeTool('exiftool-noop', `echo '    0 image files updated'`);
		await expect(writeVideoMetadata(mp4(), taken, null, signal)).rejects.toMatchObject({ code: 'retryable', detail: expect.stringMatching(/did not update/) });
	});
});

describe('ffmpeg progress', () => {
	it('reports pct (≤ 99) and an ETA from speed at the end of each block', () => {
		const p = new ProgressParser(10, 0);
		expect(p.line('frame=10', 1000)).toBeNull();
		expect(p.line('out_time_us=N/A', 1000)).toBeNull();
		expect(p.lastAdvanceMs).toBe(0);
		p.line('out_time_us=2500000', 2000);
		p.line('speed=2.5x', 2000);
		expect(p.line('progress=continue', 2000)).toEqual({ pct: 25, etaS: 3 });
		expect(p.lastAdvanceMs).toBe(2000);
		p.line('out_time_us=2500000', 9000);
		expect(p.lastAdvanceMs).toBe(2000); // not advancing: the stall clock keeps running
		p.line('out_time_ms=10400000', 9500);
		p.line('speed=N/A', 9500);
		expect(p.line('progress=end', 9500)).toEqual({ pct: 99 });
	});

	it('hard cap is 120 s + 30 × duration', () => {
		expect(hardCapMs(10)).toBe(420_000);
	});

	it('maps runner failures to media errors', () => {
		const exit = (stderr: string) => new RunError('exit', 'ffmpeg', 1, stderr, 'ffmpeg failed');
		expect(toMediaError(exit('[mov] moov atom not found\nError opening input: Invalid data found when processing input'), 'ffmpeg')).toMatchObject({ name: 'MediaError', code: 'corrupt' });
		expect(toMediaError(exit('[hevc] Could not find ref with POC 3\nDecode error rate 0.9 exceeds maximum 0.666667'), 'ffmpeg')).toMatchObject({ code: 'corrupt' });
		expect(toMediaError(exit('Option not found'), 'ffmpeg')).toMatchObject({ code: 'retryable' });
		// A few bad frames are normal in camera files; they don't make a failed run 'corrupt'.
		const glitch = '[h264] error while decoding MB 12 7, bytestream -5\n[h264] concealing 300 DC, 300 AC errors\nError while decoding stream #0:0: Invalid data found when processing input';
		expect(toMediaError(exit(`${glitch}\nConversion failed!`), 'ffmpeg')).toMatchObject({ code: 'retryable' });
		// System trouble wins over input errors seen on the way.
		expect(toMediaError(exit(`${glitch}\nDecode error rate 0.7 exceeds maximum 0.666667\nav_interleaved_write_frame(): No space left on device`), 'ffmpeg')).toMatchObject({ code: 'retryable' });
		expect(toMediaError(exit('Error opening input: Input/output error'), 'ffmpeg')).toMatchObject({ code: 'retryable' });
		const stall = new RunError('aborted', 'ffmpeg', null, '', 'ffmpeg aborted');
		const e = toMediaError(stall, 'ffmpeg', 180_000);
		expect(MediaError.is(e) && e.detail).toMatch(/stalled: no progress for 180 s/);
		expect(toMediaError(new RunError('timeout', 'ffmpeg', null, '', 'ffmpeg exceeded 420 s'), 'ffmpeg')).toMatchObject({ code: 'retryable' });
		const plain = new Error('x');
		expect(toMediaError(plain, 'ffmpeg')).toBe(plain);
	});
});

describe('runConversion', () => {
	const base = { expectedDurationS: 10, sourceDurationS: 10, signal: new AbortController().signal };

	it('reports progress from -progress blocks and resolves on exit 0', async () => {
		const ffmpeg = fakeTool('ffmpeg-ok', `printf 'out_time_us=2500000\\nspeed=2.5x\\nprogress=continue\\nout_time_us=10000000\\nprogress=end\\n'`);
		const seen: [number, number | undefined][] = [];
		await runConversion(ffmpeg, [], { ...base, progress: (pct, etaS) => seen.push([pct, etaS]) });
		expect(seen).toEqual([[25, 3], [99, 0]]);
	});

	it('kills ffmpeg when out_time stops advancing (stall) → retryable', async () => {
		const ffmpeg = fakeTool('ffmpeg-stall', `while :; do printf 'out_time_us=1000000\\nspeed=1x\\nprogress=continue\\n'; sleep 0.05; done`);
		const started = Date.now();
		await expect(runConversion(ffmpeg, [], { ...base, progress: () => undefined, stallMs: 400 })).rejects.toMatchObject({
			code: 'retryable',
			detail: expect.stringMatching(/ffmpeg stalled: no progress for 0.4 s/)
		});
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it('kills ffmpeg at the hard cap even while it advances → retryable', async () => {
		const ffmpeg = fakeTool('ffmpeg-slow', `i=0\nwhile :; do i=$((i+10000)); printf 'out_time_us=%d\\nprogress=continue\\n' $i; sleep 0.05; done`);
		await expect(runConversion(ffmpeg, [], { ...base, progress: () => undefined, timeoutMs: 400 })).rejects.toMatchObject({
			code: 'retryable',
			detail: expect.stringMatching(/exceeded/)
		});
	});

	it('maps an unreadable input to corrupt', async () => {
		const ffmpeg = fakeTool('ffmpeg-bad', `echo 'Error opening input: Invalid data found when processing input' >&2\nexit 1`);
		await expect(runConversion(ffmpeg, [], { ...base, progress: () => undefined })).rejects.toMatchObject({ code: 'corrupt' });
	});
});

describe('ffprobe errors', () => {
	afterEach(() => setEnv({ FFPROBE_BIN: undefined }));
	const file = () => {
		const f = path.join(testEnv().root, 'probe-me.mp4');
		fs.writeFileSync(f, 'x');
		return f;
	};

	it('a timeout or a missing ffprobe is retryable', async () => {
		setEnv({ FFPROBE_BIN: fakeTool('ffprobe-hang', 'exec sleep 10') });
		await expect(ffprobeJson(file(), { timeoutMs: 200 })).rejects.toMatchObject({ name: 'MediaError', code: 'retryable' });
		setEnv({ FFPROBE_BIN: path.join(testEnv().root, 'no-such-ffprobe') });
		await expect(ffprobeJson(file())).rejects.toMatchObject({ code: 'retryable', detail: expect.stringMatching(/ENOENT/) });
	});

	it('an unreadable file is corrupt', async () => {
		setEnv({ FFPROBE_BIN: fakeTool('ffprobe-bad', `echo 'probe-me.mp4: Invalid data found when processing input' >&2\nexit 1`) });
		await expect(ffprobeJson(file())).rejects.toMatchObject({ code: 'corrupt', detail: expect.stringMatching(/Invalid data/) });
	});
});

describe('output verification', () => {
	const good = (): FfprobeResult => ({
		streams: [
			{ index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', level: 40, color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709' },
			{ index: 1, codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2, sample_rate: '48000' }
		],
		format: { duration: '10.04' }
	});
	const exp = { mode: 'transcode' as const, audio: true, expectedDurationS: 10 };

	it('passes a compliant output', () => {
		expect(checkOutput(good(), exp)).toEqual([]);
	});

	it('flags every broken rule', () => {
		const raw = good();
		raw.streams[0] = { ...raw.streams[0], level: 51, pix_fmt: 'yuvj420p', color_transfer: 'arib-std-b67', side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }, { side_data_type: 'Mastering display metadata' }] };
		raw.streams[1] = { ...raw.streams[1], channels: 6, sample_rate: '32000' };
		raw.streams.push({ index: 2, codec_type: 'data', codec_tag_string: 'tmcd' });
		raw.format.duration = '9.5';
		const problems = checkOutput(raw, exp);
		expect(problems).toEqual([
			'unexpected data track(s)',
			'pixel format is yuvj420p',
			'H.264 level is 51 (max 42)',
			'colour transfer is arib-std-b67, not bt709',
			'unexpected Display Matrix',
			'unexpected Mastering display metadata',
			'audio has 6 channels',
			'audio sample rate is 32000',
			'duration is 9.500 s, expected 10.000 s ± 0.200'
		]);
	});

	it('remux keeps rotation and full range, but not extra audio', () => {
		const raw = good();
		raw.streams[0] = { ...raw.streams[0], pix_fmt: 'yuvj420p', color_primaries: undefined, side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] };
		expect(checkOutput(raw, { ...exp, mode: 'remux' })).toEqual([]);
		raw.streams.push({ index: 2, codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2, sample_rate: '48000' });
		expect(checkOutput(raw, { ...exp, mode: 'remux' })).toEqual(['expected at most one audio track, found 2']);
		expect(checkOutput(good(), { ...exp, audio: false })).toEqual(['unexpected audio track']);
	});

	it('duration tolerance is ±max(0.1 s, 2%)', () => {
		const raw = good();
		raw.format.duration = '0.95';
		expect(checkOutput({ ...raw, streams: raw.streams.slice(0, 1) }, { mode: 'transcode', audio: false, expectedDurationS: 1 })).toEqual([]);
		raw.format.duration = '16.3';
		expect(checkOutput(raw, { ...exp, expectedDurationS: 16 })).toEqual([]);
		raw.format.duration = '16.4';
		expect(checkOutput(raw, { ...exp, expectedDurationS: 16 })).toHaveLength(1);
	});
});

describe('MP4 top-level boxes', () => {
	const box = (type: string, payload = 0) => {
		const b = Buffer.alloc(8 + payload);
		b.writeUInt32BE(8 + payload, 0);
		b.write(type, 4, 'latin1');
		return b;
	};
	const write = (name: string, ...parts: Buffer[]) => {
		const f = path.join(testEnv().root, name);
		fs.writeFileSync(f, Buffer.concat(parts));
		return f;
	};

	it('walks boxes, including 64-bit sizes, and checks moov before mdat', async () => {
		const large = Buffer.alloc(16 + 4);
		large.writeUInt32BE(1, 0);
		large.write('mdat', 4, 'latin1');
		large.writeBigUInt64BE(20n, 8);
		const f = write('ok.mp4', box('ftyp', 8), box('moov', 32), box('free'), large);
		const boxes = await topLevelBoxes(f);
		expect(boxes.map((b) => b.type)).toEqual(['ftyp', 'moov', 'free', 'mdat']);
		expect(faststartProblem(boxes)).toBeNull();
	});

	it('rejects moov after mdat and truncated files', async () => {
		const late = await topLevelBoxes(write('late.mp4', box('ftyp', 8), box('mdat', 64), box('moov', 32)));
		expect(faststartProblem(late)).toBe('moov comes after mdat');
		expect(faststartProblem([{ type: 'mdat', offset: 0, size: 8 }])).toMatch(/starts with 'mdat'/);
		const cut = Buffer.concat([box('ftyp', 8), box('moov', 32), box('mdat', 64)]).subarray(0, 70);
		await expect(topLevelBoxes(write('cut.mp4', cut))).rejects.toThrow(/overruns/);
	});
});
