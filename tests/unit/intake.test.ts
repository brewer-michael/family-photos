import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectFile, type DetectResult } from '#lib/server/media/detect';
import { estimateCostS, probeVideo, type VideoProbe } from '#lib/server/media/probe';
import { wakeQueue } from '#lib/server/queue';
import { sha256File, startIntake, stopIntake, wakeIntake } from '#lib/server/intake';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import { getConfig } from '#lib/server/config';
import { incomingDir, incomingPath } from '#lib/server/paths';
import { MediaError } from '#lib/shared/errors';
import { freshDb } from '../helpers/env';

vi.mock('#lib/server/media/detect', () => ({ detectFile: vi.fn() }));
vi.mock('#lib/server/media/probe', () => ({ probeVideo: vi.fn(), estimateCostS: vi.fn() }));
vi.mock('#lib/server/queue', () => ({ wakeQueue: vi.fn() }));

const detect = vi.mocked(detectFile);
const probe = vi.mocked(probeVideo);
const cost = vi.mocked(estimateCostS);

const JPEG: DetectResult = { kind: 'photo', mime: 'image/jpeg', ext: 'jpg' };
const MOV: DetectResult = { kind: 'video', mime: 'video/quicktime', ext: 'mov', brand: 'qt  ' };
const PDF: DetectResult = { kind: null, mime: 'application/pdf', ext: 'pdf' };

let album: number;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A finished tus upload: .incoming/<token> (+ .json) and its `received` row. */
function upload(bytes: Buffer, opts: { albumId?: number; name?: string } = {}): { id: string; token: string; file: string } {
	const token = randomBytes(16).toString('base64url');
	const file = incomingPath(token);
	fs.mkdirSync(incomingDir(), { recursive: true });
	fs.writeFileSync(file, bytes);
	fs.writeFileSync(`${file}.json`, '{}');
	const id = media.insertReceived({
		uploadToken: token,
		albumId: opts.albumId ?? album,
		sourceName: opts.name ?? 'IMG_0001.JPG',
		sourceSize: bytes.length,
		clientMtimeMs: null,
		uploadedByName: 'Aunt Linda',
		uploadedByDevice: 'deviceAAAAAAAAAAAAAAAA'
	});
	return { id, token, file };
}

const row = (id: string) => media.getById(id)!;

beforeEach(() => {
	freshDb();
	vi.clearAllMocks();
	album = albums.create({ title: 'Lake trip', createdByName: 'Linda', createdByDevice: null }).id;
	detect.mockResolvedValue(JPEG);
});

afterAll(async () => {
	await stopIntake();
});

