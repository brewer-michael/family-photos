/**
 * Worker lanes, main-process side (src/worker/README.md; docs/media-pipeline.md §3 "Resource
 * limits" and "Progress").
 *
 * One child process per lane, at a lower CPU priority than the web process:
 *   nice -n 10|15 node --max-old-space-size=512 <WORKER_ENTRY> --lane=photo|video
 *   stdio ['ignore','inherit','inherit','ipc'], UV_THREADPOOL_SIZE=4
 * Each lane runs one job at a time: media.nextQueued(lane) → media.claimForProcessing() (processing,
 * attempts++) → {type:'job'}. Photos go first in, first out; videos cheapest-first with ageing.
 *
 * Outcomes. The worker commits success itself (markReady); `done` ready/duplicate needs nothing
 * here. `done` failed, a crash, or a kill (timeout/stall) is a failure: retryable with attempts left
 * → media.requeue(), otherwise media.markFailed(). Both leave a `ready` row alone, so a job that
 * committed and then failed is still a success.
 *
 * Limits. Photo jobs get 300 s (600 s when the source is over 40 MB); video jobs 120 s + 30 s per
 * second of video, and are also stopped when no progress message arrived for 180 s. An overrun
 * kills the lane (SIGTERM, then SIGKILL after 10 s); it is respawned with backoff. A job is only
 * dispatched while /config has ≥ 2 GiB free.
 *
 * Progress lives in memory only (a restart re-runs the job anyway).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from './config';
import { configRoot, tmpRoot, workRoot } from './paths';
import * as media from './repo/media';
import { runSelfCheck } from './selfcheck';
import { JOB_MIN_FREE_BYTES, formatBytes, freeBytesSync } from './disk';
import { MAX_ATTEMPTS, type ErrorCode } from '#lib/shared/media-types';
import { LANES, isWorkerToMain, type Lane, type MainToWorker, type WorkerToMain } from '#lib/shared/worker-protocol';
import { errorDetail } from '#lib/shared/errors';

export interface QueueTimings {
	photoTimeoutMs: number;
	/** For photo sources larger than bigPhotoBytes. */
	bigPhotoTimeoutMs: number;
	bigPhotoBytes: number;
	/** Video hard cap: videoBaseMs + videoPerSecondMs × duration (s). */
	videoBaseMs: number;
	videoPerSecondMs: number;
	/** Video jobs: longest silence between progress messages. */
	stallMs: number;
	/** SIGTERM → SIGKILL when a lane is killed. */
	killGraceMs: number;
	/** A lane that hasn't said hello by then is killed and respawned. */
	helloTimeoutMs: number;
	/** Respawn delay after a crash or kill: base × 2^(n−1) for the n-th in a row, at most max. */
	respawnBaseMs: number;
	respawnMaxMs: number;
	/** stopQueue(): `shutdown` message → SIGKILL. */
	shutdownGraceMs: number;
	/** Free space /config needs before a job is dispatched, and how often to look again. */
	minConfigFreeBytes: number;
	diskRecheckMs: number;
	/** Wait after a database error while dispatching. */
	dispatchRetryMs: number;
}

export const DEFAULT_TIMINGS: Readonly<QueueTimings> = {
	photoTimeoutMs: 300_000,
	bigPhotoTimeoutMs: 600_000,
	bigPhotoBytes: 40 * 1000 * 1000,
	videoBaseMs: 120_000,
	videoPerSecondMs: 30_000,
	stallMs: 180_000,
	killGraceMs: 10_000,
	helloTimeoutMs: 60_000,
	respawnBaseMs: 1_000,
	respawnMaxMs: 60_000,
	shutdownGraceMs: 5_000,
	minConfigFreeBytes: JOB_MIN_FREE_BYTES,
	diskRecheckMs: 60_000,
	dispatchRetryMs: 5_000
};

const NICENESS: Readonly<Record<Lane, number>> = { photo: 10, video: 15 };
const NICE_BIN = ['/usr/bin/nice', '/bin/nice'].find((p) => fs.existsSync(p)) ?? null;

interface RunningJob {
	id: string;
	startedAt: number;
	hardTimer: NodeJS.Timeout;
	stallTimer: NodeJS.Timeout | null;
}

interface LaneState {
	lane: Lane;
	child: ChildProcess | null;
	/** The child said hello and can take a job. */
	ready: boolean;
	job: RunningJob | null;
	/** Set while the child is being killed: the failure recorded for its job when it exits. */
	killing: string | null;
	/** Crashes/kills since the last `done` (respawn backoff). */
	crashes: number;
	helloTimer: NodeJS.Timeout | null;
	killTimer: NodeJS.Timeout | null;
	/** Pending respawn, low-disk recheck or dispatch retry. */
	wakeTimer: NodeJS.Timeout | null;
	/** One log line per episode for a missing worker bundle or low disk. */
	warned: 'bundle' | 'disk' | null;
}

