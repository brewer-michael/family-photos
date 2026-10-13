/**
 * Type detection from bytes, never from the extension (docs/media-pipeline.md §2 "Detection").
 * Runs in the main process during intake, so it stays light: the first 4,100 bytes, a few
 * positioned reads for WebP chunk headers, and file-type 22 (which reads lazily from the file,
 * so TIFF-based RAW whose IFD sits at the end of the file is still recognised). No sharp.
 *
 * Overrides on top of file-type:
 *   - ISOBMFF major brand: HEIF brands → HEIF route; qt/isom/iso2/mp41/mp42/M4V/3g* → video;
 *     crx → RAW (CR3); any other brand → HEIF if a compatible brand is a HEIF brand, else video.
 *   - WebP: VP8L = lossless; VP8X flags 0x10 = alpha, 0x02 = animated.
 *   - APNG: an acTL chunk before IDAT (file-type's PNG detector).
 *   - SVG, HTML, PDF and everything unknown → kind null ('unsupported').
 */
import { open, type FileHandle } from 'node:fs/promises';
import { fileTypeFromFile } from 'file-type';

/** Which photo route the lane takes. */
export type PhotoSubtype =
	| 'jpeg'
	| 'png'
	| 'gif'
	| 'webp'
	| 'heif'
	| 'avif'
	| 'tiff'
	| 'bmp'
	| 'jxl'
	| 'jp2'
	| 'psd'
	| 'raw';

export interface DetectResult {
	/** null → not a photo or video we accept (fails as 'unsupported'). */
	kind: 'photo' | 'video' | null;
	/** Detected MIME, e.g. 'image/heic'; 'application/octet-stream' when unknown. */
	mime: string;
	/** Detected extension without dot, e.g. 'heic' (used for originals/<sh>/<id>.<ext>). */
	ext: string;
	/** True for HEIF/AVIF containers that go through heif-dec. */
	heif?: boolean;
	/** ISOBMFF major brand when relevant, e.g. 'heic', 'qt  ', 'isom'. */
	brand?: string;
	/** Photo route; set whenever kind is 'photo'. */
	subtype?: PhotoSubtype;
	/** APNG, animated WebP, or a HEIF/AVIF image sequence (only its primary still is used). */
	animated?: boolean;
	/** WebP stored losslessly (VP8L). */
	lossless?: boolean;
	/** WebP with an alpha channel (VP8X alpha flag or the VP8L alpha hint). */
	alpha?: boolean;
}

/** Bytes read from the start of the file (file-type's own sample size). */
const HEAD_BYTES = 4100;

const UNKNOWN: DetectResult = { kind: null, mime: 'application/octet-stream', ext: 'bin' };

const HEIF_BRANDS = new Set([
	'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs',
	'mif1', 'mif2', 'msf1', 'miaf', 'MiHE', 'MiHB', 'MiHA', 'avif', 'avis'
]);
const HEVC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);
const SEQUENCE_BRANDS = new Set(['msf1', 'avis', 'hevc', 'hevx', 'hevm', 'hevs']);
const AV1_BRANDS = new Set(['avif', 'avis']);
const VIDEO_BRANDS = new Set(['qt  ', 'isom', 'iso2', 'mp41', 'mp42', 'M4V ']);

/** file-type results that are TIFF-based (or otherwise camera) RAW formats. */
const RAW_EXTS = new Set(['dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2']);

/** file-type extension → photo route, for the formats file-type identifies on its own. */
const PHOTO_EXTS: Readonly<Record<string, PhotoSubtype>> = {
	jpg: 'jpeg',
	png: 'png',
	apng: 'png',
	gif: 'gif',
	tif: 'tiff',
	bmp: 'bmp',
	jxl: 'jxl',
	jp2: 'jp2',
	jpx: 'jp2',
	j2c: 'jp2',
	psd: 'psd'
};

export async function detectFile(path: string): Promise<DetectResult> {
	const fh = await open(path, 'r');
	try {
		const { size } = await fh.stat();
		const head = await readAt(fh, 0, Math.min(HEAD_BYTES, size));
		if (head.length === 0) return UNKNOWN;
		const iso = detectIsobmff(head);
		if (iso) return iso;
		if (head.length >= 16 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
			return await detectWebp(fh, size);
		}
		const ft = await fileTypeFromFile(path);
		if (!ft || ft.mime === 'application/xml') return detectText(head) ?? (ft ? { kind: null, mime: ft.mime, ext: ft.ext } : UNKNOWN);
		if (RAW_EXTS.has(ft.ext)) return { kind: 'photo', mime: ft.mime, ext: ft.ext, subtype: 'raw' };
		const subtype = PHOTO_EXTS[ft.ext];
		if (subtype) {
			return { kind: 'photo', mime: ft.mime, ext: ft.ext, subtype, ...(ft.ext === 'apng' ? { animated: true } : {}) };
		}
		if (ft.mime.startsWith('video/')) return { kind: 'video', mime: ft.mime, ext: ft.ext };
		return { kind: null, mime: ft.mime, ext: ft.ext };
	} finally {
		await fh.close();
	}
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
	const buf = Buffer.alloc(length);
	const { bytesRead } = await fh.read(buf, 0, length, position);
	return buf.subarray(0, bytesRead);
}

