import fs from 'node:fs';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import * as media from '#lib/server/repo/media';
import { cacheFile } from '#lib/server/paths';
import { getProgress, queuePosition } from '#lib/server/queue';
import { mediaUrl } from '#lib/client/dto';
import { isMediaId, type MediaStatusDTO } from '#lib/shared/media-types';

/** Most ids one request may ask about. */
const MAX_STATUS_IDS = 100;

const NO_STORE = { 'cache-control': 'no-store' };

function toDTO(row: media.MediaStatusRow): MediaStatusDTO {
	const dto: MediaStatusDTO = { id: row.id, status: row.status, kind: row.kind };
	if (row.status === 'processing') {
		const p = getProgress(row.id);
		if (p) {
			dto.pct = p.pct;
			if (p.etaS !== undefined) dto.etaS = p.etaS;
		}
	} else if (row.status === 'queued') {
		const ahead = queuePosition(row.id);
		if (ahead !== undefined) dto.queuePos = ahead;
	} else if (row.status === 'duplicate' && row.duplicate_of) {
		dto.duplicateOf = row.duplicate_of;
	} else if (row.status === 'failed' && row.error_code) {
		dto.errorCode = row.error_code;
	}
	// Ready items show their thumbnail; a video gets its poster while it is still processing.
	const picture =
		row.status === 'ready' && fs.existsSync(cacheFile(row.id, 'thumb'))
			? 'thumb'
			: fs.existsSync(cacheFile(row.id, 'poster'))
				? 'poster'
				: null;
	if (picture) dto.posterUrl = mediaUrl(row.id, picture, { v: row.pipeline_version });
	return dto;
}

/**
 * GET /api/status?ids=a,b,… (at most 100) → MediaStatusDTO[] for the uploader's tiles.
 * Family members see ready items and their own device's uploads; the admin sees everything.
 * Unknown, malformed and hidden ids are left out of the answer.
 */
export const GET: RequestHandler = ({ url, locals }) => {
	if (!locals.role) return json({ message: 'Please sign in first' }, { status: 401, headers: NO_STORE });
	const ids = [
		...new Set(
			(url.searchParams.get('ids') ?? '')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		)
	];
	if (ids.length > MAX_STATUS_IDS) {
		return json({ message: `Ask about at most ${MAX_STATUS_IDS} items at a time` }, { status: 400, headers: NO_STORE });
	}
	const isAdmin = locals.role === 'admin';
	const rows = media
		.statusForIds(ids.filter(isMediaId))
		.filter(
			(r) =>
				isAdmin ||
				(r.deleted_at === null && (r.status === 'ready' || (locals.deviceId !== null && r.uploaded_by_device === locals.deviceId)))
		);
	return json(rows.map(toDTO), { headers: NO_STORE });
};
