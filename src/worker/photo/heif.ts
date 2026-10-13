/**
 * HEIF/AVIF decode (docs/media-pipeline.md §2 "HEIF decode"): heif-info finds the top-level
 * images and the primary one, then heif-dec (heif-convert on libheif 1.17) writes PNGs into the
 * job's tmp dir. Never libheif's JPEG writer (it shifts colours on BT.709 / limited-range sources).
 * The PNG route applies the nclx matrix/range, irot/imir/clap, keeps the ICC profile and writes the
 * EXIF with Orientation 1; 10-bit sources become 16-bit PNGs.
 *
 * - Output: dec.png for one top-level image, dec-<k>.png (k = 1-based position) for several.
 * - Decoders in order (ffmpegdec first for HEVC, then libde265; dav1d then aom for AV1); on a
 *   failure the next one is tried. A timeout is not retried (the photo job would overrun).
 * - Timeout 180 s, 360 s with more than one top-level image.
 * - "Security limit exceeded" → one retry with --disable-limits when the tool supports it and
 *   the primary image is ≤ 250 MP and the file ≤ 100 MB; otherwise too_large.
 * - heif-dec stops at the first image it can't decode, so a broken non-primary image fails the
 *   item as corrupt (the source is kept for the admin).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { MediaError } from '#lib/shared/errors';
import { run, RunError } from '../spawn';
import { decoderOrder, type HeifTools } from './tools';

export interface HeifImage {
	/** As displayed (libheif applies irot/imir/clap). */
	width: number;
	height: number;
	primary: boolean;
	/** The colour box type: 'nclx', 'prof', 'rICC', or 'no'. */
	colorProfile: string;
}

export interface HeifInfo {
	images: HeifImage[];
	/** Index into `images` of the primary image. */
	primaryIndex: number;
}

const DECODE_TIMEOUT_MS = 180_000;
/** libheif 1.17's heif-info also decodes every image (1.18+ only reads the headers). */
const INFO_TIMEOUT_MS = DECODE_TIMEOUT_MS;
const DISABLE_LIMITS_MAX_PIXELS = 250_000_000;
const DISABLE_LIMITS_MAX_BYTES = 100 * 1024 * 1024;
const LIMIT_RE = /security limit exceeded/i;
const UNSUPPORTED_RE = /unsupported (feature|codec|filetype|image type)|no decoding plugin|not a supported format/i;

/**
 * Parses heif-info output (the same `image:` lines in libheif 1.17 and 1.19; 1.19 adds `tiles:`).
 * Returns null when no image is listed.
 */
export function parseHeifInfo(text: string): HeifInfo | null {
	const images: HeifImage[] = [];
	let current: HeifImage | null = null;
	for (const line of text.split('\n')) {
		const img = /^image: (\d+)x(\d+) \(id=\d+\)(, primary)?\s*$/.exec(line);
		if (img) {
			current = { width: Number(img[1]), height: Number(img[2]), primary: !!img[3], colorProfile: 'no' };
			images.push(current);
			continue;
		}
		const profile = /^ {2}color profile: (\S+)/.exec(line);
		if (current && profile) current.colorProfile = profile[1];
	}
	if (images.length === 0) return null;
	const primaryIndex = Math.max(0, images.findIndex((i) => i.primary));
	return { images, primaryIndex };
}

function stderrTail(e: unknown): string {
	return e instanceof RunError ? e.stderr.trim().split('\n').slice(-3).join(' | ') : String(e);
}

/** A RunError that is not about the file's content. */
function runFailure(e: unknown, what: string): MediaError | null {
	if (!(e instanceof RunError)) return null;
	if (e.reason === 'spawn') return new MediaError('retryable', `${what} could not start: ${e.message}`);
	if (e.reason === 'aborted') return new MediaError('retryable', `${what} was cancelled`);
	if (e.reason === 'timeout' || e.reason === 'stall') return new MediaError('retryable', `${what} timed out: ${e.message}`);
	return null;
}

