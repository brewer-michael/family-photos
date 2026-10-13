import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import * as memories from '#lib/server/repo/memories';
import { libraryPath } from '#lib/server/paths';
import { buildMemoriesText, planAlbumZip, streamZip, zipEntryDate, zipFileName, MEMORIES_FILE } from '#lib/server/zip';
import type { Kind } from '#lib/shared/media-types';
import { freshDb, testEnv } from '../helpers/env';

const DEVICE = 'deviceAAAAAAAAAAAAAAAA';
let seq = 0;

/** A ready item with a canonical file of `bytes` in library/. */
function readyItem(
	albumId: number,
	o: { name: string; kind?: Kind; takenAt: string; takenMs: number; contentId?: string; durationMs?: number; bytes?: Buffer }
): string {
	const kind = o.kind ?? 'photo';
	const id = media.insertReceived({
		uploadToken: `tok${String(++seq).padStart(20, '0')}`,
		albumId,
		sourceName: o.name,
		sourceSize: 10,
		clientMtimeMs: null,
		uploadedByName: 'Aunt Linda',
		uploadedByDevice: DEVICE
	});
	media.markQueued(id, { kind, sourceMime: 'x/y', sourceExt: 'bin', sourceSha256: `sha${seq}`, estCostS: null });
	media.claimForProcessing(id);
	const ext = kind === 'video' ? 'mp4' : 'jpg';
	const bytes = o.bytes ?? Buffer.from(`${o.name}-${seq}`);
	fs.mkdirSync(path.dirname(libraryPath(id, ext)), { recursive: true });
	fs.writeFileSync(libraryPath(id, ext), bytes);
	media.markReady(id, {
		conversion: 'transcode',
		canonicalExt: ext,
		canonicalSize: bytes.length,
		width: 10,
		height: 10,
		durationMs: o.durationMs ?? null,
		takenAt: o.takenAt,
		takenMs: o.takenMs,
		contentId: o.contentId ?? null,
		sourceKept: true
	});
	return id;
}

async function writeZip(albumId: number): Promise<string> {
	const album = albums.get(albumId)!;
	const out = path.join(testEnv().root, `album-${albumId}-${++seq}.zip`);
	const plan = await planAlbumZip(album);
	await pipeline(Readable.fromWeb(streamZip(plan, new AbortController().signal) as never), fs.createWriteStream(out));
	return out;
}

let albumId: number;
beforeEach(() => {
	freshDb();
	albumId = albums.create({ title: 'Retreat 2023', whenText: 'Summer 2023', createdByName: 'Linda', createdByDevice: DEVICE }).id;
});

