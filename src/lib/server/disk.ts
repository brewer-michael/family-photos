/**
 * Free-space checks (docs/media-pipeline.md §3 "Resource limits" → Caps):
 *   - tus creation needs free space on /photos ≥ 2 × Upload-Length + 2 GiB (the upload, plus room
 *     for its canonical file, plus headroom);
 *   - each lane job needs ≥ 2 GiB free on /config (decoded intermediates in /config/tmp).
 */
import fs from 'node:fs';

export const GiB = 1024 ** 3;
/** Headroom kept free on /photos on top of twice the upload's size. */
export const UPLOAD_HEADROOM_BYTES = 2 * GiB;
/** Free space a lane job needs on /config before it is dispatched. */
export const JOB_MIN_FREE_BYTES = 2 * GiB;

/** Bytes available to this (unprivileged) process on the filesystem holding `dir`. */
export async function freeBytes(dir: string): Promise<number> {
	const s = await fs.promises.statfs(dir);
	return s.bavail * s.bsize;
}

/** Synchronous variant for the queue's per-job check (one statfs syscall). */
export function freeBytesSync(dir: string): number {
	const s = fs.statfsSync(dir);
	return s.bavail * s.bsize;
}

/** Free space an upload of `uploadLength` bytes needs: 2 × length + 2 GiB. */
export function spaceNeededForUpload(uploadLength: number): number {
	return 2 * uploadLength + UPLOAD_HEADROOM_BYTES;
}

export function hasRoomForUpload(free: number, uploadLength: number): boolean {
	return free >= spaceNeededForUpload(uploadLength);
}

/** 1536 → "1.5 KB", 52_428_800 → "52.4 MB" (decimal units, as phones and Unraid show them). */
export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n < 1000) return `${Math.max(0, Math.round(n || 0))} bytes`;
	const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
	let v = n / 1000;
	let i = 0;
	while (v >= 1000 && i < units.length - 1) {
		v /= 1000;
		i++;
	}
	return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