let timings: QueueTimings = { ...DEFAULT_TIMINGS };
let lanes: LaneState[] = [];
let started = false;
let stopping = false;
const progress = new Map<string, { pct: number; etaS?: number }>();
/** Items ahead per queued id: rebuilt on demand, dropped whenever the queue moves, kept ≤ 2 s. */
let aheadCache: { at: number; ahead: Map<string, number> } | null = null;
const AHEAD_CACHE_MS = 2_000;

const secs = (ms: number) => `${Math.round(ms / 1000)} s`;

function later(fn: () => void, ms: number): NodeJS.Timeout {
	const t = setTimeout(fn, ms);
	t.unref();
	return t;
}

function clear(t: NodeJS.Timeout | null): null {
	if (t) clearTimeout(t);
	return null;
}

// ---------------------------------------------------------------------------
// Lane processes
// ---------------------------------------------------------------------------

function spawnLane(l: LaneState): void {
	l.wakeTimer = clear(l.wakeTimer);
	if (stopping) return;
	const entry = getConfig().workerEntry;
	if (!fs.existsSync(entry)) {
		if (l.warned !== 'bundle') {
			console.error(`[queue] worker bundle ${entry} is missing (run \`npm run build:worker\`); the ${l.lane} lane starts once it exists`);
		}
		l.warned = 'bundle';
		l.wakeTimer = later(() => spawnLane(l), timings.respawnMaxMs);
		return;
	}
	const nodeArgs = ['--max-old-space-size=512', entry, `--lane=${l.lane}`];
	const niceness = NICENESS[l.lane];
	const child = spawn(NICE_BIN ?? process.execPath, NICE_BIN ? ['-n', String(niceness), process.execPath, ...nodeArgs] : nodeArgs, {
		stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
		env: { ...process.env, UV_THREADPOOL_SIZE: '4' }
	});
	if (!NICE_BIN && child.pid !== undefined) {
		try {
			os.setPriority(child.pid, niceness);
		} catch {
			// not permitted here; the lane still works at normal priority
		}
	}
	l.child = child;
	l.ready = false;
	l.killing = null;
	child.on('message', (m: unknown) => onMessage(l, child, m));
	child.once('exit', (code, signal) => onExit(l, child, code === null ? `signal ${signal}` : `exit code ${code}`));
	child.on('error', (e) => {
		if (child.pid === undefined) onExit(l, child, `could not start: ${e.message}`);
		else kill(l, `IPC error: ${e.message}`);
	});
	l.helloTimer = later(() => kill(l, `it did not start within ${secs(timings.helloTimeoutMs)}`), timings.helloTimeoutMs);
}

function send(l: LaneState, msg: MainToWorker): void {
	const child = l.child;
	if (!child?.connected) return;
	child.send(msg, (err) => {
		if (err && l.child === child) kill(l, `could not send ${msg.type}: ${err.message}`);
	});
}

/** SIGTERM now, SIGKILL after the grace period. `reason` becomes the job's failure detail. */
function kill(l: LaneState, reason: string): void {
	const child = l.child;
	if (!child || l.killing) return;
	l.killing = reason;
	l.ready = false;
	l.helloTimer = clear(l.helloTimer);
	console.warn(`[queue] stopping the ${l.lane} lane (pid ${child.pid}): ${reason}`);
	child.kill('SIGTERM');
	l.killTimer = later(() => child.kill('SIGKILL'), timings.killGraceMs);
}

function onMessage(l: LaneState, child: ChildProcess, m: unknown): void {
	if (l.child !== child || l.killing || !isWorkerToMain(m)) return;
	try {
		handleMessage(l, m);
	} catch (e) {
		console.error(`[queue] ${l.lane} lane: handling ${m.type} failed:`, errorDetail(e, 500));
	}
}

function handleMessage(l: LaneState, m: WorkerToMain): void {
	switch (m.type) {
		case 'hello':
			l.ready = true;
			l.helloTimer = clear(l.helloTimer);
			if (l.warned === 'bundle') l.warned = null;
			dispatch(l);
			return;
		case 'progress':
			if (l.job?.id !== m.id || !Number.isFinite(m.pct)) return;
			progress.set(m.id, {
				pct: Math.max(0, Math.min(99, Math.floor(m.pct))),
				...(m.etaS !== undefined && Number.isFinite(m.etaS) && m.etaS >= 0 ? { etaS: Math.round(m.etaS) } : {})
			});
			armStall(l);
			return;
		case 'done': {
			const job = l.job;
			if (job?.id !== m.id) {
				console.warn(`[queue] ${l.lane} lane reported ${m.id}, which it wasn't working on`);
				return;
			}
			endJob(l);
			l.crashes = 0;
			try {
				if (m.outcome === 'failed') recordFailure(m.id, m.errorCode ?? 'retryable', m.detail || 'failed without details');
				else console.log(`[queue] ${m.id} ${m.outcome} (${l.lane}, ${secs(Date.now() - job.startedAt)})`);
			} finally {
				dispatch(l);
			}
			return;
		}
	}
}

