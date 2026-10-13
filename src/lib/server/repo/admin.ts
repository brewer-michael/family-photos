/** Queries only the admin pages and maintenance need (the core repos cover everything else). */
import { stmt, tx } from '#lib/server/db';
import type { MediaRow } from './media';

/**
 * Items trashed before `cutoff` plus their hidden Live Photo videos (whose rows go with them via
 * ON DELETE CASCADE), so their files can be deleted before the rows.
 *
 * Items that intake or a lane is working on right now ('received', 'processing', or a redo a lane
 * is running; or whose Live Photo video is) are left for a later purge: a lane would otherwise
 * rename its output into library/ after the row is gone, and nothing would ever delete that file.
 * They settle by themselves. Trashed 'queued' rows are never claimed (claimForProcessing skips the
 * trash, and trashing drops a waiting redo), so they can go at once.
 */
export function trashedBefore(cutoff: number): MediaRow[] {
	return stmt(
		`WITH gone AS (
			SELECT id FROM media p
			 WHERE p.deleted_at IS NOT NULL AND p.deleted_at < ?
			   AND p.status NOT IN ('received', 'processing') AND p.redo_state IS NOT 'running'
			   AND NOT EXISTS (SELECT 1 FROM media v WHERE v.live_photo_of = p.id
			                    AND (v.status IN ('received', 'processing') OR v.redo_state = 'running'))
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

// ---------------------------------------------------------------------------
// Files of deleted items (file_deletions, 003): rows go first, files after
// ---------------------------------------------------------------------------

/** What it takes to find every file of a deleted item (#lib/server/admin deleteItemFiles). */
export type ItemFiles = Pick<MediaRow, 'id' | 'canonical_ext' | 'source_ext' | 'upload_token'>;

export interface FileDeletionRow {
	media_id: string;
	canonical_ext: MediaRow['canonical_ext'];
	source_ext: MediaRow['source_ext'];
	upload_token: MediaRow['upload_token'];
	queued_at: number;
	last_error: string | null;
}

/** Records the files of items whose rows are being deleted, for deleteQueuedFiles(). */
export function queueFileDeletions(rows: readonly ItemFiles[], now: number = Date.now()): void {
	const ins = stmt(
		`INSERT INTO file_deletions(media_id, canonical_ext, source_ext, upload_token, queued_at)
		 VALUES (?, ?, ?, ?, ?) ON CONFLICT(media_id) DO NOTHING`
	);
	for (const r of rows) ins.run(r.id, r.canonical_ext, r.source_ext, r.upload_token, now);
}

/**
 * Deletes media rows and records their files in the same transaction, so the files can go after
 * the rows: whatever happens to the files, nothing is left in the trash without them. Returns how
 * many rows.
 */
export function deleteMediaQueueingFiles(rows: readonly ItemFiles[], now: number = Date.now()): number {
	if (rows.length === 0) return 0;
	return tx(() => {
		queueFileDeletions(rows, now);
		return deleteMedia(rows.map((r) => r.id));
	});
}

/** Files still to delete, oldest first. */
export function queuedFileDeletions(): FileDeletionRow[] {
	return stmt('SELECT * FROM file_deletions ORDER BY queued_at, media_id').all() as FileDeletionRow[];
}

/** Every file of this item is gone. */
export function fileDeletionDone(mediaId: string): void {
	stmt('DELETE FROM file_deletions WHERE media_id = ?').run(mediaId);
}

/** Deleting this item's files failed (kept for the next run). */
export function fileDeletionFailed(mediaId: string, error: string): void {
	stmt('UPDATE file_deletions SET last_error = ? WHERE media_id = ?').run(error.slice(0, 2000), mediaId);
}

/** For the admin page: deleted items whose files are still there because deleting them failed. */
export function fileDeletionProblems(): { count: number; lastError: string | null } {
	const r = stmt(
		`SELECT COUNT(*) AS count,
			(SELECT last_error FROM file_deletions WHERE last_error IS NOT NULL ORDER BY queued_at DESC LIMIT 1) AS lastError
		 FROM file_deletions WHERE last_error IS NOT NULL`
	).get() as { count: number; lastError: string | null };
	return r;
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

/** Live albums' ids and titles, A to Z (pickers and QR cards: no counts needed). */
export function listAlbumTitles(): Pick<AdminAlbumRow, 'id' | 'title' | 'when_text'>[] {
	return stmt(
		`SELECT id, title, when_text FROM albums WHERE deleted_at IS NULL ORDER BY title COLLATE NOCASE, id`
	).all() as Pick<AdminAlbumRow, 'id' | 'title' | 'when_text'>[];
}

/**
 * The archived originals "Delete all archived originals" would delete now, counted in SQL: kept,
 * and their item ready and not being redone (the same test as media.originalDeletable()).
 */
export function deletableOriginals(): { count: number; bytes: number } {
	return stmt(
		`SELECT COUNT(*) AS count, COALESCE(SUM(source_size), 0) AS bytes FROM media
		 WHERE source_kept = 1 AND status = 'ready' AND redo_state IS NULL`
	).get() as { count: number; bytes: number };
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
