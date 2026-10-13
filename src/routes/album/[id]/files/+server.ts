import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import * as albums from '#lib/server/repo/albums';
import { parseAlbumId, saveTargets } from '#lib/server/repo/ui';

/** "Save all" on phones: every file of the album, oldest first, with unique names. */
export const GET: RequestHandler = ({ params }) => {
	const album = albums.get(parseAlbumId(params.id));
	if (!album) error(404, { message: "We couldn't find that album." });
	return json(saveTargets(album.id), { headers: { 'cache-control': 'private, no-store' } });
};
