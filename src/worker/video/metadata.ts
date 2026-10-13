/**
 * Date and place for a video, and the required exiftool post-step that writes them back into the
 * canonical MP4 where phones read them (docs/media-pipeline.md §3 "Metadata").
 *
 * taken date fallback: Apple creationdate (local time + offset) → mvhd creation_time (UTC) →
 * the client's lastModified → upload time. Years before 2000 are skipped (unset camera clocks,
 * the 1904/1970 epochs).
 */
import { MediaError } from '#lib/shared/errors';
import { exiftool } from '../exiftool';

export interface Gps {
	lat: number;
	lon: number;
	alt: number | null;
}

export interface Taken {
	/** Local wall time plus offset when known ('2024-07-04T11:22:31-07:00'), a UTC instant ('…Z'), or null. */
	takenAt: string | null;
	/** UTC epoch ms. */
	takenMs: number;
	/** '-07:00' when the local offset is known (then Keys:CreationDate is written). */
	offset: string | null;
}

const MIN_YEAR = 2000;

/**
 * ISO 6709 point, e.g. '+37.3349-122.0090+010.000/' (Apple, ffmpeg ©xyz). Degrees may also be
 * written as ±DDMM.M / ±DDMMSS.S (latitude) and ±DDDMM.M / ±DDDMMSS.S (longitude).
 * Returns null when unparsable, out of range, or exactly 0,0 (no fix).
 */
export function parseIso6709(s: string | null | undefined): Gps | null {
	const m = /^([+-])(\d+(?:\.\d+)?)([+-])(\d+(?:\.\d+)?)(?:([+-]\d+(?:\.\d+)?))?/.exec((s ?? '').trim());
	if (!m) return null;
	const deg = (sign: string, v: string, degDigits: number): number => {
		const intLen = v.split('.')[0].length;
		const x = Number(v);
		let d: number;
		if (intLen <= degDigits) d = x;
		else if (intLen === degDigits + 2) d = Math.floor(x / 100) + (x % 100) / 60;
		else if (intLen === degDigits + 4) d = Math.floor(x / 10000) + (Math.floor(x / 100) % 100) / 60 + (x % 100) / 3600;
		else return NaN;
		return sign === '-' ? -d : d;
	};
	const lat = deg(m[1], m[2], 2);
	const lon = deg(m[3], m[4], 3);
	if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
	if (lat === 0 && lon === 0) return null;
	const alt = m[5] === undefined ? null : Number(m[5]);
	return { lat, lon, alt: alt !== null && Number.isFinite(alt) ? alt : null };
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');

function formatOffset(min: number): string {
	return `${min < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(min) / 60))}:${pad(Math.abs(min) % 60)}`;
}

/**
 * '2024-07-04T11:22:31-0700' (Apple), '…-07:00', '…Z' or no offset (local time unknown zone).
 * Returns the wall-clock parts and the offset in minutes (null when absent).
 */
export function parseLocalDate(s: string | null | undefined): { local: string; utcMs: number; offsetMin: number | null } | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec((s ?? '').trim());
	if (!m) return null;
	const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
	if (y < MIN_YEAR || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60) return null;
	let offsetMin: number | null = null;
	if (m[7] === 'Z') offsetMin = 0;
	else if (m[7]) {
		const o = m[7].replace(':', '');
		offsetMin = (o[0] === '-' ? -1 : 1) * (Number(o.slice(1, 3)) * 60 + Number(o.slice(3, 5)));
		if (Math.abs(offsetMin) > 14 * 60) return null;
	}
	const wall = Date.UTC(y, mo - 1, d, h, mi, se);
	return {
		local: `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(se)}`,
		utcMs: wall - (offsetMin ?? 0) * 60_000,
		offsetMin
	};
}

const validMs = (ms: number | null | undefined): ms is number =>
	typeof ms === 'number' && Number.isFinite(ms) && new Date(ms).getUTCFullYear() >= MIN_YEAR;

export function resolveTaken(input: {
	creationDate: string | null;
	creationTime: string | null;
	clientMtimeMs: number | null;
	uploadedMs: number;
}): Taken {
	const apple = parseLocalDate(input.creationDate);
	// mvhd creation_time is UTC by definition, with or without a 'Z'.
	const utcMs = parseLocalDate(input.creationTime)?.utcMs ?? null;
	if (apple && apple.offsetMin !== null) {
		const offset = formatOffset(apple.offsetMin);
		return { takenAt: apple.local + offset, takenMs: apple.utcMs, offset };
	}
	if (apple) return { takenAt: apple.local, takenMs: utcMs ?? apple.utcMs, offset: null };
	if (utcMs !== null) return { takenAt: new Date(utcMs).toISOString().replace(/\.\d{3}Z$/, 'Z'), takenMs: utcMs, offset: null };
	if (validMs(input.clientMtimeMs)) return { takenAt: null, takenMs: input.clientMtimeMs, offset: null };
	return { takenAt: null, takenMs: input.uploadedMs, offset: null };
}

/** mvhd creation_time for ffmpeg ('2024-07-04T18:22:31.000Z'), or null before 2000. */
export function creationTimeFor(takenMs: number): string | null {
	return validMs(takenMs) ? new Date(takenMs).toISOString() : null;
}

/** '2024-07-04T11:22:31-07:00' → '2024:07:04 11:22:31-07:00' (ExifTool date syntax). */
export function exifDate(takenAt: string): string {
	return takenAt.replace(/^(\d{4})-(\d{2})-(\d{2})T/, '$1:$2:$3 ');
}

/** '37.3349, -122.009, 10' — the form ExifTool accepts for QuickTime GPSCoordinates. */
export function gpsCoordinates(g: Gps): string {
	const f = (n: number) => String(Number(n.toFixed(6)));
	return [f(g.lat), f(g.lon), ...(g.alt !== null ? [f(g.alt)] : [])].join(', ');
}

/**
 * The required exiftool step on the canonical MP4 (values come from the database): Keys:CreationDate
 * when the local offset is known (Apple reads Keys from moov/meta), and Keys + UserData (©xyz,
 * read by Google Photos) GPS. ExifTool fixes chunk offsets and keeps moov before mdat.
 */
export async function writeVideoMetadata(file: string, taken: Taken, gps: Gps | null): Promise<void> {
	const tags: Record<string, string> = {};
	if (taken.offset && taken.takenAt) tags['Keys:CreationDate'] = exifDate(taken.takenAt);
	if (gps) {
		tags['Keys:GPSCoordinates'] = gpsCoordinates(gps);
		tags['UserData:GPSCoordinates'] = gpsCoordinates(gps);
	}
	if (Object.keys(tags).length === 0) return;
	try {
		await exiftool().write(file, tags, { writeArgs: ['-overwrite_original', '-api', 'QuickTimeUTC=1'] });
	} catch (e) {
		throw new MediaError('retryable', `exiftool could not write the date/place: ${(e as Error).message}`);
	}
}
