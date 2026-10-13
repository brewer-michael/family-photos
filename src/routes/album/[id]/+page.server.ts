import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import { ALBUM_PAGE_SIZE, parseAlbumId, pendingTiles, toTile } from '#lib/server/repo/ui';
import { ValidationError } from '#lib/shared/errors';

const NOT_FOUND = { message: "We couldn't find that album. It may have been removed." };

export const load: PageServerLoad = ({ params, locals, url }) => {
	const album = albums.getSummary(parseAlbumId(params.id));
	if (!album) error(404, NOT_FOUND);
	// Without JavaScript, "Show more" is a link to ?before=<cursor> (with it, items/+server.ts).
	const before = media.decodeCursor(url.searchParams.get('before'));
	const page = media.listByAlbum(album.id, { limit: ALBUM_PAGE_SIZE, before });
	const canEdit = albums.canEdit(album, { role: locals.role, deviceId: locals.deviceId });
	const isAdmin = locals.role === 'admin';
	return {
		album: {
			id: album.id,
			title: album.title,
			whenText: album.when_text,
			description: album.description,
			createdByName: album.created_by_name,
			itemCount: album.item_count,
			photoCount: album.photo_count,
			videoCount: album.video_count
		},
		items: page.items.map(toTile),
		next: page.next ? media.encodeCursor(page.next) : null,
		olderPage: before !== null,
		// Unfinished uploads: the uploader's own, or everyone's for the admin.
		pending: isAdmin ? pendingTiles(album.id, null) : locals.deviceId ? pendingTiles(album.id, locals.deviceId) : [],
		canEdit,
		editing: canEdit && url.searchParams.has('edit'),
		openUploader: url.searchParams.has('add') || album.item_count === 0
	};
};

const text = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');

export const actions: Actions = {
	/** Title / when / description: the album's creator (by device) or the admin. */
	edit: async ({ params, request, locals }) => {
		const album = albums.get(parseAlbumId(params.id));
		if (!album) error(404, NOT_FOUND);
		if (!albums.canEdit(album, { role: locals.role, deviceId: locals.deviceId })) {
			error(403, { message: 'Only the person who started this album can change it.' });
		}
		const form = await request.formData();
		const values = { title: text(form.get('title')), whenText: text(form.get('whenText')), description: text(form.get('description')) };
		try {
			albums.update(album.id, values);
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { editError: { message: e.message, field: e.field }, values });
			throw e;
		}
		redirect(303, `/album/${album.id}`);
	}
};
