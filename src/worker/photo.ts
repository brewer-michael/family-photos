/**
 * Photo lane job (docs/media-pipeline.md §1 photo rows and §2): detect from bytes → read the
 * source's metadata → build the one canonical JPEG/PNG/GIF, or keep the source bytes → verify →
 * derivatives → fsync → rename into library/ → media.markReady → archive or delete the source.
 *
 * Routes by detected subtype:
 *   jpeg       RGB/grey → the source bytes ('none'); CMYK/YCCK → sRGB JPEG
 *   png        the source bytes; EXIF Orientation ≠ 1 (not APNG) → losslessly rotated PNG
 *   gif        the source bytes
 *   webp       animated → GIF; lossless (VP8L) → PNG; lossy → JPEG (PNG with real transparency)
 *   heif/avif  heif-info + heif-dec → PNG → JPEG (PNG with real transparency)
 *   tiff       page 0 → JPEG (PNG with real transparency); a RAW that looked like TIFF → raw
 *   bmp        ffmpeg → PNG;  jxl, jp2, psd: ffmpeg → JPEG (PNG with real transparency)
 *   raw        the largest embedded JPEG preview (≥ 1600 px) with the RAW's tags
 *
 * Called by main.ts for a row the main process already claimed ('processing'). Known failures are
 * thrown as MediaError(code, detail); the main process decides retry. Nothing throws after
 * markReady() returned true. tmp/<id> and .work/<id> are removed in `finally`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Metadata } from 'sharp';
import { detectFile, type DetectResult } from '#lib/server/media/detect';
import * as media from '#lib/server/repo/media';
import { MediaError, errorDetail } from '#lib/shared/errors';
import type { Conversion } from '#lib/shared/media-types';
import type { WorkerContext } from './context';
import {
	animatedToGif,
	encodeCanonical,
	inspectCanonical,
	makeDerivatives,
	probeImage,
	type DerivativeDate,
	type Encoded
} from './photo/encode';
import { ffmpegDecode } from './photo/ffmpeg';
import { decodeHeif, readHeifInfo } from './photo/heif';
import { displayP3Icc, embedIccInPng } from './photo/icc';
import {
	copyExif,
	copyRawTags,
	exiftoolTransient,
	hasExif,
	photoMeta,
	readSourceTags,
	type PhotoMeta,
	type SourceTags,
	type Taken
} from './photo/metadata';
import { RAW_FILE_TYPES, rawPreview } from './photo/raw';
import { ffmpegImageTools, heifTools, photoToolProblems } from './photo/tools';

/** sharp's default limitInputPixels (0x3FFF²): larger photos fail as too_large. */
const MAX_PIXELS = 268_402_689;
/** nclx colour_primaries of Display P3 (SMPTE EG 432-1). */
const NCLX_DISPLAY_P3 = 12;
/** nclx transfer_characteristics of HDR photos: PQ (SMPTE ST 2084) and HLG (ARIB STD-B67). */
const NCLX_HDR_TRANSFER: Readonly<Record<number, string>> = { 16: 'PQ', 18: 'HLG' };

interface Canonical extends Encoded {
	conversion: Conversion;
}

interface Job {
	id: string;
	src: string;
	sizeBytes: number;
	det: DetectResult;
	tags: SourceTags;
	meta: PhotoMeta;
	ctx: WorkerContext;
	/** .work/<id>/<id> — the canonical output without its extension. */
	outBase: string;
}

let toolsLogged = false;

/** Logs the decoders once per lane, and what an admin should install (also on the self-check). */
async function logTools(ctx: WorkerContext): Promise<void> {
	if (toolsLogged) return;
	toolsLogged = true;
	const [h, f] = await Promise.all([heifTools(), ffmpegImageTools()]);
	ctx.log.info(`photo tools: ${path.basename(h.decBin)} libheif ${h.version ?? 'missing'}`, { decoders: h.decoders, ffmpeg: f.decodes });
	for (const p of photoToolProblems(h, f)) ctx.log.warn(p);
}

