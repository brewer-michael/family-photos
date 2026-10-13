import fs from 'node:fs';
import type { Actions, PageServerLoad } from './$types';
import { daysLeftInTrash, done, emptyTrash, field, problem, requireAdmin, restoreItem } from '#lib/server/admin';
import { cacheFile } from '#lib/server/paths';
import * as media from '#lib/server/repo/media';
import { albumTitles } from '#lib/server/repo/admin';
import { mediaUrl } from '#lib/client/dto';
import { isMediaId } from '#lib/shared/media-types';

export const load: PageServerLoad = ({ locals }) => {
	requireAdmin(locals);
	const titles = albumTitles();
	const now = Date.now();
	return {
		items: media.listTrash().map((r) => ({
			id: r.id,
			kind: r.kind,
			name: r.source_name,
			by: r.uploaded_by_name,
			album: titles.get(r.album_id) ?? '',
			reason: r.deleted_reason,
			trashedAt: r.deleted_at!,
			daysLeft: daysLeftInTrash(r.deleted_at!, now),
			ready: r.status === 'ready',
			thumbUrl: fs.existsSync(cacheFile(r.id, 'thumb')) ? mediaUrl(r.id, 'thumb', { v: r.pipeline_version }) : null
		}))
	};
};

export const actions: Actions = {
	/** Back where it was (refused when its album has the same photo or video again). */
	restore: async ({ request, locals }) => {
		requireAdmin(locals);
		const id = field(await request.formData(), 'id');
		const row = isMediaId(id) ? media.getById(id) : undefined;
		const r = row ? await restoreItem(row.id) : ({ ok: false, reason: 'not_found' } as const);
		if (r.ok) return done('trash', `${row!.source_name} is back in its album.`);
		if (r.reason === 'duplicate') {
			return problem(409, 'trash', `Its album has the same ${row!.kind ?? 'photo'} again, so this copy stays in the trash.`, r.conflictId);
		}
		if (r.reason === 'file_missing') {
			return problem(410, 'trash', `The file of ${row!.source_name} is gone from the photos folder, so it can't come back.`);
		}
		return problem(404, 'trash', 'It is no longer in the trash.');
	},

	/** Deletes everything in the trash for good, now (the same routine as the 30-day purge). */
	empty: async ({ locals }) => {
		requireAdmin(locals);
		const n = await emptyTrash();
		return done('trash', n === 0 ? 'The trash was already empty.' : `Deleted ${n} ${n === 1 ? 'item' : 'items'} for good.`);
	}
};
