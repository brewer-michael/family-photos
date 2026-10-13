/** Removal ("deletion") requests. Stored first, emailed asynchronously; admin approves/dismisses via POST. */
import { stmt, tx } from '#lib/server/db';
import { ValidationError } from '#lib/shared/errors';
import {
	REMOVAL_REASONS,
	type EmailStatus,
	type Kind,
	type RemovalReason,
	type RequestStatus
} from '#lib/shared/media-types';

export interface RemovalRequestRow {
	id: number;
	media_id: string;
	requester_name: string;
	requester_device: string;
	reason: RemovalReason;
	details: string | null;
	status: RequestStatus;
	resolved_action: 'removed' | 'moved' | null;
	email_status: EmailStatus;
	email_error: string | null;
	created_at: number;
	updated_at: number;
	resolved_at: number | null;
}

/** Request joined with what the admin page/email needs about the item and album. */
export interface RemovalRequestDetail extends RemovalRequestRow {
	media_kind: Kind | null;
	media_status: string;
	media_deleted_at: number | null;
	source_name: string;
	uploaded_by_name: string;
	album_id: number;
	album_title: string;
}

export interface CreateRequestInput {
	mediaId: string;
	requesterName: string;
	requesterDevice: string;
	reason: RemovalReason;
	/** Required when reason is 'other'. */
	details?: string | null;
}

function cleanDetails(reason: RemovalReason, details: string | null | undefined): string | null {
	const t = (details ?? '')
		.normalize('NFC')
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
		.trim();
	if (t.length > 2000) throw new ValidationError('Please keep it under 2000 characters.', 'details');
	if (reason === 'other' && t.length === 0) throw new ValidationError('Please tell us a little about why.', 'details');
	return t === '' ? null : t;
}

/**
 * Creates a pending request. If this device already has a pending request for the item,
 * returns that one with created=false (one pending request per device per item).
 */
export function create(input: CreateRequestInput): { request: RemovalRequestRow; created: boolean } {
	if (!REMOVAL_REASONS.includes(input.reason)) throw new ValidationError('Please pick a reason.', 'reason');
	const details = cleanDetails(input.reason, input.details);
	return tx(() => {
		const existing = stmt(
			`SELECT * FROM deletion_requests WHERE media_id = ? AND requester_device = ? AND status = 'pending'`
		).get(input.mediaId, input.requesterDevice) as RemovalRequestRow | undefined;
		if (existing) return { request: existing, created: false };
		const now = Date.now();
		const r = stmt(
			`INSERT INTO deletion_requests(media_id, requester_name, requester_device, reason, details,
				status, email_status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'pending', 'pending', ?, ?)`
		).run(input.mediaId, input.requesterName, input.requesterDevice, input.reason, details, now, now);
		return { request: get(Number(r.lastInsertRowid))!, created: true };
	});
}

export function get(id: number): RemovalRequestRow | undefined {
	return stmt('SELECT * FROM deletion_requests WHERE id = ?').get(id) as RemovalRequestRow | undefined;
}

const DETAIL_SQL = `
	SELECT r.*, m.kind AS media_kind, m.status AS media_status, m.deleted_at AS media_deleted_at,
		m.source_name, m.uploaded_by_name, m.album_id, a.title AS album_title
	FROM deletion_requests r
	JOIN media m ON m.id = r.media_id
	JOIN albums a ON a.id = m.album_id`;

export function getDetail(id: number): RemovalRequestDetail | undefined {
	return stmt(`${DETAIL_SQL} WHERE r.id = ?`).get(id) as RemovalRequestDetail | undefined;
}

/** Pending requests, oldest first. */
export function listPending(): RemovalRequestDetail[] {
	return stmt(`${DETAIL_SQL} WHERE r.status = 'pending' ORDER BY r.created_at ASC, r.id ASC`).all() as RemovalRequestDetail[];
}

/** Recently resolved requests (admin history). */
export function listResolved(opts: { limit?: number } = {}): RemovalRequestDetail[] {
	return stmt(
		`${DETAIL_SQL} WHERE r.status <> 'pending' ORDER BY r.resolved_at DESC, r.id DESC LIMIT ?`
	).all(Math.max(1, Math.floor(opts.limit ?? 50))) as RemovalRequestDetail[];
}

export function countPending(): number {
	return (stmt(`SELECT COUNT(*) AS n FROM deletion_requests WHERE status = 'pending'`).get() as { n: number }).n;
}

/** Requests whose email still needs sending (pending) or failed (admin "Resend"). */
export function listEmailUnsent(): RemovalRequestRow[] {
	return stmt(
		`SELECT * FROM deletion_requests WHERE email_status IN ('pending','failed') ORDER BY created_at ASC`
	).all() as RemovalRequestRow[];
}

export function setEmailStatus(id: number, status: EmailStatus, error?: string | null): void {
	stmt('UPDATE deletion_requests SET email_status = ?, email_error = ?, updated_at = ? WHERE id = ?').run(
		status,
		error ? error.slice(0, 2000) : null,
		Date.now(),
		id
	);
}

/**
 * pending → approved|dismissed. `action` records what approval did ('removed' to trash or
 * 'moved' to another album). Returns false if it wasn't pending.
 */
export function resolve(
	id: number,
	status: 'approved' | 'dismissed',
	action: 'removed' | 'moved' | null = null
): boolean {
	const now = Date.now();
	return (
		stmt(
			`UPDATE deletion_requests SET status = ?, resolved_action = ?, resolved_at = ?, updated_at = ?
			 WHERE id = ? AND status = 'pending'`
		).run(status, status === 'approved' ? action : null, now, now, id).changes > 0
	);
}

/** Resolves every other pending request for the same item (after it was removed). Returns the count. */
export function resolveAllForMedia(mediaId: string, status: 'approved' | 'dismissed', action: 'removed' | 'moved' | null = null): number {
	const now = Date.now();
	return stmt(
		`UPDATE deletion_requests SET status = ?, resolved_action = ?, resolved_at = ?, updated_at = ?
		 WHERE media_id = ? AND status = 'pending'`
	).run(status, status === 'approved' ? action : null, now, now, mediaId).changes;
}

export function hasPendingFor(mediaId: string, device: string): boolean {
	return !!stmt(
		`SELECT 1 FROM deletion_requests WHERE media_id = ? AND requester_device = ? AND status = 'pending'`
	).get(mediaId, device);
}
