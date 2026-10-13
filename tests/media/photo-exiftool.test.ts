/**
 * exiftool failing to copy metadata into a canonical file (docs/media-pipeline.md §2 "Other
 * decoders"): a failure a retry won't fix keeps the photo without the copied tags (the row already
 * has the date and place), except a RAW preview that needs the RAW's Orientation, which fails as
 * corrupt; only a transient failure (timeout, exiftool gone, disk) is retryable. The same holds
 * for reading the source's metadata and extracting a RAW's preview: a transient failure is
 * retryable instead of committing the photo without its date, place and Live Photo id. The
 * exiftool steps are mocked to fail; everything else is the real lane.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getConfig } from '#lib/server/config';
import { getDb } from '#lib/server/db';
import { detectFile } from '#lib/server/media/detect';
import * as paths from '#lib/server/paths';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import { MediaError } from '#lib/shared/errors';
import { freshDb, testEnv } from '../helpers/env';
import { OTHER_EXIF, PHOTO_FIXTURES } from '../helpers/photo-fixtures';
import type { WorkerContext } from '../../src/worker/context';
import { endExiftool, exiftool } from '../../src/worker/exiftool';
import { processPhoto } from '../../src/worker/photo';
import { copyExif, copyRawTags, readSourceTags } from '../../src/worker/photo/metadata';

vi.mock('../../src/worker/photo/metadata', async (importOriginal) => {
	const real = await importOriginal<typeof import('../../src/worker/photo/metadata')>();
	return { ...real, copyExif: vi.fn(real.copyExif), copyRawTags: vi.fn(real.copyRawTags), readSourceTags: vi.fn(real.readSourceTags) };
});

/** What exiftool-vendored rejects with when exiftool refuses a file's tags. */
const REFUSED = new Error('Error: Bad format (0) for IFD0 entry 3 - /photos/.work/x/x.jpg');
/** batch-cluster's TaskTimeoutError. */
const TIMEOUT = Object.assign(new Error('timeout: waited 60000ms'), { name: 'TaskTimeoutError' });

let albumId: number;

beforeAll(() => {
	freshDb();
	paths.ensureDirs();
	albumId = albums.create({ title: 'exiftool tests', createdByName: 'Test', createdByDevice: 'deviceEEEEEEEEEEEEEEEE' }).id;
});

afterEach(() => {
	vi.mocked(copyExif).mockClear();
	vi.mocked(copyRawTags).mockClear();
	vi.mocked(readSourceTags).mockClear();
	vi.restoreAllMocks();
});

afterAll(async () => {
	await endExiftool();
});

async function enqueue(file: string): Promise<string> {
	const token = randomBytes(16).toString('base64url');
	fs.copyFileSync(file, paths.incomingPath(token));
	const det = await detectFile(file);
	const id = media.insertReceived({
		uploadToken: token,
		albumId,
		sourceName: path.basename(file),
		sourceSize: fs.statSync(file).size,
		clientMtimeMs: null,
		uploadedByName: 'Test',
		uploadedByDevice: 'deviceEEEEEEEEEEEEEEEE'
	});
	media.markQueued(id, { kind: 'photo', sourceMime: det.mime, sourceExt: det.ext, sourceSha256: randomBytes(32).toString('hex'), estCostS: null });
	media.claimForProcessing(id);
	return id;
}

let logs: string[] = [];

function context(): WorkerContext {
	logs = [];
	const line = (level: string) => (m: string, extra?: Record<string, unknown>) => logs.push(`${level} ${m} ${JSON.stringify(extra ?? {})}`);
	return {
		db: getDb(),
		config: getConfig(),
		paths,
		lane: 'photo',
		progress: () => undefined,
		signal: new AbortController().signal,
		log: { info: line('INFO'), warn: line('WARN'), error: line('ERROR') }
	};
}

async function failure(id: string): Promise<MediaError> {
	const err = await processPhoto(id, context()).then(
		() => null,
		(e: unknown) => e
	);
	expect(MediaError.is(err), String(err)).toBe(true);
	expect(media.getById(id)?.status).toBe('processing');
	return err as MediaError;
}

function exif(file: string): Record<string, unknown> {
	return (JSON.parse(execFileSync('exiftool', ['-j', '-n', '-G1', file], { encoding: 'utf8' })) as Record<string, unknown>[])[0];
}

const warnings = () => logs.filter((l) => !l.startsWith('INFO'));

