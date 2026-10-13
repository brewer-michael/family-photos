import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import * as memories from '#lib/server/repo/memories';
import * as ui from '#lib/server/repo/ui';
import { cacheFile } from '#lib/server/paths';
import type { CanonicalExt, Kind } from '#lib/shared/media-types';
import { freshDb } from '../helpers/env';

const DEV_A = 'deviceAAAAAAAAAAAAAAAA';
const DEV_B = 'deviceBBBBBBBBBBBBBBBB';
let seq = 0;

function received(albumId: number, o: { device?: string; name?: string } = {}): string {
	return media.insertReceived({
		uploadToken: `tok${String(++seq).padStart(20, '0')}`,
		albumId,
		sourceName: o.name ?? `IMG_${seq}.HEIC`,
		sourceSize: 100,
		clientMtimeMs: null,
		uploadedByName: 'Aunt Linda',
		uploadedByDevice: o.device ?? DEV_A
	});
}

function ready(
	albumId: number,
	o: { name?: string; kind?: Kind; takenMs?: number; pv?: number; mime?: string; ext?: CanonicalExt } = {}
): string {
	const id = received(albumId, { name: o.name });
	const kind = o.kind ?? 'photo';
	media.markQueued(id, { kind, sourceMime: o.mime ?? 'x/y', sourceSha256: `sha${seq}`, estCostS: null });
	media.claimForProcessing(id);
	media.markReady(id, {
		conversion: 'transcode',
		canonicalExt: o.ext ?? (kind === 'video' ? 'mp4' : 'jpg'),
		canonicalSize: 1234,
		width: 4032,
		height: 3024,
		durationMs: kind === 'video' ? 42_000 : null,
		takenAt: '2024-07-04T11:22:31-07:00',
		takenMs: o.takenMs ?? Date.UTC(2024, 6, 4, 18, 22, 31),
		sourceKept: true,
		pipelineVersion: o.pv
	});
	return id;
}

let albumId: number;
beforeEach(() => {
	freshDb();
	albumId = albums.create({ title: 'Retreat', createdByName: 'Linda', createdByDevice: DEV_A }).id;
});

