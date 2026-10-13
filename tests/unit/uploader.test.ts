/**
 * The Uploader's state (src/lib/client/uploader.svelte.ts) with tus-js-client, fetch, the wake
 * lock, previews and timers stubbed. The unit project has no Svelte plugin, so the module is
 * compiled here (types stripped, then svelte/compiler for the runes) into a temp file whose imports
 * point back at the real allowlist/status modules and at a stand-in for tus-js-client.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { compileModule } from 'svelte/compiler';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UploaderModule from '#lib/client/uploader.svelte';
import type { MediaStatusDTO } from '#lib/shared/media-types';
import { testEnv } from '../helpers/env';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const MB = 1024 * 1024;
const ID = { a: '01J00000000000000000000AAA', b: '01J00000000000000000000BBB', c: '01J00000000000000000000CCC' };

// --- the module under test ----------------------------------------------------------------------

/** Compiles uploader.svelte.ts like vite-plugin-svelte does and imports the result. */
async function compileUploader(): Promise<typeof UploaderModule> {
	const dir = fs.mkdtempSync(path.join(testEnv().root, 'uploader-'));
	const fakeTus = path.join(dir, 'fake-tus.mjs');
	fs.writeFileSync(
		fakeTus,
		`export class Upload {
	constructor(file, options) { this.file = file; this.options = options; this.started = false; globalThis.__fakeTus.created.push(this); }
	findPreviousUploads() { return Promise.resolve(globalThis.__fakeTus.previous); }
	resumeFromPreviousUpload(p) { this.resumedFrom = p; }
	start() { this.started = true; }
	abort() { this.aborted = true; return Promise.resolve(); }
}\n`
	);
	const source = fs.readFileSync(path.join(ROOT, 'src/lib/client/uploader.svelte.ts'), 'utf8');
	const js = ts.transpileModule(source, {
		compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, useDefineForClassFields: true }
	}).outputText;
	let code = compileModule(js, { filename: 'uploader.svelte.js', generate: 'client' }).js.code;
	const swaps: [string, string][] = [
		[`'svelte/internal/client'`, createRequire(import.meta.url).resolve('svelte/internal/client')],
		[`'#lib/media/allowlist'`, path.join(ROOT, 'src/lib/media/allowlist.ts')],
		[`'./status'`, path.join(ROOT, 'src/lib/client/status.ts')],
		[`import('tus-js-client')`, `import(${JSON.stringify(fakeTus)})`]
	];
	for (const [from, to] of swaps) {
		expect(code, `compiled uploader imports ${from}`).toContain(from);
		code = code.replace(from, from.startsWith('import(') ? to : JSON.stringify(to));
	}
	const file = path.join(dir, 'uploader.svelte.js');
	fs.writeFileSync(file, code);
	await import(/* @vite-ignore */ fakeTus);
	return (await import(/* @vite-ignore */ file)) as typeof UploaderModule;
}

let U: typeof UploaderModule;

beforeAll(async () => {
	U = await compileUploader();
	// The first send loads tus-js-client (here the stand-in) through the module runner, which can
	// take a while under load; afterwards it is a resolved promise and settle() is enough.
	const warm = new U.UploadBatch({ albumId: () => 1 });
	warm.add([photo()]);
	await vi.waitFor(() => expect(tus.created).toHaveLength(1));
	warm.destroy();
});

// --- stand-ins ----------------------------------------------------------------------------------

interface FakeUpload {
	file: File;
	options: {
		endpoint: string;
		chunkSize: number;
		retryDelays: number[];
		removeFingerprintOnSuccess: boolean;
		metadata: Record<string, string>;
		onShouldRetry: (e: Error, attempt: number, options: unknown) => boolean;
		onProgress: (sent: number, total: number) => void;
		onSuccess: (p: { lastResponse: { getHeader: (name: string) => string | undefined } }) => void;
		onError: (e: Error) => void;
	};
	started: boolean;
	resumedFrom?: unknown;
	aborted?: boolean;
}

const tus = { created: [] as FakeUpload[], previous: [] as unknown[] };
(globalThis as unknown as { __fakeTus: typeof tus }).__fakeTus = tus;

