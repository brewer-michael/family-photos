import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { issueAccess, verifyJoinToken } from '#lib/server/auth';

/**
 * QR landing: /join/<token>[?album=<id>] → sets fp_access, then /name or the target (token stripped).
 * An old card (after "Reset access") goes to the family code page, which still carries on to the album.
 */
export const GET: RequestHandler = ({ params, url, cookies, locals }) => {
	const album = url.searchParams.get('album');
	const target = album && /^[1-9]\d{0,9}$/.test(album) ? `/album/${album}` : '/';
	if (!verifyJoinToken(params.token)) {
		redirect(303, target === '/' ? '/login?error=join' : `/login?error=join&next=${encodeURIComponent(target)}`);
	}
	if (locals.role !== 'admin') issueAccess(cookies, url, 'family');
	redirect(303, locals.name ? target : `/name?next=${encodeURIComponent(target)}`);
};
