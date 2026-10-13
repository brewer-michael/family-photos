/**
 * Previews rebuilt from library/ (src/worker/previews.ts) after /config/cache was lost: a photo and
 * a video go through their real lanes, their cache folder is deleted, and rebuildPreviews() makes
 * the previews again from the canonical file alone (same sizes, the photo's date), without
 * touching the row.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getConfig } from '#lib/server/config';
import { getDb } from '#lib/server/db';
import { detectFile } from '#lib/server/media/detect';
import * as paths from '#lib/server/paths';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import { MediaError } from '#lib/shared/errors';
import type { CacheVariant, Kind } from '#lib/shared/media-types';
import { freshDb, testEnv } from '../helpers/env';
import { PHOTO_FIXTURES } from '../helpers/photo-fixtures';
import { FIXTURES, makeFixture, missingEncoders } from '../fixtures/video/fixtures';
import type { WorkerContext } from '../../src/worker/context';
import { endExiftool } from '../../src/worker/exiftool';
import { processPhoto } from '../../src/worker/photo';
import { rebuildPreviews, rowDerivativeDate } from '../../src/worker/previews';
import { processVideo } from '../../src/worker/video';

const DEVICE = 'devicePPPPPPPPPPPPPPPP';
let albumId: number;

beforeAll(() => {
	freshDb();
	paths.ensureDirs();
	albumId = albums.create({ title: 'Previews', createdByName: 'Test', createdByDevice: DEVICE }).id;
});

afterAll(async () => {
	await endExiftool();
});

function context(lane: Kind, logs: string[] = []): WorkerContext {
	const line = (level: string) => (m: string) => logs.push(`${level} ${m}`);
	return {
		db: getDb(),
		config: getConfig(),
		paths,
		lane,
		progress: () => undefined,
		signal: new AbortController().signal,
		log: { info: line('INFO'), warn: line('WARN'), error: line('ERROR') }
	};
}

/** Walks a file through intake and its real lane to `ready`. */
async function added(file: string, kind: Kind): Promise<media.MediaRow> {
	const token = randomBytes(16).toString('base64url');
	const src = paths.incomingPath(token);
	fs.copyFileSync(file, src);
	const det = await detectFile(src);
	const id = media.insertReceived({
		uploadToken: token,
		albumId,
		sourceName: path.basename(file),
		sourceSize: fs.statSync(src).size,
		clientMtimeMs: null,
		uploadedByName: 'Test',
		uploadedByDevice: DEVICE
	});
	media.markQueued(id, { kind, sourceMime: det.mime, sourceExt: det.ext, sourceSha256: randomBytes(32).toString('hex'), estCostS: 1 });
	expect(media.claimForProcessing(id)?.status).toBe('processing');
	await (kind === 'photo' ? processPhoto : processVideo)(id, context(kind));
	const row = media.getById(id)!;
	expect(row.status).toBe('ready');
	return row;
}

async function sizes(id: string, variants: readonly CacheVariant[]): Promise<Record<string, [number, number]>> {
	const out: Record<string, [number, number]> = {};
	for (const v of variants) {
		const m = await sharp(paths.cacheFile(id, v)).metadata();
		expect(m.format).toBe('webp');
		out[v] = [m.width, m.height];
	}
	return out;
}

const exif = (file: string) => (JSON.parse(execFileSync('exiftool', ['-j', '-G1', file], { encoding: 'utf8' })) as Record<string, unknown>[])[0];

describe('rebuildPreviews', () => {
	it('makes a photo’s display and thumbnail again from its canonical file, with its date', async () => {
		const row = await added(path.join(PHOTO_FIXTURES, 'o6.heic'), 'photo');
		const before = await sizes(row.id, ['display', 'thumb']);
		const dateBefore = exif(paths.cacheFile(row.id, 'display'))['ExifIFD:DateTimeOriginal'];
		fs.rmSync(paths.cacheDir(row.id), { recursive: true });

		const logs: string[] = [];
		expect(await rebuildPreviews(row.id, context('photo', logs))).toBe(true);
		expect(await sizes(row.id, ['display', 'thumb'])).toEqual(before);
		expect(exif(paths.cacheFile(row.id, 'display'))['ExifIFD:DateTimeOriginal']).toBe(dateBefore);
		expect(media.getById(row.id)).toEqual(row);
		expect(logs).toEqual([]);
		expect(fs.existsSync(paths.tmpDir(row.id))).toBe(false);
	});

	it.skipIf(missingEncoders(FIXTURES.F3).length > 0)('makes a video’s poster and thumbnail again from its MP4', async () => {
		const row = await added(makeFixture(FIXTURES.F3, path.join(testEnv().root, 'fixtures')), 'video');
		const before = await sizes(row.id, ['poster', 'thumb']);
		fs.rmSync(paths.cacheDir(row.id), { recursive: true });

		expect(await rebuildPreviews(row.id, context('video'))).toBe(true);
		expect(await sizes(row.id, ['poster', 'thumb'])).toEqual(before);
		expect(media.getById(row.id)).toEqual(row);
	});

	it('fails without touching the row when the canonical file is gone, and skips items that are not ready', async () => {
		const row = await added(path.join(PHOTO_FIXTURES, 'o1.jpg'), 'photo');
		fs.rmSync(paths.cacheDir(row.id), { recursive: true });
		fs.renameSync(paths.libraryPath(row.id, 'jpg'), `${paths.libraryPath(row.id, 'jpg')}.away`);
		const err = await rebuildPreviews(row.id, context('photo')).catch((e: unknown) => e);
		expect(MediaError.is(err) && err.code).toBe('corrupt');
		expect(media.getById(row.id)).toEqual(row);
		expect(fs.existsSync(paths.cacheDir(row.id))).toBe(false);

		expect(await rebuildPreviews('01ARZ3NDEKTSV4RRFFQ69G5FAV', context('photo'))).toBe(false);
	});
});

describe('rowDerivativeDate', () => {
	it('uses the local taken time and its offset, or the UTC instant', () => {
		expect(rowDerivativeDate({ taken_at: '2024-07-04T11:22:31-07:00', taken_ms: 0, created_at: 0 })).toEqual({ exif: '2024:07:04 11:22:31', offset: '-07:00' });
		expect(rowDerivativeDate({ taken_at: '2024-07-04T11:22:31', taken_ms: 0, created_at: 0 })).toEqual({ exif: '2024:07:04 11:22:31', offset: null });
		expect(rowDerivativeDate({ taken_at: null, taken_ms: Date.UTC(2023, 4, 5, 6, 7, 8), created_at: 0 })).toEqual({ exif: '2023:05:05 06:07:08', offset: '+00:00' });
	});
});
