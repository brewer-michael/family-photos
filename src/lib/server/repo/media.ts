/**
 * Media items. One row per upload; see 001_init.sql for columns and the duplicate strategy.
 *
 * Lifecycle (who calls what):
 *   tus onUploadFinish ─ insertReceived()                         status=received
 *   intake (main)      ─ findDuplicate() → markDuplicate()         status=duplicate
 *                      ─ markQueued()  (re-checks duplicates)      status=queued
 *                      ─ markFailed(id, 'unsupported', …, extra)   status=failed
 *   queue (main)       ─ nextQueued(kind) → claimForProcessing()   status=processing, attempts++
 *   lane (worker)      ─ markReady()   (commit step; pairs Live Photos, touches album)
 *                      ─ sourceSettled() (after archiving or deleting the source)
 *   queue (main)       ─ on failure: requeue() or markFailed()
 *                        Both only act on unfinished rows and return false otherwise: a job that
 *                        committed markReady() and then failed (cleanup error, timeout, crash) is
 *                        a success, and the main process must leave the ready row alone.
 *   startup            ─ requeueInterrupted(); each lane: listUnsettled() → sourceSettled()
 *
 * upload_token: kept while the source may still be in .incoming/<token> (received, queued,
 * processing, failed, and a `ready` row until the lane has archived or deleted the source),
 * so the .incoming sweep never deletes a source a row still needs. Cleared by sourceSettled()
 * and markDuplicate(). Use sourcePath() to locate an item's source file.
 *
 * Boolean columns are 0/1 numbers in rows.
 */
import { monotonicFactory } from 'ulid';
import { stmt, tx } from '#lib/server/db';
import { incomingPath, originalsPath } from '#lib/server/paths';
import { touch as touchAlbum, get as getAlbum } from './albums';
import {
	MAX_ATTEMPTS,
	PIPELINE_VERSION,
	type CanonicalExt,
	type Conversion,
	type ErrorCode,
	type Kind,
	type Status
} from '#lib/shared/media-types';

export interface MediaRow {
	id: string;
	upload_token: string | null;
	album_id: number;
	uploaded_by_name: string;
	uploaded_by_device: string;
	kind: Kind | null;
	status: Status;
	attempts: number;
	error_code: ErrorCode | null;
	error_detail: string | null;
	pipeline_version: number;
	source_name: string;
	source_mime: string | null;
	source_ext: string | null;
	source_size: number;
	source_sha256: string | null;
	source_kept: number;
	client_mtime_ms: number | null;
	conversion: Conversion | null;
	canonical_ext: CanonicalExt | null;
	canonical_size: number | null;
	width: number | null;
	height: number | null;
	duration_ms: number | null;
	hdr_tonemapped: number;
	audio_dropped: number;
	slowmo_retimed: number;
	est_cost_s: number | null;
	queued_ms: number | null;
	taken_at: string | null;
	taken_ms: number | null;
	gps_lat: number | null;
	gps_lon: number | null;
	gps_alt: number | null;
	content_id: string | null;
	live_photo_of: string | null;
	duplicate_of: string | null;
	created_at: number;
	updated_at: number;
	deleted_at: number | null;
	deleted_reason: string | null;
	/** Admin redo of a ready item: NULL, waiting ('queued') or in a lane ('running'). */
	redo_state: RedoState | null;
	redo_queued_ms: number | null;
	redo_attempts: number;
	/** Why the last redo didn't work (admin only); the item kept its old file. */
	redo_error: string | null;
}

export type RedoState = 'queued' | 'running';

/** Visible in grids, ZIPs and prev/next: ready, not trashed, not a hidden Live Photo video. */
const VISIBLE = `status = 'ready' AND deleted_at IS NULL AND live_photo_of IS NULL`;

/** Live Photo videos longer than this are never paired. */
export const LIVE_PHOTO_MAX_MS = 4500;

const newId = monotonicFactory();

// ---------------------------------------------------------------------------
// Insert & lookup
// ---------------------------------------------------------------------------

export interface InsertReceivedInput {
	uploadToken: string;
	albumId: number;
	sourceName: string;
	sourceSize: number;
	clientMtimeMs: number | null;
	uploadedByName: string;
	uploadedByDevice: string;
}

