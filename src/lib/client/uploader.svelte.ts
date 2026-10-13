/**
 * The Uploader's state (docs/media-pipeline.md §6 "Uploader UX changes"): one tile per picked file
 * straight away, tus uploads two at a time, small local previews, a Screen Wake Lock while sending,
 * and /api/status polling until every item has settled. Uploader.svelte renders it.
 *
 * Nothing is converted, resized or hashed here: files go up exactly as picked, and the server
 * decides what they are from their bytes. Only obvious non-media (documents, archives, audio, SVG,
 * empty files) is skipped. tus-js-client is loaded on first use, in the browser only.
 */
import type { DetailedError, Upload } from 'tus-js-client';
import { isIOS, isObviouslyNotMedia, looksLikeVideo } from '#lib/media/allowlist';
import { isFinished, POLL_HIDDEN_MS, POLL_VISIBLE_MS, retryUpload } from './status';
import type { MediaStatusDTO } from '#lib/shared/media-types';

/** 50 MiB: under Cloudflare's 100 MB request limit (and BODY_SIZE_LIMIT=64M). */
export const CHUNK_SIZE = 50 * 1024 * 1024;
export const RETRY_DELAYS = [0, 1000, 3000, 5000, 10_000, 20_000, 60_000];
export const PARALLEL_UPLOADS = 2;
/** /api/status answers at most this many ids per request. */
const STATUS_BATCH = 100;
const PREVIEW_WIDTH = 240;
/** iOS: one preview at a time, small files only (memory); elsewhere a few at once. */
const PREVIEW_LIMITS = {
	ios: { parallel: 1, maxBytes: 8 * 1024 * 1024, perBatch: Infinity },
	other: { parallel: 4, maxBytes: 15 * 1024 * 1024, perBatch: 30 }
};
/** The iOS picker can take a while to hand files over after it closes. */
const GAP_DELAY_MS = 600;
const GAP_GIVE_UP_MS = 2 * 60_000;

export const NOT_MEDIA_TEXT = "That one isn't a photo or video.";
const SEND_FAILED_TEXT = "This one didn't send. Check your connection, then try again.";

/**
 * waiting → sending → sent (then the server's status takes over), or skipped (not media) or
 * error (the upload itself failed; "Try again" sends it again, resuming where it stopped).
 */
export type Stage = 'waiting' | 'sending' | 'sent' | 'skipped' | 'error';

let nextKey = 1;

export class UploadItem {
	readonly key = nextKey++;
	readonly file: File;
	readonly video: boolean;
	stage = $state<Stage>('waiting');
	/** Bytes sent so far. */
	sent = $state(0);
	/** The media id the server gave the finished upload (X-Media-Id). */
	mediaId = $state<string | null>(null);
	/** Latest /api/status answer. */
	server = $state<MediaStatusDTO | null>(null);
	/** Blob URL of a small local preview. */
	preview = $state<string | null>(null);
	/** Why the upload didn't happen (skipped/error). */
	problem = $state<string | null>(null);
	/** "Try again" in flight. */
	retrying = $state(false);
	upload: Upload | null = null;

	constructor(file: File) {
		this.file = file;
		this.video = looksLikeVideo(file);
	}

	get name(): string {
		return this.file.name || (this.video ? 'Video' : 'Photo');
	}

	/** Nothing more will happen without the user doing something. */
	get settled(): boolean {
		if (this.stage === 'skipped' || this.stage === 'error') return true;
		if (this.stage !== 'sent') return false;
		return this.mediaId === null || (this.server !== null && isFinished(this.server.status));
	}

	/** "Try again" applies: the upload failed, or the server reports a retryable failure. */
	get canRetry(): boolean {
		return this.stage === 'error' || (this.server?.status === 'failed' && this.server.errorCode === 'retryable');
	}
}

type TusModule = typeof import('tus-js-client');
let tusModule: Promise<TusModule> | null = null;
const loadTus = () => (tusModule ??= import('tus-js-client'));

