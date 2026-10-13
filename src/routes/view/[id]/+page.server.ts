import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad, RequestEvent } from './$types';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import * as memories from '#lib/server/repo/memories';
import * as requests from '#lib/server/repo/requests';
import { memoryList, saveTarget, viewItem } from '#lib/server/repo/ui';
import { askLimiter, createRemovalRequest } from '#lib/server/removal';
import { getConfig, publicOrigin } from '#lib/server/config';
import { clientKeys } from '#lib/server/ratelimit';
import { ValidationError } from '#lib/shared/errors';
import { isMediaId, REMOVAL_REASONS, type RemovalReason } from '#lib/shared/media-types';

const NOT_HERE = "This isn't here. It may have been removed, or it's still getting ready.";

/**
 * The item if this viewer may see it: ready and in a live album; trashed items and items of a
 * deleted album only for the admin. Anything else is the friendly 404.
 */
function viewable(id: string, locals: App.Locals) {
	const isAdmin = locals.role === 'admin';
	const row = isMediaId(id) ? media.getById(id) : undefined;
	if (!row || row.status !== 'ready' || !row.kind || !row.canonical_ext || (row.deleted_at !== null && !isAdmin)) {
		error(404, NOT_HERE);
	}
	const album = albums.get(row.album_id, { includeDeleted: isAdmin });
	if (!album) error(404, NOT_HERE);
	return { row, album, isAdmin };
}

/** The person acting (the gate guarantees a name, and with it a device id). */
function author(locals: App.Locals): { name: string; device: string } {
	if (!locals.name || !locals.deviceId) error(403, 'Please tell us your name first.');
	return { name: locals.name, device: locals.deviceId };
}

const text = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');

/** The memory `id` from the form, if it belongs to this item. */
async function memoryOf(event: RequestEvent, mediaId: string) {
	const form = await event.request.formData();
	const id = Number(form.get('id'));
	const memory = Number.isInteger(id) ? memories.get(id) : undefined;
	if (!memory || memory.media_id !== mediaId) error(404, "We couldn't find that memory.");
	return { memory, form };
}

export const load: PageServerLoad = ({ params, locals, url }) => {
	const { row, album, isAdmin } = viewable(params.id, locals);
	const { prev, next } = media.prevNext(row.id);
	const edit = Number(url.searchParams.get('edit'));
	return {
		item: viewItem(row),
		save: saveTarget(row),
		album: { id: album.id, title: album.title },
		prevHref: prev ? `/view/${prev}` : null,
		nextHref: next ? `/view/${next}` : null,
		memories: memoryList(row.id, { device: locals.deviceId, isAdmin }),
		editingId: Number.isInteger(edit) && edit > 0 ? edit : null,
		alreadyAsked: locals.deviceId ? requests.hasPendingFor(row.id, locals.deviceId) : false,
		trashed: row.deleted_at !== null,
		// The admin's archive copy of what was uploaded (/admin/original checks the role again).
		originalHref: isAdmin && row.source_kept && row.source_ext ? `/admin/original/${row.id}` : null
	};
};

export const actions: Actions = {
	addMemory: async ({ params, request, locals }) => {
		const { row } = viewable(params.id, locals);
		const who = author(locals);
		const body = text((await request.formData()).get('body'));
		try {
			memories.add({ mediaId: row.id, authorName: who.name, authorDevice: who.device, body });
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { memory: { error: e.message, errorFor: 'add' as const, body } });
			throw e;
		}
		return { memory: { saved: true } };
	},

	/** Only the device that wrote a memory may change it. */
	editMemory: async (event) => {
		const { row } = viewable(event.params.id, event.locals);
		const who = author(event.locals);
		const { memory, form } = await memoryOf(event, row.id);
		const body = text(form.get('body'));
		try {
			if (!memories.update(memory.id, body, { device: who.device })) {
				error(403, 'You can only change memories you wrote.');
			}
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { memory: { error: e.message, errorFor: memory.id, body } });
			throw e;
		}
		redirect(303, `/view/${row.id}#memory-${memory.id}`);
	},

	/** The device that wrote it, or the admin. */
	deleteMemory: async (event) => {
		const { row, isAdmin } = viewable(event.params.id, event.locals);
		const { memory } = await memoryOf(event, row.id);
		if (!memories.remove(memory.id, { device: event.locals.deviceId, isAdmin })) {
			error(403, 'You can only delete memories you wrote.');
		}
		return { memory: { deleted: true } };
	},

	/**
	 * "Ask to remove": stored first, then the admin is emailed (one pending request per device, and
	 * a few dozen an hour per person; see #lib/server/removal for the limits on emails).
	 */
	askRemove: async (event) => {
		const { params, request, locals } = event;
		const { row } = viewable(params.id, locals);
		const who = author(locals);
		const form = await request.formData();
		const reason = text(form.get('reason')) as RemovalReason;
		if (!REMOVAL_REASONS.includes(reason)) return fail(400, { remove: { error: 'Please pick a reason.' } });
		if (requests.hasPendingFor(row.id, who.device)) return { remove: { sent: true } };
		const keys = [...clientKeys(event), `device:${who.device}`];
		const limit = askLimiter.check(keys);
		if (limit.limited) {
			const minutes = Math.max(1, Math.ceil(limit.retryAfterS / 60));
			return fail(429, {
				remove: {
					error: `That's a lot of requests at once. Please wait ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} and try again, or tell ${getConfig().adminName}.`
				}
			});
		}
		try {
			await createRemovalRequest({
				mediaId: row.id,
				requesterName: who.name,
				requesterDevice: who.device,
				reason,
				details: text(form.get('details')),
				origin: publicOrigin()
			});
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { remove: { error: e.message } });
			throw e;
		}
		askLimiter.fail(keys); // counts requests, not failures
		return { remove: { sent: true } };
	}
};
