/** Memories (journal entries) on a media item. Authors (by device) edit/delete their own; admin can delete any. */
import { stmt } from '#lib/server/db';
import { ValidationError } from '#lib/shared/errors';

export interface MemoryRow {
	id: number;
	media_id: string;
	author_name: string;
	author_device: string;
	body: string;
	created_at: number;
	updated_at: number;
}

export const MEMORY_MAX_CHARS = 5000;

/** Trims, normalises newlines, strips control chars; throws ValidationError if empty or > 5000 chars. */
export function cleanBody(body: string): string {
	const t = String(body ?? '')
		.normalize('NFC')
		.replace(/\r\n?/g, '\n')
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
		.trim();
	if (t.length === 0) throw new ValidationError('Please write something first.', 'body');
	if (t.length > MEMORY_MAX_CHARS) {
		throw new ValidationError(`That's a bit long — please keep it under ${MEMORY_MAX_CHARS} characters.`, 'body');
	}
	return t;
}

/** Memories for an item, oldest first. */
export function list(mediaId: string): MemoryRow[] {
	return stmt('SELECT * FROM memories WHERE media_id = ? ORDER BY created_at ASC, id ASC').all(mediaId) as MemoryRow[];
}

export function get(id: number): MemoryRow | undefined {
	return stmt('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
}

export function add(input: { mediaId: string; authorName: string; authorDevice: string; body: string }): MemoryRow {
	const now = Date.now();
	const r = stmt(
		`INSERT INTO memories(media_id, author_name, author_device, body, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(input.mediaId, input.authorName, input.authorDevice, cleanBody(input.body), now, now);
	return get(Number(r.lastInsertRowid))!;
}

/** Edits the body only if `device` wrote it. Returns the updated row, or null if not allowed / not found. */
export function update(id: number, body: string, who: { device: string | null }): MemoryRow | null {
	const clean = cleanBody(body);
	if (!who.device) return null;
	const r = stmt('UPDATE memories SET body = ?, updated_at = ? WHERE id = ? AND author_device = ?').run(
		clean,
		Date.now(),
		id,
		who.device
	);
	return r.changes > 0 ? (get(id) ?? null) : null;
}

/** Deletes if `device` wrote it or the caller is admin. Returns true if deleted. */
export function remove(id: number, who: { device: string | null; isAdmin: boolean }): boolean {
	if (who.isAdmin) return stmt('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
	if (!who.device) return false;
	return stmt('DELETE FROM memories WHERE id = ? AND author_device = ?').run(id, who.device).changes > 0;
}

export function canEdit(row: Pick<MemoryRow, 'author_device'>, who: { device: string | null }): boolean {
	return !!who.device && row.author_device === who.device;
}

/** Memory counts for several items (grid badges). */
export function countFor(mediaIds: readonly string[]): Map<string, number> {
	const out = new Map<string, number>();
	if (mediaIds.length === 0) return out;
	const rows = stmt(
		`SELECT media_id, COUNT(*) AS n FROM memories WHERE media_id IN (SELECT value FROM json_each(?)) GROUP BY media_id`
	).all(JSON.stringify(mediaIds)) as { media_id: string; n: number }[];
	for (const r of rows) out.set(r.media_id, r.n);
	return out;
}

export interface AlbumMemoryRow extends MemoryRow {
	source_name: string;
	taken_at: string | null;
	taken_ms: number | null;
}

/** Every memory on visible items of an album, in grid-export order (memories.txt in ZIPs). */
export function listForAlbum(albumId: number): AlbumMemoryRow[] {
	return stmt(
		`SELECT mem.*, m.source_name, m.taken_at, m.taken_ms FROM memories mem
		 JOIN media m ON m.id = mem.media_id
		 WHERE m.album_id = ? AND m.status = 'ready' AND m.deleted_at IS NULL AND m.live_photo_of IS NULL
		 ORDER BY m.taken_ms ASC, m.id ASC, mem.created_at ASC, mem.id ASC`
	).all(albumId) as AlbumMemoryRow[];
}