describe('TIFF and ffmpeg routes (copied EXIF)', () => {
	it('keeps the photo without the EXIF when exiftool refuses it', async () => {
		vi.mocked(copyExif).mockRejectedValueOnce(REFUSED);
		const id = await enqueue(path.join(PHOTO_FIXTURES, 'quad.tif'));
		await processPhoto(id, context());
		const row = media.getById(id)!;
		expect(row).toMatchObject({ status: 'ready', conversion: 'transcode', canonical_ext: 'jpg', taken_at: OTHER_EXIF.takenAt });
		expect(copyExif).toHaveBeenCalledTimes(1);
		expect(warnings()).toEqual([expect.stringMatching(/^WARN .*kept without the source's EXIF.*Bad format/)]);
		const t = exif(paths.libraryPath(id, 'jpg'));
		expect(t['ExifIFD:DateTimeOriginal']).toBeUndefined();
		expect(t['IFD0:Make']).toBeUndefined();
	});

	it('is retryable when exiftool times out', async () => {
		vi.mocked(copyExif).mockRejectedValueOnce(TIMEOUT);
		const e = await failure(await enqueue(path.join(PHOTO_FIXTURES, 'quad.tif')));
		expect(e.code).toBe('retryable');
		expect(e.detail).toMatch(/timeout/);
	});
});

describe('RAW (tags copied into the preview)', () => {
	it('fails as corrupt when the preview needs the RAW orientation exiftool could not copy', async () => {
		vi.mocked(copyRawTags).mockRejectedValueOnce(REFUSED);
		const e = await failure(await enqueue(path.join(PHOTO_FIXTURES, 'preview.dng')));
		expect(e.code).toBe('corrupt');
		expect(e.detail).toMatch(/Orientation 6/);
	});

	it('keeps an upright preview without the RAW tags', async () => {
		const upright = path.join(testEnv().root, 'upright.dng');
		execFileSync('exiftool', ['-q', '-Orientation#=1', '-o', upright, path.join(PHOTO_FIXTURES, 'preview.dng')]);
		vi.mocked(copyRawTags).mockRejectedValueOnce(REFUSED);
		const id = await enqueue(upright);
		await processPhoto(id, context());
		expect(media.getById(id)).toMatchObject({ status: 'ready', canonical_ext: 'jpg', width: 1600, height: 1200, taken_at: OTHER_EXIF.takenAt });
		expect(warnings()).toEqual([expect.stringMatching(/^WARN .*without the RAW's tags/)]);
		expect(exif(paths.libraryPath(id, 'jpg'))['IFD0:Make']).toBeUndefined();
	});

	it('is retryable when exiftool could not start', async () => {
		vi.mocked(copyRawTags).mockRejectedValueOnce(Object.assign(new Error('spawn /usr/bin/exiftool ENOENT'), { code: 'ENOENT' }));
		const e = await failure(await enqueue(path.join(PHOTO_FIXTURES, 'preview.dng')));
		expect(e.code).toBe('retryable');
	});
});

describe('reading the source (before anything is converted)', () => {
	it('is retryable when exiftool times out, so the photo keeps its date, place and Live Photo id', async () => {
		vi.mocked(readSourceTags).mockRejectedValueOnce(TIMEOUT);
		const id = await enqueue(path.join(PHOTO_FIXTURES, 'o6.heic'));
		const e = await failure(id);
		expect(e.code).toBe('retryable');
		expect(e.detail).toMatch(/metadata.*timeout/);
		// The next attempt reads the tags.
		await processPhoto(id, context());
		expect(media.getById(id)).toMatchObject({ status: 'ready', taken_at: '2024-07-04T11:22:31-07:00', gps_lat: 37.3349 });
	});

	it('is retryable when exiftool is gone', async () => {
		vi.mocked(readSourceTags).mockRejectedValueOnce(new Error('BatchCluster has ended, cannot enqueue -G1 -n'));
		const e = await failure(await enqueue(path.join(PHOTO_FIXTURES, 'o1.jpg')));
		expect(e.code).toBe('retryable');
	});

	it('goes on without the tags when exiftool refuses this file', async () => {
		vi.mocked(readSourceTags).mockRejectedValueOnce(REFUSED);
		const id = await enqueue(path.join(PHOTO_FIXTURES, 'o1.jpg'));
		await processPhoto(id, context());
		const row = media.getById(id)!;
		expect(row).toMatchObject({ status: 'ready', taken_at: null, gps_lat: null });
		expect(row.taken_ms).toBe(row.created_at);
		expect(warnings()).toEqual([expect.stringMatching(/^WARN exiftool could not read .*Bad format/)]);
	});

	it("is retryable when exiftool times out extracting a RAW's preview (not 'no preview')", async () => {
		vi.spyOn(exiftool(), 'extractJpgFromRaw').mockRejectedValueOnce(TIMEOUT);
		const e = await failure(await enqueue(path.join(PHOTO_FIXTURES, 'preview.dng')));
		expect(e.code).toBe('retryable');
		expect(e.detail).toMatch(/JpgFromRaw.*timeout/);
	});
});
