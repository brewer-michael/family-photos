import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';

/** Minimal album page; the UI track replaces it. */
export const load: PageServerLoad = ({ params }) => {
	const id = /^\d{1,10}$/.test(params.id) ? Number(params.id) : NaN;
	const album = albums.getSummary(id);
	if (!album) error(404, { message: "We couldn't find that album." });
	const page = media.listByAlbum(album.id, { limit: 60 });
	return {
		album: { id: album.id, title: album.title, whenText: album.when_text, itemCount: album.item_count },
		items: page.items.map((m) => ({ id: m.id, kind: m.kind })),
		next: page.next ? media.encodeCursor(page.next) : null
	};
};
