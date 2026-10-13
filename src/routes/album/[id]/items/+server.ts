import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import { ALBUM_PAGE_SIZE, parseAlbumId, toTile } from '#lib/server/repo/ui';

/** Most tiles one request returns (a refresh reloads every page fetched by "Show more" at once). */
const MAX_LIMIT = 500;

/** "Show more": the tiles after `?before=<cursor>` (`&limit=`, default one page) → { items, next }. */
export const GET: RequestHandler = ({ params, url }) => {
	const album = albums.get(parseAlbumId(params.id));
	if (!album) error(404, "We couldn't find that album.");
	const before = media.decodeCursor(url.searchParams.get('before'));
	if (!before) error(400, 'Missing or invalid cursor.');
	const asked = Number(url.searchParams.get('limit') ?? ALBUM_PAGE_SIZE);
	const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_LIMIT) : ALBUM_PAGE_SIZE;
	const page = media.listByAlbum(album.id, { limit, before });
	return json(
		{ items: page.items.map(toTile), next: page.next ? media.encodeCursor(page.next) : null },
		{ headers: { 'cache-control': 'private, no-store' } }
	);
};