/** ISOBMFF files: route by the ftyp box's major and compatible brands. */
function detectIsobmff(head: Buffer): DetectResult | null {
	if (head.length < 16 || head.toString('latin1', 4, 8) !== 'ftyp') return null;
	const boxSize = Math.min(head.readUInt32BE(0), head.length);
	if (boxSize < 16) return null;
	const major = head.toString('latin1', 8, 12);
	const compatible: string[] = [];
	for (let p = 16; p + 4 <= boxSize; p += 4) compatible.push(head.toString('latin1', p, p + 4));
	const brand = { brand: major };

	if (major === 'crx ') return { kind: 'photo', mime: 'image/x-canon-cr3', ext: 'cr3', subtype: 'raw', ...brand };
	if (VIDEO_BRANDS.has(major) || major.startsWith('3g')) return { kind: 'video', ...videoType(major), ...brand };
	const heifBrands = HEIF_BRANDS.has(major) ? [major, ...compatible] : compatible.filter((b) => HEIF_BRANDS.has(b));
	if (heifBrands.length === 0) return { kind: 'video', ...videoType(major), ...brand };

	const all = [major, ...compatible];
	// An AV1 brand wins over the generic mif1/msf1 ones unless an HEVC brand says otherwise.
	const av1 = AV1_BRANDS.has(major) || (all.some((b) => AV1_BRANDS.has(b)) && !HEVC_BRANDS.has(major));
	const hevc = !av1 && all.some((b) => HEVC_BRANDS.has(b));
	const sequence = SEQUENCE_BRANDS.has(major);
	const mime = av1 ? 'image/avif' : `image/${hevc ? 'heic' : 'heif'}${sequence ? '-sequence' : ''}`;
	return {
		kind: 'photo',
		mime,
		ext: av1 ? 'avif' : hevc ? 'heic' : 'heif',
		heif: true,
		subtype: av1 ? 'avif' : 'heif',
		...(sequence ? { animated: true } : {}),
		...brand
	};
}

function videoType(major: string): { mime: string; ext: string } {
	if (major === 'qt  ') return { mime: 'video/quicktime', ext: 'mov' };
	if (major === 'M4V ') return { mime: 'video/x-m4v', ext: 'm4v' };
	if (major.startsWith('3g2')) return { mime: 'video/3gpp2', ext: '3g2' };
	if (major.startsWith('3g')) return { mime: 'video/3gpp', ext: '3gp' };
	return { mime: 'video/mp4', ext: 'mp4' };
}

/** Walks the RIFF chunk headers: VP8 (lossy), VP8L (lossless) or VP8X (extended, with flags). */
async function detectWebp(fh: FileHandle, size: number): Promise<DetectResult> {
	const result: DetectResult = { kind: 'photo', mime: 'image/webp', ext: 'webp', subtype: 'webp', lossless: false, alpha: false };
	let pos = 12;
	for (let i = 0; i < 64 && pos + 8 <= size; i++) {
		const hdr = await readAt(fh, pos, 8 + 10);
		if (hdr.length < 8) break;
		const fourcc = hdr.toString('latin1', 0, 4);
		const len = hdr.readUInt32LE(4);
		const data = hdr.subarray(8);
		if (fourcc === 'VP8X' && data.length >= 1) {
			result.alpha = (data[0] & 0x10) !== 0;
			if (data[0] & 0x02) return { ...result, animated: true };
		} else if (fourcc === 'VP8L') {
			// 0x2f signature, then 14 bits width−1, 14 bits height−1, 1 bit alpha_is_used (LE).
			if (data.length >= 5 && data[0] === 0x2f && (data.readUInt32LE(1) >>> 28) & 1) result.alpha = true;
			return { ...result, lossless: true };
		} else if (fourcc === 'VP8 ') {
			return result;
		}
		pos += 8 + len + (len & 1);
	}
	return result;
}

/** SVG and HTML (file-type leaves text formats alone); both are rejected. */
function detectText(head: Buffer): DetectResult | null {
	const text = head.toString('utf8').replace(/^﻿/, '').trimStart();
	if (!text.startsWith('<')) return null;
	if (/<svg[\s>]/i.test(text)) return { kind: null, mime: 'image/svg+xml', ext: 'svg' };
	if (/<!doctype html|<(html|head|body|script)[\s>]/i.test(text)) return { kind: null, mime: 'text/html', ext: 'html' };
	if (text.startsWith('<?xml')) return { kind: null, mime: 'application/xml', ext: 'xml' };
	return null;
}
