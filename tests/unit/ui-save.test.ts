import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	IOS_SHARE_MAX_BYTES,
	canShareFiles,
	detectPlatform,
	fetchAsFile,
	planSaveAll,
	saveMode,
	shouldPrefetch
} from '#lib/client/save';
import type { SaveTargetDTO } from '#lib/client/dto';

const MB = 1024 * 1024;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

function target(o: Partial<SaveTargetDTO> = {}): SaveTargetDTO {
	return {
		id: '01J0000000000000000000000A',
		kind: 'photo',
		url: '/media/x/file?v=1',
		downloadUrl: '/media/x/file?v=1&dl=1',
		name: 'IMG_1.jpg',
		type: 'image/jpeg',
		size: 2 * MB,
		takenMs: Date.UTC(2024, 6, 4),
		...o
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('save to my phone', () => {
	it('detects iPhones, iPads (which claim to be Macs), Android and computers', () => {
		expect(detectPlatform({ userAgent: IPHONE, maxTouchPoints: 5 })).toBe('ios');
		expect(detectPlatform({ userAgent: IPAD_DESKTOP, maxTouchPoints: 5 })).toBe('ios');
		expect(detectPlatform({ userAgent: IPAD_DESKTOP, maxTouchPoints: 0 })).toBe('desktop'); // a real Mac
		expect(detectPlatform({ userAgent: ANDROID, maxTouchPoints: 5 })).toBe('android');
		expect(detectPlatform({ userAgent: WINDOWS, maxTouchPoints: 0 })).toBe('desktop');
	});

	it('shares on iOS (unless the video is huge) and downloads everywhere else', () => {
		expect(saveMode(target(), 'ios', true)).toBe('share');
		expect(saveMode(target({ kind: 'video', size: 200 * MB }), 'ios', true)).toBe('share');
		expect(saveMode(target({ kind: 'video', size: IOS_SHARE_MAX_BYTES + 1 }), 'ios', true)).toBe('download');
		expect(saveMode(target({ kind: 'video', size: null }), 'ios', true)).toBe('download');
		expect(saveMode(target({ size: 900 * MB }), 'ios', true)).toBe('share'); // photos always share
		expect(saveMode(target(), 'ios', false)).toBe('download');
		expect(saveMode(target(), 'android', true)).toBe('download');
		expect(saveMode(target(), 'desktop', true)).toBe('download');
	});

	it('prefetches only small photos, and never with Data Saver', () => {
		expect(shouldPrefetch(target({ size: 3 * MB }), false)).toBe(true);
		expect(shouldPrefetch(target({ size: 3 * MB + 1 }), false)).toBe(false);
		expect(shouldPrefetch(target(), true)).toBe(false);
		expect(shouldPrefetch(target({ kind: 'video', size: MB }), false)).toBe(false);
		expect(shouldPrefetch(target({ size: null }), false)).toBe(false);
	});

	it('checks file sharing by feature, not by brand', () => {
		const nav = (share: unknown, canShare: unknown) => ({ share, canShare }) as unknown as Navigator;
		expect(canShareFiles(nav(() => Promise.resolve(), () => true))).toBe(true);
		expect(canShareFiles(nav(() => Promise.resolve(), () => false))).toBe(false);
		expect(canShareFiles(nav(undefined, undefined))).toBe(false);
		expect(
			canShareFiles(
				nav(
					() => Promise.resolve(),
					() => {
						throw new Error('nope');
					}
				)
			)
		).toBe(false);
	});

	it('fetches the canonical file as a File dated to when it was taken, with progress', async () => {
		const bytes = new Uint8Array(1000).fill(7);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				const body = new ReadableStream<Uint8Array>({
					start(c) {
						c.enqueue(bytes.subarray(0, 400));
						c.enqueue(bytes.subarray(400));
						c.close();
					}
				});
				return new Response(body, { headers: { 'content-length': '1000' } });
			})
		);
		const progress: number[] = [];
		const file = await fetchAsFile(target({ size: 1000 }), (p) => progress.push(p));
		expect(file.name).toBe('IMG_1.jpg');
		expect(file.type).toBe('image/jpeg');
		expect(file.lastModified).toBe(Date.UTC(2024, 6, 4));
		expect(file.size).toBe(1000);
		expect(progress).toEqual([40, 99, 100]);

		vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })));
		await expect(fetchAsFile(target())).rejects.toThrow(/404/);
	});
});

describe('save all (iOS)', () => {
	it('shares batches of at most 10 files and 250 MB; huge videos become downloads', () => {
		const photos = Array.from({ length: 23 }, (_, i) => target({ id: `p${i}`, size: MB }));
		const steps = planSaveAll(photos);
		expect(steps.map((s) => (s.kind === 'share' ? s.items.length : 'download'))).toEqual([10, 10, 3]);

		const mixed = [
			target({ id: 'a', kind: 'video', size: 150 * MB }),
			target({ id: 'b', kind: 'video', size: 150 * MB }),
			target({ id: 'c', kind: 'video', size: 300 * MB }),
			target({ id: 'd', size: MB })
		];
		expect(planSaveAll(mixed).map((s) => (s.kind === 'share' ? s.items.map((i) => i.id).join('') : `dl:${s.item.id}`))).toEqual([
			'a',
			'dl:c',
			'bd'
		]);
		expect(planSaveAll([])).toEqual([]);
	});
});