/** Words for a failed upload: the server's own short sentence for 401/403/404/413, else generic. */
function sendProblem(err: Error | DetailedError): string {
	const res = 'originalResponse' in err ? err.originalResponse : null;
	const status = res?.getStatus() ?? 0;
	if ([401, 403, 404, 413].includes(status)) {
		const body = (res?.getBody() ?? '').trim();
		if (body !== '' && body.length <= 200 && !body.includes('<')) return body;
	}
	return SEND_FAILED_TEXT;
}

export interface UploadBatchOptions {
	albumId: () => number;
	/** Every file of the batch has settled and at least one was sent. */
	ondone?: () => void;
}

export class UploadBatch {
	items = $state<UploadItem[]>([]);
	/** iOS: the picker closed but its files haven't arrived yet. */
	gap = $state(false);

	/** Files that go to the server in this batch (not skipped). */
	readonly toSend = $derived(this.items.filter((i) => i.stage !== 'skipped'));
	readonly sending = $derived(this.items.some((i) => i.stage === 'waiting' || i.stage === 'sending'));
	/** 1-based number of the file being sent, for "Sending 3 of 12…". */
	readonly current = $derived(
		Math.min(this.toSend.length, this.toSend.filter((i) => i.stage === 'sent' || i.stage === 'error').length + 1)
	);
	readonly bytesTotal = $derived(this.toSend.filter((i) => i.stage !== 'error').reduce((n, i) => n + i.file.size, 0));
	readonly bytesSent = $derived(this.toSend.filter((i) => i.stage !== 'error').reduce((n, i) => n + i.sent, 0));
	readonly allSettled = $derived(this.items.length > 0 && this.items.every((i) => i.settled));

	readonly #opts: UploadBatchOptions;
	#active = 0;
	#doneFired = false;
	#pollTimer: ReturnType<typeof setTimeout> | null = null;
	#pollDue = 0;
	#polling = false;
	#previewQueue: UploadItem[] = [];
	#previewActive = 0;
	#previewCount = 0;
	#wakeLock: WakeLockSentinel | null = null;
	#picking = false;
	#gapTimer: ReturnType<typeof setTimeout> | null = null;
	#destroyed = false;

	constructor(opts: UploadBatchOptions) {
		this.#opts = opts;
	}

	// --- picking -------------------------------------------------------------------

	/** The file picker is about to open. */
	picking(): void {
		this.#picking = true;
	}

	/** Window focus came back (the picker closed): on iOS, say something if files are slow to arrive. */
	focused(ios: boolean): void {
		if (!this.#picking || !ios) return;
		this.#clearGap();
		this.#gapTimer = setTimeout(() => {
			if (!this.#picking) return;
			this.gap = true;
			this.#gapTimer = setTimeout(() => this.pickerClosed(), GAP_GIVE_UP_MS);
		}, GAP_DELAY_MS);
	}

	/** `change` or `cancel` on the input. */
	pickerClosed(): void {
		this.#picking = false;
		this.#clearGap();
		this.gap = false;
	}

	#clearGap(): void {
		if (this.#gapTimer) clearTimeout(this.#gapTimer);
		this.#gapTimer = null;
	}

	// --- adding and sending ----------------------------------------------------------

	/** New files from the picker: tiles at once, then uploads and previews. */
	add(files: Iterable<File>): void {
		this.pickerClosed();
		if (this.allSettled) this.#clear();
		const added: UploadItem[] = [];
		for (const file of files) {
			const item = new UploadItem(file);
			if (isObviouslyNotMedia(file)) {
				item.stage = 'skipped';
				item.problem = NOT_MEDIA_TEXT;
			}
			added.push(item);
		}
		if (added.length === 0) return;
		this.#doneFired = false;
		this.items.push(...added);
		this.#queuePreviews(added.filter((i) => i.stage !== 'skipped'));
		this.#pump();
		this.#checkDone();
	}

