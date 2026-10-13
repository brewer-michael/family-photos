/**
 * Poster and thumbnail for a video: one representative frame (ffmpeg → PNG on stdout) encoded by
 * sharp into cache/<sh>/<id>/poster.webp (≤ 1920 box, q80) and thumb.webp (480 box, q76).
 * Written to the job's tmp dir and renamed into the cache (same filesystem), so a tile never
 * sees a half-written file.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { WorkerContext } from '../context';
import { run } from '../spawn';

const POSTER_TIMEOUT_MS = 120_000;

let sharpConfigured = false;

/** Runs ffmpeg with `args` (PNG on stdout) and installs poster.webp + thumb.webp for `id`. */
export async function makePoster(id: string, args: readonly string[], ctx: WorkerContext): Promise<void> {
	if (!sharpConfigured) {
		sharp.concurrency(2);
		sharp.cache(false);
		sharpConfigured = true;
	}
	const { stdout: png } = await run(ctx.config.ffmpegBin, args, {
		timeoutMs: POSTER_TIMEOUT_MS,
		signal: ctx.signal,
		ionice: true
	});
	if (png.length === 0) throw new Error('ffmpeg produced no poster frame');
	const tmp = ctx.paths.tmpDir(id);
	const variants = [
		{ variant: 'poster', box: 1920, quality: 80 },
		{ variant: 'thumb', box: 480, quality: 76 }
	] as const;
	for (const v of variants) {
		await sharp(png)
			.resize({ width: v.box, height: v.box, fit: 'inside', withoutEnlargement: true })
			.webp({ quality: v.quality, smartSubsample: true, effort: 4 })
			.toFile(path.join(tmp, `${v.variant}.webp`));
	}
	const dest = ctx.paths.cacheDir(id);
	await fs.mkdir(dest, { recursive: true });
	for (const v of variants) {
		await fs.rename(path.join(tmp, `${v.variant}.webp`), ctx.paths.cacheFile(id, v.variant));
	}
}
