/** Queries only the admin pages and maintenance need (the core repos cover everything else). */
import { stmt } from '#lib/server/db';
import type { MediaRow } from './media';

/**
 * Items trashed before `cutoff` plus their hidden Live Photo videos (whose rows go with them via
 * ON DELETE CASCADE), so their files can be deleted before the rows.
 *
 * Items that intake or a lane is working on right now ('received', 'processing'; or whose Live
 * Photo video is) are left for a later purge: a lane would otherwise rename its output into
 * library/ after the row is gone, and nothing would ever delete that file. They settle by
 * themselves. Trashed 'queued' rows are never claimed (claimForProcessing skips the trash), so
 * they can go at once.
 */
export function trashedBefore(cutoff: number): MediaRow[] {
	return stmt(
		`WITH gone AS (
			SELECT id FROM media p
			 WHERE p.deleted_at IS NOT NULL AND p.deleted_at < ?
			   AND p.status NOT IN ('received', 'processing')
			   AND NOT EXISTS (SELECT 1 FROM media v WHERE v.live_photo_of = p.id AND v.status IN ('received', 'processing'))
			   -- a hidden Live Photo video in the trash with its photo goes when its photo goes
			   AND NOT EXISTS (SELECT 1 FROM media o WHERE o.id = p.live_photo_of AND o.deleted_at IS NOT NULL)
		)
		SELECT * FROM media WHERE id IN (SELECT id FROM gone) OR live_photo_of IN (SELECT id FROM gone)`
	).all(cutoff) as MediaRow[];
}

/** Deletes media rows (memories and removal requests go with them). Returns how many. */
export function deleteMedia(ids: readonly string[]): number {
	if (ids.length === 0) return 0;
	return stmt('DELETE FROM media WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids)).changes;
}

/** Which of these media ids still have a row. */
export function existingMediaIds(ids: readonly string[]): Set<string> {
	if (ids.length === 0) return new Set();
	const rows = stmt('SELECT id FROM media WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as {
		id: string;
	}[];
	return new Set(rows.map((r) => r.id));
}

export interface AdminAlbumRow {
	id: number;
	title: string;
	when_text: string | null;
	/** Items the family sees. */
	visible: number;
	/** Every item, including unfinished, failed and trashed ones (hidden Live Photo videos aside). */
	total: number;
}

/** Live albums for the admin's album list, A to Z. */
export function listAlbums(): AdminAlbumRow[] {
	return stmt(
		`SELECT a.id, a.title, a.when_text,
			(SELECT COUNT(*) FROM media m WHERE m.album_id = a.id AND m.live_photo_of IS NULL
				AND m.status = 'ready' AND m.deleted_at IS NULL) AS visible,
			(SELECT COUNT(*) FROM media m WHERE m.album_id = a.id AND m.live_photo_of IS NULL) AS total
		 FROM albums a WHERE a.deleted_at IS NULL
		 ORDER BY a.title COLLATE NOCASE, a.id`
	).all() as AdminAlbumRow[];
}

/**
 * Ids to move to empty an album: every item except hidden Live Photo videos whose photo is in the
 * same album (media.move() takes those along).
 */
export function albumItemIds(albumId: number): string[] {
	const rows = stmt(
		`SELECT id FROM media WHERE album_id = ?
		   AND (live_photo_of IS NULL OR live_photo_of NOT IN (SELECT id FROM media WHERE album_id = ?))
		 ORDER BY created_at, id`
	).all(albumId, albumId) as { id: string }[];
	return rows.map((r) => r.id);
}

/** Every row still in an album, Live Photo videos included (0 = the album can go). */
export function countAlbumRows(albumId: number): number {
	return (stmt('SELECT COUNT(*) AS n FROM media WHERE album_id = ?').get(albumId) as { n: number }).n;
}

/** Album titles by id, deleted albums included (labels for failed items and the trash). */
export function albumTitles(): Map<number, string> {
	const rows = stmt('SELECT id, title FROM albums').all() as { id: number; title: string }[];
	return new Map(rows.map((r) => [r.id, r.title]));
}