function succeed(u: FakeUpload, mediaId: string | null): void {
	u.options.onProgress(u.file.size, u.file.size);
	u.options.onSuccess({ lastResponse: { getHeader: (name) => (name === 'X-Media-Id' ? (mediaId ?? undefined) : undefined) } });
}

function httpError(status: number, body = ''): Error {
	return Object.assign(new Error('tus: unexpected response'), { originalResponse: { getStatus: () => status, getBody: () => body } });
}

function fail(u: FakeUpload, status: number, body = ''): void {
	u.options.onError(httpError(status, body));
}

/** A request that never got an answer (tus-js-client's DetailedError without a response). */
const networkError = () => Object.assign(new Error('tus: failed to upload chunk'), { originalRequest: {} });

/** navigator.onLine as the browser reports it (the stand-in navigator is a plain object). */
function setOnline(onLine: boolean): void {
	(navigator as unknown as { onLine: boolean }).onLine = onLine;
}

/** What GET /api/status answers per id (missing ids are left out, as the server does). */
let statusOf: Record<string, MediaStatusDTO> = {};
let statusFails = false;
let retryAnswer: { status: string } | null = { status: 'received' };
const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
	if (url.startsWith('/api/status?ids=')) {
		if (statusFails) return new Response('busy', { status: 503 });
		const ids = decodeURIComponent(url.slice('/api/status?ids='.length)).split(',');
		return Response.json(ids.flatMap((id) => (statusOf[id] ? [statusOf[id]] : [])));
	}
	if (url === '/api/retry' && init?.method === 'POST') {
		return retryAnswer ? Response.json(retryAnswer) : Response.json({ message: 'no' }, { status: 409 });
	}
	return new Response('not found', { status: 404 });
});
const statusCalls = () => fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/status')).map(([url]) => decodeURIComponent(url.split('=')[1]));

interface Sentinel {
	release: () => Promise<void>;
	releases: number;
	addEventListener: ReturnType<typeof vi.fn>;
}
let wakeLockRequests: { resolve: (s: Sentinel) => void }[] = [];

function sentinel(): Sentinel {
	const s: Sentinel = {
		releases: 0,
		// The browser can reject a release; the uploader must not leave that unhandled. (A plain
		// function, not vi.fn: a spy would handle the rejection itself.)
		release: () => {
			s.releases++;
			return Promise.reject(new Error('already released'));
		},
		addEventListener: vi.fn()
	};
	return s;
}

function stubNavigator(userAgent: string): void {
	vi.stubGlobal('navigator', {
		userAgent,
		maxTouchPoints: userAgent === IPHONE ? 5 : 0,
		wakeLock: {
			request: vi.fn(() => new Promise<Sentinel>((resolve) => wakeLockRequests.push({ resolve })))
		}
	});
}

const photo = (name = 'IMG_0001.JPG', size = 1000) => new File([new Uint8Array(size)], name, { type: 'image/jpeg', lastModified: 1_700_000_000_000 });
const video = (name = 'IMG_0002.MOV') => new File([new Uint8Array(1000)], name, { type: 'video/quicktime' });

