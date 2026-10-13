/**
 * The Uploader's state (docs/media-pipeline.md §6 "Uploader UX changes"): one tile per picked file
 * straight away, tus uploads two at a time, small local previews, a Screen Wake Lock while sending,
 * and /api/status polling until every item has settled. Uploader.svelte renders it.
 *
 * A dropped connection is retried on RETRY_DELAYS even while the browser says it is offline
 * (tus-js-client's default gives up at once then). If it is still offline after the last retry, the
 * file waits for the browser's `online` event and carries on from where it stopped: it never ends
 * as "didn't send" just because the Wi-Fi dropped for a while.
 *
 * Nothing is converted, resized or hashed here: files go up exactly as picked, and the server
 * decides what they are from their bytes. Only obvious non-media (documents, archives, audio, SVG,
 * empty files) is skipped. tus-js-client is loaded on first use, in the browser only.
 */
import type { DetailedError, Upload } from 'tus-js-client';
import { isIOS, isObviouslyNotMedia, looksLikeVideo, withoutExtension } from '#lib/media/allowlist';
import { isFinished, POLL_HIDDEN_MS, POLL_VISIBLE_MS, retryUpload, STATUS_BATCH } from './status';
import type { MediaStatusDTO } from '#lib/shared/media-types';

/** 50 MiB: under Cloudflare's 100 MB request limit (and BODY_SIZE_LIMIT=64M). */
export const CHUNK_SIZE = 50 * 1024 * 1024;
export const RETRY_DELAYS = [0, 1000, 3000, 5000, 10_000, 20_000, 60_000];
export const PARALLEL_UPLOADS = 2;
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
export const SEND_FAILED_TEXT = "This one didn't send. Check your connection, then try again.";

/** The browser knows it has no connection (navigator.onLine can only be trusted when false). */
const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * tus-js-client's own retry rule (network errors, 5xx, 409, 423; plus 429), without its "only while
 * the browser says it is online" condition.
 */
export function shouldRetrySend(err: Error | DetailedError): boolean {
	const status = ('originalResponse' in err ? err.originalResponse?.getStatus() : null) ?? 0;
	return status < 400 || status >= 500 || status === 409 || status === 423 || status === 429;
}

/**
 * waiting → sending → sent (then the server's status takes over), or skipped (not media) or
 * error (the upload itself failed; "Try again" sends it again, resuming where it stopped). An item
 * whose connection dropped stays 'sending' (with `offline`) until the internet is back.
 */
export type Stage = 'waiting' | 'sending' | 'sent' | 'skipped' | 'error';

let nextKey = 1;

export class UploadItem {
	readonly key = nextKey++;
	readonly file: File;
	readonly video: boolean;
	/** The album it goes to, fixed when it was picked. */
	readonly albumId: number;
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
	/** Sending, but the browser is offline: it carries on by itself when the internet is back. */
	offline = $state(false);
	/**
	 * /api/status stopped answering for it (the admin removed it, or this browser's sign-in
	 * changed): there is nothing more to follow, so the tile stays at "✓ Sent".
	 */
	gone = $state(false);
	upload: Upload | null = null;

	constructor(file: File, albumId: number) {
		this.file = file;
		this.albumId = albumId;
		this.video = looksLikeVideo(file);
	}

	/** The picked file's name without its extension ("IMG_1234"), as on the album page. */
	get name(): string {
		return withoutExtension(this.file.name).trim() || (this.video ? 'Video' : 'Photo');
	}

	/** Nothing more will happen without the user doing something. */
	get settled(): boolean {
		if (this.stage === 'skipped' || this.stage === 'error') return true;
		if (this.stage !== 'sent') return false;
		return this.mediaId === null || this.gone || (this.server !== null && isFinished(this.server.status));
	}

	/** "Try again" applies: the upload failed, or the server reports a retryable failure. */
	get canRetry(): boolean {
		return this.stage === 'error' || (this.server?.status === 'failed' && this.server.errorCode === 'retryable');
	}
}

type TusModule = typeof import('tus-js-client');
let tusModule: Promise<TusModule> | null = null;
/** A failed load (e.g. offline before the first upload) is tried again next time. */
const loadTus = () =>
	(tusModule ??= import('tus-js-client').catch((e: unknown) => {
		tusModule = null;
		throw e;
	}));

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
	/**
	 * Every file of the batch has settled and at least one was sent. `unsent`: how many didn't send
	 * (their tiles say why and offer "Try again"; a retry that works calls ondone again).
	 */
	ondone?: (result: { unsent: number }) => void;
	/**
	 * After `ondone`, hand the sent files over to the page (which lists them itself): their tiles
	 * make way for a one-line `summary`. Tiles only the uploader knows about (not sent, or skipped)
	 * stay.
	 */
	clearOnDone?: () => boolean;
}

