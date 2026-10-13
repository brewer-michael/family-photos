import type { RequestHandler } from './$types';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import { cacheFile, libraryPath } from '#lib/server/paths';
import { serveFile } from '#lib/server/serve';
import { contentDisposition, downloadName } from '#lib/server/filenames';
import { CANONICAL_MIME, isMediaId, type Variant } from '#lib/shared/media-types';

const VARIANTS: ReadonlySet<string> = new Set<Variant>(['thumb', 'display', 'poster', 'file']);
/** URLs carry ?v=<pipeline_version>, so a ready item's files never change under the same URL. */
const IMMUTABLE = 'private, max-age=31536000, immutable';

const notFound = () =>
	new Response('Not found', {
		status: 404,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
	});

/**
 * /media/<id>/<thumb|display|poster|file>[?dl=1] for the family (the gate requires access).
 * - thumb/poster: whenever the cache file exists (a video's poster appears while it processes).
 * - display/file: ready items only. `file` is the canonical JPEG/PNG/GIF/MP4, `?dl=1` as an attachment.
 *   A photo whose display.webp is missing (cache/ lost, its previews not rebuilt yet: queue.ts
 *   queueMissingPreviews) gets its canonical file instead, uncached, so the viewer keeps working.
 * - Trashed items, and items of a deleted album: admin only. Anything else is a 404, so ids can't
 *   be probed.
 */
const handler: RequestHandler = async ({ params, request, url, locals }) => {
	const variant = params.variant as Variant;
	if (!isMediaId(params.id) || !VARIANTS.has(variant)) return notFound();
	const row = media.getById(params.id);
	if (!row) return notFound();
	if (locals.role !== 'admin' && (row.deleted_at !== null || !albums.get(row.album_id))) return notFound();
	const ready = row.status === 'ready';

	let path: string;
	let contentType = 'image/webp';
	let disposition: string | null = null;
	if (variant === 'file') {
		if (!ready || !row.canonical_ext) return notFound();
		path = libraryPath(row.id, row.canonical_ext);
		contentType = CANONICAL_MIME[row.canonical_ext];
		disposition = contentDisposition(url.searchParams.get('dl') === '1' ? 'attachment' : 'inline', downloadName(row));
	} else {
		if (variant === 'display' && !ready) return notFound();
		path = cacheFile(row.id, variant);
	}

	const res = await serveFile(request, {
		path,
		contentType,
		etag: `"${row.id}-${row.pipeline_version}-${variant}"`,
		lastModified: row.taken_ms ?? row.created_at,
		cacheControl: ready ? IMMUTABLE : 'private, no-cache',
		disposition
	});
	if (res) return res;
	if (variant === 'display' && ready && row.kind === 'photo' && row.canonical_ext) {
		// The same picture, browser-safe but full size; not cached, so display.webp is used once it is back.
		const canonical = await serveFile(request, {
			path: libraryPath(row.id, row.canonical_ext),
			contentType: CANONICAL_MIME[row.canonical_ext],
			etag: `"${row.id}-${row.pipeline_version}-display-file"`,
			lastModified: row.taken_ms ?? row.created_at,
			cacheControl: 'private, no-cache',
			disposition: null
		});
		if (canonical) return canonical;
	}
	return notFound();
};

export const GET = handler;
export const HEAD = handler;