/** Lets promise chains and the (cached) dynamic import of tus-js-client run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

function newBatch(o: Partial<UploaderModule.UploadBatchOptions> = {}) {
	const ondone = vi.fn();
	const batch = new U.UploadBatch({ albumId: () => 7, ondone, ...o });
	return { batch, ondone };
}

beforeEach(() => {
	tus.created = [];
	tus.previous = [];
	statusOf = {};
	statusFails = false;
	retryAnswer = { status: 'received' };
	wakeLockRequests = [];
	fetchMock.mockClear();
	vi.stubGlobal('fetch', fetchMock);
	stubNavigator(WINDOWS);
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

// --- tests --------------------------------------------------------------------------------------

describe('sending', () => {
	it('sends files as picked with tus, two at a time, in 50 MiB chunks, into the album picked for', async () => {
		let album = 7;
		const { batch } = newBatch({ albumId: () => album });
		batch.add([photo('IMG_0001.JPG'), photo('IMG_0002.HEIC'), video('IMG_0003.MOV')]);
		album = 9; // e.g. the page moved on to another album
		await settle();
		expect(tus.created).toHaveLength(U.PARALLEL_UPLOADS);
		const [first] = tus.created;
		expect(first.options).toMatchObject({
			endpoint: '/api/upload',
			chunkSize: U.CHUNK_SIZE,
			retryDelays: U.RETRY_DELAYS,
			removeFingerprintOnSuccess: true,
			metadata: { filename: 'IMG_0001.JPG', lastModified: '1700000000000', albumId: '7' }
		});
		expect(U.CHUNK_SIZE).toBe(50 * MB);
		expect(first.started).toBe(true);
		expect(batch.items.map((i) => i.stage)).toEqual(['sending', 'sending', 'waiting']);
		// Tiles name files like the album page does, without the extension.
		expect(batch.items.map((i) => i.name)).toEqual(['IMG_0001', 'IMG_0002', 'IMG_0003']);

		succeed(first, ID.a);
		await settle();
		expect(tus.created).toHaveLength(3);
		expect(tus.created[2].options.metadata.albumId).toBe('7');
		expect(batch.items[0]).toMatchObject({ stage: 'sent', mediaId: ID.a, sent: 1000 });
		expect(batch.current).toBe(2);
	});

	it('resumes an interrupted upload of the same file only into the same album', async () => {
		tus.previous = [{ metadata: { albumId: '9' }, uploadUrl: '/api/upload/x' }, { metadata: { albumId: '7' }, uploadUrl: '/api/upload/y' }];
		const { batch } = newBatch();
		batch.add([photo()]);
		await settle();
		expect(tus.created[0].resumedFrom).toBe(tus.previous[1]);
	});

	it('skips what obviously is not a photo or video, and empty files, without sending them', async () => {
		const { batch, ondone } = newBatch();
		batch.add([new File(['%PDF-1.7'], 'Tax return.pdf', { type: 'application/pdf' }), photo('empty.jpg', 0)]);
		await settle();
		expect(batch.items.map((i) => [i.stage, i.problem])).toEqual([
			['skipped', U.NOT_MEDIA_TEXT],
			['skipped', U.NOT_MEDIA_TEXT]
		]);
		expect(tus.created).toHaveLength(0);
		expect(batch.allSettled).toBe(true);
		expect(ondone).not.toHaveBeenCalled();
	});

	it("shows the server's own words for a refused upload and offers to send a failed one again", async () => {
		const { batch } = newBatch();
		batch.add([photo('a.jpg'), photo('b.jpg')]);
		await settle();
		fail(tus.created[0], 413, "There isn't enough room left for this one. Please tell Michael.");
		fail(tus.created[1], 502, '<html>Bad gateway</html>');
		await settle();
		const [a, b] = batch.items;
		expect(a).toMatchObject({ stage: 'error', problem: "There isn't enough room left for this one. Please tell Michael." });
		expect(b).toMatchObject({ stage: 'error', problem: "This one didn't send. Check your connection, then try again." });
		expect(b.canRetry).toBe(true);
		await batch.retry(b);
		await settle();
		expect(tus.created).toHaveLength(3);
		expect(tus.created[2].file).toBe(b.file);
		expect(b).toMatchObject({ stage: 'sending', problem: null });
	});
});

describe('a dropped connection', () => {
	beforeEach(() => {
		vi.stubGlobal('window', new EventTarget());
	});

	it('is retried on RETRY_DELAYS even while the browser says it is offline', async () => {
		const { batch } = newBatch();
		batch.add([photo()]);
		await settle();
		const [u] = tus.created;
		const [item] = batch.items;
		setOnline(false);
		// tus-js-client's default gives up at once while offline; ours keeps to the retry schedule.
		expect(u.options.onShouldRetry(networkError(), 0, u.options)).toBe(true);
		expect(item.offline).toBe(true);
		expect(batch.offline).toBe(true);
		setOnline(true);
		for (const status of [500, 502, 503, 409, 423, 429]) expect(u.options.onShouldRetry(httpError(status), 0, u.options), String(status)).toBe(true);
		for (const status of [400, 401, 403, 404, 410, 413]) expect(u.options.onShouldRetry(httpError(status), 0, u.options), String(status)).toBe(false);
		expect(item.offline).toBe(false);
		// Bytes moving again clear the "Waiting for the internet…" line.
		setOnline(false);
		u.options.onShouldRetry(networkError(), 1, u.options);
		expect(item.offline).toBe(true);
		u.options.onProgress(400, 1000);
		expect(item).toMatchObject({ offline: false, sent: 400, stage: 'sending' });
	});

	it('waits for the internet after the last retry instead of failing, then carries on', async () => {
		tus.previous = [{ metadata: { albumId: '7' }, uploadUrl: '/api/upload/a' }];
		const { batch, ondone } = newBatch();
		batch.add([photo('a.jpg'), photo('b.jpg'), photo('c.jpg')]);
		await settle();
		const [a, b] = batch.items;
		setOnline(false);
		tus.created[0].options.onError(networkError());
		await settle();
		// Still "sending": the screen stays awake, leaving still asks, nothing says Done.
		expect(a).toMatchObject({ stage: 'sending', offline: true, problem: null });
		expect(a.canRetry).toBe(false);
		expect(batch).toMatchObject({ sending: true, offline: true, unsent: 0, allSettled: false });
		// It keeps its sending slot: the third file doesn't start while offline.
		expect(tus.created).toHaveLength(2);
		succeed(tus.created[1], ID.b);
		await settle();
		expect(b.stage).toBe('sent');
		expect(tus.created).toHaveLength(3);
		tus.created[2].options.onError(networkError());
		await settle();
		expect(batch.items[2]).toMatchObject({ stage: 'sending', offline: true });

		setOnline(true);
		window.dispatchEvent(new Event('online'));
		await settle();
		// Both go back in line and resume where they stopped, two at a time.
		expect(tus.created).toHaveLength(5);
		expect(tus.created[3]).toMatchObject({ file: a.file, started: true, resumedFrom: tus.previous[0] });
		expect(tus.created[4].file).toBe(batch.items[2].file);
		expect(batch.items.map((i) => [i.stage, i.offline])).toEqual([
			['sending', false],
			['sent', false],
			['sending', false]
		]);
		succeed(tus.created[3], ID.a);
		succeed(tus.created[4], ID.c);
		statusOf = Object.fromEntries([ID.a, ID.b, ID.c].map((id) => [id, { id, status: 'ready', kind: 'photo' } as MediaStatusDTO]));
		await vi.advanceTimersByTimeAsync(3000);
		await settle();
		expect(batch.allSettled).toBe(true);
		expect(ondone).toHaveBeenCalledExactlyOnceWith({ unsent: 0 });
		// Nothing is left listening.
		window.dispatchEvent(new Event('online'));
		await settle();
		expect(tus.created).toHaveLength(5);
	});

	it('carries on when the page is shown again with the connection back (no online event seen)', async () => {
		const { batch } = newBatch();
		batch.add([photo()]);
		await settle();
		setOnline(false);
		tus.created[0].options.onError(networkError());
		await settle();
		batch.visible();
		await settle();
		expect(tus.created).toHaveLength(1);
		setOnline(true);
		batch.visible();
		await settle();
		expect(tus.created).toHaveLength(2);
		expect(batch.items[0]).toMatchObject({ stage: 'sending', offline: false });
	});

	it('stops waiting when the uploader goes away', async () => {
		const { batch } = newBatch();
		batch.add([photo()]);
		await settle();
		setOnline(false);
		tus.created[0].options.onError(networkError());
		await settle();
		batch.destroy();
		setOnline(true);
		window.dispatchEvent(new Event('online'));
		await settle();
		expect(tus.created).toHaveLength(1);
	});

	it('tells ondone how many did not send, and again once "Try all again" sent them', async () => {
		const { batch, ondone } = newBatch();
		batch.add([photo('a.jpg'), photo('b.jpg'), photo('c.jpg')]);
		await settle();
		succeed(tus.created[0], ID.a);
		await settle();
		fail(tus.created[1], 502);
		await settle();
		fail(tus.created[2], 500);
		statusOf = { [ID.a]: { id: ID.a, status: 'ready', kind: 'photo' } };
		await vi.advanceTimersByTimeAsync(3000);
		await settle();
		expect(batch.unsent).toBe(2);
		expect(ondone).toHaveBeenCalledExactlyOnceWith({ unsent: 2 });

		batch.retryAll();
		await settle();
		expect(batch.unsent).toBe(0);
		expect(tus.created).toHaveLength(5);
		succeed(tus.created[3], ID.b);
		succeed(tus.created[4], ID.c);
		statusOf = Object.fromEntries([ID.a, ID.b, ID.c].map((id) => [id, { id, status: 'ready', kind: 'photo' } as MediaStatusDTO]));
		await vi.advanceTimersByTimeAsync(3000);
		await settle();
		expect(ondone).toHaveBeenCalledTimes(2);
		expect(ondone).toHaveBeenLastCalledWith({ unsent: 0 });
	});
});

describe('following the server', () => {
	it('polls /api/status every 3 s until every item has finished, then calls ondone once and stops', async () => {
		const { batch, ondone } = newBatch();
		batch.add([photo('a.jpg'), video('b.mov')]);
		await settle();
		succeed(tus.created[0], ID.a);
		succeed(tus.created[1], ID.b);
		await settle();
		expect(statusCalls()).toEqual([]);
		statusOf = { [ID.a]: { id: ID.a, status: 'queued', kind: 'photo' }, [ID.b]: { id: ID.b, status: 'processing', kind: 'video', pct: 40 } };
		await vi.advanceTimersByTimeAsync(2999);
		expect(statusCalls()).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(statusCalls()).toEqual([`${ID.a},${ID.b}`]);
		expect(batch.items[1].server).toMatchObject({ status: 'processing', pct: 40 });

		statusOf = { [ID.a]: { id: ID.a, status: 'ready', kind: 'photo' }, [ID.b]: { id: ID.b, status: 'processing', kind: 'video', pct: 80 } };
		await vi.advanceTimersByTimeAsync(3000);
		await settle();
		expect(statusCalls()).toHaveLength(2);
		expect(ondone).not.toHaveBeenCalled();

		statusOf[ID.b] = { id: ID.b, status: 'duplicate', kind: 'video', duplicateOf: ID.c };
		await vi.advanceTimersByTimeAsync(3000);
		await settle();
		expect(statusCalls()).toEqual([`${ID.a},${ID.b}`, `${ID.a},${ID.b}`, ID.b]);
		expect(batch.allSettled).toBe(true);
		expect(ondone).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(statusCalls()).toHaveLength(3);
	});

	it('waits 10 s after a failed status request', async () => {
		const { batch } = newBatch();
		batch.add([photo()]);
		await settle();
		succeed(tus.created[0], ID.a);
		statusFails = true;
		await vi.advanceTimersByTimeAsync(3000);
		await settle();
		expect(statusCalls()).toHaveLength(1);
		statusFails = false;
		statusOf = { [ID.a]: { id: ID.a, status: 'ready', kind: 'photo' } };
		await vi.advanceTimersByTimeAsync(9999);
		expect(statusCalls()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(statusCalls()).toHaveLength(2);
		expect(batch.allSettled).toBe(true);
	});

	it('stops following an item the server no longer reports (removed, or another sign-in)', async () => {
		const { batch, ondone } = newBatch();
		batch.add([photo('a.jpg'), photo('b.jpg')]);
		await settle();
		succeed(tus.created[0], ID.a);
		succeed(tus.created[1], ID.b);
		statusOf = { [ID.a]: { id: ID.a, status: 'ready', kind: 'photo' } };
		await vi.advanceTimersByTimeAsync(3000);
		await settle();
		const [a, b] = batch.items;
		expect(a.settled).toBe(true);
		expect(b).toMatchObject({ gone: true, settled: true, server: null });
		expect(ondone).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(statusCalls()).toHaveLength(1);
	});

	it('"Try again" on a failed item asks POST /api/retry and follows it again', async () => {
		const { batch, ondone } = newBatch();
		batch.add([photo()]);
		await settle();
		succeed(tus.created[0], ID.a);
		statusOf = { [ID.a]: { id: ID.a, status: 'failed', kind: 'photo', errorCode: 'retryable' } };
		await vi.advanceTimersByTimeAsync(3000);
		await settle();
		const [item] = batch.items;
		expect(item.canRetry).toBe(true);
		expect(ondone).toHaveBeenCalledTimes(1);

		statusOf = { [ID.a]: { id: ID.a, status: 'ready', kind: 'photo' } };
		await batch.retry(item);
		const retry = fetchMock.mock.calls.find(([url]) => url === '/api/retry');
		expect(JSON.parse(String(retry?.[1]?.body))).toEqual({ id: ID.a });
		expect(item.server?.status).toBe('received');
		expect(item.settled).toBe(false);
		await vi.advanceTimersByTimeAsync(3000);
		await settle();
		expect(item.server?.status).toBe('ready');
		expect(ondone).toHaveBeenCalledTimes(2);
	});

	it('a failure that is not "retryable" offers no "Try again"', async () => {
		const { batch } = newBatch();
		batch.add([photo()]);
		await settle();
		succeed(tus.created[0], ID.a);
		statusOf = { [ID.a]: { id: ID.a, status: 'failed', kind: 'photo', errorCode: 'unsupported' } };
		await vi.advanceTimersByTimeAsync(3000);
		await settle();
		expect(batch.items[0].canRetry).toBe(false);
		await batch.retry(batch.items[0]);
		expect(fetchMock.mock.calls.some(([url]) => url === '/api/retry')).toBe(false);
	});
});

describe('clearOnDone', () => {
	it('hands the sent files over to the page and keeps only the tiles the page cannot show', async () => {
		const { batch, ondone } = newBatch({ clearOnDone: () => true });
		batch.add([photo('a.jpg'), photo('b.jpg'), new File(['x'], 'notes.txt', { type: 'text/plain' })]);
		await settle();
		succeed(tus.created[0], ID.a);
		fail(tus.created[1], 500);
		await settle();
		succeed(tus.created[0], ID.a);
		statusOf = { [ID.a]: { id: ID.a, status: 'failed', kind: 'photo', errorCode: 'corrupt' } };
		await vi.advanceTimersByTimeAsync(3000);
		await settle();
		expect(ondone).toHaveBeenCalledTimes(1);
		expect(batch.items.map((i) => [i.name, i.stage])).toEqual([
			['b', 'error'],
			['notes', 'skipped']
		]);
		expect(batch.summary).toEqual({ added: 0, already: 0, failed: 1, sent: 0 });
		expect(U.summaryText(batch.summary!)).toBe("1 couldn't be added — see below.");

		// Sending the one that didn't go adds to the same summary.
		await batch.retry(batch.items[0]);
		await settle();
		succeed(tus.created[2], ID.b);
		statusOf = { [ID.b]: { id: ID.b, status: 'ready', kind: 'photo' } };
		await vi.advanceTimersByTimeAsync(3000);
		await settle();
		expect(ondone).toHaveBeenCalledTimes(2);
		expect(batch.items.map((i) => i.name)).toEqual(['notes']);
		expect(U.summaryText(batch.summary!)).toBe("Done! 1 added. 1 couldn't be added — see below.");

		// A new batch starts afresh.
		batch.add([photo('c.jpg')]);
		expect(batch.summary).toBeNull();
		expect(batch.items.map((i) => i.name)).toEqual(['c']);
	});

	it('keeps every tile by default', async () => {
		const { batch, ondone } = newBatch();
		batch.add([photo('a.jpg')]);
		await settle();
		succeed(tus.created[0], ID.a);
		statusOf = { [ID.a]: { id: ID.a, status: 'ready', kind: 'photo' } };
		await vi.advanceTimersByTimeAsync(3000);
		await settle();
		expect(ondone).toHaveBeenCalledTimes(1);
		expect(batch.items).toHaveLength(1);
		expect(batch.summary).toBeNull();
	});

	it('sums up in one line', () => {
		const s = (o: Partial<UploaderModule.DoneSummary>) => U.summaryText({ added: 0, already: 0, failed: 0, sent: 0, ...o });
		expect(s({ added: 3 })).toBe('Done! 3 added.');
		expect(s({ added: 2, already: 1 })).toBe('Done! 2 added · 1 already in this album.');
		expect(s({ failed: 2 })).toBe("2 couldn't be added — see below.");
		expect(s({ added: 1, sent: 1, failed: 1 })).toBe("Done! 1 added · 1 sent. 1 couldn't be added — see below.");
		expect(s({})).toBe('Done!');
	});
});

describe('the phone side', () => {
	it('iOS: says when the picked files are slow to arrive, and gives up after 2 minutes', async () => {
		const { batch } = newBatch();
		batch.picking();
		batch.focused(true);
		await vi.advanceTimersByTimeAsync(599);
		expect(batch.gap).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(batch.gap).toBe(true);
		batch.add([photo()]);
		expect(batch.gap).toBe(false);

		batch.picking();
		batch.focused(true);
		await vi.advanceTimersByTimeAsync(600);
		expect(batch.gap).toBe(true);
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(batch.gap).toBe(false);

		// Elsewhere, or when the picker was cancelled, nothing is said.
		batch.picking();
		batch.focused(false);
		await vi.advanceTimersByTimeAsync(5000);
		expect(batch.gap).toBe(false);
		batch.picking();
		batch.pickerClosed();
		batch.focused(true);
		await vi.advanceTimersByTimeAsync(5000);
		expect(batch.gap).toBe(false);
	});

	it('makes previews one at a time and only of small photos on iOS; four at once, 30 per batch elsewhere', async () => {
		const pending: (() => void)[] = [];
		vi.stubGlobal('HTMLImageElement', class {}); // no DOM here: the canvas step fails and the tile keeps its icon
		vi.stubGlobal(
			'createImageBitmap',
			vi.fn(() => new Promise((resolve) => pending.push(() => resolve({ width: 4000, height: 3000, close() {} }))))
		);
		const drain = async (): Promise<number> => {
			let most = 0;
			while (pending.length > 0) {
				most = Math.max(most, pending.length);
				pending.splice(0).forEach((go) => go());
				await settle();
			}
			return most;
		};

		stubNavigator(IPHONE);
		newBatch().batch.add([photo('a.jpg'), photo('big.jpg', 9 * MB), video(), photo('b.jpg'), photo('c.jpg')]);
		expect(await drain()).toBe(1);
		expect(createImageBitmap).toHaveBeenCalledTimes(3);

		vi.mocked(createImageBitmap).mockClear();
		stubNavigator(WINDOWS);
		newBatch().batch.add([photo('big.jpg', 14 * MB), ...Array.from({ length: 35 }, (_, i) => photo(`p${i}.jpg`))]);
		expect(await drain()).toBe(4);
		expect(createImageBitmap).toHaveBeenCalledTimes(30);
	});

	it('holds one screen wake lock while sending, even when asked twice at once, and lets it go when done', async () => {
		const { batch } = newBatch();
		batch.add([photo('a.jpg'), photo('b.jpg'), photo('c.jpg')]);
		batch.visible(); // the page became visible while the first request is still on its way
		await settle();
		expect(navigator.wakeLock.request).toHaveBeenCalledTimes(1);
		const lock = sentinel();
		wakeLockRequests[0].resolve(lock);
		await settle();
		succeed(tus.created[0], ID.a); // the pump runs again: the lock is already held
		await settle();
		expect(navigator.wakeLock.request).toHaveBeenCalledTimes(1);
		succeed(tus.created[1], ID.b);
		succeed(tus.created[2], ID.c);
		await settle();
		expect(lock.releases).toBe(1);
	});

	it('lets go of a wake lock that arrives after sending finished', async () => {
		const { batch } = newBatch();
		batch.add([photo()]);
		await settle();
		succeed(tus.created[0], ID.a);
		const late = sentinel();
		wakeLockRequests[0].resolve(late);
		await settle();
		expect(late.releases).toBe(1);
		expect(late.addEventListener).not.toHaveBeenCalled();
		expect(batch.sending).toBe(false);
	});
});