/** What became of the files handed over after a batch finished (UploadBatchOptions.clearOnDone). */
export interface DoneSummary {
	added: number;
	/** Already in this album. */
	already: number;
	failed: number;
	/** Sent, with nothing more known about them. */
	sent: number;
}

/** "Done! 3 added." / "Done! 2 added. 1 couldn't be added — see below." / "1 couldn't be added — see below." */
export function summaryText(s: DoneSummary): string {
	const ok = [
		...(s.added ? [`${s.added} added`] : []),
		...(s.already ? [`${s.already} already in this album`] : []),
		...(s.sent ? [`${s.sent} sent`] : [])
	];
	const lines = [
		...(ok.length > 0 ? [`Done! ${ok.join(' · ')}.`] : []),
		...(s.failed ? [`${s.failed} couldn't be added — see below.`] : [])
	];
	return lines.join(' ') || 'Done!';
}

export class UploadBatch {
	items = $state<UploadItem[]>([]);
	/** iOS: the picker closed but its files haven't arrived yet. */
	gap = $state(false);
	/** With clearOnDone: what became of the files handed over to the page since the batch began. */
	summary = $state<DoneSummary | null>(null);

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
	/** Files whose upload failed (stage 'error'): nothing is done until "Try again". */
	readonly unsent = $derived(this.items.filter((i) => i.stage === 'error').length);
	/** Some file is waiting for the internet to come back. */
	readonly offline = $derived(this.items.some((i) => i.offline));

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
	/** A wake lock request is on its way (so overlapping calls don't take two). */
	#wakeLockPending = false;
	#picking = false;
	#gapTimer: ReturnType<typeof setTimeout> | null = null;
	#destroyed = false;
	/**
	 * Uploads that ran out of retries while offline. Each keeps its sending slot and its 'sending'
	 * stage (so the screen stays awake and leaving still asks) until `online`.
	 */
	#parked = new Set<UploadItem>();
	#listening = false;

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
		const albumId = this.#opts.albumId();
		const added: UploadItem[] = [];
		for (const file of files) {
			const item = new UploadItem(file, albumId);
			if (isObviouslyNotMedia(file)) {
				item.stage = 'skipped';
				item.problem = NOT_MEDIA_TEXT;
			}
			added.push(item);
		}
		if (added.length === 0) return;
		if (this.allSettled || this.items.length === 0) this.#clear();
		this.#doneFired = false;
		this.items.push(...added);
		this.#queuePreviews(added.filter((i) => i.stage !== 'skipped'));
		this.#pump();
		this.#checkDone();
	}

	/** "Try again" on every file that didn't send. */
	retryAll(): void {
		for (const item of this.items) if (item.stage === 'error') void this.retry(item);
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
		const albumId = String(item.albumId);
		let finished = false;
		const finish = (stage: 'sent' | 'error', problem: string | null = null) => {
			if (finished) return;
			finished = true;
			item.stage = stage;
			item.problem = problem;
			item.offline = false;
			item.upload = null;
			this.#active--;
			this.#pump();
			this.#poll(POLL_VISIBLE_MS);
			this.#checkDone();
		};
		/** Out of retries while offline: wait for the connection instead of giving up. */
		const park = () => {
			if (finished) return;
			finished = true;
			item.offline = true;
			item.upload = null;
			this.#parked.add(item);
			this.#listenForInternet();
		};
		try {
			const { Upload } = await loadTus();
			const upload = new Upload(item.file, {
				endpoint: '/api/upload',
				chunkSize: CHUNK_SIZE,
				retryDelays: RETRY_DELAYS,
				removeFingerprintOnSuccess: true,
				metadata: { filename: item.file.name, lastModified: String(item.file.lastModified), albumId },
				onShouldRetry: (err) => {
					item.offline = isOffline();
					return shouldRetrySend(err);
				},
				onProgress: (sent) => {
					item.sent = sent;
					item.offline = false;
				},
				onSuccess: ({ lastResponse }) => {
					item.sent = item.file.size;
					item.mediaId = lastResponse.getHeader('X-Media-Id') ?? null;
					finish('sent');
				},
				onError: (err) => {
					if (isOffline() && !this.#destroyed) park();
					else finish('error', sendProblem(err));
				}
			});
			item.upload = upload;
			// Resume an earlier, interrupted upload of this same file into this same album.
			const previous = (await upload.findPreviousUploads().catch(() => [])).find((p) => p.metadata?.albumId === albumId);
			if (previous) upload.resumeFromPreviousUpload(previous);
			if (this.#destroyed) finish('error', SEND_FAILED_TEXT);
			else upload.start();
		} catch {
			if (isOffline() && !this.#destroyed) park();
			else finish('error', SEND_FAILED_TEXT);
		}
	}

	#listenForInternet(): void {
		if (this.#listening || typeof window === 'undefined') return;
		this.#listening = true;
		window.addEventListener('online', this.#online);
	}

	#stopListening(): void {
		if (!this.#listening) return;
		this.#listening = false;
		window.removeEventListener('online', this.#online);
	}

	/**
	 * The internet is back: parked uploads go back in line and carry on where they stopped (a new
	 * tus Upload, with a fresh set of retries, finds the earlier one like "Try again" does).
	 */
	readonly #online = (): void => {
		if (this.#destroyed) return;
		for (const item of this.items) item.offline = false;
		const parked = [...this.#parked];
		this.#parked.clear();
		this.#stopListening();
		for (const item of parked) {
			if (item.stage !== 'sending') continue;
			item.stage = 'waiting';
			this.#active--;
		}
		this.#pump();
	};

	#checkDone(): void {
		if (this.#destroyed || this.#doneFired || !this.allSettled || !this.items.some((i) => i.stage === 'sent')) return;
		this.#doneFired = true;
		this.#opts.ondone?.({ unsent: this.unsent });
		if (this.#opts.clearOnDone?.()) this.#handOver();
	}

	/** clearOnDone: the sent files' tiles make way for the summary (the page shows them now). */
	#handOver(): void {
		const summary: DoneSummary = { ...(this.summary ?? { added: 0, already: 0, failed: 0, sent: 0 }) };
		const kept: UploadItem[] = [];
		for (const i of this.items) {
			if (i.stage !== 'sent') {
				kept.push(i);
				continue;
			}
			const status = i.gone ? null : i.server?.status;
			if (status === 'ready') summary.added++;
			else if (status === 'duplicate') summary.already++;
			else if (status === 'failed') summary.failed++;
			else summary.sent++;
			if (i.preview) URL.revokeObjectURL(i.preview);
		}
		this.items = kept;
		this.summary = summary;
	}

	/** A new batch after the previous one settled: forget the old tiles. */
	#clear(): void {
		for (const i of this.items) if (i.preview) URL.revokeObjectURL(i.preview);
		this.items = [];
		this.summary = null;
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
				const asked = new Set(ids.slice(at, at + STATUS_BATCH));
				const q = encodeURIComponent([...asked].join(','));
				const res = await fetch(`/api/status?ids=${q}`, { headers: { accept: 'application/json' } });
				if (!res.ok) throw new Error(`status ${res.status}`);
				const byId = new Map(((await res.json()) as MediaStatusDTO[]).map((r) => [r.id, r]));
				for (const item of this.items) {
					if (!item.mediaId || !asked.has(item.mediaId)) continue;
					const s = byId.get(item.mediaId);
					// Left out of the answer: removed, or no longer ours to see. Stop asking.
					if (s) item.server = s;
					else item.gone = true;
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

	/**
	 * The page became visible again: refresh now, take the wake lock back if still sending, and
	 * carry on with parked uploads if the connection came back meanwhile.
	 */
	visible(): void {
		this.#poll(0);
		if (this.#parked.size > 0 && !isOffline()) this.#online();
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
		if (this.#wakeLock || this.#wakeLockPending || this.#destroyed || !('wakeLock' in navigator) || this.#hidden()) return;
		this.#wakeLockPending = true;
		try {
			const lock = await navigator.wakeLock.request('screen');
			if (this.#destroyed || !this.sending) {
				void lock.release().catch(() => {});
				return;
			}
			this.#wakeLock = lock;
			lock.addEventListener('release', () => {
				if (this.#wakeLock === lock) this.#wakeLock = null;
			});
		} catch {
			// not allowed right now (battery saver, hidden tab): the copy still says keep it open
		} finally {
			this.#wakeLockPending = false;
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
		this.#parked.clear();
		this.#stopListening();
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
