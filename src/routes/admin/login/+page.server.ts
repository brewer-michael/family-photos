import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { checkAdminPassword, issueAccess, safeNext } from '#lib/server/auth';
import { adminLimiter, signInSubject } from '#lib/server/ratelimit';

function afterLogin(name: string | null, next: string): string {
	return name ? next : `/name?next=${encodeURIComponent(next)}`;
}

export const load: PageServerLoad = ({ locals, url }) => {
	const next = safeNext(url.searchParams.get('next'), '/admin');
	if (locals.role === 'admin') redirect(303, afterLogin(locals.name, next));
	return { next };
};

export const actions: Actions = {
	default: async (event) => {
		const { request, cookies, url, locals } = event;
		// The limit first: a limited client's body isn't even read.
		const keys = signInSubject(event);
		const limit = adminLimiter.check(keys);
		if (limit.limited) {
			const minutes = Math.max(1, Math.ceil(limit.retryAfterS / 60));
			return fail(429, {
				message: `Too many tries. Please wait ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} and try again.`
			});
		}
		const form = await request.formData();
		const next = safeNext(String(form.get('next') ?? ''), '/admin');
		const password = String(form.get('password') ?? '');
		if (!checkAdminPassword(password)) {
			adminLimiter.fail(keys);
			return fail(400, { message: "That password didn't work." });
		}
		adminLimiter.clear(keys);
		issueAccess(cookies, url, 'admin');
		redirect(303, afterLogin(locals.name, next));
	}
};
