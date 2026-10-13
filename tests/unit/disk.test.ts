import { describe, expect, it } from 'vitest';
import {
	GiB,
	JOB_MIN_FREE_BYTES,
	UPLOAD_HEADROOM_BYTES,
	formatBytes,
	freeBytes,
	freeBytesSync,
	hasRoomForUpload,
	spaceNeededForUpload
} from '#lib/server/disk';
import { testEnv } from '../helpers/env';

describe('upload space rule: free ≥ 2 × Upload-Length + 2 GiB', () => {
	it('needs twice the upload plus 2 GiB', () => {
		expect(UPLOAD_HEADROOM_BYTES).toBe(2 * GiB);
		expect(spaceNeededForUpload(0)).toBe(2 * GiB);
		expect(spaceNeededForUpload(1 * GiB)).toBe(4 * GiB);
		expect(spaceNeededForUpload(50 * GiB)).toBe(102 * GiB);
	});

	it('accepts exactly at the boundary and refuses one byte below', () => {
		const size = 3 * GiB + 12345;
		const need = 2 * size + 2 * GiB;
		expect(hasRoomForUpload(need, size)).toBe(true);
		expect(hasRoomForUpload(need + 1, size)).toBe(true);
		expect(hasRoomForUpload(need - 1, size)).toBe(false);
		expect(hasRoomForUpload(0, 0)).toBe(false);
	});

	it('keeps 2 GiB for each lane job on /config', () => {
		expect(JOB_MIN_FREE_BYTES).toBe(2 * GiB);
	});
});

describe('freeBytes', () => {
	it('reads the free space of a real directory (async and sync agree)', async () => {
		const dir = testEnv().root;
		const a = await freeBytes(dir);
		const b = freeBytesSync(dir);
		expect(a).toBeGreaterThan(0);
		expect(Number.isSafeInteger(a)).toBe(true);
		expect(Math.abs(a - b)).toBeLessThan(512 * 1024 * 1024); // other processes may write meanwhile
	});

	it('rejects for a missing directory', async () => {
		await expect(freeBytes('/definitely/not/here')).rejects.toThrow();
	});
});

describe('formatBytes', () => {
	it('uses decimal units like phones do', () => {
		expect(formatBytes(0)).toBe('0 bytes');
		expect(formatBytes(999)).toBe('999 bytes');
		expect(formatBytes(1536)).toBe('1.5 KB');
		expect(formatBytes(52_428_800)).toBe('52.4 MB');
		expect(formatBytes(2 * GiB)).toBe('2.1 GB');
		expect(formatBytes(28e9)).toBe('28.0 GB');
		expect(formatBytes(512e9)).toBe('512 GB');
		expect(formatBytes(3.2e12)).toBe('3.2 TB');
	});
});
