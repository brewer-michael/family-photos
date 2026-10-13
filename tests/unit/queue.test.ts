/**
 * Worker lanes against a fake worker (tests/fixtures/workers/fake-worker.mjs): real child
 * processes over IPC, the real database, short timings.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
	DEFAULT_TIMINGS,
	getProgress,
	previewsWaiting,
	queueMissingPreviews,
	queuePosition,
	startQueue,
	stopQueue,
	wakeQueue,
	type QueueTimings
} from '#lib/server/queue';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import { setSourceDuration } from '#lib/server/repo/uploads';
import { getDb } from '#lib/server/db';
import { cacheFile, tmpRoot, workRoot } from '#lib/server/paths';
import type { CacheVariant, Kind } from '#lib/shared/media-types';
import { freshDb, setEnv, testEnv } from '../helpers/env';

vi.mock('#lib/server/selfcheck', () => ({ runSelfCheck: vi.fn(async () => null) }));

const FAKE_WORKER = fileURLToPath(new URL('../fixtures/workers/fake-worker.mjs', import.meta.url));

const FAST: Partial<QueueTimings> = {
	photoTimeoutMs: 1500,
	stallMs: 500,
	killGraceMs: 300,
	helloTimeoutMs: 10_000,
	respawnBaseMs: 20,
	respawnMaxMs: 100,
	shutdownGraceMs: 1000
};

interface LogEvent {
	type: string;
	lane: Kind;
	pid: number;
	id?: string;
	behaviour?: string;
	attempts?: number;
	execArgv?: string[];
	argv?: string[];
	uvThreadpoolSize?: string;
	niceness?: number;
	secrets?: string[];
}

let album: number;
let logFile: string;
let seq = 0;

function events(): LogEvent[] {
	if (!fs.existsSync(logFile)) return [];
	return fs
		.readFileSync(logFile, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as LogEvent);
}

const jobs = (lane?: Kind) => events().filter((e) => e.type === 'job' && (!lane || e.lane === lane));
const row = (id: string) => media.getById(id)!;

/** A queued item whose source_name tells the fake worker what to do. */
function queued(behaviour: string, kind: Kind = 'photo', opts: { estCostS?: number; sourceSize?: number } = {}): string {
	const id = media.insertReceived({
		uploadToken: randomBytes(16).toString('base64url'),
		albumId: album,
		sourceName: `${behaviour}-${++seq}.${kind === 'photo' ? 'jpg' : 'mov'}`,
		sourceSize: opts.sourceSize ?? 1000,
		clientMtimeMs: null,
		uploadedByName: 'Aunt Linda',
		uploadedByDevice: 'deviceAAAAAAAAAAAAAAAA'
	});
	const r = media.markQueued(id, {
		kind,
		sourceMime: kind === 'photo' ? 'image/jpeg' : 'video/quicktime',
		sourceExt: kind === 'photo' ? 'jpg' : 'mov',
		sourceSha256: randomBytes(32).toString('hex'),
		estCostS: opts.estCostS ?? null
	});
	expect(r.outcome).toBe('queued');
	return id;
}

const release = (id: string) => fs.writeFileSync(`${logFile}.release-${id}`, '');

async function settled(id: string, status: string, timeout = 8000): Promise<void> {
	await vi.waitFor(() => expect(row(id).status).toBe(status), { timeout, interval: 20 });
}

beforeEach(() => {
	freshDb();
	album = albums.create({ title: 'Queue test', createdByName: null, createdByDevice: null }).id;
	logFile = path.join(testEnv().root, `worker-${Date.now()}-${++seq}.log`);
	setEnv({ WORKER_ENTRY: FAKE_WORKER, FAKE_WORKER_LOG: logFile, FAKE_WORKER_HELLO: undefined });
});

afterEach(async () => {
	await stopQueue();
	vi.restoreAllMocks();
});