/** Basename only, NFC, no control or path characters, ≤ 255 chars; never empty. */
export function sanitizeSourceName(name: string): string {
	const base = name.replace(/^.*[\\/]/, '');
	const clean = base
		.normalize('NFC')
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.replace(/[\\/:*?"<>|]/g, '_')
		.trim()
		.slice(0, 255);
	return clean === '' || clean === '.' || clean === '..' ? 'upload' : clean;
}

/**
 * Inserts a `received` row for a finished tus upload and returns its new ULID.
 * Idempotent on uploadToken: a second call for the same token returns the existing id.
 */
export function insertReceived(input: InsertReceivedInput): string {
	return tx(() => {
		const existing = getByUploadToken(input.uploadToken);
		if (existing) return existing.id;
		const id = newId();
		const now = Date.now();
		stmt(
			`INSERT INTO media(id, upload_token, album_id, uploaded_by_name, uploaded_by_device,
				status, source_name, source_size, client_mtime_ms, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, ?)`
		).run(
			id,
			input.uploadToken,
			input.albumId,
			input.uploadedByName,
			input.uploadedByDevice,
			sanitizeSourceName(input.sourceName),
			Math.round(input.sourceSize),
			input.clientMtimeMs === null || !Number.isFinite(input.clientMtimeMs)
				? null
				: Math.round(input.clientMtimeMs),
			now,
			now
		);
		return id;
	});
}

export function getById(id: string): MediaRow | undefined {
	return stmt('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined;
}

export function getByUploadToken(token: string): MediaRow | undefined {
	return stmt('SELECT * FROM media WHERE upload_token = ?').get(token) as MediaRow | undefined;
}

export function clearUploadToken(id: string): void {
	stmt('UPDATE media SET upload_token = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id);
}

/**
 * Where the item's source bytes are: the tus upload in .incoming/<token> while the row holds its
 * token (not yet settled), else the archived original if kept; null when the source is gone
 * (deleted after a passthrough or with KEEP_ORIGINALS off). The lanes also look in the other
 * place (src/worker/settle.ts locateSource), for a lane that died between archiving and
 * sourceSettled().
 */
export function sourcePath(row: Pick<MediaRow, 'id' | 'upload_token' | 'source_kept' | 'source_ext'>): string | null {
	if (row.upload_token) return incomingPath(row.upload_token);
	if (row.source_kept && row.source_ext) return originalsPath(row.id, row.source_ext);
	return null;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface AlbumCursor {
	takenMs: number;
	id: string;
}

export function encodeCursor(c: AlbumCursor): string {
	return `${c.takenMs}_${c.id}`;
}

export function decodeCursor(s: string | null | undefined): AlbumCursor | null {
	if (!s) return null;
	const m = /^(-?\d{1,16})_([0-9A-HJKMNP-TV-Z]{26})$/.exec(s);
	return m ? { takenMs: Number(m[1]), id: m[2] } : null;
}

/**
 * Visible items in an album, newest taken first, keyset-paged on (taken_ms, id).
 * Pass `before` = the previous page's `next` to get the following page.
 */
export function listByAlbum(
	albumId: number,
	opts: { limit?: number; before?: AlbumCursor | null } = {}
): { items: MediaRow[]; next: AlbumCursor | null } {
	const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 60)));
	const rows = (
		opts.before
			? stmt(
					`SELECT * FROM media WHERE album_id = ? AND ${VISIBLE} AND (taken_ms, id) < (?, ?)
					 ORDER BY taken_ms DESC, id DESC LIMIT ?`
				).all(albumId, opts.before.takenMs, opts.before.id, limit + 1)
			: stmt(
					`SELECT * FROM media WHERE album_id = ? AND ${VISIBLE}
					 ORDER BY taken_ms DESC, id DESC LIMIT ?`
				).all(albumId, limit + 1)
	) as MediaRow[];
	const more = rows.length > limit;
	const items = more ? rows.slice(0, limit) : rows;
	const last = items[items.length - 1];
	return { items, next: more && last ? { takenMs: last.taken_ms ?? 0, id: last.id } : null };
}

/** Every visible item in an album, oldest first (ZIP download, "Save all"). */
export function listAllVisibleInAlbum(albumId: number): MediaRow[] {
	return stmt(
		`SELECT * FROM media WHERE album_id = ? AND ${VISIBLE} ORDER BY taken_ms ASC, id ASC`
	).all(albumId) as MediaRow[];
}

/** Newest uploads that are ready, across albums that aren't deleted ("New photos"). */
export function listRecent(opts: { limit?: number } = {}): MediaRow[] {
	const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 24)));
	return stmt(
		`SELECT m.* FROM media m JOIN albums a ON a.id = m.album_id AND a.deleted_at IS NULL
		 WHERE m.status = 'ready' AND m.deleted_at IS NULL AND m.live_photo_of IS NULL
		 ORDER BY m.created_at DESC, m.id DESC LIMIT ?`
	).all(limit) as MediaRow[];
}

/**
 * Unfinished tiles (received/queued/processing/failed/duplicate), newest first.
 * device = null lists every device (admin). sinceMs defaults to 7 days ago.
 */
export function listPending(
	opts: { albumId?: number | null; device?: string | null; sinceMs?: number; limit?: number } = {}
): MediaRow[] {
	const since = opts.sinceMs ?? Date.now() - 7 * 24 * 3600_000;
	const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 200)));
	return stmt(
		`SELECT * FROM media
		 WHERE status <> 'ready' AND deleted_at IS NULL AND created_at >= ?
		   AND (? IS NULL OR album_id = ?)
		   AND (? IS NULL OR uploaded_by_device = ?)
		 ORDER BY created_at DESC, id DESC LIMIT ?`
	).all(
		since,
		opts.albumId ?? null,
		opts.albumId ?? null,
		opts.device ?? null,
		opts.device ?? null,
		limit
	) as MediaRow[];
}

export type MediaStatusRow = Pick<
	MediaRow,
	| 'id'
	| 'status'
	| 'kind'
	| 'error_code'
	| 'duplicate_of'
	| 'album_id'
	| 'uploaded_by_device'
	| 'queued_ms'
	| 'est_cost_s'
	| 'deleted_at'
	| 'pipeline_version'
>;

/** Status facts for /api/status (at most 500 ids; unknown ids are omitted). */
export function statusForIds(ids: readonly string[]): MediaStatusRow[] {
	if (ids.length === 0) return [];
	return stmt(
		`SELECT id, status, kind, error_code, duplicate_of, album_id, uploaded_by_device,
		        queued_ms, est_cost_s, deleted_at, pipeline_version
		 FROM media WHERE id IN (SELECT value FROM json_each(?))`
	).all(JSON.stringify(ids.slice(0, 500))) as MediaStatusRow[];
}

/** Ready items in the album's grid order around `id`: prev = newer, next = older. */
export function prevNext(id: string): { prev: string | null; next: string | null } {
	const row = getById(id);
	if (!row || row.status !== 'ready' || row.deleted_at !== null || row.live_photo_of !== null) {
		return { prev: null, next: null };
	}
	const t = row.taken_ms ?? 0;
	const prev = stmt(
		`SELECT id FROM media WHERE album_id = ? AND ${VISIBLE} AND (taken_ms, id) > (?, ?)
		 ORDER BY taken_ms ASC, id ASC LIMIT 1`
	).get(row.album_id, t, row.id) as { id: string } | undefined;
	const next = stmt(
		`SELECT id FROM media WHERE album_id = ? AND ${VISIBLE} AND (taken_ms, id) < (?, ?)
		 ORDER BY taken_ms DESC, id DESC LIMIT 1`
	).get(row.album_id, t, row.id) as { id: string } | undefined;
	return { prev: prev?.id ?? null, next: next?.id ?? null };
}

