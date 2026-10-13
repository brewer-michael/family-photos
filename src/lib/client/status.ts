/**
 * Unfinished uploads: polling GET /api/status?ids=… and the words shown on their tiles
 * (docs/media-pipeline.md §6 "Status copy" — never a format name).
 */
import type { ErrorCode, Kind, MediaStatusDTO, Status } from '#lib/shared/media-types';
import { aboutTime } from './format';

export const POLL_VISIBLE_MS = 3000;
export const POLL_HIDDEN_MS = 10_000;

const FINISHED: ReadonlySet<Status> = new Set(['ready', 'failed', 'duplicate']);

export function isFinished(status: Status): boolean {
	return FINISHED.has(status);
}

export interface StatusLine {
	text: string;
	/** A second, calmer line (videos: "You can leave this page…"). */
	detail?: string;
	tone: 'busy' | 'ok' | 'retry' | 'error';
}

export interface StatusFacts {
	status: Status;
	kind: Kind | null;
	pct?: number;
	etaS?: number;
	queuePos?: number;
	errorCode?: ErrorCode | null;
}

const LEAVE = "You can leave this page — we'll keep going.";

export function statusLine(s: StatusFacts, adminName: string): StatusLine {
	switch (s.status) {
		case 'ready':
			return { text: '✓ Added', tone: 'ok' };
		case 'duplicate':
			return { text: '✓ Already in this album', tone: 'ok' };
		case 'failed':
			return s.errorCode === 'retryable'
				? { text: "This one didn't work.", tone: 'retry' }
				: { text: `We couldn't add this one. ${adminName} has been told.`, tone: 'error' };
		case 'queued':
			if (s.kind === 'video') {
				return {
					text: s.queuePos ? `Waiting its turn (${s.queuePos} ahead)` : 'Waiting its turn',
					detail: `Videos can take a few minutes. ${LEAVE}`,
					tone: 'busy'
				};
			}
			return { text: 'Getting it ready…', tone: 'busy' };
		case 'processing':
			if (s.kind === 'video') {
				const time = aboutTime(s.etaS);
				return {
					text: s.pct !== undefined ? `Getting your video ready… ${s.pct}%` : 'Getting your video ready…',
					detail:
						s.etaS === undefined
							? `Videos can take a few minutes. ${LEAVE}`
							: `${time[0].toUpperCase()}${time.slice(1)} to go. ${LEAVE}`,
					tone: 'busy'
				};
			}
			return { text: 'Getting it ready…', tone: 'busy' };
		default:
			return { text: 'Getting it ready…', tone: 'busy' };
	}
}

export interface PollOptions {
	visibleMs?: number;
	hiddenMs?: number;
	fetchImpl?: typeof fetch;
	doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
}

/**
 * Polls the status of `ids` every 3 s (10 s while the tab is hidden) and calls `onUpdate` with
 * each answer. Ids drop out once finished; polling stops when none are left. Network errors and
 * error responses are retried on the slow interval. Returns a function that stops polling early.
 */
export function pollStatus(
	ids: readonly string[],
	onUpdate: (rows: MediaStatusDTO[]) => void,
	opts: PollOptions = {}
): () => void {
	const visibleMs = opts.visibleMs ?? POLL_VISIBLE_MS;
	const hiddenMs = opts.hiddenMs ?? POLL_HIDDEN_MS;
	const doFetch = opts.fetchImpl ?? fetch;
	const doc = opts.doc ?? document;
	const waiting = new Set(ids);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	let inFlight = false;

	const delay = () => (doc.visibilityState === 'hidden' ? hiddenMs : visibleMs);
	const onVisible = () => {
		if (doc.visibilityState === 'visible') schedule(0);
	};
	const stop = () => {
		stopped = true;
		clearTimeout(timer);
		doc.removeEventListener('visibilitychange', onVisible);
	};
	const schedule = (ms: number) => {
		clearTimeout(timer);
		if (stopped) return;
		if (waiting.size === 0) stop();
		else timer = setTimeout(tick, ms);
	};

	async function tick(): Promise<void> {
		if (stopped || inFlight || waiting.size === 0) return;
		inFlight = true;
		let next = delay();
		try {
			const q = encodeURIComponent([...waiting].join(','));
			const res = await doFetch(`/api/status?ids=${q}`, { headers: { accept: 'application/json' } });
			if (!res.ok) throw new Error(`status ${res.status}`);
			const rows = (await res.json()) as MediaStatusDTO[];
			if (stopped) return;
			for (const r of rows) if (isFinished(r.status)) waiting.delete(r.id);
			onUpdate(rows);
		} catch {
			next = hiddenMs;
		} finally {
			inFlight = false;
		}
		schedule(next);
	}

	doc.addEventListener('visibilitychange', onVisible);
	schedule(visibleMs);
	return stop;
}

/** POST /api/retry {id} ("Try again"). Resolves the item's new status, or null if it can't retry. */
export async function retryUpload(id: string, fetchImpl: typeof fetch = fetch): Promise<Status | null> {
	try {
		const res = await fetchImpl('/api/retry', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id })
		});
		if (!res.ok) return null;
		return ((await res.json()) as { status: Status }).status;
	} catch {
		return null;
	}
}
