import type { PageServerLoad } from './$types';
import { getConfig, publicOrigin } from '#lib/server/config';
import { requireAdmin } from '#lib/server/admin';
import { qrCards } from '#lib/server/qr';

export const load: PageServerLoad = async ({ locals, url }) => {
	requireAdmin(locals);
	const cards = await qrCards(getConfig().siteTitle);
	return {
		cards: cards.map(({ albumId, title, whenText, svg }) => ({ albumId, title, whenText, svg })),
		siteAddress: new URL(publicOrigin()).host,
		grid: url.searchParams.get('layout') === 'grid'
	};
};