/** The hidden Live Photo video paired with a photo, if any. */
export function livePhotoVideoFor(photoId: string): MediaRow | undefined {
	return stmt(
		`SELECT * FROM media WHERE live_photo_of = ? AND status = 'ready' AND deleted_at IS NULL
		 ORDER BY created_at LIMIT 1`
	).get(photoId) as MediaRow | undefined;
}

/** Failed items for the admin page (optionally only those failed since `sinceMs`), newest first. */
export function listFailed(opts: { limit?: number; sinceMs?: number } = {}): MediaRow[] {
	return stmt(
		`SELECT * FROM media WHERE status = 'failed' AND deleted_at IS NULL AND updated_at >= ?
		 ORDER BY updated_at DESC LIMIT ?`
	).all(opts.sinceMs ?? 0, Math.max(1, Math.floor(opts.limit ?? 200))) as MediaRow[];
}

/**
 * Repeats the media_queue index's own predicate: SQLite only uses a partial index when the query's
 * WHERE contains its terms literally (`status = 'queued'` alone doesn't imply it), and without it
 * every intake step, dispatch and status poll would scan the whole table.
 */
const IN_QUEUE = `status IN ('received','queued','processing')`;

/** Received rows waiting for intake, oldest first. */
export function listReceived(opts: { limit?: number } = {}): MediaRow[] {
	return stmt(
		`SELECT * FROM media WHERE ${IN_QUEUE} AND status = 'received' ORDER BY created_at ASC, id ASC LIMIT ?`
	).all(Math.max(1, Math.floor(opts.limit ?? 50))) as MediaRow[];
}

/** Upload tokens whose .incoming files must be kept (the .incoming sweep skips these). */
export function tokensInUse(): Set<string> {
	const rows = stmt('SELECT upload_token FROM media WHERE upload_token IS NOT NULL').all() as {
		upload_token: string;
	}[];
	return new Set(rows.map((r) => r.upload_token));
}

/** Ready items produced by an older pipeline (admin "Reprocess items below version N"). */
export function listBelowPipelineVersion(version: number, opts: { kind?: Kind } = {}): MediaRow[] {
	return stmt(
		`SELECT * FROM media WHERE status = 'ready' AND pipeline_version < ? AND (? IS NULL OR kind = ?)
		 ORDER BY created_at ASC`
	).all(version, opts.kind ?? null, opts.kind ?? null) as MediaRow[];
}

export function countByStatus(): Record<Status, number> {
	const out: Record<Status, number> = {
		received: 0,
		queued: 0,
		processing: 0,
		ready: 0,
		failed: 0,
		duplicate: 0
	};
	const rows = stmt('SELECT status, COUNT(*) AS n FROM media WHERE deleted_at IS NULL GROUP BY status').all() as {
		status: Status;
		n: number;
	}[];
	for (const r of rows) out[r.status] = r.n;
	return out;
}

// ---------------------------------------------------------------------------
// Duplicates & intake transitions
// ---------------------------------------------------------------------------

/**
 * A live item in the album with these bytes (the same predicate as the
 * media_album_sha unique index), excluding `excludeId`.
 */
export function findDuplicate(albumId: number, sha256: string, excludeId?: string): MediaRow | undefined {
	return stmt(
		`SELECT * FROM media
		 WHERE album_id = ? AND source_sha256 = ? AND status NOT IN ('duplicate','failed')
		   AND deleted_at IS NULL AND id <> ?
		 ORDER BY created_at ASC LIMIT 1`
	).get(albumId, sha256, excludeId ?? '') as MediaRow | undefined;
}

/**
 * received → duplicate of an existing item; clears its upload token (the caller deletes the
 * upload). Returns false if the row isn't `received`.
 */
export function markDuplicate(id: string, duplicateOfId: string, sourceSha256?: string | null): boolean {
	return (
		stmt(
			`UPDATE media SET status = 'duplicate', duplicate_of = ?, source_sha256 = COALESCE(?, source_sha256),
				upload_token = NULL, error_code = NULL, error_detail = NULL, updated_at = ?
			 WHERE id = ? AND status = 'received'`
		).run(duplicateOfId, sourceSha256 ?? null, Date.now(), id).changes > 0
	);
}

export interface QueueInput {
	kind: Kind;
	sourceMime: string;
	/** Detected extension, used for originals/<sh>/<id>.<ext>. */
	sourceExt?: string | null;
	sourceSha256: string;
	/** Video lane ordering; photos may pass null. */
	estCostS: number | null;
}

export type QueueResult = { outcome: 'queued' } | { outcome: 'duplicate'; duplicateOf: string };

/**
 * received → queued. Atomically re-checks for a duplicate in the album and, if one
 * appeared, marks this row duplicate instead (never violates media_album_sha).
 * Throws if the row isn't in `received`.
 */