export async function processPhoto(id: string, ctx: WorkerContext): Promise<void> {
	const row = media.getById(id);
	if (!row) throw new MediaError('unsupported', `media ${id} not found`);
	const src = media.sourcePath(row);
	if (!src) throw new MediaError('corrupt', 'the uploaded file is gone');
	let sizeBytes: number;
	try {
		sizeBytes = (await fs.stat(src)).size;
	} catch {
		throw new MediaError('corrupt', `the uploaded file is missing (${src})`);
	}
	await logTools(ctx);
	const tmp = ctx.paths.tmpDir(id);
	const work = ctx.paths.workDir(id);
	await Promise.all([tmp, work].map((d) => fs.rm(d, { recursive: true, force: true })));
	await Promise.all([tmp, work].map((d) => fs.mkdir(d, { recursive: true })));
	const started = Date.now();
	try {
		const det = await detectFile(src);
		if (det.kind !== 'photo' || !det.subtype) throw new MediaError('unsupported', `not a photo (detected ${det.mime})`);
		const tags = await sourceTags(src, ctx);
		const meta = photoMeta(tags, { clientMtimeMs: row.client_mtime_ms, uploadedMs: row.created_at });
		const job: Job = { id, src, sizeBytes, det, tags, meta, ctx, outBase: path.join(work, id) };

		const canon = await buildCanonical(job);
		const shown = await inspectCanonical(canon.file, canon.ext);
		const derivs = { display: path.join(tmp, 'display.webp'), thumb: path.join(tmp, 'thumb.webp') };
		await derivatives(job, canon, derivs);
		if (ctx.signal.aborted) throw new MediaError('retryable', 'cancelled');

		// Commit: derivatives into the cache, then the canonical file into library/ and the row, so
		// nothing but the database stands between a moved passthrough source and its commit.
		await fs.mkdir(ctx.paths.cacheDir(id), { recursive: true });
		await fs.rename(derivs.display, ctx.paths.cacheFile(id, 'display'));
		await fs.rename(derivs.thumb, ctx.paths.cacheFile(id, 'thumb'));
		const dest = ctx.paths.libraryPath(id, canon.ext);
		await fsyncPath(canon.file);
		const canonicalSize = (await fs.stat(canon.file)).size;
		await fs.mkdir(path.dirname(dest), { recursive: true });
		await fs.rename(canon.file, dest);
		const keep = canon.conversion === 'transcode' && ctx.config.keepOriginals;
		const sourceExt = row.source_ext ?? det.ext;
		let committed = false;
		try {
			await fsyncPath(path.dirname(dest));
			committed = media.markReady(id, {
				conversion: canon.conversion,
				canonicalExt: canon.ext,
				canonicalSize,
				width: shown.width,
				height: shown.height,
				takenAt: meta.taken.takenAt,
				takenMs: meta.taken.takenMs,
				gpsLat: meta.gps?.lat ?? null,
				gpsLon: meta.gps?.lon ?? null,
				gpsAlt: meta.gps?.alt ?? null,
				contentId: meta.contentId,
				sourceKept: keep,
				sourceExt
			});
		} finally {
			// Not committed: put a passthrough source back where the row expects it, or drop our output.
			if (!committed) await fs.rename(dest, canon.conversion === 'none' ? src : canon.file).catch(() => undefined);
		}
		if (!committed) throw new MediaError('retryable', `media ${id} is no longer processing; not committed`);
		ctx.log.info(`photo ${id}: ${det.subtype} → ${canon.ext} (${canon.conversion}) ${shown.width}×${shown.height} in ${Date.now() - started} ms`);
		// Committed: nothing below may fail the item (src/worker/README.md).
		await settleSource(job, canon, keep, sourceExt, row.canonical_ext).catch((e: unknown) => {
			ctx.log.error(`photo ${id}: could not settle the source`, { error: errorDetail(e, 500) });
		});
	} finally {
		await Promise.all([tmp, work].map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => undefined)));
	}
}

/** exiftool on the source; unreadable metadata is not fatal (the date falls back). */
async function sourceTags(src: string, ctx: WorkerContext): Promise<SourceTags> {
	try {
		return await readSourceTags(src);
	} catch (e) {
		ctx.log.warn(`exiftool could not read ${src}`, { error: errorDetail(e, 300) });
		return {};
	}
}

function checkPixels(width: number, height: number): void {
	if (width * height > MAX_PIXELS) {
		throw new MediaError('too_large', `${width}×${height} is over the ${MAX_PIXELS}-pixel limit`);
	}
}

