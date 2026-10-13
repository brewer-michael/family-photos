/**
 * sharp in the photo lane (docs/media-pipeline.md §2 "JPEG/PNG encode" and "Derivatives").
 * sharp only ever loads in the worker process; concurrency 2 and no cache.
 *
 * Canonical encode: orientation applied exactly once (autoOrient rotates the pixels and drops the
 * EXIF Orientation), the ICC profile of an RGB source is tagged, not converted (CMYK and grey
 * sources get the default sRGB conversion), EXIF kept (never withMetadata/keepMetadata/keepXmp:
 * XMP is dropped), JPEG q92 4:2:0 baseline, or PNG for lossless sources and real transparency.
 */
import sharp, { type FailOnOptions, type Metadata } from 'sharp';
import { MediaError } from '#lib/shared/errors';

sharp.concurrency(2);
sharp.cache(false);

export type CanonicalImageExt = 'jpg' | 'png' | 'gif';

export interface Encoded {
	file: string;
	ext: CanonicalImageExt;
}

const SHARP_FORMAT: Record<CanonicalImageExt, string> = { jpg: 'jpeg', png: 'png', gif: 'gif' };

/** Maps a sharp/libvips failure on uploaded bytes to a MediaError. */
export function sharpFailure(e: unknown, what: string): MediaError {
	if (MediaError.is(e)) return e;
	const msg = e instanceof Error ? e.message : String(e);
	const detail = `${what}: ${msg}`;
	if (/pixel limit/i.test(msg)) return new MediaError('too_large', detail);
	if (/unsupported image format/i.test(msg)) return new MediaError('unsupported', detail);
	if ((e as NodeJS.ErrnoException | null)?.code || /no space left|input\/output error|out of memory|cannot allocate/i.test(msg)) {
		return new MediaError('retryable', detail);
	}
	return new MediaError('corrupt', detail);
}

/** An RGB image's profile is kept as a tag; CMYK and grey images get sharp's sRGB conversion. */
const keepsProfile = (m: Metadata) => m.hasProfile && (m.space === 'srgb' || m.space === 'rgb16');

/**
 * Writes `<outBase>.jpg` (or `.png` when `lossless` or the image has real transparency, i.e. an
 * alpha channel that is actually used). `input` is a source sharp reads directly (JPEG, PNG,
 * WebP, TIFF) or a decoded PNG. A `lossless` 16-bit source (a rotated 16-bit PNG) stays 16-bit;
 * otherwise sharp writes 8 bits per sample (a 10-bit HEIF's precision is not kept, §2).
 */
export async function encodeCanonical(input: string, outBase: string, opts: { lossless: boolean }): Promise<Encoded> {
	try {
		const meta = await sharp(input).metadata();
		const alpha = meta.hasAlpha && !(await sharp(input).stats()).isOpaque;
		const png = opts.lossless || alpha;
		let p = sharp(input, { autoOrient: true }); // limitInputPixels ≈ 268 MP and failOn 'warning' by default
		if (meta.hasAlpha && !alpha) p = p.removeAlpha();
		if (keepsProfile(meta)) p = p.keepIccProfile(); // tags the profile, does not transform pixels
		p = p.keepExif();
		// sharp ends every pipeline in 8-bit sRGB unless told otherwise.
		if (png && opts.lossless && meta.depth === 'ushort') p = p.toColourspace(meta.channels <= 2 ? 'grey16' : 'rgb16');
		p = png
			? p.png({ compressionLevel: 6 })
			: p.jpeg({ quality: 92, chromaSubsampling: '4:2:0', optimiseCoding: true, progressive: false, mozjpeg: false });
		const ext: CanonicalImageExt = png ? 'png' : 'jpg';
		const file = `${outBase}.${ext}`;
		await p.toFile(file);
		return { file, ext };
	} catch (e) {
		throw sharpFailure(e, 'encode');
	}
}

/** Animated WebP → animated GIF with every frame (and the frame delays and loop count). */
export async function animatedToGif(input: string, outBase: string): Promise<Encoded> {
	const file = `${outBase}.gif`;
	try {
		await sharp(input, { animated: true }).gif({ effort: 7 }).toFile(file);
	} catch (e) {
		throw sharpFailure(e, 'animated encode');
	}
	return { file, ext: 'gif' };
}

/**
 * Verifies a canonical file decodes as the expected format and returns its dimensions as
 * displayed (EXIF orientation applied, first frame for animations).
 */
export async function inspectCanonical(file: string, ext: CanonicalImageExt): Promise<{ width: number; height: number }> {
	let meta: Metadata;
	try {
		meta = await sharp(file).metadata();
	} catch (e) {
		throw sharpFailure(e, 'verify');
	}
	if (meta.format !== SHARP_FORMAT[ext]) throw new MediaError('corrupt', `verify: expected ${SHARP_FORMAT[ext]}, got ${meta.format}`);
	const { width, height } = meta.autoOrient;
	if (!(width > 0 && height > 0)) throw new MediaError('corrupt', `verify: no dimensions (${width}×${height})`);
	return { width, height };
}

export interface DerivativeDate {
	/** EXIF date-time 'YYYY:MM:DD HH:MM:SS' (local wall time). */
	exif: string;
	/** '+02:00' when known. */
	offset: string | null;
}

/**
 * display.webp (2048 box, q82, ICC kept for RGB, date-only EXIF) and thumb.webp (480 box, q76, no
 * metadata) from the canonical file, one after the other; animations use their first frame.
 */
export async function makeDerivatives(
	canonical: string,
	out: { display: string; thumb: string },
	date: DerivativeDate,
	failOn: FailOnOptions = 'warning'
): Promise<void> {
	try {
		const meta = await sharp(canonical, { failOn }).metadata();
		let display = sharp(canonical, { autoOrient: true, failOn }).resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true });
		if (keepsProfile(meta)) display = display.keepIccProfile();
		await display
			.withExif({
				IFD0: { DateTime: date.exif },
				IFD2: { DateTimeOriginal: date.exif, ...(date.offset ? { OffsetTimeOriginal: date.offset } : {}) }
			})
			.webp({ quality: 82, smartSubsample: true, effort: 4 })
			.toFile(out.display);
		await sharp(canonical, { autoOrient: true, failOn })
			.resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
			.webp({ quality: 76, smartSubsample: true, effort: 4 })
			.toFile(out.thumb);
	} catch (e) {
		throw sharpFailure(e, 'derivatives');
	}
}

/** Header-only facts about a source sharp can read directly. */
export async function probeImage(file: string): Promise<Metadata> {
	try {
		return await sharp(file).metadata();
	} catch (e) {
		throw sharpFailure(e, 'read');
	}
}