export function markQueued(id: string, input: QueueInput): QueueResult {
	return tx(() => {
		const row = getById(id);
		if (!row) throw new Error(`markQueued: no media ${id}`);
		if (row.status !== 'received') throw new Error(`markQueued: media ${id} is ${row.status}, not received`);
		const dup = findDuplicate(row.album_id, input.sourceSha256, id);
		if (dup) {
			markDuplicate(id, dup.id, input.sourceSha256);
			return { outcome: 'duplicate', duplicateOf: dup.id } as const;
		}
		const now = Date.now();
		stmt(
			`UPDATE media SET status = 'queued', kind = ?, source_mime = ?, source_ext = ?, source_sha256 = ?,
				est_cost_s = ?, queued_ms = ?, error_code = NULL, error_detail = NULL, updated_at = ?
			 WHERE id = ?`
		).run(
			input.kind,
			input.sourceMime,
			input.sourceExt ?? null,
			input.sourceSha256,
			input.estCostS,
			now,
			now,
			id
		);
		return { outcome: 'queued' } as const;
	});
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

const PHOTO_ORDER = `queued_ms ASC, id ASC`;
/** Lowest est_cost_s − 0.5 × wait_s first; `?` is now (ms). */
const VIDEO_ORDER = `(COALESCE(est_cost_s, 0) - 0.5 * ((? - COALESCE(queued_ms, ?)) / 1000.0)) ASC, queued_ms ASC, id ASC`;

/** Next queued item for a lane (photo: FIFO; video: cost-aged), or undefined. */
export function nextQueued(kind: Kind, now: number = Date.now()): MediaRow | undefined {
	if (kind === 'photo') {
		return stmt(
			`SELECT * FROM media WHERE ${IN_QUEUE} AND status = 'queued' AND kind = 'photo' AND deleted_at IS NULL
			 ORDER BY ${PHOTO_ORDER} LIMIT 1`
		).get() as MediaRow | undefined;
	}
	return stmt(
		`SELECT * FROM media WHERE ${IN_QUEUE} AND status = 'queued' AND kind = 'video' AND deleted_at IS NULL
		 ORDER BY ${VIDEO_ORDER} LIMIT 1`
	).get(now, now) as MediaRow | undefined;
}

/** Queued ids of a lane in the order nextQueued() would take them (for "2 ahead"). */
export function queueOrder(kind: Kind, now: number = Date.now()): string[] {
	const rows = (
		kind === 'photo'
			? stmt(
					`SELECT id FROM media WHERE ${IN_QUEUE} AND status = 'queued' AND kind = 'photo' AND deleted_at IS NULL
					 ORDER BY ${PHOTO_ORDER}`
				).all()
			: stmt(
					`SELECT id FROM media WHERE ${IN_QUEUE} AND status = 'queued' AND kind = 'video' AND deleted_at IS NULL
					 ORDER BY ${VIDEO_ORDER}`
				).all(now, now)
	) as { id: string }[];
	return rows.map((r) => r.id);
}

/**
 * Next item of a lane waiting for a redo, oldest first. The queue asks only when nextQueued()
 * found nothing, so family uploads never wait behind a redo backlog.
 */
export function nextRedo(kind: Kind): MediaRow | undefined {
	return stmt(
		`SELECT * FROM media WHERE redo_state = 'queued' AND kind = ? AND status = 'ready' AND deleted_at IS NULL
		 ORDER BY redo_queued_ms ASC, id ASC LIMIT 1`
	).get(kind) as MediaRow | undefined;
}

/**
 * redo queued → running with redo_attempts++ (status stays 'ready'). Returns the updated row, or
 * undefined when it is no longer waiting (trashed, taken, or its original is gone).
 */
export function claimRedo(id: string): MediaRow | undefined {
	return stmt(
		`UPDATE media SET redo_state = 'running', redo_attempts = redo_attempts + 1
		 WHERE id = ? AND redo_state = 'queued' AND status = 'ready' AND deleted_at IS NULL
		   AND source_kept = 1 AND source_ext IS NOT NULL
		 RETURNING *`
	).get(id) as MediaRow | undefined;
}

/** The lane job for this row is a redo (claimRedo), not a first conversion. */
export function isRedo(row: Pick<MediaRow, 'status' | 'redo_state'>): boolean {
	return row.status === 'ready' && row.redo_state === 'running';
}

/**
 * queued → processing with attempts++ in one statement. Returns the updated row, or
 * undefined if the item wasn't queued (someone else took it, or it was trashed).
 */
export function claimForProcessing(id: string): MediaRow | undefined {
	return stmt(
		`UPDATE media SET status = 'processing', attempts = attempts + 1, updated_at = ?
		 WHERE id = ? AND status = 'queued' AND deleted_at IS NULL
		 RETURNING *`
	).get(Date.now(), id) as MediaRow | undefined;
}

export interface ReadyFields {
	conversion: Conversion;
	canonicalExt: CanonicalExt;
	canonicalSize: number;
	/** As displayed (after rotation). */
	width: number;
	height: number;
	durationMs?: number | null;
	hdrTonemapped?: boolean;
	audioDropped?: boolean;
	slowmoRetimed?: boolean;
	/** Local wall time (+offset when known), e.g. "2024-07-04T11:22:31-07:00". */
	takenAt?: string | null;
	/** UTC epoch ms; required (fallback chain ends at upload time). */
	takenMs: number;
	gpsLat?: number | null;
	gpsLon?: number | null;
	gpsAlt?: number | null;
	contentId?: string | null;
	/** True when the source was archived to originals/<sh>/<id>.<source_ext>. */
	sourceKept: boolean;
	/** Overrides the detected source extension (used for the originals/ path). */
	sourceExt?: string | null;
	/** Defaults to PIPELINE_VERSION. */
	pipelineVersion?: number;
}

const int = (v: number | null | undefined): number | null =>
	v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v);
const real = (v: number | null | undefined): number | null =>
	v === null || v === undefined || !Number.isFinite(v) ? null : v;
/** Epoch ms within the range a Date can hold (±8.64e15), rounded; null otherwise. */
const epochMs = (v: number): number | null => (Number.isFinite(v) && Math.abs(v) <= 8.64e15 ? Math.round(v) : null);

/**
 * processing → ready (the worker's commit step, after the canonical file was renamed
 * into library/). Clears the error, touches the album, and pairs Live Photos. The upload
 * token stays until the lane has archived or deleted the source (sourceSettled()). A takenMs
 * that isn't a valid epoch time (NaN, ±Infinity, beyond what a Date can hold) falls back to the
 * row's created_at, so a ready row always has its sort key.
 * Returns false if the row wasn't processing.
 */
export function markReady(id: string, f: ReadyFields): boolean {
	return tx(() => {
		const now = Date.now();
		const r = stmt(
			`UPDATE media SET status = 'ready', conversion = ?, canonical_ext = ?, canonical_size = ?,
				width = ?, height = ?, duration_ms = ?, hdr_tonemapped = ?, audio_dropped = ?, slowmo_retimed = ?,
				taken_at = ?, taken_ms = COALESCE(?, created_at), gps_lat = ?, gps_lon = ?, gps_alt = ?, content_id = ?,
				source_kept = ?, source_ext = COALESCE(?, source_ext), pipeline_version = ?,
				error_code = NULL, error_detail = NULL, updated_at = ?
			 WHERE id = ? AND status = 'processing'`
		).run(
			f.conversion,
			f.canonicalExt,
			int(f.canonicalSize),
			int(f.width),
			int(f.height),
			int(f.durationMs),
			f.hdrTonemapped ? 1 : 0,
			f.audioDropped ? 1 : 0,
			f.slowmoRetimed ? 1 : 0,
			f.takenAt ?? null,
			epochMs(f.takenMs),
			real(f.gpsLat),
			real(f.gpsLon),
			real(f.gpsAlt),
			f.contentId ?? null,
			f.sourceKept ? 1 : 0,
			f.sourceExt ?? null,
			f.pipelineVersion ?? PIPELINE_VERSION,
			now,
			id
		);
		if (r.changes === 0) return false;
		const row = getById(id)!;
		touchAlbum(row.album_id, now);
		pairLivePhoto(id);
		return true;
	});
}

