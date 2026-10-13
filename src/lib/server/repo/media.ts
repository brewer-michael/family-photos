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
 *   queue (main)       ─ on failure: requeue() or markFailed()
 *                        Both only act on unfinished rows and return false otherwise: a job that
 *                        committed markReady() and then failed (cleanup error, timeout, crash) is
 *                        a success, and the main process must leave the ready row alone.
 *   startup            ─ requeueInterrupted()
 *
 * upload_token: kept while the source still lives in .incoming/<token> (received, queued,
 * processing, failed) and cleared by markReady()/markDuplicate(), i.e. once the pipeline has
 * consumed the upload. Use sourcePath() to locate an item's source file.
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
}

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
 * Where the item's source bytes are right now: the archived original if kept,
 * else the tus upload in .incoming/<token>; null when the source is gone
 * (e.g. conversion 'none': the source became the canonical file).
 */
export function sourcePath(row: Pick<MediaRow, 'id' | 'upload_token' | 'source_kept' | 'source_ext'>): string | null {
	if (row.source_kept && row.source_ext) return originalsPath(row.id, row.source_ext);
	if (row.upload_token) return incomingPath(row.upload_token);
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

/** Received rows waiting for intake, oldest first. */
export function listReceived(opts: { limit?: number } = {}): MediaRow[] {
	return stmt(
		`SELECT * FROM media WHERE status = 'received' ORDER BY created_at ASC, id ASC LIMIT ?`
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
			`SELECT * FROM media WHERE status = 'queued' AND kind = 'photo' AND deleted_at IS NULL
			 ORDER BY ${PHOTO_ORDER} LIMIT 1`
		).get() as MediaRow | undefined;
	}
	return stmt(
		`SELECT * FROM media WHERE status = 'queued' AND kind = 'video' AND deleted_at IS NULL
		 ORDER BY ${VIDEO_ORDER} LIMIT 1`
	).get(now, now) as MediaRow | undefined;
}

/** Queued ids of a lane in the order nextQueued() would take them (for "2 ahead"). */
export function queueOrder(kind: Kind, now: number = Date.now()): string[] {
	const rows = (
		kind === 'photo'
			? stmt(
					`SELECT id FROM media WHERE status = 'queued' AND kind = 'photo' AND deleted_at IS NULL
					 ORDER BY ${PHOTO_ORDER}`
				).all()
			: stmt(
					`SELECT id FROM media WHERE status = 'queued' AND kind = 'video' AND deleted_at IS NULL
					 ORDER BY ${VIDEO_ORDER}`
				).all(now, now)
	) as { id: string }[];
	return rows.map((r) => r.id);
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
 * into library/). Clears the upload token and error, touches the album, and pairs
 * Live Photos. A takenMs that isn't a valid epoch time (NaN, ±Infinity, beyond what a Date
 * can hold) falls back to the row's created_at, so a ready row always has its sort key.
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
				upload_token = NULL, error_code = NULL, error_detail = NULL, updated_at = ?
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
 * Live Photo pairing for a ready item: a video ≤ 4.5 s whose content_id matches a
 * ready photo's in the same album gets live_photo_of = photo.id (order-independent).
 * Returns the photo id it linked to/from, or null.
 */
