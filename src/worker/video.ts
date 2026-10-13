/**
 * Video lane job (docs/media-pipeline.md §3, no 4K option): probe → plan → poster first →
 * remux/transcode into .work/<id>/<id>.mp4 with progress → exiftool date/place → verify →
 * fsync → rename into library/ → media.markReady → archive or delete the source → release the
 * upload token (./settle.ts).
 *
 * Called by main.ts for a row the main process already claimed ('processing'). Known failures
 * are thrown as MediaError(code, detail); the main process decides retry. Nothing throws after
 * markReady() returned true. tmp/<id> and .work/<id> are removed in `finally`.
 *
 * Progress: ffmpeg reports its own; the steps before and after it (probe, poster, exiftool rewrite,
 * verify, fsync) re-send 0 / 99 % every 30 s, so the queue's "no progress for 180 s" rule only
 * catches a lane that has really stopped.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as media from '#lib/server/repo/media';
import { capsProblems, ffmpegCaps, probeFirstFrameHdr, probeVideo, type FfmpegCaps } from '#lib/server/media/probe';
import { MediaError, errorDetail } from '#lib/shared/errors';
import type { WorkerContext } from './context';
import { creationTimeFor, parseIso6709, resolveTaken, writeVideoMetadata } from './video/metadata';
import { planVideo } from './video/plan';
import { makePoster } from './video/poster';
import { runConversion, toMediaError } from './video/progress';
import { verifyOutput } from './video/verify';
import { fsyncPath, locateSource, settleSource } from './settle';
import { keepLive, undoInstall } from './redo';

let capsLogged = false;

const HEARTBEAT_MS = 30_000;

/** ffmpeg capabilities, logged once per lane (on its first job). */
async function laneCaps(ctx: WorkerContext): Promise<FfmpegCaps> {
	const caps = await ffmpegCaps();
	if (!capsLogged) {
		capsLogged = true;
		ctx.log.info(`ffmpeg: ${caps.version}`, { zscale: caps.zscale, tonemap: caps.tonemap, problems: capsProblems(caps) });
	}
	return caps;
}

/** Re-sends a fixed pct every 30 s while armed (`at`), for steps that report no progress of their own. */
function heartbeat(ctx: WorkerContext) {
	let timer: NodeJS.Timeout | null = null;
	const stop = () => {
		if (timer) clearInterval(timer);
		timer = null;
	};
	return {
		at(pct: number) {
			stop();
			ctx.progress(pct);
			timer = setInterval(() => ctx.progress(pct), HEARTBEAT_MS);
		},
		stop
	};
}

