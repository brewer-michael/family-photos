import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import { ALBUM_PAGE_SIZE, parseAlbumId, toTile } from '#lib/server/repo/ui';

/** "Show more": the next page of tiles after `?before=<cursor>` → { items, next }. */
export const GET: RequestHandler = ({ params, url }) => {
	const album = albums.get(parseAlbumId(params.id));
	if (!album) error(404, { message: "We couldn't find that album." });
	const before = media.decodeCursor(url.searchParams.get('before'));
	if (!before) error(400, { message: 'Missing or invalid cursor.' });
	const page = media.listByAlbum(album.id, { limit: ALBUM_PAGE_SIZE, before });
	return json(
		{ items: page.items.map(toTile), next: page.next ? media.encodeCursor(page.next) : null },
		{ headers: { 'cache-control': 'private, no-store' } }
	);
};
