import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { issueAccess } from '#lib/server/auth';

/** Drops admin rights but keeps family access. POST only (CSRF-checked form). */
export const POST: RequestHandler = ({ cookies, url }) => {
	issueAccess(cookies, url, 'family');
	redirect(303, '/');
};
