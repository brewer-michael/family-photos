/**
 * Media vocabulary shared by the browser, the web server and the worker lanes.
 * Keep this file free of Node-only imports: it is bundled into client code.
 */

export type Kind = 'photo' | 'video';

export type Status = 'received' | 'queued' | 'processing' | 'ready' | 'failed' | 'duplicate';

/** Same codes as the `media.error_code` CHECK constraint and `MediaError.code`. */
export type ErrorCode = 'retryable' | 'unsupported' | 'corrupt' | 'too_large';

export type Conversion = 'none' | 'remux' | 'transcode';

export type CanonicalExt = 'jpg' | 'png' | 'gif' | 'mp4';

/** Files under /config/cache/<sh>/<id>/<variant>.webp */
export type CacheVariant = 'thumb' | 'display' | 'poster';

/** Variants served by /media/[id]/[variant]; `file` is the canonical file. */
export type Variant = CacheVariant | 'file';

export const KINDS: readonly Kind[] = ['photo', 'video'];
export const STATUSES: readonly Status[] = [
	'received',
	'queued',
	'processing',
	'ready',
	'failed',
	'duplicate'
];
export const ERROR_CODES: readonly ErrorCode[] = ['retryable', 'unsupported', 'corrupt', 'too_large'];
export const CANONICAL_EXTS: readonly CanonicalExt[] = ['jpg', 'png', 'gif', 'mp4'];
export const CACHE_VARIANTS: readonly CacheVariant[] = ['thumb', 'display', 'poster'];

export const CANONICAL_MIME: Readonly<Record<CanonicalExt, string>> = {
	jpg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	mp4: 'video/mp4'
};

/**
 * Bump when the photo/video pipeline output changes in a way that warrants
 * "Reprocess items below pipeline version N". Stored in media.pipeline_version
 * by markReady() and used in ETags ("<id>-<pipeline_version>").
 */
export const PIPELINE_VERSION = 1;

/** A job that has been claimed this many times without success is failed. */
export const MAX_ATTEMPTS = 3;

/** Statuses that still need work (shown as unfinished tiles to the uploader/admin). */
export const UNFINISHED_STATUSES: readonly Status[] = ['received', 'queued', 'processing'];

/** Response row for GET /api/status?ids=… */
export interface MediaStatusDTO {
	id: string;
	status: Status;
	kind?: Kind | null;
	/** 0–99 while a video is processing. */
	pct?: number;
	/** Rough seconds remaining while processing, when known. */
	etaS?: number;
	/** Number of items ahead in the lane while queued (0 = next). */
	queuePos?: number;
	/** URL of poster/thumb once one exists (videos get it before they are ready). */
	posterUrl?: string;
	/** Media id of the existing item when status is `duplicate`. */
	duplicateOf?: string;
	/** Set when status is `failed`: decides "Try again" vs "We couldn't add this one". */
	errorCode?: ErrorCode;
}

export function isKind(v: unknown): v is Kind {
	return v === 'photo' || v === 'video';
}

export function isStatus(v: unknown): v is Status {
	return typeof v === 'string' && (STATUSES as readonly string[]).includes(v);
}

export function isErrorCode(v: unknown): v is ErrorCode {
	return typeof v === 'string' && (ERROR_CODES as readonly string[]).includes(v);
}

export function isCanonicalExt(v: unknown): v is CanonicalExt {
	return typeof v === 'string' && (CANONICAL_EXTS as readonly string[]).includes(v);
}

/** ULID: 26 chars of Crockford base32 (no I, L, O, U). Media ids are always ULIDs. */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isMediaId(v: unknown): v is string {
	return typeof v === 'string' && ULID_RE.test(v);
}

/** Removal-request reason chips (the dialog copy lives in the UI). */
export type RemovalReason = 'in_it' | 'blurry_or_duplicate' | 'wrong_album' | 'other';
export const REMOVAL_REASONS: readonly RemovalReason[] = [
	'in_it',
	'blurry_or_duplicate',
	'wrong_album',
	'other'
];
export const REMOVAL_REASON_LABELS: Readonly<Record<RemovalReason, string>> = {
	in_it: "I'm in it and don't want it shared",
	blurry_or_duplicate: 'Blurry or duplicate',
	wrong_album: 'Wrong album',
	other: 'Something else'
};

export type RequestStatus = 'pending' | 'approved' | 'dismissed';
export type EmailStatus = 'pending' | 'sent' | 'saved' | 'failed';
