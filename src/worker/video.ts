/**
 * Video lane job (docs/media-pipeline.md §3, no 4K option): probe → plan → poster first →
 * remux/transcode into .work/<id>/<id>.mp4 with progress → exiftool date/place → verify →
 * fsync → rename into library/ → media.markReady → archive or delete the source.
 *
 * Called by main.ts for a row the main process already claimed ('processing'). Known failures
 * are thrown as MediaError(code, detail); the main process decides retry. Nothing throws after
 * markReady() returned true. tmp/<id> and .work/<id> are removed in `finally`.
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

let capsLogged = false;

/** ffmpeg capabilities, logged once per lane (on its first job). */
async function laneCaps(ctx: WorkerContext): Promise<FfmpegCaps> {
	const caps = await ffmpegCaps();
	if (!capsLogged) {
		capsLogged = true;
		ctx.log.info(`ffmpeg: ${caps.version}`, { zscale: caps.zscale, tonemap: caps.tonemap, problems: capsProblems(caps) });
	}
	return caps;
}

async function fsyncPath(p: string): Promise<void> {
	const fh = await fs.open(p, 'r');
	try {
		await fh.sync();
	} finally {
		await fh.close();
	}
}

export async function processVideo(id: string, ctx: WorkerContext): Promise<void> {
	const row = media.getById(id);
	if (!row) throw new MediaError('unsupported', `media ${id} not found`);
	const src = media.sourcePath(row);
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
	try {
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
		ctx.progress(0);

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

		await runConversion(ctx.config.ffmpegBin, plan.args, {
			expectedDurationS: plan.expectedDurationS,
			sourceDurationS: probe.durationS,
			signal: ctx.signal,
			progress: ctx.progress
		});
		await writeVideoMetadata(out, taken, gps);
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

		const size = await installCanonical(out, ctx.paths.libraryPath(id, 'mp4'));
		const keep = ctx.config.keepOriginals && plan.lossy;
		const ext = row.source_ext ?? 'bin';
		const committed = media.markReady(id, {
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
		if (!committed) throw new MediaError('retryable', `media ${id} is no longer processing; not committed`);
		await settleSource(id, src, keep, ext, ctx);
	} finally {
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

/**
 * After the commit: archive the source in originals/ (lossy conversion and KEEP_ORIGINALS) or
 * delete it. Never throws; if archiving fails the row is corrected to "no original kept".
 */
async function settleSource(id: string, src: string, keep: boolean, ext: string, ctx: WorkerContext): Promise<void> {
	const archived = ctx.paths.originalsPath(id, ext);
	try {
		if (!keep) {
			await fs.rm(src, { force: true });
		} else if (src !== archived) {
			await fs.mkdir(path.dirname(archived), { recursive: true });
			await fs.rename(src, archived);
		}
	} catch (e) {
		ctx.log.error(`video ${id}: could not ${keep ? 'archive' : 'delete'} the source`, { error: errorDetail(e, 500) });
		if (keep) media.markOriginalDeleted(id);
	}
}
