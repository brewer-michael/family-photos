/**
 * Camera RAW (DNG/ProRAW, CR2, CR3, NEF, ARW, RAF, ORF, RW2, …): the canonical file is the
 * largest embedded JPEG preview, not re-encoded, with the RAW's tags copied in (including
 * Orientation; metadata.ts copyRawTags, called by the photo lane), as in docs/media-pipeline.md
 * §2 "Other decoders". A RAW whose best preview is shorter than 1600 px on its long edge fails
 * as unsupported (the source is kept for the admin).
 */
import path from 'node:path';
import sharp from 'sharp';
import { MediaError } from '#lib/shared/errors';
import { exiftool } from '../exiftool';

export const RAW_MIN_LONG_EDGE = 1600;

/** exiftool FileType values of RAW formats file-type may report as plain TIFF. */
export const RAW_FILE_TYPES = new Set([
	'3FR', 'ARW', 'CR2', 'DCR', 'DNG', 'ERF', 'FFF', 'IIQ', 'KDC', 'MEF', 'MOS', 'MRW',
	'NEF', 'NRW', 'ORF', 'ORI', 'PEF', 'RAF', 'RW2', 'RWL', 'SR2', 'SRF', 'SRW'
]);

/** Extracts the largest usable preview into `dir` and returns its path (no tags copied yet). */
export async function rawPreview(src: string, dir: string): Promise<string> {
	const et = exiftool();
	const candidates: { file: string; pixels: number; longEdge: number }[] = [];
	for (const [tag, extract] of [
		['JpgFromRaw', et.extractJpgFromRaw.bind(et)],
		['PreviewImage', et.extractPreview.bind(et)]
	] as const) {
		const file = path.join(dir, `${tag}.jpg`);
		try {
			await extract(src, file);
			const m = await sharp(file).metadata();
			if (m.format !== 'jpeg') continue;
			candidates.push({ file, pixels: m.width * m.height, longEdge: Math.max(m.width, m.height) });
		} catch {
			// This RAW has no such preview (or it is unreadable): try the next one.
		}
	}
	const best = candidates.filter((c) => c.longEdge >= RAW_MIN_LONG_EDGE).sort((a, b) => b.pixels - a.pixels)[0];
	if (!best) {
		const sizes = candidates.map((c) => c.longEdge).join(', ') || 'none';
		throw new MediaError('unsupported', `RAW has no embedded JPEG preview of at least ${RAW_MIN_LONG_EDGE} px (found: ${sizes})`);
	}
	return best.file;
}
