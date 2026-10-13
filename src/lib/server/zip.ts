/**
 * Album ZIP for computers (docs/PLAN.md "Downloads", docs/media-pipeline.md §7):
 * canonical files only (never originals, derivatives or hidden Live Photo videos), oldest first,
 * friendly unique names, entries dated to when each photo was taken, plus memories.txt.
 * STORE (photos and videos don't compress), ZIP64 once it grows past 4 GiB, streamed.
 */
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { ZipArchive } from 'archiver';
import * as media from '#lib/server/repo/media';
import * as memories from '#lib/server/repo/memories';
import type { AlbumRow } from '#lib/server/repo/albums';
import { libraryPath } from '#lib/server/paths';
import { cleanStem, createNameAllocator, downloadName } from '#lib/server/filenames';

export const MEMORIES_FILE = 'memories.txt';

export interface ZipEntry {
	id: string;
	name: string;
	path: string;
	date: Date;
	stats: Stats;
}

export interface ZipPlan {
	entries: ZipEntry[];
	memoriesText: string;
}

/** Epoch ms → a Date whose UTC fields are the server's local wall time. */
function localWallTime(ms: number): Date {
	const d = new Date(ms);
	return new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
}

/**
 * The entry date: the wall-clock time the photo was taken, written as-is (ZIP times have no time
 * zone, so a photo taken at 11:22 in California shows 11:22 everywhere). Falls back to taken_ms,
 * then the upload time, in the server's time zone.
 */
export function zipEntryDate(item: Pick<media.MediaRow, 'taken_at' | 'taken_ms' | 'created_at'>): Date {
	const m = item.taken_at && /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(item.taken_at);
	if (m) {
		const [, y, mo, d, h, mi, s] = m;
		return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0));
	}
	return localWallTime(item.taken_ms ?? item.created_at);
}

/** "Retreat 2023.zip" (safe on every OS; "Photos.zip" if the title has nothing usable). */
export function zipFileName(album: Pick<AlbumRow, 'title'>): string {
	return `${cleanStem(album.title) || 'Photos'}.zip`;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * memories.txt: the album's title, when and description, then every memory under the file it
 * belongs to. CRLF + BOM so Windows Notepad shows accents and line breaks properly.
 */
export function buildMemoriesText(
	album: Pick<AlbumRow, 'title' | 'when_text' | 'description'>,
	rows: readonly memories.AlbumMemoryRow[],
	entries: readonly Pick<ZipEntry, 'id' | 'name' | 'date'>[]
): string {
	const byId = new Map(entries.map((e) => [e.id, e]));
	const lines: string[] = [album.title];
	if (album.when_text) lines.push(album.when_text);
	if (album.description) lines.push('', album.description);
	lines.push('');
	const shown = rows.filter((r) => byId.has(r.media_id));
	if (shown.length === 0) lines.push('No memories have been written for these photos yet.');
	let current: string | null = null;
	for (const r of shown) {
		if (r.media_id !== current) {
			current = r.media_id;
			const e = byId.get(r.media_id)!;
			lines.push('', `${e.name} (taken ${ymd(e.date)})`);
		}
		lines.push(`  ${r.author_name} wrote on ${ymd(localWallTime(r.created_at))}:`);
		for (const l of r.body.split('\n')) lines.push(`    ${l}`);
	}
	return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Everything that goes into an album's ZIP. Items whose file is missing on disk are left out. */
export async function planAlbumZip(album: AlbumRow): Promise<ZipPlan> {
	const take = createNameAllocator([MEMORIES_FILE]);
	const entries: ZipEntry[] = [];
	for (const row of media.listAllVisibleInAlbum(album.id)) {
		if (!row.canonical_ext) continue;
		const path = libraryPath(row.id, row.canonical_ext);
		const stats = await fs.stat(path).catch(() => null);
		if (!stats?.isFile()) continue;
		entries.push({ id: row.id, name: take(downloadName(row)), path, date: zipEntryDate(row), stats });
	}
	return { entries, memoriesText: buildMemoriesText(album, memories.listForAlbum(album.id), entries) };
}

/** Streams the ZIP. Aborting `signal` (the client went away) stops reading files at once. */
export function streamZip(plan: ZipPlan, signal: AbortSignal): ReadableStream<Uint8Array> {
	const archive = new ZipArchive({ store: true });
	const out = new PassThrough({ highWaterMark: 1024 * 1024 });
	let finished = false;
	const stop = () => {
		if (finished) return;
		finished = true;
		archive.abort();
		out.destroy();
	};
	signal.addEventListener('abort', stop, { once: true });
	archive.once('end', () => {
		finished = true;
	});
	out.once('close', () => {
		signal.removeEventListener('abort', stop);
		stop(); // the web stream was cancelled before the archive ended
	});
	archive.on('warning', (e) => console.warn('[zip]', e.message));
	archive.on('error', (e) => {
		console.error('[zip]', e);
		out.destroy(e);
	});
	archive.pipe(out);
	for (const e of plan.entries) archive.file(e.path, { name: e.name, date: e.date, stats: e.stats });
	archive.append(plan.memoriesText, { name: MEMORIES_FILE, date: localWallTime(Date.now()) });
	archive.finalize().catch(() => {
		// reported through the 'error' handler above
	});
	return Readable.toWeb(out) as ReadableStream<Uint8Array>;
}