export function pairLivePhoto(id: string): string | null {
	const row = getById(id);
	if (!row || row.status !== 'ready' || !row.content_id || row.deleted_at !== null) return null;
	if (row.kind === 'video') {
		if (row.duration_ms === null || row.duration_ms > LIVE_PHOTO_MAX_MS) return null;
		const photo = stmt(
			`SELECT id FROM media WHERE album_id = ? AND content_id = ? AND kind = 'photo'
			   AND status = 'ready' AND deleted_at IS NULL ORDER BY created_at LIMIT 1`
		).get(row.album_id, row.content_id) as { id: string } | undefined;
		if (!photo) return null;
		stmt('UPDATE media SET live_photo_of = ?, updated_at = ? WHERE id = ?').run(photo.id, Date.now(), id);
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

/** processing → queued after a retryable failure (keeps attempts and its queue position). */
export function requeue(id: string, detail?: string): boolean {
	return (
		stmt(
			`UPDATE media SET status = 'queued', error_detail = COALESCE(?, error_detail), updated_at = ?
			 WHERE id = ? AND status = 'processing'`
		).run(detail ?? null, Date.now(), id).changes > 0
	);
}

/**
 * failed → queued (or → received when it failed before detection) with attempts reset:
 * "Try again" / admin retry. Only while the source still exists (upload_token or archived
 * original). If the same bytes became live in the album meanwhile, the row becomes a
 * duplicate instead: its upload token is cleared (the .incoming sweep deletes that file) and an
 * archived original stays recorded (source_kept/source_ext) until purgeDuplicatesOlderThan()
 * hands the row to maintenance, which deletes it. Returns the new status, or null if it can't
 * be retried (including a trashed row).
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
		const status: Status = row.kind ? 'queued' : 'received';
		const now = Date.now();
		stmt(
			`UPDATE media SET status = ?, attempts = 0, error_code = NULL, error_detail = NULL,
				queued_ms = CASE WHEN ? = 'queued' THEN ? ELSE queued_ms END, updated_at = ?
			 WHERE id = ?`
		).run(status, status, now, now, id);
		return status;
	});
}

/**
 * Admin "Reprocess": ready|failed → queued (attempts reset) for an item whose source was archived
 * (source_kept = 1), so the lane re-runs from originals/. The item is hidden from grids until it
 * is ready again; the lane overwrites library/ and cache/ files by atomic rename. Items without
 * an archived original can only have their derivatives rebuilt (not via this function).
 * Returns false when not eligible, including a failed item whose bytes are live in the album
 * again (re-queuing it would create a second live copy).
 */
export function markForReprocess(id: string): boolean {
	return tx(() => {
		const row = getById(id);
		if (!row || (row.status !== 'ready' && row.status !== 'failed')) return false;
		if (row.status === 'failed' && row.source_sha256 && findDuplicate(row.album_id, row.source_sha256, id)) {
			return false;
		}
		const now = Date.now();
		return (
			stmt(
				`UPDATE media SET status = 'queued', attempts = 0, error_code = NULL, error_detail = NULL,
					queued_ms = ?, updated_at = ?
				 WHERE id = ? AND status IN ('ready','failed') AND source_kept = 1 AND source_ext IS NOT NULL
				   AND kind IS NOT NULL AND deleted_at IS NULL`
			).run(now, now, id).changes > 0
		);
	});
}

/**
 * Startup recovery: rows left in `processing` by a crash go back to `queued`, or to
 * failed/retryable once they've used MAX_ATTEMPTS.
 */
export function requeueInterrupted(maxAttempts: number = MAX_ATTEMPTS): { requeued: string[]; failed: string[] } {
	return tx(() => {
		const rows = stmt(`SELECT id, attempts FROM media WHERE status = 'processing'`).all() as {
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
		return { requeued, failed };
	});
}

// ---------------------------------------------------------------------------
// Admin: move, trash, purge
// ---------------------------------------------------------------------------

export type MoveResult =
	| { ok: true }
	| { ok: false; reason: 'not_found' | 'album_not_found' }
	| { ok: false; reason: 'duplicate'; conflictId: string };

/** An item and its hidden Live Photo video(s): the rows move/trash/restore act on together. */
function withLivePhotoVideos(row: MediaRow): MediaRow[] {
	return [row, ...(stmt('SELECT * FROM media WHERE live_photo_of = ?').all(row.id) as MediaRow[])];
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
		if (dup) return { ok: false, reason: 'duplicate', conflictId: dup.id };
		const now = Date.now();
		stmt('UPDATE media SET album_id = ?, updated_at = ? WHERE id = ? OR live_photo_of = ?').run(albumId, now, id, id);
		touchAlbum(albumId, now);
		return { ok: true };
	});
}

/** Moves an item (and its Live Photo video) to the trash. */
export function softDelete(id: string, reason: string | null): boolean {
	const now = Date.now();
	return (
		stmt(
			`UPDATE media SET deleted_at = ?, deleted_reason = ?, updated_at = ?
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
		if (dup) return { ok: false, reason: 'duplicate', conflictId: dup.id };
		stmt(
			`UPDATE media SET deleted_at = NULL, deleted_reason = NULL, updated_at = ?
			 WHERE (id = ? OR live_photo_of = ?) AND deleted_at IS NOT NULL`
		).run(Date.now(), id, id);
		return { ok: true };
	});
}

/** Trashed items (not their hidden Live Photo videos), most recently trashed first. */
export function listTrash(): MediaRow[] {
	return stmt(
		`SELECT * FROM media WHERE deleted_at IS NOT NULL AND live_photo_of IS NULL ORDER BY deleted_at DESC`
	).all() as MediaRow[];
}

/**
 * Permanently deletes rows trashed more than `ms` ago (plus their Live Photo videos) and
 * returns them so the caller can delete library/, originals/ and cache/ files.
 */
export function purgeTrashOlderThan(ms: number, now: number = Date.now()): MediaRow[] {
	const cutoff = now - ms;
	return tx(() => {
		const rows = stmt(
			`SELECT * FROM media
			 WHERE (deleted_at IS NOT NULL AND deleted_at < ?)
			    OR live_photo_of IN (SELECT id FROM media WHERE deleted_at IS NOT NULL AND deleted_at < ?)`
		).all(cutoff, cutoff) as MediaRow[];
		if (rows.length > 0) {
			stmt('DELETE FROM media WHERE id IN (SELECT value FROM json_each(?))').run(
				JSON.stringify(rows.map((r) => r.id))
			);
		}
		return rows;
	});
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
export function listKeptOriginals(): Pick<MediaRow, 'id' | 'source_ext' | 'source_size' | 'status'>[] {
	return stmt(
		`SELECT id, source_ext, source_size, status FROM media WHERE source_kept = 1`
	).all() as Pick<MediaRow, 'id' | 'source_ext' | 'source_size' | 'status'>[];
}

/** After the archived original was deleted from disk. */
export function markOriginalDeleted(id: string): void {
	stmt('UPDATE media SET source_kept = 0, updated_at = ? WHERE id = ?').run(Date.now(), id);
}
