import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollStatus, retryUpload, statusLine } from '#lib/client/status';
import type { MediaStatusDTO } from '#lib/shared/media-types';

describe('status copy (never a format name)', () => {
	it('says what is happening in plain words', () => {
		const line = (s: Parameters<typeof statusLine>[0]) => statusLine(s, 'Michael');
		expect(line({ status: 'received', kind: null })).toMatchObject({ text: 'Getting it ready…', tone: 'busy' });
		expect(line({ status: 'queued', kind: 'photo' }).text).toBe('Getting it ready…');
		expect(line({ status: 'queued', kind: 'video', queuePos: 2 }).text).toBe('Waiting its turn (2 ahead)');
		expect(line({ status: 'queued', kind: 'video', queuePos: 0 }).text).toBe('Waiting its turn');
		expect(line({ status: 'processing', kind: 'video', pct: 40 })).toMatchObject({
			text: 'Getting your video ready… 40%',
			detail: "Videos can take a few minutes. You can leave this page — we'll keep going."
		});
		expect(line({ status: 'processing', kind: 'video', pct: 40, etaS: 300 }).detail).toBe(
			"About 5 minutes to go. You can leave this page — we'll keep going."
		);
		expect(line({ status: 'processing', kind: 'photo' }).text).toBe('Getting it ready…');
		expect(line({ status: 'ready', kind: 'photo' })).toMatchObject({ text: '✓ Added', tone: 'ok' });
		expect(line({ status: 'duplicate', kind: 'photo' }).text).toBe('✓ Already in this album');
		expect(line({ status: 'failed', kind: 'photo', errorCode: 'retryable' })).toMatchObject({
			text: "This one didn't work.",
			tone: 'retry'
		});
		expect(line({ status: 'failed', kind: 'video', errorCode: 'unsupported' })).toMatchObject({
			text: "We couldn't add this one. Michael has been told.",
			tone: 'error'
		});
		for (const s of ['received', 'queued', 'processing', 'ready', 'failed', 'duplicate'] as const) {
			const { text, detail } = line({ status: s, kind: 'video', pct: 1, errorCode: 'corrupt' });
			expect(`${text} ${detail ?? ''}`).not.toMatch(/heic|hevc|format|convert/i);
		}
	});
});

describe('pollStatus', () => {
	type Listener = () => void;
	let visibility: 'visible' | 'hidden';
	let listeners: Listener[];
	const doc = {
		get visibilityState() {
			return visibility;
		},
		addEventListener: (_: string, l: Listener) => listeners.push(l),
		removeEventListener: (_: string, l: Listener) => (listeners = listeners.filter((x) => x !== l))
	} as unknown as Document;

	beforeEach(() => {
		vi.useFakeTimers();
		visibility = 'visible';
		listeners = [];
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function fakeFetch(answers: (MediaStatusDTO[] | number)[]) {
		const urls: string[] = [];
		const fn = vi.fn(async (url: string) => {
			urls.push(url);
			const a = answers.shift() ?? [];
			return typeof a === 'number' ? new Response('x', { status: a }) : Response.json(a);
		});
		return { fn: fn as unknown as typeof fetch, urls };
	}

	it('polls every 3 s, drops finished ids and stops when everything is done', async () => {
		const { fn, urls } = fakeFetch([
			[
				{ id: 'A', status: 'processing', pct: 10 },
				{ id: 'B', status: 'ready' }
			],
			[{ id: 'A', status: 'ready' }]
		]);
		const seen: MediaStatusDTO[][] = [];
		pollStatus(['A', 'B'], (rows) => seen.push(rows), { fetchImpl: fn, doc });
		await vi.advanceTimersByTimeAsync(2999);
		expect(urls).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(urls).toEqual(['/api/status?ids=A%2CB']);
		await vi.advanceTimersByTimeAsync(3000);
		expect(urls[1]).toBe('/api/status?ids=A');
		await vi.advanceTimersByTimeAsync(60_000);
		expect(urls).toHaveLength(2);
		expect(seen.map((r) => r.map((x) => `${x.id}:${x.status}`))).toEqual([['A:processing', 'B:ready'], ['A:ready']]);
		expect(listeners).toHaveLength(0); // done: no timers or listeners left
	});

	it('slows to 10 s while hidden or after an error, and catches up when the tab is shown', async () => {
		const { fn, urls } = fakeFetch([500, [{ id: 'A', status: 'queued' }], [{ id: 'A', status: 'queued' }]]);
		const stop = pollStatus(['A'], () => {}, { fetchImpl: fn, doc });
		await vi.advanceTimersByTimeAsync(3000);
		expect(urls).toHaveLength(1); // error → next try in 10 s
		await vi.advanceTimersByTimeAsync(9999);
		expect(urls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(urls).toHaveLength(2);
		visibility = 'hidden';
		await vi.advanceTimersByTimeAsync(3000); // already scheduled while visible
		expect(urls).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(3000);
		expect(urls).toHaveLength(3); // hidden: every 10 s now
		await vi.advanceTimersByTimeAsync(7000);
		expect(urls).toHaveLength(4);
		visibility = 'visible';
		for (const l of listeners) l();
		await vi.advanceTimersByTimeAsync(0);
		expect(urls).toHaveLength(5); // shown again: at once
		stop();
		expect(listeners).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(urls).toHaveLength(5);
	});
});

describe('retryUpload', () => {
	it('POSTs the id and returns the new status, or null', async () => {
		const fn = vi.fn(async (_url: string, init?: RequestInit) => {
			expect(init?.method).toBe('POST');
			expect(JSON.parse(String(init?.body))).toEqual({ id: 'A' });
			return Response.json({ status: 'queued' });
		});
		expect(await retryUpload('A', fn as unknown as typeof fetch)).toBe('queued');
		expect(await retryUpload('A', (async () => new Response('', { status: 409 })) as unknown as typeof fetch)).toBeNull();
		expect(
			await retryUpload('A', (async () => {
				throw new TypeError('offline');
			}) as unknown as typeof fetch)
		).toBeNull();
	});
});
