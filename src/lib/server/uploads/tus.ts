/**
 * tus upload endpoint (@tus/server handleWeb + @tus/file-store in paths.incomingDir()).
 * STUB — the uploads track implements this.
 *
 * Final contract (see docs/PLAN.md "Key findings" and media-pipeline.md §6):
 * - Route src/routes/api/upload/[...path]/+server.ts exports only POST/PATCH/HEAD/OPTIONS
 *   and delegates to tusHandler.handle(event). GET/DELETE → 405 (SvelteKit default).
 * - X-HTTP-Method-Override → 400. Requires event.locals.deviceId + name.
 * - namingFunction: random 128-bit base64url token (separate from the media id).
 * - onUploadCreate: maxSize = config.maxUploadBytes, free space ≥ 2×size + 2 GiB, store
 *   metadata.device = locals.deviceId, validate metadata.albumId.
 * - onIncomingRequest: HEAD/PATCH only by the same device, else 403.
 * - onUploadFinish: media.insertReceived(...) → wakeIntake(); respond with header
 *   `X-Media-Id: <ulid>` so the client can poll /api/status.
 */
import type { RequestEvent } from '@sveltejs/kit';

export interface TusHandler {
	handle(event: RequestEvent): Promise<Response>;
}

export const tusHandler: TusHandler = {
	async handle(event) {
		void event;
		return new Response('Uploads are not available yet', { status: 501 });
	}
};
