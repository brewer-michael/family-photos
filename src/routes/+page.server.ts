import type { PageServerLoad } from './$types';
import * as media from '#lib/server/repo/media';
import { albumCards, toTile } from '#lib/server/repo/ui';

const NEW_PHOTOS = 18;

export const load: PageServerLoad = () => {
	return {
		recent: media.listRecent({ limit: NEW_PHOTOS }).map(toTile),
		albums: albumCards()
	};
};