/**
 * After markReady(): the lane has archived the source in originals/ (and fsynced it) or deleted
 * it, so the row lets go of its .incoming upload. Until then the .incoming sweep keeps the file.
 */
export function sourceSettled(id: string): void {
	stmt('UPDATE media SET upload_token = NULL, updated_at = ? WHERE id = ? AND upload_token IS NOT NULL').run(Date.now(), id);
}

/**
 * Ready rows of a lane whose source was never settled (the lane died between markReady() and
 * sourceSettled()); the lane finishes them when it starts.
 */
export function listUnsettled(kind: Kind): MediaRow[] {
	return stmt(
		`SELECT * FROM media WHERE status = 'ready' AND upload_token IS NOT NULL AND kind = ? ORDER BY created_at ASC`
	).all(kind) as MediaRow[];
}

/**
 * A redo's commit step (the lane renamed the new canonical file into library/): the same fields
 * as markReady() plus the current pipeline_version, and the redo is over. The row stays 'ready'
 * the whole time and its album, trash state and Live Photo link are left as they are. Returns
 * false when the row isn't being redone any more (it was trashed while waiting, or purged); the
 * lane then puts the previous file back.
 */
export function markRedone(id: string, f: ReadyFields): boolean {
	return (
		stmt(
			`UPDATE media SET conversion = ?, canonical_ext = ?, canonical_size = ?,
				width = ?, height = ?, duration_ms = ?, hdr_tonemapped = ?, audio_dropped = ?, slowmo_retimed = ?,
				taken_at = ?, taken_ms = COALESCE(?, created_at), gps_lat = ?, gps_lon = ?, gps_alt = ?, content_id = ?,
				source_kept = ?, source_ext = COALESCE(?, source_ext), pipeline_version = ?,
				redo_state = NULL, redo_queued_ms = NULL, redo_attempts = 0, redo_error = NULL, updated_at = ?
			 WHERE id = ? AND status = 'ready' AND redo_state = 'running'`
		).run(
			f.conversion,
			f.canonicalExt,
			int(f.canonicalSize),
			int(f.width),
			int(f.height),
			int(f.durationMs),
			f.hdrTonemapped ? 1 : 0,
			f.audioDropped ? 1 : 0,
			f.slowmoRetimed ? 1 : 0,
			f.takenAt ?? null,
			epochMs(f.takenMs),
			real(f.gpsLat),
			real(f.gpsLon),
			real(f.gpsAlt),
			f.contentId ?? null,
			f.sourceKept ? 1 : 0,
			f.sourceExt ?? null,
			f.pipelineVersion ?? PIPELINE_VERSION,
			Date.now(),
			id
		).changes > 0
	);
}

/**
 * Live Photo pairing for a ready item: a video ≤ 4.5 s whose content_id matches a ready photo's
 * gets live_photo_of = photo.id (order-independent).
 *
 * A video that becomes ready after its photo also follows wherever the photo went meanwhile: a
 * photo trashed (an approved removal request) or moved before the video was ready still takes it
 * along, so the clip never shows up on its own. It looks in the video's album first, then in
 * other albums only for photos uploaded from the same device; a live photo wins over a trashed
 * one. A moved photo whose album already has these video bytes live is left unpaired (the
 * media_album_sha index would refuse the move).
 * Returns the photo id it linked to/from, or null.
 */
export function pairLivePhoto(id: string): string | null {
	const row = getById(id);
	if (!row || row.status !== 'ready' || !row.content_id || row.deleted_at !== null) return null;
	if (row.kind === 'video') {
		if (row.duration_ms === null || row.duration_ms > LIVE_PHOTO_MAX_MS || row.live_photo_of !== null) return null;
		const photo = stmt(
			`SELECT id, album_id, deleted_at, deleted_reason FROM media
			 WHERE content_id = ? AND kind = 'photo' AND status = 'ready'
			   AND (album_id = ? OR uploaded_by_device = ?)
			 ORDER BY album_id = ? DESC, deleted_at IS NOT NULL, created_at, id LIMIT 1`
		).get(row.content_id, row.album_id, row.uploaded_by_device, row.album_id) as
			| Pick<MediaRow, 'id' | 'album_id' | 'deleted_at' | 'deleted_reason'>
			| undefined;
		if (!photo) return null;
		if (photo.album_id !== row.album_id && photo.deleted_at === null && conflictIn(photo.album_id, [row])) return null;
		stmt(
			`UPDATE media SET live_photo_of = ?, album_id = ?, deleted_at = ?, deleted_reason = ?, updated_at = ? WHERE id = ?`
		).run(photo.id, photo.album_id, photo.deleted_at, photo.deleted_reason, Date.now(), id);
		return photo.id;
	}
	if (row.kind === 'photo') {
		const r = stmt(
			`UPDATE media SET live_photo_of = ?, updated_at = ?
			 WHERE album_id = ? AND content_id = ? AND kind = 'video' AND status = 'ready'
			   AND deleted_at IS NULL AND live_photo_of IS NULL AND duration_ms <= ?`
		).run(id, Date.now(), row.album_id, row.content_id, LIVE_PHOTO_MAX_MS);
		return r.changes > 0 ? id : null;
	}
	return null;
}

export interface FailExtra {
	kind?: Kind | null;
	sourceMime?: string | null;
	sourceExt?: string | null;
	sourceSha256?: string | null;
	sourceKept?: boolean;
}

