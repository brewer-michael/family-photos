import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import * as media from '#lib/server/repo/media';
import { wakeIntake } from '#lib/server/intake';
import { wakeQueue } from '#lib/server/queue';
import { isMediaId } from '#lib/shared/media-types';

const NO_STORE = { 'cache-control': 'no-store' };

function answer(status: number, body: Record<string, unknown>): Response {
	return json(body, { status, headers: NO_STORE });
}

/**
 * POST /api/retry {id} → {status}: "Try again" on a failed upload. Family members may retry their
 * own device's `retryable` failures; the admin may retry any failed item (e.g. after fixing a
 * missing decoder). The item goes back through intake (`received`) or straight to its lane
 * (`queued`), or becomes a duplicate if the same bytes are live in the album by now.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.role) return answer(401, { message: 'Please sign in first' });
	if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
		return answer(415, { message: 'Send JSON' });
	}
	let id: unknown;
	try {
		id = ((await request.json()) as { id?: unknown } | null)?.id;
	} catch {
		return answer(400, { message: 'Send {"id": "…"}' });
	}
	if (!isMediaId(id)) return answer(400, { message: 'Send {"id": "…"}' });

	const isAdmin = locals.role === 'admin';
	const row = media.getById(id);
	if (!row || (!isAdmin && row.deleted_at !== null)) return answer(404, { message: "We couldn't find that one." });
	if (!isAdmin && (locals.deviceId === null || row.uploaded_by_device !== locals.deviceId)) {
		return answer(403, { message: 'Only the person who added it can try again.' });
	}
	if (row.status !== 'failed' || (!isAdmin && row.error_code !== 'retryable')) {
		return answer(409, { status: row.status, message: "This one can't be tried again." });
	}
	const status = media.retry(id);
	if (!status) return answer(409, { status: row.status, message: "This one can't be tried again." });
	if (status === 'received') void wakeIntake();
	else if (status === 'queued') wakeQueue();
	console.log(`[retry] ${id} → ${status} (${isAdmin ? 'admin' : (locals.name ?? 'family')})`);
	return answer(200, { status });
};
