import type { PageServerLoad } from './$types';
import * as albums from '#lib/server/repo/albums';

export const load: PageServerLoad = () => {
	return {
		albums: albums.list().map((a) => ({
			id: a.id,
			title: a.title,
			whenText: a.when_text,
			itemCount: a.item_count,
			coverId: a.cover_id
		}))
	};
};
