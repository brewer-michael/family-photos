import type { RequestHandler } from './$types';
import { getDb } from '#lib/server/db';

/** Container HEALTHCHECK: DB ping. */
export const GET: RequestHandler = () => {
	try {
		getDb().prepare('SELECT 1').get();
		return new Response('ok', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
	} catch (e) {
		console.error('[healthz]', e);
		return new Response('db unavailable', { status: 503, headers: { 'cache-control': 'no-store' } });
	}
};
