/**
 * Facts read from the uploaded source with exiftool (docs/media-pipeline.md §2 "Metadata read"),
 * before anything is converted: Apple's MakerNote (ContentIdentifier, for Live Photo pairing) may
 * not survive a re-encode.
 *
 * taken date fallback: EXIF DateTimeOriginal (+ OffsetTimeOriginal, SubSecTimeOriginal) → EXIF
 * CreateDate (+ OffsetTimeDigitized) → XMP dates → the client's lastModified → upload time.
 * taken_at is the local wall time plus the offset when known; taken_ms is UTC (a wall time
 * without an offset is read as UTC, as the video lane does).
 */
import { exiftool } from '../exiftool';

/** exiftool -j -n -G1 output: "Group:Tag" → value. */
export type SourceTags = Record<string, unknown>;

export interface Taken {
	/** '2024-07-04T11:22:31-07:00', or '2024-07-04T11:22:31' when the offset is unknown, or null. */
	takenAt: string | null;
	takenMs: number;
	/** '-07:00' when known. */
	offset: string | null;
}

export interface Gps {
	lat: number;
	lon: number;
	alt: number | null;
}

export interface PhotoMeta {
	taken: Taken;
	gps: Gps | null;
	/** Apple ContentIdentifier (Live Photo pairing). */
	contentId: string | null;
	/** nclx colour primaries of a HEIF/AVIF (12 = Display P3), when exiftool reports them. */
	colorPrimaries: number | null;
	/** exiftool's FileType, e.g. 'JPEG', 'NEF'. */
	fileType: string | null;
}

/** Earliest believable capture year (scans of old photos may carry real 20th-century dates). */
const MIN_YEAR = 1900;

const EXIF_GROUPS = new Set(['ExifIFD', 'IFD0', 'SubIFD']);

/** Not -fast: that can stop before metadata stored after the image data (e.g. PNG text chunks). */
export async function readSourceTags(src: string): Promise<SourceTags> {
	return (await exiftool().readRaw(src, { readArgs: ['-G1', '-n'] })) as SourceTags;
}

/** First value of `tag` in one of `groups` (any group when omitted). */
function find(tags: SourceTags, tag: string, groups?: (group: string) => boolean): unknown {
	for (const [key, value] of Object.entries(tags)) {
		const i = key.indexOf(':');
		if (i < 0 || key.slice(i + 1) !== tag) continue;
		if (!groups || groups(key.slice(0, i))) return value;
	}
	return undefined;
}

const str = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() || null : null);
function num(v: unknown): number | null {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
	return Number.isFinite(n) ? n : null;
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');

function formatOffset(min: number): string {
	return `${min < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(min) / 60))}:${pad(Math.abs(min) % 60)}`;
}

/** '+02:00', '-0700', 'Z' → minutes east of UTC; null when absent or invalid. */
export function parseOffset(s: string | null | undefined): number | null {
	const m = /^(Z|([+-])(\d{2}):?(\d{2}))$/.exec((s ?? '').trim());
	if (!m) return null;
	if (m[1] === 'Z') return 0;
	const min = (m[2] === '-' ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4]));
	return Math.abs(min) <= 14 * 60 ? min : null;
}

/**
 * EXIF/XMP date-time ('2024:07:04 11:22:31', optionally '.123' and an offset) → taken date.
 * `offset` and `subsec` (EXIF OffsetTime* / SubSecTime*) apply when the string has none.
 */
export function parseExifDate(value: unknown, offset?: unknown, subsec?: unknown): Taken | null {
	const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(str(value) ?? '');
	if (!m) return null;
	const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
	const wall = Date.UTC(y, mo - 1, d, h, mi, se);
	const check = new Date(wall);
	if (y < MIN_YEAR || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) return null;
	const frac = m[7] ?? (/^\d+$/.test(str(subsec) ?? '') ? `.${str(subsec)}` : '');
	const ms = frac ? Math.round(Number(`0${frac}`) * 1000) % 1000 : 0;
	const offMin = m[8] ? parseOffset(m[8]) : parseOffset(str(offset));
	const local = `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(se)}`;
	const off = offMin === null ? null : formatOffset(offMin);
	return { takenAt: local + (off ?? ''), takenMs: wall + ms - (offMin ?? 0) * 60_000, offset: off };
}