const lanesStarted = (lane: Kind) => events().filter((e) => e.type === 'start' && e.lane === lane).length;

describe('limits', () => {
	it('defaults to the limits in the spec', () => {
		expect(DEFAULT_TIMINGS).toMatchObject({
			photoTimeoutMs: 300_000,
			bigPhotoTimeoutMs: 600_000,
			bigPhotoBytes: 40_000_000,
			videoBaseMs: 120_000,
			videoPerSecondMs: 30_000,
			stallMs: 180_000,
			killGraceMs: 10_000,
			minConfigFreeBytes: 2 * 1024 ** 3
		});
	});
});

describe('lanes', () => {
	it('spawns one niced child per lane with the memory cap, its lane, UV_THREADPOOL_SIZE=4 and no secrets', async () => {
		setEnv({ SMTP_HOST: 'smtp.example.com', SMTP_PASS: 'mail-secret' });
		onTestFinished(() => setEnv({ SMTP_HOST: undefined, SMTP_PASS: undefined }));
		expect(process.env.FAMILY_PASSWORD).toBeTruthy();
		startQueue({ timings: FAST });
		await vi.waitFor(() => expect(events().filter((e) => e.type === 'start')).toHaveLength(2));
		const base = os.getPriority();
		for (const lane of ['photo', 'video'] as const) {
			const start = events().find((e) => e.type === 'start' && e.lane === lane)!;
			expect(start.execArgv).toContain('--max-old-space-size=512');
			expect(start.argv).toEqual([`--lane=${lane}`]);
			expect(start.uvThreadpoolSize).toBe('4');
			expect(start.niceness).toBe(Math.min(19, base + (lane === 'photo' ? 10 : 15)));
			// The family code, admin password and SMTP password stay in the web process.
			expect(start.secrets).toEqual([]);
		}
	});

	it('runs photos first in, first out and videos cheapest first, one job at a time per lane', async () => {
		const photos = [queued('ok'), queued('ok'), queued('ok')];
		const long = queued('ok', 'video', { estCostS: 900 });
		const short = queued('ok', 'video', { estCostS: 5 });
		const medium = queued('ok', 'video', { estCostS: 60 });
		startQueue({ timings: FAST });
		for (const id of [...photos, long, short, medium]) await settled(id, 'ready');
		expect(jobs('photo').map((e) => e.id)).toEqual(photos);
		expect(jobs('video').map((e) => e.id)).toEqual([short, medium, long]);
		for (const id of [...photos, short]) expect(row(id).attempts).toBe(1);
	});

	it('picks up work queued later when woken', async () => {
		startQueue({ timings: FAST });
		await vi.waitFor(() => expect(events().filter((e) => e.type === 'start')).toHaveLength(2));
		const id = queued('ok');
		wakeQueue();
		await settled(id, 'ready');
	});

	it('keeps progress in memory while a job runs and reports queue positions', async () => {
		const running = queued('hold', 'video', { estCostS: 1 });
		const next = queued('ok', 'video', { estCostS: 2 });
		const after = queued('ok', 'video', { estCostS: 3 });
		startQueue({ timings: FAST });
		await vi.waitFor(() => expect(getProgress(running)).toEqual({ pct: 42, etaS: 90 }));
		expect(row(running).status).toBe('processing');
		// The lane is busy with `running`, so `next` has one item ahead of it.
		expect(queuePosition(next)).toBe(1);
		expect(queuePosition(after)).toBe(2);
		expect(queuePosition(running)).toBeUndefined();
		release(running);
		await settled(after, 'ready');
		expect(getProgress(running)).toBeUndefined();
		expect(queuePosition(next)).toBeUndefined();
	});
});

