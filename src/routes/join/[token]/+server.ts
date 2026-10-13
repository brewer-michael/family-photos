import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { issueAccess, verifyJoinToken } from '#lib/server/auth';

/** QR landing: /join/<token>[?album=<id>] → sets fp_access, then /name or the target (token stripped). */
export const GET: RequestHandler = ({ params, url, cookies, locals }) => {
	if (!verifyJoinToken(params.token)) redirect(303, '/login?error=join');
	if (locals.role !== 'admin') issueAccess(cookies, url, 'family');
	const album = url.searchParams.get('album');
	const target = album && /^[1-9]\d{0,9}$/.test(album) ? `/album/${album}` : '/';
	redirect(303, locals.name ? target : `/name?next=${encodeURIComponent(target)}`);
};