describe('intake', () => {
	it('hashes, detects and queues a photo, then wakes the queue', async () => {
		const bytes = randomBytes(3000);
		const { id, file } = upload(bytes);
		await wakeIntake();
		const r = row(id);
		expect(r.status).toBe('queued');
		expect(r.kind).toBe('photo');
		expect(r.source_sha256).toBe(sha(bytes));
		expect(r.source_mime).toBe('image/jpeg');
		expect(r.source_ext).toBe('jpg');
		expect(r.queued_ms).toBeGreaterThan(0);
		expect(r.est_cost_s).toBeNull();
		expect(fs.existsSync(file)).toBe(true); // the lane reads it from .incoming
		expect(detect).toHaveBeenCalledWith(file);
		expect(probe).not.toHaveBeenCalled();
		expect(wakeQueue).toHaveBeenCalledTimes(1);
	});

	it('probes videos for the cost estimate and remembers their duration', async () => {
		detect.mockResolvedValue(MOV);
		probe.mockResolvedValue({ durationS: 12.5 } as VideoProbe);
		cost.mockReturnValue(3.25);
		const { id, file } = upload(randomBytes(500), { name: 'IMG_0002.MOV' });
		await wakeIntake();
		const r = row(id);
		expect(r.status).toBe('queued');
		expect(r.kind).toBe('video');
		expect(r.est_cost_s).toBe(3.25);
		expect(r.duration_ms).toBe(12500);
		expect(probe).toHaveBeenCalledWith(file, { maxDurationS: getConfig().maxVideoSeconds });
		expect(wakeQueue).toHaveBeenCalledTimes(1);
	});

	it('turns the same bytes in the same album into a duplicate and deletes the upload', async () => {
		const bytes = randomBytes(2000);
		const first = upload(bytes);
		await wakeIntake();
		detect.mockClear();
		const second = upload(bytes, { name: 'copy.jpg' });
		await wakeIntake();
		const r = row(second.id);
		expect(r.status).toBe('duplicate');
		expect(r.duplicate_of).toBe(first.id);
		expect(r.upload_token).toBeNull();
		expect(fs.existsSync(second.file)).toBe(false);
		expect(fs.existsSync(`${second.file}.json`)).toBe(false);
		expect(fs.existsSync(first.file)).toBe(true);
		expect(detect).not.toHaveBeenCalled();

		// Another album may have the same photo.
		const other = albums.create({ title: 'Other', createdByName: null, createdByDevice: null }).id;
		const third = upload(bytes, { albumId: other });
		await wakeIntake();
		expect(row(third.id).status).toBe('queued');
	});

	it('marks a duplicate when two copies arrive in one pass', async () => {
		const bytes = randomBytes(1000);
		const a = upload(bytes);
		const b = upload(bytes);
		await wakeIntake();
		expect(row(a.id).status).toBe('queued');
		expect(row(b.id).status).toBe('duplicate');
		expect(row(b.id).duplicate_of).toBe(a.id);
	});

	it('fails what is not a photo or video as unsupported and keeps the source', async () => {
		detect.mockResolvedValue(PDF);
		const bytes = randomBytes(800);
		const { id, token, file } = upload(bytes, { name: 'Tax return.pdf' });
		await wakeIntake();
		const r = row(id);
		expect(r.status).toBe('failed');
		expect(r.error_code).toBe('unsupported');
		expect(r.error_detail).toContain('application/pdf');
		expect(r.kind).toBeNull();
		expect(r.source_sha256).toBe(sha(bytes));
		expect(r.source_mime).toBe('application/pdf');
		expect(r.upload_token).toBe(token);
		expect(fs.existsSync(file)).toBe(true);
		expect(wakeQueue).not.toHaveBeenCalled();
	});

	it('fails a video over MAX_VIDEO_MINUTES as too_large', async () => {
		detect.mockResolvedValue(MOV);
		probe.mockRejectedValue(new MediaError('too_large', 'video is 180 min long; the limit is 120 min (MAX_VIDEO_MINUTES)'));
		const { id, file } = upload(randomBytes(700), { name: 'wedding.MOV' });
		await wakeIntake();
		const r = row(id);
		expect(r.status).toBe('failed');
		expect(r.error_code).toBe('too_large');
		expect(r.error_detail).toContain('MAX_VIDEO_MINUTES');
		expect(r.kind).toBe('video');
		expect(fs.existsSync(file)).toBe(true);
	});

	it('fails a missing upload file as corrupt', async () => {
		const { id, file } = upload(randomBytes(10));
		fs.rmSync(file);
		await wakeIntake();
		expect(row(id).status).toBe('failed');
		expect(row(id).error_code).toBe('corrupt');
	});

	it('fails unexpected errors as retryable without a kind, so "Try again" re-runs intake', async () => {
		detect.mockRejectedValueOnce(new Error('EIO: i/o error, read'));
		const bytes = randomBytes(1200);
		const { id } = upload(bytes);
		await wakeIntake();
		expect(row(id).status).toBe('failed');
		expect(row(id).error_code).toBe('retryable');
		expect(row(id).kind).toBeNull();

		expect(media.retry(id)).toBe('received');
		await wakeIntake();
		expect(row(id).status).toBe('queued');
		expect(row(id).source_sha256).toBe(sha(bytes));
	});

	it('keeps going after a bad item', async () => {
		detect.mockImplementation(async (file) => {
			if (file.endsWith(bad.token)) throw new Error('boom');
			return JPEG;
		});
		const bad = upload(randomBytes(100));
		const good = upload(randomBytes(100));
		await wakeIntake();
		expect(row(bad.id).status).toBe('failed');
		expect(row(good.id).status).toBe('queued');
	});

	it('picks up rows that arrive while a pass is running', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		detect.mockImplementationOnce(async () => {
			await gate;
			return JPEG;
		});
		const a = upload(randomBytes(100));
		const running = wakeIntake();
		await vi.waitFor(() => expect(detect).toHaveBeenCalledTimes(1));
		const b = upload(randomBytes(100));
		const again = wakeIntake();
		expect(again).toBe(running); // one pass at a time; the new row joins it
		release();
		await again;
		expect(row(a.id).status).toBe('queued');
		expect(row(b.id).status).toBe('queued');
	});

	it('drains rows left `received` by a restart when it starts', async () => {
		const { id } = upload(randomBytes(100));
		startIntake();
		await vi.waitFor(() => expect(row(id).status).toBe('queued'));
	});
});

describe('sha256File', () => {
	it('matches a one-shot hash of a multi-MiB file', async () => {
		const bytes = randomBytes(3 * 1024 * 1024 + 7);
		const file = path.join(incomingDir(), 'hash-test');
		fs.mkdirSync(incomingDir(), { recursive: true });
		fs.writeFileSync(file, bytes);
		expect(await sha256File(file)).toBe(sha(bytes));
	});
});