describe('failures', () => {
	it('retries a retryable failure and fails it after 3 attempts', async () => {
		const id = queued('fail-retryable');
		startQueue({ timings: FAST });
		await settled(id, 'failed');
		const r = row(id);
		expect(r.attempts).toBe(3);
		expect(r.error_code).toBe('retryable');
		expect(r.error_detail).toContain('Gave up after 3 attempts');
		expect(r.error_detail).toContain('flaky disk');
		expect(jobs().filter((e) => e.id === id)).toHaveLength(3);
	});

	it('fails a non-retryable error at once', async () => {
		const id = queued('fail-corrupt');
		startQueue({ timings: FAST });
		await settled(id, 'failed');
		expect(row(id).attempts).toBe(1);
		expect(row(id).error_code).toBe('corrupt');
		expect(row(id).error_detail).toBe('broken bytes');
	});

	it('treats a crash as retryable, respawns the lane and carries on', async () => {
		const crash = queued('crash');
		const killed = queued('kill');
		const ok = queued('ok');
		startQueue({ timings: FAST });
		await settled(ok, 'ready');
		for (const id of [crash, killed]) {
			expect(row(id).status).toBe('failed');
			expect(row(id).error_code).toBe('retryable');
			expect(row(id).attempts).toBe(3);
		}
		expect(row(crash).error_detail).toContain('exit code 3');
		expect(row(killed).error_detail).toContain('SIGKILL');
		// 6 crashes → 7 photo-lane processes (plus the video lane).
		expect(events().filter((e) => e.type === 'start' && e.lane === 'photo')).toHaveLength(7);
	});

	it('kills a video lane that stops sending progress, then respawns it', async () => {
		const stalled = queued('stall', 'video', { estCostS: 1 });
		const ok = queued('ok', 'video', { estCostS: 2 });
		startQueue({ timings: FAST });
		await settled(stalled, 'failed', 15_000);
		expect(row(stalled).attempts).toBe(3);
		expect(row(stalled).error_detail).toContain('no progress');
		await settled(ok, 'ready');
	});

	it("kills a video job that outlives its hard cap (base + per second of the video's duration)", async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		// It keeps sending progress, so only the hard cap can stop it: 200 ms + 400 ms × 2 s = 1 s.
		// Without the duration the cap would be minutes (MAX_VIDEO_MINUTES).
		const id = queued('hold', 'video', { estCostS: 1 });
		expect(setSourceDuration(id, 2000)).toBe(true);
		startQueue({ timings: { ...FAST, stallMs: 60_000, videoBaseMs: 200, videoPerSecondMs: 400 } });
		await settled(id, 'failed', 15_000);
		expect(row(id).attempts).toBe(3);
		expect(row(id).error_code).toBe('retryable');
		expect(row(id).error_detail).toContain('took longer than 1 s');
		expect(jobs('video').filter((e) => e.id === id)).toHaveLength(3);
	});

	it('kills a photo job that runs too long, escalating to SIGKILL', async () => {
		const stubborn = queued('stubborn');
		const ok = queued('ok');
		startQueue({ timings: { ...FAST, photoTimeoutMs: 300 } });
		await settled(ok, 'ready', 15_000);
		expect(row(stubborn).status).toBe('failed');
		expect(row(stubborn).error_detail).toContain('took longer than');
		expect(events().filter((e) => e.type === 'ignored-sigterm')).toHaveLength(3);
	});

	it('gives big photos the longer time limit', async () => {
		const big = queued('hold', 'photo', { sourceSize: 41_000_000 });
		startQueue({ timings: { ...FAST, photoTimeoutMs: 200, bigPhotoTimeoutMs: 20_000 } });
		await vi.waitFor(() => expect(jobs('photo')).toHaveLength(1));
		await new Promise((r) => setTimeout(r, 500));
		expect(row(big).status).toBe('processing');
		release(big);
		await settled(big, 'ready');
	});

	it('leaves a committed item ready when its worker fails or crashes afterwards', async () => {
		const failsLate = queued('ready-then-fail');
		const crashesLate = queued('ready-then-crash');
		const ok = queued('ok');
		startQueue({ timings: FAST });
		await settled(ok, 'ready');
		for (const id of [failsLate, crashesLate]) {
			expect(row(id).status).toBe('ready');
			expect(row(id).attempts).toBe(1);
			expect(row(id).error_code).toBeNull();
		}
	});
});