/** heif-info on the source, retried with --disable-limits when needed and supported. */
export async function readHeifInfo(src: string, tools: HeifTools, signal: AbortSignal): Promise<HeifInfo> {
	const attempt = async (disableLimits: boolean): Promise<HeifInfo> => {
		const args = [...(disableLimits ? ['--disable-limits'] : []), src];
		const { stdout } = await run(tools.infoBin, args, { timeoutMs: INFO_TIMEOUT_MS, signal });
		const info = parseHeifInfo(stdout.toString('utf8'));
		if (!info) throw new MediaError('corrupt', 'heif-info listed no images');
		return info;
	};
	try {
		return await attempt(false);
	} catch (e) {
		const fatal = runFailure(e, 'heif-info');
		if (fatal) throw fatal;
		if (MediaError.is(e)) throw e;
		const tail = stderrTail(e);
		if (LIMIT_RE.test(tail)) {
			if (!tools.infoDisableLimits) throw new MediaError('too_large', `heif-info: ${tail}`);
			try {
				return await attempt(true);
			} catch (e2) {
				throw runFailure(e2, 'heif-info') ?? new MediaError('corrupt', `heif-info: ${stderrTail(e2)}`);
			}
		}
		if (UNSUPPORTED_RE.test(tail)) throw new MediaError('unsupported', `heif-info: ${tail}`);
		throw new MediaError('corrupt', `heif-info: ${tail}`);
	}
}

export interface DecodeHeifOptions {
	codec: 'hevc' | 'av1';
	sizeBytes: number;
	signal: AbortSignal;
	log: (msg: string) => void;
}

/**
 * Decodes every top-level image to PNG in `dir` and returns the primary image's PNG (the other
 * outputs are deleted). Throws MediaError.
 */
export async function decodeHeif(src: string, dir: string, info: HeifInfo, tools: HeifTools, opts: DecodeHeifOptions): Promise<string> {
	const decoders = decoderOrder(tools, opts.codec);
	if (decoders.length === 0) {
		throw new MediaError('retryable', `libheif has no ${opts.codec === 'av1' ? 'AV1' : 'HEVC'} decoder installed`);
	}
	const multi = info.images.length > 1;
	const out = path.join(dir, 'dec.png');
	const outputs = multi ? info.images.map((_, k) => path.join(dir, `dec-${k + 1}.png`)) : [out];
	const primary = outputs[multi ? info.primaryIndex : 0];
	const p = info.images[info.primaryIndex];
	const mayDisableLimits =
		tools.decDisableLimits && p.width * p.height <= DISABLE_LIMITS_MAX_PIXELS && opts.sizeBytes <= DISABLE_LIMITS_MAX_BYTES;

	const decode = (decoder: string, disableLimits: boolean) =>
		run(
			tools.decBin,
			['-d', decoder, '--quiet', '--png-compression-level', '1', ...(disableLimits ? ['--disable-limits'] : []), src, out],
			{ timeoutMs: multi ? 2 * DECODE_TIMEOUT_MS : DECODE_TIMEOUT_MS, signal: opts.signal }
		);

	let lastError = '';
	for (const decoder of decoders) {
		try {
			try {
				await decode(decoder, false);
			} catch (e) {
				if (!(e instanceof RunError) || e.reason !== 'exit' || !LIMIT_RE.test(e.stderr)) throw e;
				if (!mayDisableLimits) throw new MediaError('too_large', `${tools.decBin}: ${stderrTail(e)}`);
				opts.log(`HEIF security limit hit; retrying with --disable-limits (${p.width}×${p.height})`);
				await decode(decoder, true);
			}
			await fs.access(primary);
			await Promise.all(outputs.filter((o) => o !== primary).map((o) => fs.rm(o, { force: true })));
			return primary;
		} catch (e) {
			if (MediaError.is(e)) throw e;
			const fatal = runFailure(e, tools.decBin);
			if (fatal) throw fatal;
			lastError = `${decoder}: ${e instanceof RunError ? stderrTail(e) : `no output (${String(e)})`}`;
			opts.log(`HEIF decoder ${decoder} failed: ${lastError}`);
			await Promise.all(outputs.map((o) => fs.rm(o, { force: true })));
		}
	}
	if (UNSUPPORTED_RE.test(lastError)) throw new MediaError('unsupported', lastError);
	throw new MediaError('corrupt', `${multi ? `one of ${info.images.length} images is broken; ` : ''}${lastError}`);
}
