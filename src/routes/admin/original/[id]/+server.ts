import type { RequestHandler } from './$types';
import * as media from '#lib/server/repo/media';
import { serveFile } from '#lib/server/serve';
import { contentDisposition } from '#lib/server/filenames';
import { isMediaId } from '#lib/shared/media-types';

const plain = (status: number, message: string) =>
	new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

/**
 * /admin/original/<id>: the uploaded source exactly as it arrived (docs/media-pipeline.md §4), for
 * the admin only. Always an attachment of type application/octet-stream under its uploaded name,
 * with `Content-Security-Policy: sandbox`, so whatever the bytes are they are never rendered or
 * run on this origin. 404 when the source isn't kept (e.g. it became the canonical file).
 */
const handler: RequestHandler = async ({ params, request, locals }) => {
	if (locals.role !== 'admin') return plain(403, 'Admins only');
	const row = isMediaId(params.id) ? media.getById(params.id) : undefined;
	const source = row ? media.sourcePath(row) : null;
	if (!row || !source) return plain(404, 'There is no original file for this item.');
	const res = await serveFile(request, {
		path: source,
		contentType: 'application/octet-stream',
		etag: `"${row.id}-original"`,
		lastModified: row.created_at,
		cacheControl: 'private, no-store',
		disposition: contentDisposition('attachment', row.source_name)
	});
	if (!res) return plain(404, 'There is no original file for this item.');
	res.headers.set('content-security-policy', 'sandbox');
	return res;
};

export const GET = handler;
export const HEAD = handler;