describe('start and stop', () => {
	it('re-queues interrupted jobs and clears the scratch folders at startup', async () => {
		const id = queued('ok');
		expect(media.claimForProcessing(id)).toBeTruthy(); // "crashed" while processing
		for (const root of [tmpRoot(), workRoot()]) {
			fs.mkdirSync(path.join(root, 'LEFTOVER'), { recursive: true });
			fs.writeFileSync(path.join(root, 'LEFTOVER', 'x'), 'x');
		}
		startQueue({ timings: FAST });
		expect(fs.readdirSync(tmpRoot())).toEqual([]);
		expect(fs.readdirSync(workRoot())).toEqual([]);
		await settled(id, 'ready');
		expect(row(id).attempts).toBe(2);
	});

	it('kills and respawns a lane that never says hello, then carries on once one does', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		setEnv({ FAKE_WORKER_HELLO: 'never' });
		const id = queued('ok');
		startQueue({ timings: { ...FAST, helloTimeoutMs: 200 } });
		await vi.waitFor(() => expect(lanesStarted('photo')).toBeGreaterThanOrEqual(3), { timeout: 8000, interval: 20 });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('it did not start within'));
		expect(jobs()).toHaveLength(0);
		expect(row(id).status).toBe('queued');
		expect(row(id).attempts).toBe(0);
		// The next respawn starts normally (the lane inherits the environment at spawn time).
		setEnv({ FAKE_WORKER_HELLO: undefined });
		await settled(id, 'ready');
		expect(row(id).attempts).toBe(1);
	});

	it('waits for a missing worker bundle, saying so once per lane, and starts once it exists', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const entry = path.join(testEnv().root, `bundle-${++seq}`, 'worker.js');
		setEnv({ WORKER_ENTRY: entry });
		const id = queued('ok');
		startQueue({ timings: FAST });
		await new Promise((r) => setTimeout(r, 450)); // several rechecks (respawnMaxMs = 100)
		expect(events()).toEqual([]);
		expect(error.mock.calls.filter((c) => String(c[0]).includes(`worker bundle ${entry} is missing`))).toHaveLength(2);
		expect(row(id).status).toBe('queued');
		// `npm run build:worker` finished: the bundle appears.
		fs.mkdirSync(path.dirname(entry));
		fs.symlinkSync(FAKE_WORKER, entry);
		await settled(id, 'ready');
		// Each lane looks again on its own timer, so the video lane may start a recheck later.
		await vi.waitFor(() => expect(lanesStarted('video')).toBe(1), { timeout: 2000, interval: 20 });
		expect(lanesStarted('photo')).toBe(1);
	});

	it('waits while /config is short of space', async () => {
		const id = queued('ok');
		startQueue({ timings: { ...FAST, minConfigFreeBytes: Number.MAX_SAFE_INTEGER, diskRecheckMs: 100 } });
		await vi.waitFor(() => expect(events().filter((e) => e.type === 'start')).toHaveLength(2));
		await new Promise((r) => setTimeout(r, 400));
		expect(row(id).status).toBe('queued');
		expect(jobs()).toHaveLength(0);
	});

	it('stops the lanes on shutdown and re-queues the job that was cut short', async () => {
		const id = queued('hang');
		startQueue({ timings: FAST });
		await vi.waitFor(() => expect(jobs('photo')).toHaveLength(1));
		await stopQueue();
		expect(events().filter((e) => e.type === 'shutdown')).toHaveLength(2);
		expect(row(id).status).toBe('queued');
		expect(row(id).attempts).toBe(0); // the claim's attempt is given back: restarts never use up MAX_ATTEMPTS
	});

	it('re-queues a job the shutdown aborted, even on its last attempt (the lane answers "failed" first)', async () => {
		const id = queued('abortable');
		getDb().prepare('UPDATE media SET attempts = 2 WHERE id = ?').run(id);
		startQueue({ timings: FAST });
		await vi.waitFor(() => expect(jobs('photo')).toHaveLength(1));
		expect(row(id).attempts).toBe(3);
		await stopQueue();
		expect(row(id).status).toBe('queued');
		expect(row(id).attempts).toBe(2);
		expect(row(id).error_code).toBeNull();
		expect(row(id).error_detail).toBe('Interrupted by a shutdown; re-queued');
	});

	it('SIGKILLs a lane that ignores the shutdown request', async () => {
		const id = queued('stubborn');
		startQueue({ timings: { ...FAST, shutdownGraceMs: 200 } });
		await vi.waitFor(() => expect(jobs('photo')).toHaveLength(1));
		const started = Date.now();
		await stopQueue();
		expect(Date.now() - started).toBeGreaterThanOrEqual(190);
		expect(Date.now() - started).toBeLessThan(5000);
		expect(events().filter((e) => e.type === 'ignored-shutdown')).toHaveLength(1);
		expect(row(id).status).toBe('queued');
	});
});