describe('album ZIP', () => {
	it('holds canonical files with friendly unique names, oldest first, plus memories.txt', async () => {
		const a = readyItem(albumId, { name: 'IMG_0001.HEIC', takenAt: '2023-07-01T10:00:00-07:00', takenMs: Date.UTC(2023, 6, 1, 17) });
		readyItem(albumId, { name: 'img_0001.jpg', takenAt: '2023-07-02T10:00:00-07:00', takenMs: Date.UTC(2023, 6, 2, 17) });
		readyItem(albumId, { name: 'trim.ABC.MOV', kind: 'video', durationMs: 20_000, takenAt: '2023-07-03T09:08:07', takenMs: Date.UTC(2023, 6, 3, 9, 8, 7) });
		// A Live Photo: the photo is in the ZIP, its ≤4.5 s video is hidden and left out.
		readyItem(albumId, { name: 'IMG_0002.HEIC', takenAt: '2023-07-04T12:00:00-07:00', takenMs: Date.UTC(2023, 6, 4, 19), contentId: 'CID-1' });
		const live = readyItem(albumId, { name: 'IMG_0002.MOV', kind: 'video', durationMs: 3000, takenAt: '2023-07-04T12:00:00-07:00', takenMs: Date.UTC(2023, 6, 4, 19), contentId: 'CID-1' });
		expect(media.getById(live)!.live_photo_of).not.toBeNull();
		// Trashed and other albums' items are left out too.
		media.softDelete(readyItem(albumId, { name: 'gone.jpg', takenAt: '2023-07-05T00:00:00', takenMs: Date.UTC(2023, 6, 5) }), 'test');
		readyItem(albums.create({ title: 'Other', createdByName: null, createdByDevice: null }).id, { name: 'other.jpg', takenAt: '2023-01-01T00:00:00', takenMs: 0 });
		memories.add({ mediaId: a, authorName: 'Grandma Jo', authorDevice: DEVICE, body: 'What a day!\nSo sunny.' });

		const zip = await writeZip(albumId);
		const listing = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
		expect(listing).toEqual(['IMG_0001.jpg', 'img_0001 (2).jpg', 'Video_2023-07-03_09-08-07.mp4', 'IMG_0002.jpg', MEMORIES_FILE]);
		expect(listing.join(' ')).not.toMatch(/heic|mov|gone|other/i);

		// Entries are stored (no compression) and dated to the taken wall time.
		const verbose = execFileSync('zipinfo', ['-l', zip, 'IMG_0001.jpg'], { encoding: 'utf8' });
		expect(verbose).toMatch(/stor/);
		expect(verbose).toMatch(/23-Jul-01 10:00/);
		expect(execFileSync('unzip', ['-p', zip, 'IMG_0001.jpg']).toString()).toMatch(/^IMG_0001\.HEIC-/);

		const text = execFileSync('unzip', ['-p', zip, MEMORIES_FILE], { encoding: 'utf8' });
		expect(text.startsWith('﻿Retreat 2023\r\nSummer 2023\r\n')).toBe(true);
		expect(text).toContain('IMG_0001.jpg (taken 2023-07-01)');
		expect(text).toContain('Grandma Jo wrote on');
		expect(text).toContain('    What a day!\r\n    So sunny.\r\n');
	});

	it('skips items whose file is missing and still writes memories.txt', async () => {
		const id = readyItem(albumId, { name: 'IMG_9.jpg', takenAt: '2023-07-01T10:00:00', takenMs: 1 });
		fs.rmSync(libraryPath(id, 'jpg'));
		const zip = await writeZip(albumId);
		expect(execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim()).toBe(MEMORIES_FILE);
		expect(execFileSync('unzip', ['-p', zip, MEMORIES_FILE], { encoding: 'utf8' })).toContain('No memories have been written');
	});

	describe('when the download stops half-way', () => {
		/** Open descriptors of this process that point at `file` (Linux). */
		const fdsOn = (file: string) =>
			fs.readdirSync('/proc/self/fd').filter((fd) => {
				try {
					return fs.readlinkSync(`/proc/self/fd/${fd}`) === file;
				} catch {
					return false; // closed while listing
				}
			}).length;

		async function waitForNoFds(file: string): Promise<number> {
			for (let i = 0; i < 100 && fdsOn(file) > 0; i++) await new Promise((r) => setTimeout(r, 20));
			return fdsOn(file);
		}

		/** Starts a ZIP of one 32 MB file, reads ~4 MB of it and returns the reader. */
		async function startBigZip(signal: AbortSignal) {
			const id = readyItem(albumId, { name: 'big.mp4', kind: 'video', takenAt: '2023-07-01T10:00:00', takenMs: 1, bytes: Buffer.alloc(32 * 1024 * 1024, 1) });
			const file = libraryPath(id, 'mp4');
			const reader = streamZip(await planAlbumZip(albums.get(albumId)!), signal).getReader();
			for (let read = 0; read < 4 * 1024 * 1024; ) read += (await reader.read()).value?.length ?? 0;
			expect(fdsOn(file)).toBe(1);
			return { reader, file };
		}

		it.runIf(process.platform === 'linux')('closes the file when the client goes away', async () => {
			const ac = new AbortController();
			const { reader, file } = await startBigZip(ac.signal);
			ac.abort();
			const end = await (async () => {
				for (let i = 0; i < 10_000; i++) if ((await reader.read()).done) return 'ended';
				return 'still running';
			})().catch(() => 'errored');
			expect(end).toMatch(/ended|errored/);
			expect(await waitForNoFds(file)).toBe(0);
		});

		it.runIf(process.platform === 'linux')('closes the file when the stream is cancelled', async () => {
			const { reader, file } = await startBigZip(new AbortController().signal);
			await reader.cancel();
			expect(await waitForNoFds(file)).toBe(0);
		});

		it.runIf(process.platform === 'linux')('opens one file at a time', async () => {
			const files = Array.from({ length: 5 }, (_, i) =>
				libraryPath(readyItem(albumId, { name: `f${i}.jpg`, takenAt: '2023-07-01T10:00:00', takenMs: i, bytes: Buffer.alloc(4 * 1024 * 1024, i) }), 'jpg')
			);
			const reader = streamZip(await planAlbumZip(albums.get(albumId)!), new AbortController().signal).getReader();
			let most = 0;
			for (;;) {
				const { done } = await reader.read();
				if (done) break;
				most = Math.max(most, files.reduce((n, f) => n + fdsOn(f), 0));
			}
			expect(most).toBe(1);
		});

		it('fails the download (instead of hanging) when a file disappears', async () => {
			const id = readyItem(albumId, { name: 'gone.jpg', takenAt: '2023-07-01T10:00:00', takenMs: 1 });
			const plan = await planAlbumZip(albums.get(albumId)!);
			fs.rmSync(libraryPath(id, 'jpg'));
			const reader = streamZip(plan, new AbortController().signal).getReader();
			await expect((async () => {
				while (!(await reader.read()).done);
			})()).rejects.toThrow(/ENOENT/);
		});
	});
});

describe('zip helpers', () => {
	it('dates entries by the wall time where the photo was taken', () => {
		expect(zipEntryDate({ taken_at: '2024-07-04T11:22:31-07:00', taken_ms: 0, created_at: 0 }).toISOString()).toBe(
			'2024-07-04T11:22:31.000Z'
		);
		const d = new Date(Date.UTC(2024, 0, 2, 3, 4, 5));
		expect(zipEntryDate({ taken_at: null, taken_ms: d.getTime(), created_at: 0 }).getUTCHours()).toBe(d.getHours());
	});

	it('names the ZIP after the album', () => {
		expect(zipFileName({ title: 'Retreat 2023' })).toBe('Retreat 2023.zip');
		expect(zipFileName({ title: 'Mum/Dad: 40 years?' })).toBe('Mum_Dad_ 40 years_.zip');
		expect(zipFileName({ title: '...' })).toBe('Photos.zip');
	});

	it('memories.txt lists only memories of files in the ZIP', () => {
		const text = buildMemoriesText(
			{ title: 'T', when_text: null, description: 'About' },
			[
				{ id: 1, media_id: 'A', author_name: 'Jo', author_device: 'd', body: 'Hi', created_at: 0, updated_at: 0, source_name: 'a', taken_at: null, taken_ms: 0 },
				{ id: 2, media_id: 'B', author_name: 'Bo', author_device: 'd', body: 'Gone', created_at: 0, updated_at: 0, source_name: 'b', taken_at: null, taken_ms: 0 }
			],
			[{ id: 'A', name: 'a.jpg', date: new Date(Date.UTC(2020, 0, 1)) }]
		);
		expect(text).toContain('T\r\n\r\nAbout\r\n');
		expect(text).toContain('a.jpg (taken 2020-01-01)');
		expect(text).not.toContain('Gone');
	});
});
