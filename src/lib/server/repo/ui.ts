/**
 * Read models for the family pages: rows from the core repos turned into the plain DTOs of
 * #lib/client/dto (media URLs carry ?v=<pipeline_version> to bust the immutable cache).
 */
import fs from 'node:fs';
import { stmt } from '#lib/server/db';
import { cacheFile } from '#lib/server/paths';
import { createNameAllocator, downloadName } from '#lib/server/filenames';
import * as albums from './albums';
import * as media from './media';
import * as memories from './memories';
import { CANONICAL_MIME } from '#lib/shared/media-types';
import {
	mediaUrl,
	type AlbumCardDTO,
	type MemoryDTO,
	type PendingDTO,
	type SaveTargetDTO,
	type TileDTO
} from '#lib/client/dto';

/** Tiles per album page (first load and each "Show more"). */
export const ALBUM_PAGE_SIZE = 60;

/** Route param → album id (NaN for anything but a plain positive number, which no album has). */
export function parseAlbumId(param: string): number {
	return /^[1-9]\d{0,9}$/.test(param) ? Number(param) : NaN;
}

/** pipeline_version per media id (for cover thumbnails, which album summaries don't carry). */
export function pipelineVersions(ids: readonly string[]): Map<string, number> {
	const out = new Map<string, number>();
	if (ids.length === 0) return out;
	const rows = stmt(
		'SELECT id, pipeline_version FROM media WHERE id IN (SELECT value FROM json_each(?))'
	).all(JSON.stringify(ids)) as { id: string; pipeline_version: number }[];
	for (const r of rows) out.set(r.id, r.pipeline_version);
	return out;
}

export function toTile(row: media.MediaRow): TileDTO {
	return {
		id: row.id,
		kind: row.kind ?? 'photo',
		thumbUrl: mediaUrl(row.id, 'thumb', { v: row.pipeline_version }),
		durationMs: row.kind === 'video' ? row.duration_ms : null,
		takenAt: row.taken_at,
		takenMs: row.taken_ms,
		by: row.uploaded_by_name
	};
}

/** Album cards for the home page and /add, most recently updated first. */
export function albumCards(): AlbumCardDTO[] {
	const list = albums.list();
	const versions = pipelineVersions(list.flatMap((a) => (a.cover_id ? [a.cover_id] : [])));
	return list.map((a) => ({
		id: a.id,
		title: a.title,
		whenText: a.when_text,
		photoCount: a.photo_count,
		videoCount: a.video_count,
		coverUrl: a.cover_id ? mediaUrl(a.cover_id, 'thumb', { v: versions.get(a.cover_id) }) : null
	}));
}

/**
 * Unfinished uploads to show as tiles: this device's (or every device's, for the admin) items in
 * the album that are still on their way, or failed. Duplicates are left out (nothing to do).
 */
export function pendingTiles(albumId: number, device: string | null): PendingDTO[] {
	return media
		.listPending({ albumId, device })
		.filter((r) => r.status !== 'duplicate')
		.map((r) => ({
			id: r.id,
			kind: r.kind,
			status: r.status,
			errorCode: r.error_code,
			name: r.source_name,
			posterUrl: fs.existsSync(cacheFile(r.id, 'poster')) ? mediaUrl(r.id, 'poster') : null
		}));
}

export function saveTarget(row: media.MediaRow, name: string = downloadName(row)): SaveTargetDTO {
	const ext = row.canonical_ext ?? 'jpg';
	return {
		id: row.id,
		kind: row.kind ?? 'photo',
		url: mediaUrl(row.id, 'file', { v: row.pipeline_version }),
		downloadUrl: mediaUrl(row.id, 'file', { v: row.pipeline_version, download: true }),
		name,
		type: CANONICAL_MIME[ext],
		size: row.canonical_size,
		takenMs: row.taken_ms
	};
}

/** Every visible item of an album, oldest first, with unique names ("Save all" on phones). */
export function saveTargets(albumId: number): SaveTargetDTO[] {
	const take = createNameAllocator();
	return media.listAllVisibleInAlbum(albumId).map((r) => saveTarget(r, take(downloadName(r))));
}

/** An item's memories as seen by this viewer. */
export function memoryList(mediaId: string, who: { device: string | null; isAdmin: boolean }): MemoryDTO[] {
	return memories.list(mediaId).map((m) => {
		const mine = memories.canEdit(m, { device: who.device });
		return {
			id: m.id,
			authorName: m.author_name,
			body: m.body,
			createdAt: m.created_at,
			edited: m.updated_at > m.created_at,
			mine,
			canDelete: mine || who.isAdmin
		};
	});
}