describe('admin redos', () => {
	/** A ready item made by an older pipeline, with its redo queued; the fake worker acts on `behaviour`. */
	function redoItem(behaviour: string): string {
		const id = queued(behaviour);
		media.claimForProcessing(id);
		media.markReady(id, { conversion: 'transcode', canonicalExt: 'jpg', canonicalSize: 1, width: 1, height: 1, takenMs: 0, sourceKept: true, pipelineVersion: 0 });
		expect(media.markForReprocess(id)).toBe(true);
		return id;
	}

	it('run only while no upload waits; a redo that fails leaves the item ready and visible', async () => {
		const redo = redoItem('fail-corrupt');
		const upload = queued('ok');
		startQueue({ timings: FAST });
		await vi.waitFor(() => expect(row(redo).redo_state).toBeNull(), { timeout: 8000, interval: 20 });
		expect(jobs('photo').map((j) => j.id)).toEqual([upload, redo]);
		expect(row(upload).status).toBe('ready');
		expect(row(redo)).toMatchObject({ status: 'ready', pipeline_version: 0, redo_error: 'corrupt: broken bytes', error_code: null });
		expect(media.listByAlbum(album).items.map((r) => r.id).sort()).toEqual([redo, upload].sort());
		expect(media.listFailed()).toEqual([]);
	});

	it('try a retryable failure again, then give up without touching the item', async () => {
		const redo = redoItem('fail-retryable');
		startQueue({ timings: FAST });
		await vi.waitFor(() => expect(row(redo).redo_state).toBeNull(), { timeout: 8000, interval: 20 });
		expect(jobs('photo').filter((j) => j.id === redo)).toHaveLength(3);
		expect(row(redo)).toMatchObject({ status: 'ready', redo_error: 'Gave up after 3 attempts. Last error: flaky disk' });
	});

	it('a redo the shutdown cut short waits again with its attempt given back', async () => {
		const redo = redoItem('hang');
		startQueue({ timings: FAST });
		await vi.waitFor(() => expect(jobs('photo')).toHaveLength(1));
		expect(row(redo)).toMatchObject({ status: 'ready', redo_state: 'running', redo_attempts: 1 });
		await stopQueue();
		expect(row(redo)).toMatchObject({ status: 'ready', redo_state: 'queued', redo_attempts: 0 });
	});

	it('a waiting redo whose original is no longer recorded ends instead of holding up the ones behind it', async () => {
		const orphan = redoItem('ok');
		media.markOriginalDeleted(orphan);
		const next = redoItem('ok');
		startQueue({ timings: FAST });
		// (the fake worker doesn't commit redos, so the lane's job list is what shows it was taken)
		await vi.waitFor(() => expect(jobs('photo').map((j) => j.id)).toEqual([next]), { timeout: 8000, interval: 20 });
		expect(row(orphan)).toMatchObject({ status: 'ready', redo_state: null, redo_error: "Its archived original is gone, so it can't be redone" });
	});
});

