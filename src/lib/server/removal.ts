/**
 * Removal requests: store first, then email the admin asynchronously.
 * PARTIAL STUB — storing works; the admin track adds the email (subject
 * `Removal request: photo in "<album>" from <name>`, 600px JPEG CID thumbnail, links
 * to <origin>/view/<id> and <origin>/admin/requests/<rid>) and records email_status.
 */
import * as requests from './repo/requests';
import type { RemovalReason } from '#lib/shared/media-types';

export interface RemovalRequestInput {
	mediaId: string;
	requesterName: string;
	requesterDevice: string;
	reason: RemovalReason;
	details?: string | null;
	/** Origin for links in the email: publicOrigin() (always PUBLIC_URL, never the request's Host). */
	origin: string;
}

/** Throws ValidationError for bad input. Idempotent per device+item while pending. */
export async function createRemovalRequest(input: RemovalRequestInput): Promise<{ id: number }> {
	const { request } = requests.create({
		mediaId: input.mediaId,
		requesterName: input.requesterName,
		requesterDevice: input.requesterDevice,
		reason: input.reason,
		details: input.details
	});
	// TODO(admin track): queueMicrotask → sendMail(...) → requests.setEmailStatus(request.id, …)
	return { id: request.id };
}
