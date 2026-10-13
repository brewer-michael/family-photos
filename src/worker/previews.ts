/**
 * A `previews` job (worker-protocol JobMessage.task): rebuilds a ready item's previews in
 * cache/<sh>/<id>/ (thumb.webp + display.webp for a photo, thumb.webp + poster.webp for a video)
 * from its canonical file in library/, with the same builders a lane uses when the item is first
 * added (docs/PLAN.md "Storage layout": cache/ is rebuildable from library/). The canonical file is
 * already upright and browser-safe (a video's is SDR BT.709), so it needs no tone mapping or
 * decoding step of its own.
 *
 * Queued by the main process (queue.ts) for ready items whose previews are missing: at every start,
 * and from the admin page's "Rebuild missing previews", only while no upload or redo waits. The
 * job never changes the row: the item stays ready and visible, and "Save" keeps working, the whole
 * time. A failure is reported like any job's (MediaError), and the main process only logs it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as media from '#lib/server/repo/media';
import { ffmpegCaps, probeVideo } from '#lib/server/media/probe';
import { MediaError } from '#lib/shared/errors';
import type { WorkerContext } from './context';
import { makeDerivatives, type DerivativeDate } from './photo/encode';
import { planVideo } from './video/plan';
import { makePoster } from './video/poster';
import { toMediaError } from './video/progress';

type Row = Pick<media.MediaRow, 'taken_at' | 'taken_ms' | 'created_at'>;

/**
 * The date a photo's display.webp carries, from the row (photo.ts builds the same from the
 * source's tags): the local taken time with its offset, or the UTC instant when only that is known.
 */
export function rowDerivativeDate(row: Row): DerivativeDate {
	if (row.taken_at) {
		const offset = /([+-]\d{2}:\d{2}|Z)$/.exec(row.taken_at)?.[1] ?? null;
		return {
			exif: row.taken_at.slice(0, 19).replace('T', ' ').replaceAll('-', ':'),
			offset: offset === 'Z' ? '+00:00' : offset
		};
	}
	const utc = new Date(row.taken_ms ?? row.created_at).toISOString().slice(0, 19);
	return { exif: utc.replace('T', ' ').replaceAll('-', ':'), offset: '+00:00' };
}

/**
 * Rebuilds the previews of a ready item from library/. Returns false when there is nothing to do
 * (the item is gone or not ready any more). Throws MediaError when they can't be built.
 */
export async function rebuildPreviews(id: string, ctx: WorkerContext): Promise<boolean> {
	const row = media.getById(id);
	if (!row || row.status !== 'ready' || !row.kind || !row.canonical_ext) return false;
	if (row.kind !== ctx.lane) throw new MediaError('retryable', `the previews of a ${row.kind} were sent to the ${ctx.lane} lane`);
	const file = ctx.paths.libraryPath(id, row.canonical_ext);
	try {
		await fs.access(file);
	} catch {
		throw new MediaError('corrupt', `its file in library/ is missing (${file})`);
	}
	const tmp = ctx.paths.tmpDir(id);
	await fs.rm(tmp, { recursive: true, force: true });
	await fs.mkdir(tmp, { recursive: true });
	try {
		if (row.kind === 'photo') await photoPreviews(row, file, tmp, ctx);
		else await videoPreviews(id, file, tmp, ctx);
	} finally {
		await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
	}
	return true;
}

/** display.webp + thumb.webp, built in tmp/ and renamed into the cache (a tile never sees half a file). */
async function photoPreviews(row: media.MediaRow, file: string, tmp: string, ctx: WorkerContext): Promise<void> {
	const out = { display: path.join(tmp, 'display.webp'), thumb: path.join(tmp, 'thumb.webp') };
	const date = rowDerivativeDate(row);
	try {
		await makeDerivatives(file, out, date);
	} catch (e) {
		// Like the lane: a passthrough JPEG that fails only on a decoder warning is built leniently.
		if (row.conversion !== 'none' || row.canonical_ext !== 'jpg' || !MediaError.is(e) || e.code !== 'corrupt') throw e;
		ctx.log.warn(`photo ${row.id}: JPEG decoder warning; building previews leniently`, { error: e.detail });
		await makeDerivatives(file, out, date, 'error');
	}
	if (ctx.signal.aborted) throw new MediaError('retryable', 'cancelled');
	await fs.mkdir(ctx.paths.cacheDir(row.id), { recursive: true });
	await fs.rename(out.display, ctx.paths.cacheFile(row.id, 'display'));
	await fs.rename(out.thumb, ctx.paths.cacheFile(row.id, 'thumb'));
}

/** poster.webp + thumb.webp from a frame of the canonical MP4 (makePoster installs both). */
async function videoPreviews(id: string, file: string, tmp: string, ctx: WorkerContext): Promise<void> {
	const caps = await ffmpegCaps();
	const probe = await probeVideo(file, { decoders: caps.decoders, signal: ctx.signal, maxDurationS: Infinity });
	// Only the poster arguments are used; `out` is never written.
	const { posterArgs } = planVideo(probe, { caps, threads: ctx.config.videoThreads, src: file, out: path.join(tmp, `${id}.mp4`), creationTime: null });
	try {
		await makePoster(id, posterArgs, ctx);
	} catch (e) {
		throw toMediaError(e, 'poster');
	}
}