/**
 * received|queued|processing → failed with a code and admin-only detail. Optional source facts
 * (intake failures). Returns false for any other status — in particular a `ready` row stays
 * ready even if its worker reported a failure after committing (see the lifecycle above).
 */
export function markFailed(id: string, code: ErrorCode, detail: string, extra: FailExtra = {}): boolean {
	return (
		stmt(
			`UPDATE media SET status = 'failed', error_code = ?, error_detail = ?,
				kind = COALESCE(?, kind), source_mime = COALESCE(?, source_mime), source_ext = COALESCE(?, source_ext),
				source_sha256 = COALESCE(?, source_sha256), source_kept = COALESCE(?, source_kept), updated_at = ?
			 WHERE id = ? AND status IN ('received','queued','processing')`
		).run(
			code,
			detail.slice(0, 8000),
			extra.kind ?? null,
			extra.sourceMime ?? null,
			extra.sourceExt ?? null,
			extra.sourceSha256 ?? null,
			extra.sourceKept === undefined ? null : extra.sourceKept ? 1 : 0,
			Date.now(),
			id
		).changes > 0
	);
}

/**
 * processing → queued, keeping its queue position. After a retryable failure the attempt counts
 * (keeps attempts). `refund` is for a job a graceful shutdown cut short: that isn't the item's
 * fault, so the claim's attempt is given back and restarts never use up MAX_ATTEMPTS.
 */
export function requeue(id: string, detail?: string, opts: { refund?: boolean } = {}): boolean {
	return (
		stmt(
			`UPDATE media SET status = 'queued', error_detail = COALESCE(?, error_detail),
				attempts = CASE WHEN ? THEN MAX(attempts - 1, 0) ELSE attempts END, updated_at = ?
			 WHERE id = ? AND status = 'processing'`
		).run(detail ?? null, opts.refund ? 1 : 0, Date.now(), id).changes > 0
	);
}

/**
 * failed → queued with attempts reset: "Try again" / admin retry. An item that failed before it
 * ever reached a lane (attempts = 0: intake refused it, e.g. too long, damaged or unrecognised)
 * goes back to `received` instead, so intake detects and probes it again: the video caps apply
 * again, and est_cost_s and duration_ms are set for the lane's order and time limit. Only while the
 * source still exists (upload_token or archived original). If the same bytes became live in the
 * album meanwhile, the row becomes a duplicate instead: its upload token is cleared (the
 * .incoming sweep deletes that file) and an archived original stays recorded
 * (source_kept/source_ext) until purgeDuplicatesOlderThan() hands the row to maintenance, which
 * deletes it. Returns the new status, or null if it can't be retried (including a trashed row).
 */
export function retry(id: string): Status | null {
	return tx((): Status | null => {
		const row = getById(id);
		if (!row || row.status !== 'failed' || row.deleted_at !== null) return null;
		if (!row.upload_token && !row.source_kept) return null;
		if (row.source_sha256) {
			const dup = findDuplicate(row.album_id, row.source_sha256, id);
			if (dup) {
				stmt(
					`UPDATE media SET status = 'duplicate', duplicate_of = ?, upload_token = NULL,
						error_code = NULL, error_detail = NULL, updated_at = ? WHERE id = ?`
				).run(dup.id, Date.now(), id);
				return 'duplicate';
			}
		}
		const backToIntake = !row.kind || (row.attempts === 0 && row.upload_token !== null);
		const status: Status = backToIntake ? 'received' : 'queued';
		const now = Date.now();
		stmt(
			`UPDATE media SET status = ?, attempts = 0, error_code = NULL, error_detail = NULL,
				queued_ms = CASE WHEN ? = 'queued' THEN ? ELSE queued_ms END, updated_at = ?
			 WHERE id = ?`
		).run(status, status, now, now, id);
		return status;
	});
}

// ---------------------------------------------------------------------------
// Redo (admin "Redo them"): tracked in redo_* columns, never in `status`
// ---------------------------------------------------------------------------

/**
 * Items a redo can start for: ready, not in the trash, with an archived original to redo from,
 * and not already being redone. Shared by queueRedos(), countOutdated() and listOutdated(), so
 * "Redo them" never finds nothing.
 */
const REDOABLE = `status = 'ready' AND source_kept = 1 AND source_ext IS NOT NULL AND kind IS NOT NULL
	AND deleted_at IS NULL AND redo_state IS NULL`;

/**
 * Admin "Redo": queues a redo of a ready item from its archived original (originals/). The item
 * stays ready and visible with its current file until the lane commits the new one
 * (markRedone()); if the redo doesn't work, it stays exactly as it was (failRedo()). Returns false
 * when not eligible (not ready, trashed, no archived original, or already being redone).
 */
export function markForReprocess(id: string, now: number = Date.now()): boolean {
	return (
		stmt(
			`UPDATE media SET redo_state = 'queued', redo_queued_ms = ?, redo_attempts = 0, redo_error = NULL
			 WHERE id = ? AND ${REDOABLE}`
		).run(now, id).changes > 0
	);
}

/** "Redo them": queues a redo of every item made by a pipeline older than `version`, in one statement. */
export function queueRedos(version: number = PIPELINE_VERSION, now: number = Date.now()): number {
	return stmt(
		`UPDATE media SET redo_state = 'queued', redo_queued_ms = ?, redo_attempts = 0, redo_error = NULL
		 WHERE ${REDOABLE} AND pipeline_version < ?`
	).run(now, version).changes;
}

/** How many items queueRedos(version) would queue. */
export function countOutdated(version: number = PIPELINE_VERSION): number {
	return (stmt(`SELECT COUNT(*) AS n FROM media WHERE ${REDOABLE} AND pipeline_version < ?`).get(version) as { n: number }).n;
}

/** The items queueRedos(version) would queue, oldest first. */
export function listOutdated(version: number = PIPELINE_VERSION): MediaRow[] {
	return stmt(`SELECT * FROM media WHERE ${REDOABLE} AND pipeline_version < ? ORDER BY created_at ASC, id ASC`).all(
		version
	) as MediaRow[];
}

