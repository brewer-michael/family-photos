/**
 * Plain-JSON shapes the server sends to pages and components, and the media URL builder.
 * Built by #lib/server/repo/ui; safe to import from the browser (types and pure functions only).
 */
import type { ErrorCode, Kind, Status, Variant } from '#lib/shared/media-types';

/**
 * /media/<id>/<variant>[?v=<pipeline version>][&dl=1]. The version busts the year-long immutable
 * cache when the admin reprocesses an item.
 */
export function mediaUrl(id: string, variant: Variant, opts: { v?: number; download?: boolean } = {}): string {
	const q = new URLSearchParams();
	if (opts.v) q.set('v', String(opts.v));
	if (opts.download) q.set('dl', '1');
	const s = q.toString();
	return `/media/${id}/${variant}${s ? `?${s}` : ''}`;
}

/** One square tile in a grid or the "New photos" strip. */
export interface TileDTO {
	id: string;
	kind: Kind;
	thumbUrl: string;
	durationMs: number | null;
	takenAt: string | null;
	takenMs: number | null;
	by: string;
}

export interface AlbumCardDTO {
	id: number;
	title: string;
	whenText: string | null;
	photoCount: number;
	videoCount: number;
	coverUrl: string | null;
}

/** An upload of this device (or any device, for the admin) that isn't in the grid yet. */
export interface PendingDTO {
	id: string;
	kind: Kind | null;
	status: Status;
	errorCode: ErrorCode | null;
	/** The uploaded name without its extension ("beach"); may be empty. */
	name: string;
	posterUrl: string | null;
}

/** The item on /view/[id]. */
export interface ViewItemDTO {
	id: string;
	kind: Kind;
	/** Photos: display.webp, or the canonical file when animated (GIF/APNG). Videos: the canonical MP4. */
	src: string;
	/** Videos: the poster; photos: the thumbnail, shown while the big image loads. */
	placeholderUrl: string;
	width: number | null;
	height: number | null;
	durationMs: number | null;
	takenAt: string | null;
	takenMs: number | null;
	by: string;
}

/** Everything "Save to my phone" needs about one file. */
export interface SaveTargetDTO {
	id: string;
	kind: Kind;
	/** Canonical file (inline). */
	url: string;
	/** Canonical file as an attachment (?dl=1). */
	downloadUrl: string;
	name: string;
	type: string;
	size: number | null;
	takenMs: number | null;
}

export interface MemoryDTO {
	id: number;
	authorName: string;
	body: string;
	createdAt: number;
	edited: boolean;
	/** Written on this device: may edit and delete. */
	mine: boolean;
	/** Mine, or the viewer is the admin. */
	canDelete: boolean;
}
