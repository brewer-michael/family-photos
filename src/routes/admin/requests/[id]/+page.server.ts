import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { done, field, problem, requireAdmin } from '#lib/server/admin';
import { tx } from '#lib/server/db';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import * as requests from '#lib/server/repo/requests';
import { listAlbumTitles } from '#lib/server/repo/admin';
import { mediaUrl } from '#lib/client/dto';
import { REMOVAL_REASON_LABELS } from '#lib/shared/media-types';

const GONE = "This request isn't here any more. Its photo or video may have been deleted for good.";

/** The request and its item, or the friendly 404. */
function find(param: string) {
	const id = /^[1-9]\d{0,9}$/.test(param) ? Number(param) : NaN;
	const request = Number.isInteger(id) ? requests.getDetail(id) : undefined;
	const item = request && media.getById(request.media_id);
	if (!request || !item) error(404, GONE);
	return { request, item };
}

export const load: PageServerLoad = ({ params, locals }) => {
	requireAdmin(locals);
	const { request: r, item } = find(params.id);
	const kind = item.kind ?? 'photo';
	const preview = kind === 'video' ? 'poster' : 'display';
	return {
		request: {
			id: r.id,
			status: r.status,
			resolvedAction: r.resolved_action,
			resolvedAt: r.resolved_at,
			requester: r.requester_name,
			reason: REMOVAL_REASON_LABELS[r.reason],
			details: r.details,
			createdAt: r.created_at
		},
		item: {
			id: item.id,
			kind,
			previewUrl: item.status === 'ready' ? mediaUrl(item.id, preview, { v: item.pipeline_version }) : null,
			width: item.width,
			height: item.height,
			takenAt: item.taken_at,
			takenMs: item.taken_ms,
			by: item.uploaded_by_name,
			albumId: item.album_id,
			album: r.album_title,
			trashed: item.deleted_at !== null,
			hasOriginal: media.sourcePath(item) !== null
		},
		otherAlbums: listAlbumTitles()
			.filter((a) => a.id !== item.album_id)
			.map((a) => ({ id: a.id, title: a.title }))
	};
};

/** The request (still pending) and its item for an action; anything else is an error result. */
function pending(param: string) {
	const found = find(param);
	return found.request.status === 'pending' ? found : null;
}

const ALREADY = 'This request was already handled.';

export const actions: Actions = {
	/** To the trash; every pending request for the item is approved with it. */
	remove: ({ params, locals }) => {
		requireAdmin(locals);
		const found = pending(params.id);
		if (!found) return problem(409, 'request', ALREADY);
		const { request: r, item } = found;
		tx(() => {
			media.softDelete(item.id, `${r.requester_name} asked: ${REMOVAL_REASON_LABELS[r.reason]}`);
			requests.resolve(r.id, 'approved', 'removed');
			requests.resolveAllForMedia(item.id, 'approved', 'removed');
		});
		return done('request', 'Removed. It stays in the trash for 30 days in case you change your mind.');
	},

	/**
	 * To another album (refused when that album already has the same photo or video). Other pending
	 * "Wrong album" requests for the item are approved with it; requests for other reasons stay
	 * pending, since moving it doesn't answer them.
	 */
	move: async ({ params, request, locals }) => {
		requireAdmin(locals);
		const found = pending(params.id);
		if (!found) return problem(409, 'request', ALREADY);
		const { request: r, item } = found;
		const albumId = Number(field(await request.formData(), 'album'));
		const target = Number.isInteger(albumId) ? albums.get(albumId) : undefined;
		if (!target) return problem(400, 'request', 'Please pick an album.');
		const moved = tx(() => {
			const m = media.move(item.id, target.id);
			if (!m.ok) return m;
			requests.resolve(r.id, 'approved', 'moved');
			for (const other of requests.listPending()) {
				if (other.media_id === item.id && other.reason === 'wrong_album') requests.resolve(other.id, 'approved', 'moved');
			}
			return m;
		});
		if (moved.ok) return done('request', `Moved to “${target.title}”.`);
		if (moved.reason === 'duplicate') {
			return problem(409, 'request', `“${target.title}” already has this ${item.kind ?? 'photo'}, so it wasn't moved.`, moved.conflictId);
		}
		return problem(404, 'request', "We couldn't find that album.");
	},

	dismiss: ({ params, locals }) => {
		requireAdmin(locals);
		const found = pending(params.id);
		if (!found) return problem(409, 'request', ALREADY);
		requests.resolve(found.request.id, 'dismissed');
		return done('request', 'Dismissed. Nothing was changed.');
	}
};
