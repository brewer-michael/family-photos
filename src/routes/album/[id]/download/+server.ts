import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import * as albums from '#lib/server/repo/albums';
import { contentDisposition } from '#lib/server/filenames';
import { planAlbumZip, streamZip, zipFileName } from '#lib/server/zip';
import { parseAlbumId } from '#lib/server/repo/ui';

/** "Download all (for computers)": the album's canonical files as a streamed ZIP + memories.txt. */
export const GET: RequestHandler = async ({ params, request }) => {
	const album = albums.get(parseAlbumId(params.id));
	if (!album) error(404, "We couldn't find that album.");
	const plan = await planAlbumZip(album);
	return new Response(streamZip(plan, request.signal), {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': contentDisposition('attachment', zipFileName(album)),
			'cache-control': 'private, no-store',
			'x-content-type-options': 'nosniff'
		}
	});
};