/** Header facts of an image sharp reads directly, after the pixel-count cap. */
async function probe(file: string): Promise<Metadata> {
	const m = await probeImage(file);
	checkPixels(m.width, m.height);
	return m;
}

const transcode = (e: Encoded): Canonical => ({ ...e, conversion: 'transcode' });

async function buildCanonical(job: Job): Promise<Canonical> {
	const { src, det, outBase } = job;
	const passthrough = (ext: Canonical['ext']): Canonical => ({ file: src, ext, conversion: 'none' });
	switch (det.subtype) {
		case 'jpeg':
			if ((await probe(src)).space !== 'cmyk') return passthrough('jpg');
			return transcode(await encodeCanonical(src, outBase, { lossless: false }));
		case 'png':
			if (det.animated || ((await probe(src)).orientation ?? 1) === 1) return passthrough('png');
			return transcode(await encodeCanonical(src, outBase, { lossless: true }));
		case 'gif':
			await probe(src);
			return passthrough('gif');
		case 'webp':
			await probe(src);
			if (det.animated) return transcode(await animatedToGif(src, outBase));
			return transcode(await encodeCanonical(src, outBase, { lossless: !!det.lossless }));
		case 'heif':
		case 'avif':
			return transcode(await fromHeif(job));
		case 'tiff':
			if (job.meta.fileType && RAW_FILE_TYPES.has(job.meta.fileType)) return fromRaw(job);
			await probe(src);
			return transcode(await withSourceExif(job, await encodeCanonical(src, outBase, { lossless: false })));
		case 'bmp':
		case 'jxl':
		case 'jp2':
		case 'psd': {
			const dec = path.join(job.ctx.paths.tmpDir(job.id), 'dec.png');
			await ffmpegDecode(src, dec, det.subtype, await ffmpegImageTools(), job.ctx.signal);
			await probe(dec);
			return transcode(await withSourceExif(job, await encodeCanonical(dec, outBase, { lossless: det.subtype === 'bmp' })));
		}
		case 'raw':
			return fromRaw(job);
		default:
			throw new MediaError('unsupported', `no photo route for ${det.mime}`);
	}
}

/**
 * HEIF/AVIF: primary image → PNG (Display P3 ICC added when only nclx says P3) → JPEG/PNG.
 * HDR (PQ/HLG) photos are converted without tone mapping in v1 (§2): logged for the admin.
 */
async function fromHeif(job: Job): Promise<Encoded> {
	const { id, src, ctx } = job;
	const log = (msg: string) => ctx.log.info(`photo ${id}: ${msg}`);
	const tools = await heifTools();
	const info = await readHeifInfo(src, tools, { sizeBytes: job.sizeBytes, signal: ctx.signal, log });
	const primary = info.images[info.primaryIndex];
	checkPixels(primary.width, primary.height);
	const dec = await decodeHeif(src, ctx.paths.tmpDir(id), info, tools, {
		codec: job.det.subtype === 'avif' ? 'av1' : 'hevc',
		sizeBytes: job.sizeBytes,
		signal: ctx.signal,
		log
	});
	if (primary.colorProfile === 'nclx' && job.meta.colorPrimaries === NCLX_DISPLAY_P3) {
		await embedIccInPng(dec, displayP3Icc(), 'Display P3');
	}
	const hdr = job.meta.transfer === null ? undefined : NCLX_HDR_TRANSFER[job.meta.transfer];
	if (hdr) ctx.log.warn(`photo ${id}: HDR photo shown without tone mapping (${hdr}); it may look flat`);
	return encodeCanonical(dec, job.outBase, { lossless: false });
}

/**
 * RAW: the embedded preview becomes the canonical JPEG as it is (tags copied, not re-encoded).
 * When exiftool can't copy the tags for a reason a retry won't fix, the preview is kept without
 * them (the row already has the date and place) unless it needs the RAW's Orientation to show
 * upright: then the item fails as corrupt.
 */
