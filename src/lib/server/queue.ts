/**
 * Worker lanes (main process side). STUB — the queue track implements this.
 *
 * Final contract:
 * - startQueue(): requeueInterrupted(), clear tmp/.work, run the media self-check, spawn one
 *   child per lane:
 *     spawn('nice', ['-n', photo ? '10' : '15', process.execPath, '--max-old-space-size=512',
 *            config.workerEntry, `--lane=${lane}`], { stdio: ['ignore','inherit','inherit','ipc'],
 *            env: { ...process.env, UV_THREADPOOL_SIZE: '4' } })
 *   then loop: media.nextQueued(lane) → media.claimForProcessing(id) → send {type:'job'}.
 *   On `done` failed: retryable && attempts < MAX_ATTEMPTS → media.requeue, else media.markFailed.
 *   Crash/timeout without `done` counts as retryable. Both return false when the row is already
 *   `ready` (the worker committed before failing): treat that as success, never alert or retry.
 *   Messages: #lib/shared/worker-protocol.
 * - wakeQueue(): called by intake after markQueued (and by admin retry) to start idle lanes.
 * - stopQueue(): SIGTERM the children, SIGKILL after ~10 s, resolve when they exited.
 * - getProgress(id): last progress message for an item being processed (in memory only).
 * - queuePosition(id): items ahead of `id` in its lane (0 = next), undefined if not queued.
 */
const progress = new Map<string, { pct: number; etaS?: number }>();

export function startQueue(): void {
	// TODO(queue track): spawn worker lanes and run the scheduling loop.
}

export function wakeQueue(): void {
	// TODO(queue track)
}

export async function stopQueue(): Promise<void> {
	// TODO(queue track): terminate lane children.
	progress.clear();
}

export function getProgress(id: string): { pct: number; etaS?: number } | undefined {
	return progress.get(id);
}

export function queuePosition(id: string): number | undefined {
	void id;
	// TODO(queue track): index of id in media.queueOrder(kind).
	return undefined;
}