/** A file's lastModified before 2000 is an unset clock (the 1970 epoch), not a capture date. */
const validMtime = (ms: number | null | undefined): ms is number =>
	typeof ms === 'number' && Number.isFinite(ms) && new Date(ms).getUTCFullYear() >= 2000;

export function resolveTaken(tags: SourceTags, fallback: { clientMtimeMs: number | null; uploadedMs: number }): Taken {
	const exif = (g: string) => EXIF_GROUPS.has(g);
	const candidates: (() => Taken | null)[] = [
		() => parseExifDate(find(tags, 'DateTimeOriginal', exif), find(tags, 'OffsetTimeOriginal', exif), find(tags, 'SubSecTimeOriginal', exif)),
		() => parseExifDate(find(tags, 'CreateDate', exif), find(tags, 'OffsetTimeDigitized', exif), find(tags, 'SubSecTimeDigitized', exif)),
		() => parseExifDate(find(tags, 'DateTimeOriginal', (g) => g.startsWith('XMP'))),
		() => parseExifDate(find(tags, 'DateCreated', (g) => g.startsWith('XMP'))),
		() => parseExifDate(find(tags, 'CreateDate', (g) => g.startsWith('XMP')))
	];
	for (const c of candidates) {
		const t = c();
		if (t) return t;
	}
	if (validMtime(fallback.clientMtimeMs)) return { takenAt: null, takenMs: fallback.clientMtimeMs, offset: null };
	return { takenAt: null, takenMs: fallback.uploadedMs, offset: null };
}

export function resolveGps(tags: SourceTags): Gps | null {
	let lat = num(find(tags, 'GPSLatitude', (g) => g === 'Composite'));
	let lon = num(find(tags, 'GPSLongitude', (g) => g === 'Composite'));
	if (lat === null || lon === null) {
		lat = num(find(tags, 'GPSLatitude', (g) => g === 'GPS'));
		lon = num(find(tags, 'GPSLongitude', (g) => g === 'GPS'));
		if (lat !== null && str(find(tags, 'GPSLatitudeRef', (g) => g === 'GPS')) === 'S') lat = -Math.abs(lat);
		if (lon !== null && str(find(tags, 'GPSLongitudeRef', (g) => g === 'GPS')) === 'W') lon = -Math.abs(lon);
	}
	if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
	const alt = num(find(tags, 'GPSAltitude', (g) => g === 'Composite' || g === 'GPS'));
	return { lat, lon, alt };
}

export function photoMeta(tags: SourceTags, fallback: { clientMtimeMs: number | null; uploadedMs: number }): PhotoMeta {
	return {
		taken: resolveTaken(tags, fallback),
		gps: resolveGps(tags),
		contentId: str(find(tags, 'ContentIdentifier', (g) => g === 'Apple')),
		colorPrimaries: num(find(tags, 'ColorPrimaries', (g) => g === 'QuickTime')),
		fileType: str(find(tags, 'FileType', (g) => g === 'File'))
	};
}

/** The source carries EXIF worth keeping (date, camera or place). */
export function hasExif(tags: SourceTags): boolean {
	return Object.keys(tags).some((k) => /^(IFD0|ExifIFD|GPS):/.test(k));
}

/**
 * Copies the source's EXIF into a canonical file whose decoder dropped it (TIFF, ffmpeg-decoded
 * formats), except Orientation: the canonical pixels are already upright.
 */
export async function copyExif(src: string, dest: string): Promise<void> {
	await exiftool().write(dest, {}, {
		writeArgs: ['-overwrite_original', '-TagsFromFile', src, '-EXIF:all', '--Orientation', '--IFD1:all'],
		ignoreMinorErrors: true
	});
}
