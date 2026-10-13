import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { checkFamilyCode, issueAccess, safeNext } from '#lib/server/auth';
import { clientKeys, loginLimiter } from '#lib/server/ratelimit';

function afterLogin(name: string | null, next: string): string {
	return name ? next : `/name?next=${encodeURIComponent(next)}`;
}

export const load: PageServerLoad = ({ locals, url }) => {
	const next = safeNext(url.searchParams.get('next'));
	if (locals.role) redirect(303, afterLogin(locals.name, next));
	return { next, joinExpired: url.searchParams.get('error') === 'join' };
};

export const actions: Actions = {
	default: async (event) => {
		const { request, cookies, url, locals } = event;
		const form = await request.formData();
		const next = safeNext(String(form.get('next') ?? ''));
		const code = String(form.get('code') ?? '');

		const keys = clientKeys(event);
		const limit = loginLimiter.check(keys);
		if (limit.limited) {
			const minutes = Math.max(1, Math.ceil(limit.retryAfterS / 60));
			return fail(429, {
				limited: true,
				message: `Too many tries. Please wait ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} and try again.`
			});
		}
		if (code.trim() === '') {
			return fail(400, { limited: false, message: 'Please type the family code.' });
		}
		if (!checkFamilyCode(code)) {
			loginLimiter.fail(keys);
			return fail(400, {
				limited: false,
				message: "That code didn't work. Check the spelling and try again."
			});
		}
		loginLimiter.clear(keys);
		if (locals.role !== 'admin') issueAccess(cookies, url, 'family');
		redirect(303, afterLogin(locals.name, next));
	}
};
