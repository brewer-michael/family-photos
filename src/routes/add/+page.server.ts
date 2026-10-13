import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import * as albums from '#lib/server/repo/albums';
import { albumCards, parseAlbumId } from '#lib/server/repo/ui';
import { ValidationError } from '#lib/shared/errors';

/** /add: pick an album (or start one), then upload into it (?album=<id>). */
export const load: PageServerLoad = ({ url }) => {
	const album = albums.get(parseAlbumId(url.searchParams.get('album') ?? ''));
	return {
		album: album ? { id: album.id, title: album.title } : null,
		albums: album ? [] : albumCards()
	};
};

export const actions: Actions = {
	/** "Start a new album" right here, then continue adding to it. */
	create: async ({ request, locals }) => {
		const raw = (await request.formData()).get('title');
		const title = typeof raw === 'string' ? raw : '';
		let id: number;
		try {
			id = albums.create({ title, createdByName: locals.name, createdByDevice: locals.deviceId }).id;
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { error: e.message, title });
			throw e;
		}
		redirect(303, `/add?album=${id}`);
	}
};
