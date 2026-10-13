import { describe, expect, it } from 'vitest';
import { aboutTime, countLabel, formatDay, formatDuration, formatTaken, tileAlt } from '#lib/client/format';
import { mediaUrl } from '#lib/client/dto';

describe('format', () => {
	it('shows the taken day in the wall time where it was taken', () => {
		// 23:30 in California is already the 5th in UTC: still July 4.
		expect(formatTaken('2024-07-04T23:30:00-07:00', Date.UTC(2024, 6, 5, 6, 30), 'UTC')).toBe('July 4, 2024');
		expect(formatTaken(null, Date.UTC(2024, 6, 5, 6, 30), 'America/Los_Angeles')).toBe('July 4, 2024');
		expect(formatTaken(null, Date.UTC(2024, 6, 5, 6, 30), 'Europe/Berlin')).toBe('July 5, 2024');
		expect(formatTaken(null, null, 'UTC')).toBe('');
		expect(formatDay(0, 'Not/AZone')).toBe('January 1, 1970'); // unknown zones fall back to UTC
	});

	it('formats durations, counts, alt text and rough times', () => {
		expect(formatDuration(42_000)).toBe('0:42');
		expect(formatDuration(62_400)).toBe('1:02');
		expect(formatDuration(3_723_000)).toBe('1:02:03');
		expect(formatDuration(null)).toBe('');
		expect(countLabel(12, 2)).toBe('12 photos · 2 videos');
		expect(countLabel(1, 0)).toBe('1 photo');
		expect(countLabel(0, 1)).toBe('1 video');
		expect(countLabel(0, 0)).toBe('Nothing here yet');
		const t = { kind: 'photo' as const, durationMs: null, takenAt: '2024-07-04T11:00:00', takenMs: 0, by: 'Aunt Linda' };
		expect(tileAlt(t, 'UTC')).toBe('Photo from July 4, 2024, added by Aunt Linda');
		expect(tileAlt({ ...t, kind: 'video', durationMs: 42_000 }, 'UTC')).toBe('Video, 0:42, from July 4, 2024, added by Aunt Linda');
		expect(tileAlt({ ...t, takenAt: null, takenMs: null }, 'UTC')).toBe('Photo added by Aunt Linda');
		expect(aboutTime(undefined)).toBe('a few minutes');
		expect(aboutTime(30)).toBe('a few minutes');
		expect(aboutTime(400)).toBe('about 7 minutes');
		expect(aboutTime(3 * 3600)).toBe('about 3 hours');
	});

	it('builds media URLs with the cache-busting version', () => {
		const id = '01J0000000000000000000000A';
		expect(mediaUrl(id, 'thumb', { v: 2 })).toBe(`/media/${id}/thumb?v=2`);
		expect(mediaUrl(id, 'file', { v: 1, download: true })).toBe(`/media/${id}/file?v=1&dl=1`);
		expect(mediaUrl(id, 'poster')).toBe(`/media/${id}/poster`);
	});
});
