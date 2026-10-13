import type { PageServerLoad } from './$types';
import { getConfig } from '#lib/server/config';
import * as requests from '#lib/server/repo/requests';

/** Minimal admin page; the admin track replaces it. (The /admin gate is in hooks.server.ts.) */
export const load: PageServerLoad = () => {
	return {
		warnings: getConfig().warnings,
		pendingRequests: requests.countPending()
	};
};