function onExit(l: LaneState, child: ChildProcess, how: string): void {
	if (l.child !== child) return;
	l.child = null;
	l.ready = false;
	l.helloTimer = clear(l.helloTimer);
	l.killTimer = clear(l.killTimer);
	const reason = l.killing;
	l.killing = null;
	const job = l.job;
	if (job) {
		endJob(l);
		try {
			if (stopping) media.requeue(job.id, 'Interrupted by a shutdown; re-queued');
			else recordFailure(job.id, 'retryable', reason ?? `the ${l.lane} worker stopped (${how}) while working on it`);
		} catch (e) {
			console.error(`[queue] could not record the outcome of ${job.id}:`, errorDetail(e, 500));
		}
	}
	if (stopping) return;
	l.crashes++;
	const delay = Math.min(timings.respawnMaxMs, timings.respawnBaseMs * 2 ** (l.crashes - 1));
	console.error(`[queue] the ${l.lane} lane exited (${how}${reason ? `; ${reason}` : ''}); restarting in ${secs(delay)}`);
	l.wakeTimer = clear(l.wakeTimer);
	l.wakeTimer = later(() => spawnLane(l), delay);
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** retryable with attempts left → back in the queue; otherwise failed. A `ready` row is left alone. */
function recordFailure(id: string, code: ErrorCode, detail: string): void {
	const row = media.getById(id);
	if (!row) return;
	aheadCache = null;
	if (code === 'retryable' && row.attempts < MAX_ATTEMPTS) {
		if (media.requeue(id, detail)) console.warn(`[queue] ${id} will be tried again (attempt ${row.attempts} of ${MAX_ATTEMPTS} failed): ${detail}`);
		return;
	}
	const final = code === 'retryable' ? `Gave up after ${row.attempts} attempts. Last error: ${detail}` : detail;
	if (media.markFailed(id, code, final)) console.error(`[queue] ${id} (${row.source_name}) failed: ${code}: ${final}`);
}

function hardLimitMs(l: LaneState, row: media.MediaRow): number {
	if (l.lane === 'photo') return row.source_size > timings.bigPhotoBytes ? timings.bigPhotoTimeoutMs : timings.photoTimeoutMs;
	const durationS = row.duration_ms !== null ? row.duration_ms / 1000 : getConfig().maxVideoSeconds;
	return timings.videoBaseMs + timings.videoPerSecondMs * durationS;
}

function armStall(l: LaneState): void {
	const job = l.job;
	if (!job || l.lane !== 'video') return;
	clear(job.stallTimer);
	job.stallTimer = later(() => kill(l, `no progress for ${secs(timings.stallMs)}`), timings.stallMs);
}

function startJob(l: LaneState, row: media.MediaRow): void {
	const limit = hardLimitMs(l, row);
	l.job = {
		id: row.id,
		startedAt: Date.now(),
		hardTimer: later(() => kill(l, `it took longer than ${secs(limit)}`), limit),
		stallTimer: null
	};
	armStall(l);
	send(l, { type: 'job', id: row.id, kind: l.lane });
}

function endJob(l: LaneState): void {
	const job = l.job;
	if (!job) return;
	clear(job.hardTimer);
	clear(job.stallTimer);
	progress.delete(job.id);
	l.job = null;
	aheadCache = null;
}

/** /config must have room for the job's intermediates; otherwise look again later. */
function enoughScratchSpace(l: LaneState): boolean {
	let free: number;
	try {
		free = freeBytesSync(configRoot());
	} catch {
		return true; // can't tell: let the job run and fail on its own if it must
	}
	if (free >= timings.minConfigFreeBytes) {
		if (l.warned === 'disk') l.warned = null;
		return true;
	}
	if (l.warned !== 'disk') {
		console.error(
			`[queue] only ${formatBytes(free)} is free on ${configRoot()}; the ${l.lane} lane waits until ${formatBytes(timings.minConfigFreeBytes)} is free`
		);
	}
	l.warned = 'disk';
	return false;
}

function dispatch(l: LaneState): void {
	if (stopping || !l.child || !l.ready || l.job || l.killing || l.wakeTimer) return;
	try {
		if (!enoughScratchSpace(l)) {
			l.wakeTimer = later(() => {
				l.wakeTimer = null;
				dispatch(l);
			}, timings.diskRecheckMs);
			return;
		}
		// claimForProcessing only refuses rows that stopped being queued since nextQueued (a race).
		for (let i = 0; i < 10; i++) {
			const next = media.nextQueued(l.lane);
			if (!next) return;
			const row = media.claimForProcessing(next.id);
			aheadCache = null;
			if (row) {
				startJob(l, row);
				return;
			}
		}
	} catch (e) {
		console.error(`[queue] ${l.lane} lane: could not pick the next job; trying again soon:`, errorDetail(e, 500));
		l.wakeTimer = later(() => {
			l.wakeTimer = null;
			dispatch(l);
		}, timings.dispatchRetryMs);
	}
}

/** Empties /config/tmp and /photos/.work (leftovers of jobs a restart interrupted). */
function clearScratch(): void {
	for (const root of [tmpRoot(), workRoot()]) {
		fs.mkdirSync(root, { recursive: true });
		for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface QueueOptions {
	/** Overrides of DEFAULT_TIMINGS (tests use short ones). */
	timings?: Partial<QueueTimings>;
}

/**
 * Startup: runs the media self-check (in the background), clears tmp/.work, re-queues jobs a
 * restart interrupted, then spawns both lanes. Idempotent.
 */
export function startQueue(opts: QueueOptions = {}): void {
	if (started) return;
	started = true;
	stopping = false;
	timings = { ...DEFAULT_TIMINGS, ...opts.timings };
	void runSelfCheck();
	try {
		clearScratch();
	} catch (e) {
		console.error('[queue] could not clear the scratch folders:', errorDetail(e, 500));
	}
	try {
		const { requeued, failed } = media.requeueInterrupted();
		if (requeued.length > 0) console.warn(`[queue] re-queued ${requeued.length} item(s) interrupted by a restart`);
		if (failed.length > 0) console.error(`[queue] ${failed.length} item(s) failed after ${MAX_ATTEMPTS} interrupted attempts: ${failed.join(', ')}`);
	} catch (e) {
		console.error('[queue] could not re-queue interrupted jobs:', errorDetail(e, 500));
	}
	lanes = LANES.map((lane) => ({
		lane,
		child: null,
		ready: false,
		job: null,
		killing: null,
		crashes: 0,
		helloTimer: null,
		killTimer: null,
		wakeTimer: null,
		warned: null
	}));
	for (const l of lanes) spawnLane(l);
}

/** New work is queued (intake, "Try again", admin reprocess): idle lanes pick it up now. */
export function wakeQueue(): void {
	aheadCache = null;
	for (const l of lanes) dispatch(l);
}

/**
 * Shutdown: asks each lane to stop (`shutdown`: the running job is aborted), SIGKILLs it after
 * the grace period, and resolves once every child has exited. Jobs cut short are re-queued.
 */
export async function stopQueue(): Promise<void> {
	if (!started) return;
	stopping = true;
	await Promise.all(
		lanes.map((l) => {
			l.wakeTimer = clear(l.wakeTimer);
			l.helloTimer = clear(l.helloTimer);
			const child = l.child;
			if (!child) return Promise.resolve();
			return new Promise<void>((resolve) => {
				const force = later(() => child.kill('SIGKILL'), timings.shutdownGraceMs);
				child.once('exit', () => {
					clearTimeout(force);
					resolve();
				});
				if (child.connected) send(l, { type: 'shutdown' });
				else child.kill('SIGTERM');
			});
		})
	);
	lanes = [];
	progress.clear();
	aheadCache = null;
	started = false;
	stopping = false;
}

/** Last progress of an item being processed (videos: 0–99, ETA when known). */
export function getProgress(id: string): { pct: number; etaS?: number } | undefined {
	return progress.get(id);
}

/**
 * Items ahead of a queued item in its lane (0 = it is next): its place in media.queueOrder(), plus
 * one when the lane is busy with another job. undefined when the item isn't queued.
 */
export function queuePosition(id: string): number | undefined {
	const now = Date.now();
	if (!aheadCache || now - aheadCache.at > AHEAD_CACHE_MS) {
		const ahead = new Map<string, number>();
		for (const lane of LANES) {
			const busy = lanes.some((l) => l.lane === lane && l.job) ? 1 : 0;
			media.queueOrder(lane, now).forEach((qid, i) => ahead.set(qid, i + busy));
		}
		aheadCache = { at: now, ahead };
	}
	return aheadCache.ahead.get(id);
}