describe('repo/ui', () => {
	it('parses album ids strictly', () => {
		expect(ui.parseAlbumId('12')).toBe(12);
		for (const bad of ['0', '012', '-1', '1.5', '1e3', 'abc', '', '12345678901']) expect(ui.parseAlbumId(bad), bad).toBeNaN();
	});

	it('tiles and album cards carry versioned thumbnail URLs', () => {
		const id = ready(albumId, { kind: 'video', pv: 3 });
		expect(ui.toTile(media.getById(id)!)).toEqual({
			id,
			kind: 'video',
			thumbUrl: `/media/${id}/thumb?v=3`,
			durationMs: 42_000,
			takenAt: '2024-07-04T11:22:31-07:00',
			takenMs: Date.UTC(2024, 6, 4, 18, 22, 31),
			by: 'Aunt Linda'
		});
		const card = ui.albumCards().find((a) => a.id === albumId)!;
		expect(card).toMatchObject({ title: 'Retreat', photoCount: 0, videoCount: 1, coverUrl: `/media/${id}/thumb?v=3` });
		expect(ui.albumCards().find((a) => a.title === 'Everyday Photos')?.coverUrl).toBeNull();
	});

	it("pending tiles: the device's own unfinished and failed uploads (all devices for the admin), no duplicates", () => {
		const mine = received(albumId, { name: 'beach.MOV' });
		const theirs = received(albumId, { device: DEV_B });
		const failed = received(albumId);
		media.markFailed(failed, 'unsupported', 'svg');
		const live = ready(albumId);
		const dup = received(albumId);
		media.markDuplicate(dup, live, 'x');
		fs.mkdirSync(path.dirname(cacheFile(mine, 'poster')), { recursive: true });
		fs.writeFileSync(cacheFile(mine, 'poster'), 'webp');

		const own = ui.pendingTiles(albumId, DEV_A);
		expect(own.map((p) => p.id).sort()).toEqual([mine, failed].sort());
		// Named without the extension: no "MOV" or "HEIC" on screen.
		expect(own.find((p) => p.id === mine)).toMatchObject({ name: 'beach', status: 'received', posterUrl: `/media/${mine}/poster` });
		expect(own.find((p) => p.id === failed)).toMatchObject({ status: 'failed', errorCode: 'unsupported', posterUrl: null });
		expect(ui.pendingTiles(albumId, null).map((p) => p.id).sort()).toEqual([mine, theirs, failed].sort());
	});

	it('save targets: canonical file URLs, friendly unique names, oldest first', () => {
		const a = ready(albumId, { name: 'IMG_1.HEIC', takenMs: 1000 });
		const b = ready(albumId, { name: 'img_1.jpg', takenMs: 2000 });
		const v = ready(albumId, { name: 'trim.ABC.MOV', kind: 'video', takenMs: 3000 });
		const targets = ui.saveTargets(albumId);
		expect(targets.map((t) => [t.id, t.name, t.type])).toEqual([
			[a, 'IMG_1.jpg', 'image/jpeg'],
			[b, 'img_1 (2).jpg', 'image/jpeg'],
			[v, 'Video_2024-07-04_11-22-31.mp4', 'video/mp4']
		]);
		expect(targets[0]).toMatchObject({
			kind: 'photo',
			url: `/media/${a}/file?v=1`,
			downloadUrl: `/media/${a}/file?v=1&dl=1`,
			size: 1234,
			takenMs: 1000
		});
	});

	it('the viewer shows display.webp for still photos, the file itself for videos and moving pictures', () => {
		const still = ready(albumId, { mime: 'image/heic', pv: 2 });
		expect(ui.viewItem(media.getById(still)!)).toEqual({
			id: still,
			kind: 'photo',
			src: `/media/${still}/display?v=2`,
			placeholderUrl: `/media/${still}/thumb?v=2`,
			width: 4032,
			height: 3024,
			durationMs: null,
			takenAt: '2024-07-04T11:22:31-07:00',
			takenMs: Date.UTC(2024, 6, 4, 18, 22, 31),
			by: 'Aunt Linda'
		});
		const video = ready(albumId, { kind: 'video', mime: 'video/quicktime' });
		expect(ui.viewItem(media.getById(video)!)).toMatchObject({
			kind: 'video',
			src: `/media/${video}/file?v=1`,
			placeholderUrl: `/media/${video}/poster?v=1`,
			durationMs: 42_000
		});
		// display.webp holds only the first frame: GIFs (animated WebPs become GIFs) and APNGs play as the file.
		const src = (o: { mime: string; ext: CanonicalExt }) => ui.viewItem(media.getById(ready(albumId, o))!).src;
		expect(src({ mime: 'image/gif', ext: 'gif' })).toMatch(/\/file\?v=1$/);
		expect(src({ mime: 'image/webp', ext: 'gif' })).toMatch(/\/file\?v=1$/);
		expect(src({ mime: 'image/apng', ext: 'png' })).toMatch(/\/file\?v=1$/);
		expect(src({ mime: 'image/png', ext: 'png' })).toMatch(/\/display\?v=1$/);
		expect(src({ mime: 'image/webp', ext: 'png' })).toMatch(/\/display\?v=1$/);
	});

	it('memories know who may edit and delete them', () => {
		const id = ready(albumId);
		const m = memories.add({ mediaId: id, authorName: 'Jo', authorDevice: DEV_A, body: 'Hello' });
		expect(ui.memoryList(id, { device: DEV_A, isAdmin: false })).toEqual([
			{ id: m.id, authorName: 'Jo', body: 'Hello', createdAt: m.created_at, edited: false, mine: true, canDelete: true }
		]);
		expect(ui.memoryList(id, { device: DEV_B, isAdmin: false })[0]).toMatchObject({ mine: false, canDelete: false });
		expect(ui.memoryList(id, { device: DEV_B, isAdmin: true })[0]).toMatchObject({ mine: false, canDelete: true });
		expect(ui.memoryList(id, { device: null, isAdmin: false })[0]).toMatchObject({ mine: false, canDelete: false });
	});
});
