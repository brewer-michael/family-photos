/**
 * "Save to my phone" (docs/media-pipeline.md §7). Always the canonical file, never a preview.
 *
 * - iOS/iPadOS: Web Share with the file (File.lastModified = taken date), which offers
 *   "Save Image/Video" into the camera roll. Safari only lets share() run straight from a tap, so
 *   a file that isn't in memory yet takes two taps: "Getting it ready… 45%", then "Tap to save".
 *   Photos ≤ 3 MB are fetched ahead of time once the photo has been open 1.5 s (not with Data
 *   Saver on), so one tap is enough. Videos over 250 MB are a plain download into Files instead.
 * - Android and computers: a plain `<a download>` of `?dl=1` (Content-Disposition: attachment).
 * - Album "Save all": iOS shares batches of up to 10 (one "Save next 10" tap each); Android
 *   downloads the files one by one, 500 ms apart.
 */
import type { SaveTargetDTO } from './dto';

export type Platform = 'ios' | 'android' | 'desktop';
export type SaveMode = 'share' | 'download';

export const PREFETCH_MAX_BYTES = 3 * 1024 * 1024;
export const PREFETCH_DELAY_MS = 1500;
/** Bigger iOS videos are downloaded (to Files) instead of being shared from memory. */
export const IOS_SHARE_MAX_BYTES = 250 * 1024 * 1024;
export const SAVE_ALL_BATCH = 10;
export const ANDROID_DOWNLOAD_GAP_MS = 500;

type NavLike = Pick<Navigator, 'userAgent' | 'maxTouchPoints'>;

/** iPadOS reports itself as a Mac; touch points give it away. */
export function detectPlatform(nav: NavLike = navigator): Platform {
	const ua = nav.userAgent;
	if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1)) return 'ios';
	if (/Android/i.test(ua)) return 'android';
	return 'desktop';
}

/** True when the browser can share files (checked with a tiny JPEG, never by brand). */
export function canShareFiles(nav: Navigator = navigator): boolean {
	try {
		return (
			typeof nav.share === 'function' &&
			typeof nav.canShare === 'function' &&
			nav.canShare({ files: [new File([new Uint8Array(1)], 'x.jpg', { type: 'image/jpeg' })] })
		);
	} catch {
		return false;
	}
}

export function saveDataOn(nav: Navigator = navigator): boolean {
	return (nav as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
}

/** How "Save to my phone" works for this file on this device. */
export function saveMode(t: Pick<SaveTargetDTO, 'kind' | 'size'>, platform: Platform, canShare: boolean): SaveMode {
	if (platform !== 'ios' || !canShare) return 'download';
	if (t.kind === 'video' && (t.size ?? Infinity) > IOS_SHARE_MAX_BYTES) return 'download';
	return 'share';
}

/** Small photos are fetched ahead of time so a single tap can share them. */
export function shouldPrefetch(t: Pick<SaveTargetDTO, 'kind' | 'size'>, saveData: boolean): boolean {
	return !saveData && t.kind === 'photo' && t.size !== null && t.size <= PREFETCH_MAX_BYTES;
}

/** Downloads the canonical file into memory as a File dated to when it was taken. */
export async function fetchAsFile(
	t: SaveTargetDTO,
	onProgress?: (pct: number) => void,
	signal?: AbortSignal
): Promise<File> {
	const res = await fetch(t.url, { signal, credentials: 'same-origin' });
	if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
	const total = t.size ?? (Number(res.headers.get('content-length')) || 0);
	const reader = res.body.getReader();
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.byteLength;
		if (total > 0) onProgress?.(Math.min(99, Math.floor((received * 100) / total)));
	}
	onProgress?.(100);
	return new File(chunks, t.name, { type: t.type, lastModified: t.takenMs ?? Date.now() });
}

/** Opens the share sheet. Resolves 'cancelled' when the person closes it without choosing. */
export async function shareFiles(files: File[]): Promise<'shared' | 'cancelled'> {
	try {
		await navigator.share({ files });
		return 'shared';
	} catch (e) {
		if ((e as DOMException).name === 'AbortError') return 'cancelled';
		throw e;
	}
}

/** Starts a plain download (the server sends Content-Disposition: attachment). */
export function startDownload(url: string, name: string): void {
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	a.rel = 'noopener';
	a.hidden = true;
	document.body.append(a);
	a.click();
	a.remove();
}

export type SaveAllStep<T> = { kind: 'share'; items: T[] } | { kind: 'download'; item: T };

/**
 * Splits an album into "Save all" steps for iOS: share batches of up to `batchSize` files and at
 * most IOS_SHARE_MAX_BYTES together, plus one download step per video too big to share.
 */
export function planSaveAll<T extends Pick<SaveTargetDTO, 'kind' | 'size'>>(
	items: readonly T[],
	batchSize: number = SAVE_ALL_BATCH,
	maxBytes: number = IOS_SHARE_MAX_BYTES
): SaveAllStep<T>[] {
	const steps: SaveAllStep<T>[] = [];
	let batch: T[] = [];
	let bytes = 0;
	const flush = () => {
		if (batch.length > 0) steps.push({ kind: 'share', items: batch });
		batch = [];
		bytes = 0;
	};
	for (const item of items) {
		if (saveMode(item, 'ios', true) === 'download') {
			steps.push({ kind: 'download', item });
			continue;
		}
		const size = item.size ?? 0;
		if (batch.length >= batchSize || (batch.length > 0 && bytes + size > maxBytes)) flush();
		batch.push(item);
		bytes += size;
	}
	flush();
	return steps;
}