	/** "Try again": re-send a failed upload, or ask the server to retry a failed item. */
	async retry(item: UploadItem): Promise<void> {
		if (!item.canRetry || item.retrying) return;
		this.#doneFired = false;
		if (item.stage === 'error') {
			item.stage = 'waiting';
			item.problem = null;
			item.sent = 0;
			this.#pump();
			return;
		}
		item.retrying = true;
		const status = item.mediaId ? await retryUpload(item.mediaId) : null;
		item.retrying = false;
		if (status && item.mediaId) item.server = { id: item.mediaId, status, kind: item.server?.kind ?? null };
		this.#poll(POLL_VISIBLE_MS);
		this.#checkDone();
	}

	#pump(): void {
		while (!this.#destroyed && this.#active < PARALLEL_UPLOADS) {
			const next = this.items.find((i) => i.stage === 'waiting');
			if (!next) break;
			this.#active++;
			next.stage = 'sending';
			void this.#send(next);
		}
		if (this.sending) void this.#holdWakeLock();
		else this.#releaseWakeLock();
	}

	async #send(item: UploadItem): Promise<void> {
		const albumId = String(this.#opts.albumId());
		let finished = false;
		const finish = (stage: 'sent' | 'error', problem: string | null = null) => {
			if (finished) return;
			finished = true;
			item.stage = stage;
			item.problem = problem;
			item.upload = null;
			this.#active--;
			this.#pump();
			this.#poll(POLL_VISIBLE_MS);
			this.#checkDone();
		};
		try {
			const { Upload } = await loadTus();
			const upload = new Upload(item.file, {
				endpoint: '/api/upload',
				chunkSize: CHUNK_SIZE,
				retryDelays: RETRY_DELAYS,
				removeFingerprintOnSuccess: true,
				metadata: { filename: item.file.name, lastModified: String(item.file.lastModified), albumId },
				onProgress: (sent) => {
					item.sent = sent;
				},
				onSuccess: ({ lastResponse }) => {
					item.sent = item.file.size;
					item.mediaId = lastResponse.getHeader('X-Media-Id') ?? null;
					finish('sent');
				},
				onError: (err) => finish('error', sendProblem(err))
			});
			item.upload = upload;
			// Resume an earlier, interrupted upload of this same file into this same album.
			const previous = (await upload.findPreviousUploads().catch(() => [])).find((p) => p.metadata?.albumId === albumId);
			if (previous) upload.resumeFromPreviousUpload(previous);
			if (this.#destroyed) finish('error', SEND_FAILED_TEXT);
			else upload.start();
		} catch {
			finish('error', SEND_FAILED_TEXT);
		}
	}

	#checkDone(): void {
		if (this.#destroyed || this.#doneFired || !this.allSettled || !this.items.some((i) => i.stage === 'sent')) return;
		this.#doneFired = true;
		this.#opts.ondone?.();
	}

	/** A new batch after the previous one settled: forget the old tiles. */
	#clear(): void {
		for (const i of this.items) if (i.preview) URL.revokeObjectURL(i.preview);
		this.items = [];
		this.#previewQueue = [];
		this.#previewCount = 0;
	}

	// --- status polling --------------------------------------------------------------

	#pendingIds(): string[] {
		return this.items.flatMap((i) => (i.stage === 'sent' && i.mediaId && !i.settled ? [i.mediaId] : []));
	}

	/** Polls in `ms`, unless a poll is due sooner; a no-op when nothing is waiting for the server. */
	#poll(ms: number): void {
		if (this.#destroyed || this.#polling || this.#pendingIds().length === 0) return;
		const due = Date.now() + ms;
		if (this.#pollTimer) {
			if (this.#pollDue <= due) return;
			clearTimeout(this.#pollTimer);
		}
		this.#pollDue = due;
		this.#pollTimer = setTimeout(() => void this.#pollNow(), ms);
	}

	async #pollNow(): Promise<void> {
		this.#pollTimer = null;
		const ids = this.#pendingIds();
		if (ids.length === 0) return;
		this.#polling = true;
		let next = this.#hidden() ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
		try {
			for (let at = 0; at < ids.length; at += STATUS_BATCH) {
				const q = encodeURIComponent(ids.slice(at, at + STATUS_BATCH).join(','));
				const res = await fetch(`/api/status?ids=${q}`, { headers: { accept: 'application/json' } });
				if (!res.ok) throw new Error(`status ${res.status}`);
				const byId = new Map(((await res.json()) as MediaStatusDTO[]).map((r) => [r.id, r]));
				for (const item of this.items) {
					const s = item.mediaId ? byId.get(item.mediaId) : undefined;
					if (s) item.server = s;
				}
			}
		} catch {
			next = POLL_HIDDEN_MS;
		} finally {
			this.#polling = false;
		}
		this.#checkDone();
		this.#poll(next);
	}

	#hidden(): boolean {
		return typeof document !== 'undefined' && document.visibilityState === 'hidden';
	}

	/** The page became visible again: refresh now and take the wake lock back if still sending. */
	visible(): void {
		this.#poll(0);
		if (this.sending) void this.#holdWakeLock();
	}

	// --- previews --------------------------------------------------------------------

	#queuePreviews(items: UploadItem[]): void {
		const limits = isIOS(navigator.userAgent, navigator.maxTouchPoints) ? PREVIEW_LIMITS.ios : PREVIEW_LIMITS.other;
		for (const item of items) {
			if (item.video || item.file.size > limits.maxBytes || this.#previewCount >= limits.perBatch) continue;
			this.#previewCount++;
			this.#previewQueue.push(item);
		}
		while (this.#previewActive < limits.parallel && this.#previewQueue.length > 0) {
			const item = this.#previewQueue.shift()!;
			this.#previewActive++;
			void preview(item.file)
				.then((url) => {
					if (url && (this.#destroyed || !this.items.includes(item))) URL.revokeObjectURL(url);
					else item.preview = url;
				})
				.finally(() => {
					this.#previewActive--;
					this.#queuePreviews([]);
				});
		}
	}

	// --- wake lock -------------------------------------------------------------------

	async #holdWakeLock(): Promise<void> {
		if (this.#wakeLock || this.#destroyed || !('wakeLock' in navigator) || this.#hidden()) return;
		try {
			const lock = await navigator.wakeLock.request('screen');
			if (this.#destroyed || !this.sending) {
				void lock.release();
				return;
			}
			this.#wakeLock = lock;
			lock.addEventListener('release', () => {
				if (this.#wakeLock === lock) this.#wakeLock = null;
			});
		} catch {
			// not allowed right now (battery saver, hidden tab): the copy still says keep it open
		}
	}

	#releaseWakeLock(): void {
		const lock = this.#wakeLock;
		this.#wakeLock = null;
		if (lock) void lock.release().catch(() => {});
	}

	// --- teardown --------------------------------------------------------------------

	/** The component is going away: stop sending (uploads resume when the same file is picked again). */
	destroy(): void {
		this.#destroyed = true;
		for (const i of this.items) {
			void i.upload?.abort();
			if (i.preview) URL.revokeObjectURL(i.preview);
		}
		if (this.#pollTimer) clearTimeout(this.#pollTimer);
		this.#clearGap();
		this.#releaseWakeLock();
	}
}

/**
 * A ≤240 px wide JPEG preview as a blob URL, or null when this browser can't decode the file
 * (the tile then keeps its icon). createImageBitmap first; img.decode() as the fallback, with its
 * object URL revoked as soon as the image is decoded.
 */
async function preview(file: File): Promise<string | null> {
	let source: ImageBitmap | HTMLImageElement | null = null;
	try {
		source = await createImageBitmap(file, { resizeWidth: PREVIEW_WIDTH, resizeQuality: 'medium' });
	} catch {
		const url = URL.createObjectURL(file);
		try {
			const img = new Image();
			img.src = url;
			await img.decode();
			source = img;
		} catch {
			return null;
		} finally {
			URL.revokeObjectURL(url);
		}
	}
	try {
		const w = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
		const h = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
		if (!w || !h) return null;
		const scale = Math.min(1, PREVIEW_WIDTH / w);
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(w * scale));
		canvas.height = Math.max(1, Math.round(h * scale));
		canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
		return blob ? URL.createObjectURL(blob) : null;
	} catch {
		return null;
	} finally {
		if (!(source instanceof HTMLImageElement)) source?.close();
	}
}
