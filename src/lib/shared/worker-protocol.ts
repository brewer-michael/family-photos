/**
 * IPC protocol between the web process (src/lib/server/queue.ts) and a worker
 * lane child process (build-worker/worker.js --lane=photo|video).
 *
 * Contract:
 * - The main process owns state transitions except success: it calls
 *   media.claimForProcessing(id) (status=processing, attempts++) BEFORE sending
 *   `job`, and on `done` with outcome 'failed' it decides retry vs failed
 *   (media.requeue / media.markFailed). A crash/timeout (no `done`) is treated
 *   as a retryable failure by the main process.
 * - The worker commits success itself (processPhoto/processVideo call
 *   media.markReady inside the commit sequence) and then sends `done` 'ready'.
 * - A failure reported after the commit (cleanup threw, timeout or crash after
 *   markReady) must not undo it: requeue/markFailed only touch unfinished rows and
 *   return false for a `ready` one, and the main process then treats the job as done.
 *   Workers should not throw after markReady returned true (log cleanup errors).
 * - One job at a time per lane. The worker sends `hello` once it is ready.
 * - A `job` with task 'previews' rebuilds a ready item's previews from library/: nothing was
 *   claimed and the worker writes nothing to the row, so its `done` is only logged.
 */
import type { ErrorCode, Kind } from './media-types';

export type Lane = Kind;

export const LANES: readonly Lane[] = ['photo', 'video'];

export interface JobMessage {
	type: 'job';
	id: string;
	kind: Kind;
	/**
	 * 'previews': rebuild a ready item's previews in cache/ from its file in library/
	 * (src/worker/previews.ts). The row is not claimed and never changes; a failure is only logged.
	 * Absent: convert the item (a first conversion, or an admin redo).
	 */
	task?: 'previews';
}

/** Ask the worker to abort the running job (ctx.signal fires). */
export interface CancelMessage {
	type: 'cancel';
	id: string;
}

/** Finish the current job (or abort after a grace period) and exit. */
export interface ShutdownMessage {
	type: 'shutdown';
}

export type MainToWorker = JobMessage | CancelMessage | ShutdownMessage;

export interface HelloMessage {
	type: 'hello';
	lane: Lane;
	pid: number;
}

export interface ProgressMessage {
	type: 'progress';
	id: string;
	/** 0–99 (100 is implied by `done`). */
	pct: number;
	etaS?: number;
}

export type DoneOutcome = 'ready' | 'failed' | 'duplicate';

export interface DoneMessage {
	type: 'done';
	id: string;
	outcome: DoneOutcome;
	/** Present when outcome is 'failed'. */
	errorCode?: ErrorCode;
	/** Admin-only detail when outcome is 'failed'. */
	detail?: string;
}

export type WorkerToMain = HelloMessage | ProgressMessage | DoneMessage;

export function isMainToWorker(m: unknown): m is MainToWorker {
	if (typeof m !== 'object' || m === null) return false;
	const t = (m as { type?: unknown }).type;
	return t === 'job' || t === 'cancel' || t === 'shutdown';
}

export function isWorkerToMain(m: unknown): m is WorkerToMain {
	if (typeof m !== 'object' || m === null) return false;
	const t = (m as { type?: unknown }).type;
	return t === 'hello' || t === 'progress' || t === 'done';
}

export function parseLaneArg(argv: readonly string[]): Lane | null {
	for (const a of argv) {
		const m = /^--lane=(photo|video)$/.exec(a);
		if (m) return m[1] as Lane;
	}
	return null;
}