describe('missing previews', () => {
	/** A ready item as a lane leaves it, with only the cache files in `cached` (the rest went missing). */
	function readyItem(behaviour: string, kind: Kind, cached: CacheVariant[] = []): string {
		const id = queued(behaviour, kind);
		media.claimForProcessing(id);
		media.markReady(id, { conversion: 'none', canonicalExt: kind === 'photo' ? 'jpg' : 'mp4', canonicalSize: 1, width: 1, height: 1, takenMs: 0, sourceKept: false });
		for (const variant of cached) {
			fs.mkdirSync(path.dirname(cacheFile(id, variant)), { recursive: true });
			fs.writeFileSync(cacheFile(id, variant), 'webp');
		}
		return id;
	}
	const rebuilt = (lane?: Kind) => events().filter((e) => e.type === 'previews' && (!lane || e.lane === lane)).map((e) => e.id);

	it('are rebuilt from library/ at startup, newest first and after uploads, without touching the rows', async () => {
		const older = readyItem('ok', 'photo');
		const complete = readyItem('ok', 'photo', ['thumb', 'display']);
		const noDisplay = readyItem('ok', 'photo', ['thumb']);
		const noPoster = readyItem('ok', 'video', ['thumb']);
		const completeVideo = readyItem('ok', 'video', ['thumb', 'poster']);
		const upload = queued('ok');
		const before = [older, complete, noDisplay, noPoster, completeVideo].map((id) => ({ ...row(id) }));
		startQueue({ timings: FAST });
		expect(previewsWaiting()).toBe(3);
		await vi.waitFor(() => expect(previewsWaiting()).toBe(0), { timeout: 8000, interval: 20 });
		// The upload first; then the previews, newest first. Items with all their previews are left alone.
		expect(events().filter((e) => e.lane === 'photo' && (e.type === 'job' || e.type === 'previews')).map((e) => e.id)).toEqual([upload, noDisplay, older]);
		expect(rebuilt('video')).toEqual([noPoster]);
		for (const id of [older, noDisplay]) expect(fs.existsSync(cacheFile(id, 'display'))).toBe(true);
		expect(fs.existsSync(cacheFile(noPoster, 'poster'))).toBe(true);
		for (const r of before) expect(row(r.id)).toEqual(r);
		expect(row(upload).status).toBe('ready');
	});

	it('are looked for again from the admin page; one that cannot be rebuilt is only logged', async () => {
		startQueue({ timings: FAST });
		const lost = readyItem('ok', 'photo');
		const broken = readyItem('previews-fail', 'photo');
		const warn = vi.spyOn(console, 'warn');
		expect(queueMissingPreviews()).toBe(2);
		await vi.waitFor(() => expect(previewsWaiting()).toBe(0), { timeout: 8000, interval: 20 });
		expect(rebuilt()).toEqual([broken, lost]);
		expect(fs.existsSync(cacheFile(lost, 'thumb'))).toBe(true);
		expect(warn).toHaveBeenCalledWith(`[queue] could not rebuild the previews of ${broken}: corrupt: its file in library/ is missing`);
		expect(row(broken)).toMatchObject({ status: 'ready', attempts: 1, error_code: null, error_detail: null, redo_state: null });
		// Not retried by itself; asking again finds only that one.
		expect(queueMissingPreviews()).toBe(1);
		await vi.waitFor(() => expect(rebuilt()).toEqual([broken, lost, broken]), { timeout: 8000, interval: 20 });
		expect(row(broken).status).toBe('ready');
	});
});
