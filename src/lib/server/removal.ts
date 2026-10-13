/**
 * Removal requests: store first, then email the admin asynchronously (docs/PLAN.md "Removal
 * requests").
 *
 *   Subject  Removal request: photo in "Retreat 2023" from Aunt Linda
 *   Body     text + HTML (every value escaped): who asked, why (+ their words), album, who added it,
 *            when it was taken, a ≤ 600 px JPEG of the item inline (cid:thumb@family-photos), and
 *            links to PUBLIC_URL/view/<id> and PUBLIC_URL/admin/requests/<rid>
 *
 * The outcome is recorded as email_status sent/saved/failed (+ email_error); the admin can resend.
 * The JPEG is made by ffmpeg from the cached display.webp (photos) or poster.webp (videos), so sharp
 * never loads in the web process. Links in the email only lead to pages: removing, moving and
 * dismissing are POST-only, so link scanners can't act on them.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { getConfig, publicOrigin } from './config';
import { cacheFile } from './paths';
import { sendMail, type MailMessage } from './mail';
import * as media from './repo/media';
import * as requests from './repo/requests';
import { formatTaken } from '#lib/client/format';
import {
	REMOVAL_REASON_LABELS,
	type CacheVariant,
	type EmailStatus,
	type Kind,
	type RemovalReason
} from '#lib/shared/media-types';

export interface RemovalRequestInput {
	mediaId: string;
	requesterName: string;
	requesterDevice: string;
	reason: RemovalReason;
	details?: string | null;
	/** Origin for links in the email: publicOrigin() (always PUBLIC_URL, never the request's Host). */
	origin: string;
}

/** Content-ID of the inline picture. */
export const THUMB_CID = 'thumb@family-photos';
/** Longest edge of the inline picture. */
export const THUMB_MAX_PX = 600;
const THUMB_TIMEOUT_MS = 30_000;

/** The server's time zone (Unraid sets TZ), as on the pages. */
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Throws ValidationError for bad input. Idempotent per device+item while pending. */
export async function createRemovalRequest(input: RemovalRequestInput): Promise<{ id: number }> {
	const { request, created } = requests.create({
		mediaId: input.mediaId,
		requesterName: input.requesterName,
		requesterDevice: input.requesterDevice,
		reason: input.reason,
		details: input.details
	});
	if (created) void emailRequest(request.id, input.origin);
	return { id: request.id };
}

/** Sends a request's email again (admin "Resend"). Resolves with the recorded status. */
export function resendRemovalEmail(id: number): Promise<EmailStatus> {
	return emailRequest(id, publicOrigin());
}

/**
 * Sends the emails still `pending` after `graceMs` (the server stopped between storing a request and
 * emailing it). Failed ones wait for the admin's "Resend". Resolves with how many were tried.
 */
export async function sendStuckRemovalEmails(graceMs: number, now: number = Date.now()): Promise<number> {
	const stuck = requests.listEmailUnsent().filter((r) => r.email_status === 'pending' && r.created_at < now - graceMs);
	for (const r of stuck) await emailRequest(r.id, publicOrigin());
	return stuck.length;
}

/** Requests whose email is being sent right now: a second send joins the first. */
const inflight = new Map<number, Promise<EmailStatus>>();

function emailRequest(id: number, origin: string): Promise<EmailStatus> {
	let p = inflight.get(id);
	if (!p) {
		p = deliver(id, origin).finally(() => inflight.delete(id));
		inflight.set(id, p);
	}
	return p;
}

/** Builds and sends the email, then records email_status. Never rejects. */
async function deliver(id: number, origin: string): Promise<EmailStatus> {
	let status: EmailStatus;
	let error: string | null = null;
	try {
		const to = getConfig().adminEmail;
		if (!to) throw new Error('No admin email address is set (ADMIN_EMAIL), so this request is only on the admin page.');
		const request = requests.getDetail(id);
		const item = request && media.getById(request.media_id);
		if (!request || !item) throw new Error(`Removal request ${id} or its item no longer exists.`);
		const thumb = await emailThumbnail(item.id, item.kind);
		status = await sendMail(removalEmail({ to, origin, request, item, thumb }));
	} catch (e) {
		status = 'failed';
		error = e instanceof Error ? e.message : String(e);
		console.warn(`[removal] the email for request ${id} failed: ${error}`);
	}
	try {
		requests.setEmailStatus(id, status, error);
	} catch (e) {
		console.error(`[removal] could not record the email status of request ${id}:`, (e as Error).message);
	}
	return status;
}

// ---------------------------------------------------------------------------
// The picture
// ---------------------------------------------------------------------------

/**
 * ffmpeg: first frame of `src`, fitted into a 600 px box (never enlarged), as a full-range baseline
 * JPEG (yuv420p + color_range pc rather than the deprecated yuvj420p; same pixels on 6.1 and 7.1).
 */