export async function processVideo(id: string, ctx: WorkerContext): Promise<void> {
	const row = media.getById(id);
	if (!row) throw new MediaError('unsupported', `media ${id} not found`);
	/** Admin "Redo them": the item stays ready and keeps its live file until markRedone() commits. */
	const redo = media.isRedo(row);
	const src = await locateSource(row);
	if (!src) throw new MediaError('corrupt', 'the uploaded file is gone');
	try {
		await fs.access(src);
	} catch {
		throw new MediaError('corrupt', `the uploaded file is missing (${src})`);
	}
	const tmp = ctx.paths.tmpDir(id);
	const work = ctx.paths.workDir(id);
	await Promise.all([tmp, work].map((d) => fs.rm(d, { recursive: true, force: true })));
	await Promise.all([tmp, work].map((d) => fs.mkdir(d, { recursive: true })));
	const beat = heartbeat(ctx);
	try {
		beat.at(0);
		const caps = await laneCaps(ctx);
		const probe = await probeVideo(src, { maxDurationS: ctx.config.maxVideoSeconds, decoders: caps.decoders, signal: ctx.signal });
		const hdrMeta =
			probe.hdrClass === 'pq' && probe.maxCll === null && probe.masteringMaxLum === null
				? await probeFirstFrameHdr(src, probe.videoIndex, { signal: ctx.signal })
				: undefined;
		const taken = resolveTaken({
			creationDate: probe.tags.creationDate,
			creationTime: probe.tags.creationTime,
			clientMtimeMs: row.client_mtime_ms,
			uploadedMs: row.created_at
		});
		const gps = parseIso6709(probe.tags.location);
		const out = path.join(work, `${id}.mp4`);
		const plan = planVideo(probe, {
			caps,
			threads: ctx.config.videoThreads,
			src,
			out,
			creationTime: creationTimeFor(taken.takenMs),
			hdrMeta
		});
		ctx.log.info(`video ${id}: ${plan.mode} ${probe.codec} ${probe.displayWidth}×${probe.displayHeight} → ${plan.width}×${plan.height}`, {
			colour: plan.colour,
			peak: plan.peak,
			fpsIn: Number(plan.fpsIn.toFixed(3)),
			fpsOut: Number(plan.fpsOut.toFixed(3)),
			slowmo: plan.slowmo,
			interlaced: plan.interlaced,
			audioCopy: plan.audioCopy,
			audioDropped: plan.audioDropped
		});

		// Poster first, so the tile shows a picture while the video converts. If the source frame
		// can't be grabbed, it is taken from the canonical file after conversion instead.
		let poster = true;
		try {
			await makePoster(id, plan.posterArgs, ctx);
		} catch (e) {
			if (ctx.signal.aborted) throw toMediaError(e, 'poster');
			poster = false;
			ctx.log.warn(`video ${id}: poster from the source failed; retrying from the converted file`, { error: errorDetail(e, 500) });
		}

		beat.stop();
		await runConversion(ctx.config.ffmpegBin, plan.args, {
			expectedDurationS: plan.expectedDurationS,
			sourceDurationS: probe.durationS,
			signal: ctx.signal,
			progress: ctx.progress
		});
		beat.at(99);
		await writeVideoMetadata(out, taken, gps, ctx.signal);
		const durationS = await verifyOutput(out, { mode: plan.mode, audio: plan.audioIndex !== null, expectedDurationS: plan.expectedDurationS }, ctx.signal);
		if (!poster) {
			const canonical = await probeVideo(out, { decoders: caps.decoders, signal: ctx.signal, maxDurationS: Infinity });
			const { posterArgs } = planVideo(canonical, { caps, threads: ctx.config.videoThreads, src: out, out, creationTime: null });
			try {
				await makePoster(id, posterArgs, ctx);
			} catch (e) {
				throw toMediaError(e, 'poster');
			}
		}

		const dest = ctx.paths.libraryPath(id, 'mp4');
		// A redo replaces the live file: keep it until the row says otherwise (./redo.ts).
		const live = redo ? await keepLive(dest, work) : null;
		const keep = ctx.config.keepOriginals && plan.lossy;
		const ext = row.source_ext ?? 'bin';
		let committed = false;
		try {
			const size = await installCanonical(out, dest);
			committed = (redo ? media.markRedone : media.markReady)(id, {
				conversion: plan.mode,
				canonicalExt: 'mp4',
				canonicalSize: size,
				width: plan.width,
				height: plan.height,
				durationMs: Math.round(durationS * 1000),
				hdrTonemapped: plan.colour === 'hdr',
				audioDropped: plan.audioDropped,
				slowmoRetimed: plan.slowmo,
				takenAt: taken.takenAt,
				takenMs: taken.takenMs,
				gpsLat: gps?.lat ?? null,
				gpsLon: gps?.lon ?? null,
				gpsAlt: gps?.alt ?? null,
				contentId: probe.tags.contentId,
				sourceKept: keep,
				sourceExt: ext
			});
		} finally {
			// Not committed: no row describes the file just installed; take it out of library/ again
			// (a redo's live file goes back).
			if (!committed) await undoInstall(dest, live).catch(() => undefined);
		}
		if (!committed) throw new MediaError('retryable', `media ${id} is no longer ${redo ? 'being redone' : 'processing'}; not committed`);
		// Committed: nothing below may fail the item (src/worker/README.md).
		await settleSource(id, src, keep, ext, ctx.log, `video ${id}`);
	} finally {
		beat.stop();
		await Promise.all([tmp, work].map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => undefined)));
	}
}

/** fsync the verified output, rename it into library/ (same filesystem) and fsync the directory. Returns its size. */
async function installCanonical(out: string, dest: string): Promise<number> {
	await fsyncPath(out);
	await fs.mkdir(path.dirname(dest), { recursive: true });
	await fs.rename(out, dest);
	await fsyncPath(path.dirname(dest));
	return (await fs.stat(dest)).size;
}
