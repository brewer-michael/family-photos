import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { cleanName, issueDevice, newDeviceId, norm, safeNext } from '#lib/server/auth';
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
		// The same person (the name typed again, in any case or spacing) keeps this device's id. Anyone
		// else ("Not Jo?" on a shared phone or tablet) gets a new one, so they don't take over the last
		// person's memories, removal requests, albums and unfinished uploads, which go by device id.
		const samePerson = locals.name !== null && norm(locals.name) === norm(name);
		issueDevice(cookies, url, { d: (samePerson ? locals.deviceId : null) ?? newDeviceId(), n: name });
		redirect(303, next);
	}
};
