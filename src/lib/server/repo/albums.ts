/** Albums. Soft-deleted albums keep their media; only the admin can delete/restore. */
import { stmt, tx } from '#lib/server/db';
import { ValidationError } from '#lib/shared/errors';
import type { Kind } from '#lib/shared/media-types';

export interface AlbumRow {
	id: number;
	title: string;
	when_text: string | null;
	description: string | null;
	cover_media_id: string | null;
	created_by_name: string | null;
	created_by_device: string | null;
	created_at: number;
	updated_at: number;
	deleted_at: number | null;
}

export interface AlbumSummary extends AlbumRow {
	/** Visible (ready, not deleted, not a hidden Live Photo video) items. */
	item_count: number;
	photo_count: number;
	video_count: number;
	/** cover_media_id if it is still visible, else the newest visible item. */
	cover_id: string | null;
	cover_kind: Kind | null;
}

export interface CreateAlbumInput {
	title: string;
	whenText?: string | null;
	description?: string | null;
	createdByName: string | null;
	createdByDevice: string | null;
}

export interface UpdateAlbumInput {
	title?: string;
	whenText?: string | null;
	description?: string | null;
	coverMediaId?: string | null;
}

function cleanText(v: string | null | undefined, field: string, max: number): string | null {
	if (v === undefined || v === null) return null;
	const t = v.normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
	if (t.length > max) throw new ValidationError(`That's too long (max ${max} characters).`, field);
	return t === '' ? null : t;
}

function cleanTitle(v: string): string {
	const t = cleanText(v, 'title', 200);
	if (!t) throw new ValidationError('Please give the album a name.', 'title');
	return t;
}

export function create(input: CreateAlbumInput): AlbumRow {
	const now = Date.now();
	const r = stmt(
		`INSERT INTO albums(title, when_text, description, created_by_name, created_by_device, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	).run(
		cleanTitle(input.title),
		cleanText(input.whenText, 'whenText', 200),
		cleanText(input.description, 'description', 5000),
		input.createdByName,
		input.createdByDevice,
		now,
		now
	);
	return get(Number(r.lastInsertRowid), { includeDeleted: true })!;
}

export function get(id: number, opts: { includeDeleted?: boolean } = {}): AlbumRow | undefined {
	if (!Number.isInteger(id)) return undefined;
	const row = stmt('SELECT * FROM albums WHERE id = ?').get(id) as AlbumRow | undefined;
	if (!row || (row.deleted_at !== null && !opts.includeDeleted)) return undefined;
	return row;
}

/**
 * Albums with their counts, cover and the cover's kind, in one query. `oneAlbum` puts the album
 * filter inside the counting subquery (a `?` for the album id, bound twice), so a single album's
 * summary reads only that album's rows (media_album_view) instead of grouping the whole library
 * and keeping one group.
 */
function summarySql(oneAlbum: boolean): string {
	return `
	SELECT s.*, (SELECT m.kind FROM media m WHERE m.id = s.cover_id) AS cover_kind
	FROM (
		SELECT a.*,
			COALESCE(c.item_count, 0)  AS item_count,
			COALESCE(c.photo_count, 0) AS photo_count,
			COALESCE(c.video_count, 0) AS video_count,
			COALESCE(
				(SELECT m.id FROM media m WHERE m.id = a.cover_media_id AND m.album_id = a.id
					AND m.status = 'ready' AND m.deleted_at IS NULL AND m.live_photo_of IS NULL),
				(SELECT m.id FROM media m WHERE m.album_id = a.id
					AND m.status = 'ready' AND m.deleted_at IS NULL AND m.live_photo_of IS NULL
					ORDER BY m.taken_ms DESC, m.id DESC LIMIT 1)
			) AS cover_id
		FROM albums a
		LEFT JOIN (
			SELECT album_id,
				COUNT(*) AS item_count,
				SUM(kind = 'photo') AS photo_count,
				SUM(kind = 'video') AS video_count
			FROM media
			WHERE ${oneAlbum ? 'album_id = ? AND ' : ''}status = 'ready' AND deleted_at IS NULL AND live_photo_of IS NULL
			GROUP BY album_id
		) c ON c.album_id = a.id
		${oneAlbum ? 'WHERE a.id = ?' : ''}
	) s`;
}

const ALL_SUMMARIES = summarySql(false);
const ONE_SUMMARY = summarySql(true);

/** Albums with counts and cover, most recently updated first. */
export function list(opts: { includeDeleted?: boolean } = {}): AlbumSummary[] {
	const where = opts.includeDeleted ? '' : 'WHERE s.deleted_at IS NULL';
	return stmt(`${ALL_SUMMARIES} ${where} ORDER BY s.updated_at DESC, s.id DESC`).all() as AlbumSummary[];
}

/** One album with counts and cover. */
export function getSummary(id: number, opts: { includeDeleted?: boolean } = {}): AlbumSummary | undefined {
	if (!Number.isInteger(id)) return undefined;
	const row = stmt(ONE_SUMMARY).get(id, id) as AlbumSummary | undefined;
	if (!row || (row.deleted_at !== null && !opts.includeDeleted)) return undefined;
	return row;
}

/** Soft-deleted albums (admin trash). */
export function listDeleted(): AlbumSummary[] {
	return stmt(`${ALL_SUMMARIES} WHERE s.deleted_at IS NOT NULL ORDER BY s.deleted_at DESC`).all() as AlbumSummary[];
}

/** Updates the given fields (undefined = unchanged, null = clear). Returns the new row. */
export function update(id: number, input: UpdateAlbumInput): AlbumRow | undefined {
	return tx(() => {
		const row = get(id);
		if (!row) return undefined;
		const next = {
			title: input.title !== undefined ? cleanTitle(input.title) : row.title,
			when_text: input.whenText !== undefined ? cleanText(input.whenText, 'whenText', 200) : row.when_text,
			description:
				input.description !== undefined ? cleanText(input.description, 'description', 5000) : row.description,
			cover_media_id: input.coverMediaId !== undefined ? input.coverMediaId : row.cover_media_id
		};
		stmt(
			`UPDATE albums SET title = ?, when_text = ?, description = ?, cover_media_id = ?, updated_at = ?
			 WHERE id = ?`
		).run(next.title, next.when_text, next.description, next.cover_media_id, Date.now(), id);
		return get(id);
	});
}

/** Bumps updated_at (new items arrived) so the album sorts to the top. */
export function touch(id: number, at: number = Date.now()): void {
	stmt('UPDATE albums SET updated_at = MAX(updated_at, ?) WHERE id = ?').run(at, id);
}

export function softDelete(id: number): boolean {
	return stmt('UPDATE albums SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(Date.now(), id).changes > 0;
}

export function restore(id: number): boolean {
	return stmt('UPDATE albums SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL').run(id).changes > 0;
}

/** Album creators (by device) and the admin may edit title/when/description. */
export function canEdit(album: Pick<AlbumRow, 'created_by_device'>, who: { role: string | null; deviceId: string | null }): boolean {
	if (who.role === 'admin') return true;
	return !!who.deviceId && album.created_by_device === who.deviceId;
}
