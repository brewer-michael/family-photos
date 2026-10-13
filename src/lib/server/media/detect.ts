/**
 * Type detection from bytes (never from the extension). Used by intake (main process)
 * and may be reused by the photo lane.
 *
 * PARTIAL — basic file-type detection only. TODO(photo track): ISOBMFF brand overrides
 * (HEIF vs video), WebP VP8L/VP8X flags, APNG, RAW, SVG/PDF rejection, mislabelled files
 * (docs/media-pipeline.md §2 "Detection").
 */
import { fileTypeFromFile } from 'file-type';

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
}

const HEIF_BRANDS = new Set([
	'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs',
	'mif1', 'mif2', 'msf1', 'miaf', 'MiHE', 'MiHB', 'MiHA', 'avif', 'avis'
]);

export async function detectFile(path: string): Promise<DetectResult> {
	const ft = await fileTypeFromFile(path);
	if (!ft) return { kind: null, mime: 'application/octet-stream', ext: 'bin' };
	const heif = ft.mime === 'image/heic' || ft.mime === 'image/heif' || ft.mime === 'image/avif' ||
		ft.mime === 'image/heic-sequence' || ft.mime === 'image/heif-sequence';
	let kind: DetectResult['kind'] = null;
	if (heif || (ft.mime.startsWith('image/') && ft.mime !== 'image/svg+xml')) kind = 'photo';
	else if (ft.mime.startsWith('video/')) kind = 'video';
	void HEIF_BRANDS; // TODO(photo track): brand-based routing
	return { kind, mime: ft.mime, ext: ft.ext, heif: heif || undefined };
}
