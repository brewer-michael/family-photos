import type { LayoutServerLoad } from './$types';
import { getConfig } from '#lib/server/config';

/** The server's time zone (Unraid sets TZ): dates render the same on the server and in browsers. */
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const load: LayoutServerLoad = ({ locals }) => {
	const c = getConfig();
	return {
		siteTitle: c.siteTitle,
		adminName: c.adminName,
		role: locals.role,
		name: locals.name,
		timeZone
	};
};
