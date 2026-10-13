import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import * as albums from '#lib/server/repo/albums';
import { ValidationError } from '#lib/shared/errors';

const text = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');

export const actions: Actions = {
	/** Anyone can start an album; it opens with the uploader showing. */
	default: async ({ request, locals }) => {
		const form = await request.formData();
		const values = { title: text(form.get('title')), whenText: text(form.get('whenText')), description: text(form.get('description')) };
		let id: number;
		try {
			id = albums.create({ ...values, createdByName: locals.name, createdByDevice: locals.deviceId }).id;
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { error: { message: e.message, field: e.field }, values });
			throw e;
		}
		redirect(303, `/album/${id}?add`);
	}
};