async function fromRaw(job: Job): Promise<Canonical> {
	const preview = await rawPreview(job.src, job.ctx.paths.workDir(job.id));
	try {
		await copyRawTags(job.src, preview);
	} catch (err) {
		const detail = `exiftool could not copy the RAW's tags: ${errorDetail(err, 500)}`;
		if (exiftoolTransient(err)) throw new MediaError('retryable', detail);
		const o = job.meta.orientation;
		if (o !== null && o !== 1) throw new MediaError('corrupt', `${detail} (the preview needs Orientation ${o})`);
		job.ctx.log.warn(`photo ${job.id}: kept the RAW preview without the RAW's tags`, { error: detail });
	}
	const file = `${job.outBase}.jpg`;
	await fs.rename(preview, file);
	return { file, ext: 'jpg', conversion: 'transcode' };
}

/**
 * Decoders that drop EXIF (TIFF, ffmpeg): copy date, camera and place from the source. When
 * exiftool can't, for a reason a retry won't fix, the canonical file is kept without them (the
 * row already has the date and place) rather than failing a good photo.
 */
async function withSourceExif(job: Job, e: Encoded): Promise<Encoded> {
	if (!hasExif(job.tags)) return e;
	try {
		await copyExif(job.src, e.file);
	} catch (err) {
		const detail = `exiftool could not copy the source's EXIF: ${errorDetail(err, 500)}`;
		if (exiftoolTransient(err)) throw new MediaError('retryable', detail);
		job.ctx.log.warn(`photo ${job.id}: kept without the source's EXIF`, { error: detail });
	}
	return e;
}

/** The preview's EXIF date: the local taken time, or the UTC instant when only that is known. */
function derivativeDate(t: Taken): DerivativeDate {
	const local = (t.takenAt ?? new Date(t.takenMs).toISOString()).slice(0, 19); // 'YYYY-MM-DDTHH:MM:SS'
	return { exif: local.replace('T', ' ').replaceAll('-', ':'), offset: t.takenAt ? t.offset : '+00:00' };
}

/**
 * display.webp + thumb.webp from the canonical file. A passthrough JPEG that fails only on a
 * decoder warning is retried once with failOn 'error' (docs/media-pipeline.md §2).
 */
async function derivatives(job: Job, canon: Canonical, out: { display: string; thumb: string }): Promise<void> {
	const date = derivativeDate(job.meta.taken);
	try {
		await makeDerivatives(canon.file, out, date);
	} catch (e) {
		if (canon.conversion !== 'none' || canon.ext !== 'jpg' || !MediaError.is(e) || e.code !== 'corrupt') throw e;
		job.ctx.log.warn(`photo ${job.id}: JPEG decoder warning; building previews leniently`, { error: e.detail });
		await makeDerivatives(canon.file, out, date, 'error');
	}
}

async function fsyncPath(p: string): Promise<void> {
	const fh = await fs.open(p, 'r');
	try {
		await fh.sync();
	} finally {
		await fh.close();
	}
}

/**
 * After the commit (never throws; every failure is logged): a transcode's source is archived in
 * originals/ (KEEP_ORIGINALS) or deleted; a passthrough source already became the canonical file.
 * A reprocessed item whose canonical extension changed loses its old library file.
 */
async function settleSource(job: Job, canon: Canonical, keep: boolean, sourceExt: string, previousExt: string | null): Promise<void> {
	const { id, src, ctx } = job;
	if (canon.conversion === 'transcode') {
		try {
			if (!keep) await fs.rm(src, { force: true });
			else {
				const archived = ctx.paths.originalsPath(id, sourceExt);
				if (src !== archived) {
					await fs.mkdir(path.dirname(archived), { recursive: true });
					await fs.rename(src, archived);
				}
			}
		} catch (e) {
			ctx.log.error(`photo ${id}: could not ${keep ? 'archive' : 'delete'} the source`, { error: errorDetail(e, 500) });
			try {
				if (keep) media.markOriginalDeleted(id);
			} catch (e2) {
				ctx.log.error(`photo ${id}: could not record the missing original`, { error: errorDetail(e2, 500) });
			}
		}
	}
	if (previousExt && previousExt !== canon.ext) {
		try {
			await fs.rm(ctx.paths.libraryPath(id, previousExt), { force: true });
		} catch (e) {
			ctx.log.warn(`photo ${id}: could not remove the old .${previousExt} library file`, { error: errorDetail(e, 500) });
		}
	}
}
