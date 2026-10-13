/**
 * Intake (main process): received → queued | duplicate | failed, one item at a time and never
 * inside a request (docs/media-pipeline.md §5 "Item lifecycle"):
 *
 *   sha  = streaming SHA-256 of .incoming/<token>
 *   same bytes live in the album  → duplicate (the upload and its .json are deleted)
 *   det  = detectFile()           → not a photo/video: failed/unsupported (the source is kept)
 *   videos: probeVideo()          → est_cost_s for lane ordering; too long/big → failed/too_large
 *   markQueued()                  → queued (or duplicate, re-checked atomically) → wakeQueue()
 *
 * Detection and probing failures arrive as MediaError and fail the item with that code; anything
 * unexpected fails it as `retryable` ("Try again" sends it back through intake). Nothing here ever
 * throws into the caller: a row whose failure couldn't even be recorded stays `received` and is
 * picked up by the next wake or the periodic sweep.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { getConfig } from './config';
import { incomingPath } from './paths';
import * as media from './repo/media';
import { setSourceDuration } from './repo/uploads';
import { detectFile, type DetectResult } from './media/detect';
import { estimateCostS, probeVideo } from './media/probe';
import { wakeQueue } from './queue';
import { MediaError, errorDetail } from '#lib/shared/errors';

/** Safety net for rows left `received` (e.g. a database hiccup while recording a failure). */
const SWEEP_MS = 60_000;

/** Hex SHA-256 of a file, streamed in 1 MiB reads. */
export async function sha256File(file: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) hash.update(chunk as Buffer);
	return hash.digest('hex');
}

/** Deletes a tus upload and its FileStore metadata file. */
async function removeUpload(token: string): Promise<void> {
	const file = incomingPath(token);
	await Promise.all([fs.promises.rm(file, { force: true }), fs.promises.rm(`${file}.json`, { force: true })]);
}

async function intakeOne(row: media.MediaRow): Promise<void> {
	const { id, upload_token: token } = row;
	let sha: string | null = null;
	let det: DetectResult | null = null;
	try {
		if (!token) throw new MediaError('corrupt', 'received without an upload token');
		const file = incomingPath(token);
		try {
			sha = await sha256File(file);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new MediaError('corrupt', `the uploaded file is missing (${file})`);
			throw e;
		}

		const dup = media.findDuplicate(row.album_id, sha, id);
		if (dup) {
			if (media.markDuplicate(id, dup.id, sha)) await removeUpload(token);
			console.log(`[intake] ${id} is a duplicate of ${dup.id}`);
			return;
		}

		det = await detectFile(file);
		if (!det.kind) throw new MediaError('unsupported', `not a photo or video (detected ${det.mime})`);

		let estCostS: number | null = null;
		let durationMs: number | null = null;
		if (det.kind === 'video') {
			const probe = await probeVideo(file, { maxDurationS: getConfig().maxVideoSeconds });
			estCostS = estimateCostS(probe);
			durationMs = probe.durationS * 1000;
		}

		const r = media.markQueued(id, { kind: det.kind, sourceMime: det.mime, sourceExt: det.ext, sourceSha256: sha, estCostS });
		if (r.outcome === 'duplicate') {
			await removeUpload(token);
			console.log(`[intake] ${id} is a duplicate of ${r.duplicateOf}`);
			return;
		}
		if (durationMs !== null) setSourceDuration(id, durationMs);
		console.log(`[intake] ${id} queued (${det.kind}, ${det.mime})`);
		wakeQueue();
	} catch (e) {
		const err = MediaError.is(e) ? e : new MediaError('retryable', errorDetail(e));
		// A retryable failure keeps kind unset, so "Try again" re-runs intake from the start.
		media.markFailed(id, err.code, err.detail, {
			kind: err.code === 'retryable' ? null : (det?.kind ?? null),
			sourceMime: det?.mime ?? null,
			sourceExt: det?.ext ?? null,
			sourceSha256: sha
		});
		console.warn(`[intake] ${id} (${row.source_name}) failed: ${err.code}: ${err.detail}`);
	}
}

let draining: Promise<void> | null = null;
let again = false;
let sweep: NodeJS.Timeout | null = null;
let stopped = false;

/** One pass over the `received` rows, oldest first; each row is tried at most once per pass. */
async function drainOnce(): Promise<void> {
	const tried = new Set<string>();
	while (!stopped) {
		// Of the first tried+1 rows at least one is untried (pigeonhole), so stuck rows can't hide newer ones.
		const row = media.listReceived({ limit: tried.size + 1 }).find((r) => !tried.has(r.id));
		if (!row) return;
		tried.add(row.id);
		try {
			await intakeOne(row);
		} catch (e) {
			console.error(`[intake] ${row.id} could not be processed; it will be tried again later:`, errorDetail(e, 500));
		}
	}
}

/**
 * Processes `received` rows until none are left (the tus onUploadFinish hook and "Try again" call
 * this). Calls while a pass is running schedule one more pass. The promise resolves when intake is
 * idle again and never rejects.
 */
export function wakeIntake(): Promise<void> {
	if (stopped) return draining ?? Promise.resolve();
	again = true;
	draining ??= (async () => {
		try {
			while (again) {
				again = false;
				await drainOnce();
			}
		} catch (e) {
			console.error('[intake] stopped early; the next wake retries:', errorDetail(e, 500));
		} finally {
			draining = null;
		}
	})();
	return draining;
}

/** Startup: drains rows left `received` by a restart, then keeps a slow sweep running. */
export function startIntake(): void {
	if (sweep) return;
	stopped = false;
	sweep = setInterval(() => void wakeIntake(), SWEEP_MS);
	sweep.unref();
	void wakeIntake();
}

/**
 * Shutdown: no new passes; resolves when the item in progress is done (its row is then either
 * finished or still `received`, which the next start picks up).
 */
export function stopIntake(): Promise<void> {
	stopped = true;
	again = false;
	if (sweep) clearInterval(sweep);
	sweep = null;
	return draining ?? Promise.resolve();
}
