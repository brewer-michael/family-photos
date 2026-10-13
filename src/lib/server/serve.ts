/**
 * File responses with HTTP caching and byte ranges (docs/media-pipeline.md §7 "Serving").
 *
 * - ETag (strong) + If-None-Match → 304.
 * - One `Range: bytes=…` → 206 with Content-Range; unsatisfiable → 416 `bytes *\/size`;
 *   multiple ranges, other units or malformed values are ignored (200, full body).
 * - If-Range: the range is honoured only when it carries our exact ETag. A date never matches,
 *   because Last-Modified is the photo's taken date, not the file's.
 * - The body streams from one open file handle (stat and read see the same file even if a
 *   reprocess renames a new one into place) and is closed when the client goes away.
 */
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';

export interface ByteRange {
	start: number;
	/** Inclusive. */
	end: number;
}

/**
 * Parses a Range header against a representation of `size` bytes.
 * Returns the range, 'unsatisfiable' (→ 416), or null to ignore the header (→ 200).
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange | 'unsatisfiable' | null {
	if (!header) return null;
	const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
	if (!m) return null; // other units, several ranges, junk
	const [, first, last] = m;
	if (first === '' && last === '') return null;
	if (first === '') {
		// Suffix range: the last N bytes.
		const n = Number(last);
		if (!Number.isSafeInteger(n)) return null;
		if (n === 0 || size === 0) return 'unsatisfiable';
		return { start: Math.max(0, size - n), end: size - 1 };
	}
	const start = Number(first);
	const end = last === '' ? Infinity : Number(last);
	if (!Number.isSafeInteger(start) || (last !== '' && !Number.isSafeInteger(end)) || end < start) return null;
	if (start >= size) return 'unsatisfiable';
	return { start, end: Math.min(end, size - 1) };
}

/** If-None-Match (weak comparison): '*' or any listed tag equal to ours, W/ prefixes ignored. */
export function noneMatch(header: string | null | undefined, etag: string): boolean {
	if (!header) return false;
	const ours = etag.replace(/^W\//, '');
	return header.split(',').some((t) => {
		const tag = t.trim();
		return tag === '*' || tag.replace(/^W\//, '') === ours;
	});
}

/** If-Range: true when the Range header may be used (no If-Range, or our exact strong ETag). */
export function ifRangeAllows(header: string | null | undefined, etag: string): boolean {
	if (!header) return true;
	const tag = header.trim();
	return !tag.startsWith('W/') && tag === etag;
}

export interface ServeFileOptions {
	path: string;
	contentType: string;
	/** Strong ETag including quotes, e.g. "\"01J…-1-file\"". */
	etag: string;
	/** Epoch ms for Last-Modified (the taken date), if any. */
	lastModified?: number | null;
	cacheControl: string;
	/** Full Content-Disposition value, if any. */
	disposition?: string | null;
}

/** null when the file doesn't exist (the caller answers 404). */
export async function serveFile(request: Request, opts: ServeFileOptions): Promise<Response | null> {
	let fh: fs.FileHandle;
	try {
		fh = await fs.open(opts.path, 'r');
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw e;
	}
	let streaming = false;
	try {
		const stat = await fh.stat();
		if (!stat.isFile()) return null;
		const size = stat.size;

		const headers = new Headers({
			etag: opts.etag,
			'cache-control': opts.cacheControl,
			'accept-ranges': 'bytes',
			'x-content-type-options': 'nosniff'
		});
		if (opts.lastModified != null && Number.isFinite(opts.lastModified)) {
			headers.set('last-modified', new Date(opts.lastModified).toUTCString());
		}

		if (noneMatch(request.headers.get('if-none-match'), opts.etag)) {
			return new Response(null, { status: 304, headers });
		}

		headers.set('content-type', opts.contentType);
		if (opts.disposition) headers.set('content-disposition', opts.disposition);

		const rangeHeader = ifRangeAllows(request.headers.get('if-range'), opts.etag)
			? request.headers.get('range')
			: null;
		const range = parseRange(rangeHeader, size);
		if (range === 'unsatisfiable') {
			headers.delete('content-disposition');
			headers.set('content-range', `bytes */${size}`);
			headers.set('content-length', '0');
			return new Response(null, { status: 416, headers });
		}

		const { start, end } = range ?? { start: 0, end: size - 1 };
		const length = size === 0 ? 0 : end - start + 1;
		headers.set('content-length', String(length));
		if (range) headers.set('content-range', `bytes ${start}-${end}/${size}`);
		const status = range ? 206 : 200;

		if (request.method === 'HEAD' || length === 0) return new Response(null, { status, headers });

		const node = fh.createReadStream({ start, end, highWaterMark: 256 * 1024 });
		streaming = true; // the stream owns (and closes) the handle from here on
		const abort = () => node.destroy();
		request.signal.addEventListener('abort', abort, { once: true });
		node.once('close', () => request.signal.removeEventListener('abort', abort));
		return new Response(Readable.toWeb(node) as ReadableStream<Uint8Array>, { status, headers });
	} finally {
		if (!streaming) await fh.close();
	}
}
