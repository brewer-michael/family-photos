import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { cleanName, issueDevice, newDeviceId, safeNext } from '#lib/server/auth';
import { ValidationError } from '#lib/shared/errors';

export const load: PageServerLoad = ({ locals, url }) => {
	return { currentName: locals.name, next: safeNext(url.searchParams.get('next')) };
};

export const actions: Actions = {
	default: async ({ request, cookies, url, locals }) => {
		const form = await request.formData();
		const next = safeNext(String(form.get('next') ?? ''));
		let name: string;
		try {
			name = cleanName(String(form.get('name') ?? ''));
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: e.message });
			throw e;
		}
		issueDevice(cookies, url, { d: locals.deviceId ?? newDeviceId(), n: name });
		redirect(303, next);
	}
};