function ffmpegJpeg(src: string): Promise<Buffer> {
	const box = `scale=w='min(${THUMB_MAX_PX},iw)':h='min(${THUMB_MAX_PX},ih)':force_original_aspect_ratio=decrease`;
	const args = [
		'-hide_banner', '-v', 'error', '-nostdin', '-i', src, '-frames:v', '1', '-vf', `${box},format=yuv420p`,
		'-c:v', 'mjpeg', '-q:v', '3', '-color_range', 'pc', '-f', 'image2pipe', 'pipe:1'
	];
	return new Promise((resolve, reject) => {
		execFile(
			getConfig().ffmpegBin,
			args,
			{ encoding: 'buffer', timeout: THUMB_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) reject(new Error(`ffmpeg failed: ${String(stderr).trim() || err.message}`));
				else if (stdout.length === 0) reject(new Error('ffmpeg produced no picture'));
				else resolve(stdout);
			}
		);
	});
}

/**
 * A ≤ 600 px JPEG of the item from its cached preview (display.webp for photos, poster.webp for
 * videos, else thumb.webp), or null when there is none or ffmpeg fails; the email goes without it.
 */
export async function emailThumbnail(id: string, kind: Kind | null): Promise<Buffer | null> {
	const order: CacheVariant[] = kind === 'video' ? ['poster', 'thumb'] : ['display', 'thumb'];
	const src = order.map((v) => cacheFile(id, v)).find((f) => fs.existsSync(f));
	if (!src) return null;
	try {
		return await ffmpegJpeg(src);
	} catch (e) {
		console.warn(`[removal] no picture for ${id}: ${(e as Error).message}`);
		return null;
	}
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

export interface RemovalEmailInput {
	to: string;
	origin: string;
	request: requests.RemovalRequestDetail;
	item: Pick<media.MediaRow, 'id' | 'kind' | 'taken_at' | 'taken_ms'>;
	/** JPEG for the inline picture, if any. */
	thumb: Buffer | null;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function askedAt(ms: number): string {
	const opts: Intl.DateTimeFormatOptions = { dateStyle: 'long', timeStyle: 'short' };
	try {
		return new Intl.DateTimeFormat('en-US', { ...opts, timeZone }).format(ms);
	} catch {
		return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(ms);
	}
}

/** The email for one request (pure: everything it shows comes from the arguments). */
export function removalEmail({ to, origin, request, item, thumb }: RemovalEmailInput): MailMessage {
	const kind = item.kind ?? 'photo';
	const viewUrl = `${origin}/view/${encodeURIComponent(item.id)}`;
	const reviewUrl = `${origin}/admin/requests/${request.id}`;
	const facts: [string, string][] = [
		['Why', REMOVAL_REASON_LABELS[request.reason]],
		...(request.details ? [['Their words', request.details] as [string, string]] : []),
		['Album', request.album_title],
		['Added by', request.uploaded_by_name],
		['Taken', formatTaken(item.taken_at, item.taken_ms, timeZone) || 'Unknown'],
		['Asked', askedAt(request.created_at)]
	];
	const lead = `${request.requester_name} asked for a ${kind} in "${request.album_title}" to be removed.`;
	const reassure = 'Nothing has been removed yet. Open the request to remove it, move it to another album, or dismiss it.';

	const text = [
		lead,
		'',
		...facts.map(([k, v]) => `${k}: ${v}`),
		'',
		`See the ${kind}: ${viewUrl}`,
		`Review the request: ${reviewUrl}`,
		'',
		reassure,
		''
	].join('\n');

	const e = escapeHtml;
	const rows = facts
		.map(
			([k, v]) =>
				`<tr><th align="left" valign="top" style="padding:4px 16px 4px 0;color:#5e4a3c">${e(k)}</th>` +
				`<td style="padding:4px 0;white-space:pre-wrap">${e(v)}</td></tr>`
		)
		.join('');
	const button = (href: string, label: string, primary: boolean) =>
		`<a href="${e(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:12px 20px;border-radius:10px;` +
		`font-weight:bold;text-decoration:none;${primary ? 'background:#9c3d1f;color:#ffffff' : 'border:2px solid #9c3d1f;color:#9c3d1f'}">${e(label)}</a>`;
	const html =
		`<!doctype html><html><body style="margin:0;padding:24px;background:#fff8ef;color:#2b1d14;` +
		`font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:17px;line-height:1.5">` +
		`<p style="margin:0 0 16px;font-size:20px;font-weight:bold">${e(lead)}</p>` +
		(thumb ? `<p style="margin:0 0 16px"><img src="cid:${THUMB_CID}" alt="The ${kind}" style="max-width:100%;border-radius:10px"></p>` : '') +
		`<table role="presentation" style="border-collapse:collapse;margin:0 0 20px">${rows}</table>` +
		`<p style="margin:0 0 12px">${button(reviewUrl, 'Review the request', true)}${button(viewUrl, `See the ${kind}`, false)}</p>` +
		`<p style="margin:0;color:#5e4a3c">${e(reassure)}</p>` +
		`</body></html>`;

	return {
		to,
		subject: `Removal request: ${kind} in "${request.album_title}" from ${request.requester_name}`,
		text,
		html,
		attachments: thumb ? [{ filename: `${kind}.jpg`, content: thumb, contentType: 'image/jpeg', cid: THUMB_CID }] : []
	};
}