/**
 * redo running → queued. A retryable failure (`refund` false) counts the attempt and goes to the
 * back of the redo queue; a job a graceful shutdown cut short (`refund`) gets its attempt back and
 * keeps its place.
 */
export function requeueRedo(id: string, opts: { refund?: boolean } = {}): boolean {
	return (
		stmt(
			`UPDATE media SET redo_state = 'queued',
				redo_attempts = CASE WHEN ? THEN MAX(redo_attempts - 1, 0) ELSE redo_attempts END,
				redo_queued_ms = CASE WHEN ? THEN redo_queued_ms ELSE ? END
			 WHERE id = ? AND redo_state = 'running'`
		).run(opts.refund ? 1 : 0, opts.refund ? 1 : 0, Date.now(), id).changes > 0
	);
}

/**
 * A redo that didn't work: the redo ends with its reason (admin only). Nothing else changes: the
 * item keeps its status, canonical file, pipeline_version and visibility, so it is still listed
 * as outdated and "Redo them" can try again.
 */
export function failRedo(id: string, detail: string): boolean {
	return (
		stmt(
			`UPDATE media SET redo_state = NULL, redo_queued_ms = NULL, redo_error = ?
			 WHERE id = ? AND redo_state IS NOT NULL`
		).run(detail.slice(0, 8000), id).changes > 0
	);
}

export interface RedoSummary {
	/** Waiting or in a lane. */
	pending: number;
	/** Not trashed items whose last redo didn't work (they still show their old version). */
	problems: Pick<MediaRow, 'id' | 'kind' | 'source_name' | 'album_id' | 'redo_error'>[];
	problemCount: number;
}

/** For the admin page: redos still to do, and the ones that didn't work (at most `limit`). */
export function redoSummary(opts: { limit?: number } = {}): RedoSummary {
	const pending = (stmt(`SELECT COUNT(*) AS n FROM media WHERE redo_state IS NOT NULL`).get() as { n: number }).n;
	const problemCount = (
		stmt(`SELECT COUNT(*) AS n FROM media WHERE redo_error IS NOT NULL AND redo_state IS NULL AND deleted_at IS NULL`).get() as {
			n: number;
		}
	).n;
	const problems = stmt(
		`SELECT id, kind, source_name, album_id, redo_error FROM media
		 WHERE redo_error IS NOT NULL AND redo_state IS NULL AND deleted_at IS NULL
		 ORDER BY id DESC LIMIT ?`
	).all(Math.max(1, Math.floor(opts.limit ?? 20))) as RedoSummary['problems'];
	return { pending, problems, problemCount };
}

/**
 * Startup recovery: rows left in `processing` by a crash go back to `queued`, or to
 * failed/retryable once they've used MAX_ATTEMPTS. Redos a lane was running go back to waiting,
 * or end (failRedo, the item untouched) once they've used MAX_ATTEMPTS.
 */
export function requeueInterrupted(maxAttempts: number = MAX_ATTEMPTS): { requeued: string[]; failed: string[] } {
	return tx(() => {
		const rows = stmt(`SELECT id, attempts FROM media WHERE ${IN_QUEUE} AND status = 'processing'`).all() as {
			id: string;
			attempts: number;
		}[];
		const requeued: string[] = [];
		const failed: string[] = [];
		for (const r of rows) {
			if (r.attempts >= maxAttempts) {
				markFailed(r.id, 'retryable', `Interrupted ${r.attempts} times (worker crash or restart)`);
				failed.push(r.id);
			} else {
				requeue(r.id, 'Interrupted by a restart; re-queued');
				requeued.push(r.id);
			}
		}
		const redos = stmt(`SELECT id, redo_attempts FROM media WHERE redo_state = 'running'`).all() as {
			id: string;
			redo_attempts: number;
		}[];
		for (const r of redos) {
			if (r.redo_attempts >= maxAttempts) {
				failRedo(r.id, `Interrupted ${r.redo_attempts} times (worker crash or restart)`);
				failed.push(r.id);
			} else {
				requeueRedo(r.id);
				requeued.push(r.id);
			}
		}
		return { requeued, failed };
	});
}

// ---------------------------------------------------------------------------
// Admin: move, trash
// ---------------------------------------------------------------------------

/** A refused move or restore names the item already there as the family sees it (see visibleId()). */
export type MoveResult =
	| { ok: true }
	| { ok: false; reason: 'not_found' | 'album_not_found' }
	| { ok: false; reason: 'duplicate'; conflictId: string };

/** An item and its hidden Live Photo video(s): the rows move/trash/restore act on together. */
function withLivePhotoVideos(row: MediaRow): MediaRow[] {
	return [row, ...(stmt('SELECT * FROM media WHERE live_photo_of = ?').all(row.id) as MediaRow[])];
}

/** The item the family sees for a row: the photo for a hidden Live Photo video, else the row itself. */
function visibleId(row: MediaRow): string {
	return row.live_photo_of ?? row.id;
}

/**
 * The live item in `albumId` that one of `rows`, once live there, would collide with on the
 * media_album_sha index. Duplicate and failed rows are exempt from the index.
 */
function conflictIn(albumId: number, rows: readonly MediaRow[]): MediaRow | undefined {
	for (const r of rows) {
		if (!r.source_sha256 || r.status === 'duplicate' || r.status === 'failed') continue;
		const dup = findDuplicate(albumId, r.source_sha256, r.id);
		if (dup) return dup;
	}
	return undefined;
}

/**
 * Moves an item (and its hidden Live Photo video) to another album. Refused when the same bytes
 * (of the item or of its video) are already live there.
 */
export function move(id: string, albumId: number): MoveResult {
	return tx((): MoveResult => {
		const row = getById(id);
		if (!row) return { ok: false, reason: 'not_found' };
		if (!getAlbum(albumId)) return { ok: false, reason: 'album_not_found' };
		if (row.album_id === albumId) return { ok: true };
		const dup = conflictIn(albumId, withLivePhotoVideos(row).filter((r) => r.deleted_at === null));
		if (dup) return { ok: false, reason: 'duplicate', conflictId: visibleId(dup) };
		const now = Date.now();
		stmt('UPDATE media SET album_id = ?, updated_at = ? WHERE id = ? OR live_photo_of = ?').run(albumId, now, id, id);
		touchAlbum(albumId, now);
		return { ok: true };
	});
}

