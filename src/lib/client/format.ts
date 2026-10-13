/**
 * Words and dates shown on pages. Deterministic on the server and in the browser (fixed locale,
 * and the server's time zone passed in from the layout), so hydration never changes the text.
 */
import type { TileDTO } from './dto';

const LOCALE = 'en-US';
const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})/;

function longDate(date: Date, timeZone: string): string {
	try {
		return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'long', timeZone }).format(date);
	} catch {
		return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'long', timeZone: 'UTC' }).format(date);
	}
}

/** "July 4, 2024": an epoch-ms instant as a calendar day in `timeZone`. */
export function formatDay(ms: number, timeZone: string): string {
	return longDate(new Date(ms), timeZone);
}

/**
 * When a photo was taken: the day from taken_at's own wall time (where it was taken), else
 * taken_ms in the server's time zone. Empty when neither is known.
 */
export function formatTaken(takenAt: string | null, takenMs: number | null, timeZone: string): string {
	const m = takenAt ? WALL_TIME.exec(takenAt) : null;
	if (m) return longDate(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)), 'UTC');
	return takenMs === null ? '' : formatDay(takenMs, timeZone);
}

/** 42 000 → "0:42", 3 723 000 → "1:02:03". */
export function formatDuration(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms) || ms < 0) return '';
	const total = Math.round(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = String(total % 60).padStart(2, '0');
	return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "12 photos · 2 videos", "1 photo", "Nothing here yet". */
export function countLabel(photos: number, videos: number): string {
	const parts: string[] = [];
	if (photos > 0) parts.push(plural(photos, 'photo', 'photos'));
	if (videos > 0) parts.push(plural(videos, 'video', 'videos'));
	return parts.length > 0 ? parts.join(' · ') : 'Nothing here yet';
}

/**
 * Alt text for a tile: "Photo from July 4, 2024, added by Aunt Linda",
 * "Video, 0:42, from July 4, 2024, added by Aunt Linda".
 */
export function tileAlt(t: Pick<TileDTO, 'kind' | 'durationMs' | 'takenAt' | 'takenMs' | 'by'>, timeZone: string): string {
	const duration = t.kind === 'video' ? formatDuration(t.durationMs) : '';
	const what = t.kind === 'video' ? (duration ? `Video, ${duration},` : 'Video') : 'Photo';
	const when = formatTaken(t.takenAt, t.takenMs, timeZone);
	return `${what}${when ? ` from ${when},` : ''} added by ${t.by}`;
}

/** Rough time left: "about 3 minutes", "a few minutes". */
export function aboutTime(etaS: number | undefined): string {
	if (etaS === undefined || !Number.isFinite(etaS) || etaS < 90) return 'a few minutes';
	const min = Math.round(etaS / 60);
	return min >= 90 ? `about ${Math.round(min / 60)} hours` : `about ${min} minutes`;
}
