import type { LayoutServerLoad } from './$types';
import { getConfig } from '#lib/server/config';

export const load: LayoutServerLoad = ({ locals }) => {
	const c = getConfig();
	return {
		siteTitle: c.siteTitle,
		adminName: c.adminName,
		role: locals.role,
		name: locals.name
	};
};