/** Moves an item (and its Live Photo video) to the trash. */
export function softDelete(id: string, reason: string | null): boolean {
	const now = Date.now();
	// A redo still waiting is dropped (restoring the item leaves it outdated, to be redone again).
	// One a lane is running finishes; the trash purge waits for it (repo/admin trashedBefore).
	return (
		stmt(
			`UPDATE media SET deleted_at = ?, deleted_reason = ?, updated_at = ?,
				redo_queued_ms = CASE WHEN redo_state = 'queued' THEN NULL ELSE redo_queued_ms END,
				redo_state = CASE WHEN redo_state = 'queued' THEN NULL ELSE redo_state END
			 WHERE (id = ? OR live_photo_of = ?) AND deleted_at IS NULL`
		).run(now, reason, now, id, id).changes > 0
	);
}

export type RestoreResult =
	| { ok: true }
	| { ok: false; reason: 'not_found' }
	| { ok: false; reason: 'duplicate'; conflictId: string };

/**
 * Restores a trashed item (and its Live Photo video) unless the same bytes (of the item or of
 * its video) are live in the album again.
 */
export function restore(id: string): RestoreResult {
	return tx((): RestoreResult => {
		const row = getById(id);
		if (!row || row.deleted_at === null) return { ok: false, reason: 'not_found' };
		const dup = conflictIn(row.album_id, withLivePhotoVideos(row).filter((r) => r.deleted_at !== null));
		if (dup) return { ok: false, reason: 'duplicate', conflictId: visibleId(dup) };
		stmt(
			`UPDATE media SET deleted_at = NULL, deleted_reason = NULL, updated_at = ?
			 WHERE (id = ? OR live_photo_of = ?) AND deleted_at IS NOT NULL`
		).run(Date.now(), id, id);
		return { ok: true };
	});
}

/**
 * Every ready item (trashed ones too: the admin's trash shows their tiles), newest first. The queue
 * looks for the ones whose previews are missing from cache/ and rebuilds them from library/
 * (queue.queueMissingPreviews).
 */
export function listReadyForPreviews(): { id: string; kind: Kind }[] {
	return stmt(
		`SELECT id, kind FROM media WHERE status = 'ready' AND kind IS NOT NULL AND canonical_ext IS NOT NULL ORDER BY id DESC`
	).all() as { id: string; kind: Kind }[];
}

/** Trashed items (not their hidden Live Photo videos), most recently trashed first. */
export function listTrash(): MediaRow[] {
	return stmt(
		`SELECT * FROM media WHERE deleted_at IS NOT NULL AND live_photo_of IS NULL ORDER BY deleted_at DESC`
	).all() as MediaRow[];
}

/**
 * Deletes `duplicate` rows that became duplicates more than `ms` ago (by updated_at) and returns
 * them. Most have no files left, but one that came from retry() may still have an archived
 * original (source_kept = 1 → sourcePath(row)) or an .incoming upload; the caller deletes those.
 */
export function purgeDuplicatesOlderThan(ms: number, now: number = Date.now()): MediaRow[] {
	return tx(() => {
		const rows = stmt(`SELECT * FROM media WHERE status = 'duplicate' AND updated_at < ?`).all(now - ms) as MediaRow[];
		if (rows.length > 0) {
			stmt('DELETE FROM media WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(rows.map((r) => r.id)));
		}
		return rows;
	});
}

export interface StorageTotals {
	/** Bytes of canonical files in library/ (including trashed items not yet purged). */
	canonicalBytes: number;
	/** Bytes of archived sources in originals/. */
	originalsBytes: number;
	originalsCount: number;
	readyCount: number;
	photoCount: number;
	videoCount: number;
	trashCount: number;
	failedCount: number;
	pendingCount: number;
}

export function storageTotals(): StorageTotals {
	const r = stmt(
		`SELECT
			COALESCE(SUM(CASE WHEN status = 'ready' THEN canonical_size END), 0) AS canonicalBytes,
			COALESCE(SUM(CASE WHEN source_kept = 1 THEN source_size END), 0) AS originalsBytes,
			COALESCE(SUM(source_kept = 1), 0) AS originalsCount,
			COALESCE(SUM(status = 'ready' AND deleted_at IS NULL AND live_photo_of IS NULL), 0) AS readyCount,
			COALESCE(SUM(status = 'ready' AND deleted_at IS NULL AND live_photo_of IS NULL AND kind = 'photo'), 0) AS photoCount,
			COALESCE(SUM(status = 'ready' AND deleted_at IS NULL AND live_photo_of IS NULL AND kind = 'video'), 0) AS videoCount,
			COALESCE(SUM(deleted_at IS NOT NULL AND live_photo_of IS NULL), 0) AS trashCount,
			COALESCE(SUM(status = 'failed' AND deleted_at IS NULL), 0) AS failedCount,
			COALESCE(SUM(status IN ('received','queued','processing') AND deleted_at IS NULL), 0) AS pendingCount
		 FROM media`
	).get() as StorageTotals;
	return r;
}

/** Items whose archived original exists (admin "Delete all archived originals"). */
export function listKeptOriginals(): Pick<MediaRow, 'id' | 'source_ext' | 'source_size' | 'status' | 'redo_state'>[] {
	return stmt(
		`SELECT id, source_ext, source_size, status, redo_state FROM media WHERE source_kept = 1`
	).all() as Pick<MediaRow, 'id' | 'source_ext' | 'source_size' | 'status' | 'redo_state'>[];
}

/** An archived original "Delete all archived originals" may delete: its item is ready and not being redone from it. */
export function originalDeletable(row: Pick<MediaRow, 'status' | 'redo_state'>): boolean {
	return row.status === 'ready' && row.redo_state === null;
}

/** After the archived original was deleted from disk. */
export function markOriginalDeleted(id: string): void {
	stmt('UPDATE media SET source_kept = 0, updated_at = ? WHERE id = ?').run(Date.now(), id);
}
