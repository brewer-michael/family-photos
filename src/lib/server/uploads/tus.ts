/**
 * tus upload endpoint: @tus/server handleWeb + @tus/file-store in PHOTOS_DIR/.incoming
 * (docs/PLAN.md "Key findings"; docs/media-pipeline.md §6 "Upload endpoint").
 *
 * - The route (src/routes/api/upload/[...path]/+server.ts) exports only POST/PATCH/HEAD/OPTIONS:
 *   GET/DELETE get SvelteKit's 405, so a raw upload can never be downloaded or deleted.
 * - X-HTTP-Method-Override → 400 (also refused by the hook; kept here as defence in depth).
 * - The upload id is a random 128-bit base64url token, separate from the media id.
 * - The session is re-read from the request's cookies in every hook (family access and a device
 *   with a name). The uploader's device and name are written into the upload's metadata by the
 *   server; anything the client sent under those keys is discarded.
 * - Creation (onUploadCreate): the album must exist and not be deleted, and /photos must have
 *   2 × Upload-Length + 2 GiB free, else 413 with words for the uploader. Over MAX_UPLOAD_GB → 413.
 *   An empty file (Upload-Length: 0) → 400: it can't be a photo or video. Uploads still on their
 *   way keep what they were let in for (2 × their length, less what they've written so far) out
 *   of that free space, so uploads started together can't each count the same room twice.
 * - HEAD/PATCH (onIncomingRequest) only from the device that created the upload, else 403.
 * - Finish (onUploadFinish): media.insertReceived() (idempotent per token), wake intake, answer at
 *   once with `X-Media-Id: <ulid>`. No hashing happens inside the request (Cloudflare's 100 s
 *   limit); the intake step does it. If the album was deleted while the file was on its way, the
 *   item goes where that album's items went: "Everyday Photos" (admin.deleteAlbum), logged for the
 *   admin. Intake then marks it `duplicate` if the same bytes are already there.
 * - A HEAD of a finished upload carries X-Media-Id too, so a client that resumes a completed
 *   upload still learns which item it became. If the finish step failed (e.g. the database was
 *   busy), tus-js-client's retry is such a HEAD: the item is recorded then, or the HEAD answers
 *   500 so the client tries again later.
 * - CSRF: tus-js-client's creation POST has no Content-Type, which SvelteKit 3 checks like a form
 *   post: its Origin must match the site's. Browsers always send Origin on POST; server.js makes the
 *   site's own origin right over plain HTTP. allowedOrigins [] sends no CORS headers at all.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { RequestEvent } from '@sveltejs/kit';
import { ERRORS, Server, type Upload } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { getConfig } from '#lib/server/config';
import { incomingDir, incomingPath, photosRoot } from '#lib/server/paths';
import { ACCESS_COOKIE, DEVICE_COOKIE, verifyAccess, verifyDevice } from '#lib/server/auth';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import { getDefaultAlbumId } from '#lib/server/repo/settings';
import { wakeIntake } from '#lib/server/intake';
import { formatBytes, freeBytes, hasRoomForUpload, spaceNeededForUpload } from '#lib/server/disk';
import { errorDetail } from '#lib/shared/errors';

const UPLOAD_PATH = '/api/upload';
/** namingFunction output: 16 random bytes, base64url. */
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

export interface TusHandler {
	handle(event: RequestEvent): Promise<Response>;
}

/** A reservation whose file never appeared (the creation failed after its check) lapses after this. */
const RESERVATION_CREATE_GRACE_MS = 60_000;
/** An upload untouched this long was given up on (the .incoming sweep deletes it after 48 h). */
const RESERVATION_IDLE_MS = 6 * 60 * 60_000;

/** Uploads let in by this process and not finished yet: token → Upload-Length, when created. */
const openUploads = new Map<string, { size: number; at: number }>();

/**
 * Space spoken for by the other unfinished uploads: 2 × their length (what their creation was
 * checked against, less the headroom) minus what they've already written, which free space counts.
 */
async function reservedBytes(except: string): Promise<number> {
	let total = 0;
	const now = Date.now();
	for (const [token, { size, at }] of openUploads) {
		if (token === except) continue;
		let written: number;
		try {
			const st = await fs.promises.stat(incomingPath(token));
			if (now - st.mtimeMs > RESERVATION_IDLE_MS) {
				openUploads.delete(token);
				continue;
			}
			written = st.size;
		} catch {
			if (now - at > RESERVATION_CREATE_GRACE_MS) {
				openUploads.delete(token);
				continue;
			}
			written = 0; // being created right now
		}
		total += Math.max(0, 2 * size - written);
	}
	return total;
}

/** Tests only: forget the uploads on their way. */
export function forgetOpenUploads(): void {
	openUploads.clear();
}

/** A tus hook failure: @tus/server answers with this status and body. */
function reject(status: number, body: string): never {
	throw Object.assign(new Error(body), { status_code: status, body });
}

function plain(status: number, body: string): Response {
	return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

/** Cookie header → name/value pairs (values percent-decoded when they can be). */
export function parseCookies(header: string | null): Map<string, string> {
	const out = new Map<string, string>();
	for (const part of (header ?? '').split(';')) {
		const eq = part.indexOf('=');
		if (eq <= 0) continue;
		const name = part.slice(0, eq).trim();
		let value = part.slice(eq + 1).trim();
		if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
		try {
			value = decodeURIComponent(value);
		} catch {
			// keep it as sent
		}
		if (!out.has(name)) out.set(name, value);
	}
	return out;
}

interface Uploader {
	deviceId: string;
	name: string;
}

/** The family member behind a request, from its own cookies. Rejects 401/403 otherwise. */
function uploaderOf(req: Request): Uploader {
	const cookies = parseCookies(req.headers.get('cookie'));
	if (!verifyAccess(cookies.get(ACCESS_COOKIE))) reject(401, 'Please sign in again.');
	const device = verifyDevice(cookies.get(DEVICE_COOKIE));
	if (!device || device.n.trim() === '') reject(403, 'Please tell us your name first.');
	return { deviceId: device.d, name: device.n };
}

/**
 * Records a finished upload as a `received` item (idempotent per upload token), wakes intake and
 * returns the media id. Throws when the upload lost its details or the database refused.
 */
function recordFinished(upload: Upload): string {
	const meta = upload.metadata ?? {};
	const albumId = Number(meta.albumId);
	if (!meta.device || !meta.name || !Number.isInteger(albumId)) reject(500, 'The upload lost its details.');
	// albums.get and insertReceived stay synchronous (no await between them), so admin.deleteAlbum's
	// transaction can't run in between: a row lands either in a live album (and deleteAlbum moves
	// it) or, if the album is already gone, straight in "Everyday Photos".
	const album = albums.get(albumId, { includeDeleted: true });
	if (!album) reject(404, "That album isn't here any more.");
	const fallback = album.deleted_at !== null ? getDefaultAlbumId() : null;
	const target = fallback !== null && albums.get(fallback) ? fallback : albumId;
	const id = media.insertReceived({
		uploadToken: upload.id,
		albumId: target,
		sourceName: meta.filename ?? 'upload',
		sourceSize: upload.size ?? upload.offset,
		clientMtimeMs: meta.lastModified ? Number(meta.lastModified) : null,
		uploadedByName: meta.name,
		uploadedByDevice: meta.device
	});
	if (album.deleted_at !== null) {
		const where = target !== albumId ? `it went to album ${target}, like the rest of that album` : 'there is no live default album, so it stays there';
		console.warn(`[upload] ${id} (${meta.filename ?? 'upload'} from ${meta.name}) arrived after its album ${albumId} "${album.title}" was deleted; ${where}`);
	}
	void wakeIntake();
	return id;
}

let server: Server | null = null;

function tusServer(): Server {
	if (server) return server;
	const config = getConfig();
	const s: Server = new Server({
		path: UPLOAD_PATH,
		datastore: new FileStore({ directory: incomingDir() }),
		relativeLocation: true,
		allowedOrigins: [],
		maxSize: config.maxUploadBytes,
		namingFunction: () => randomBytes(16).toString('base64url'),

		async onUploadCreate(req, upload) {
			const who = uploaderOf(req);
			const meta = upload.metadata ?? {};
			const albumId = Number(meta.albumId);
			if (!Number.isInteger(albumId) || !albums.get(albumId)) reject(404, "That album isn't here any more.");
			if (upload.size === undefined) reject(400, 'Upload-Length is required.');
			if (upload.size === 0) reject(400, "That one isn't a photo or video.");
			// Spoken for before the first await, so creations running alongside count this one too.
			openUploads.set(upload.id, { size: upload.size, at: Date.now() });
			try {
				const free = await freeBytes(photosRoot());
				const reserved = await reservedBytes(upload.id);
				if (!hasRoomForUpload(free - reserved, upload.size)) {
					console.warn(
						`[upload] refused ${formatBytes(upload.size)} from ${who.name}: only ${formatBytes(free)} free on ${photosRoot()}` +
							`${reserved > 0 ? `, ${formatBytes(reserved)} of it kept for uploads on their way` : ''} (needs ${formatBytes(spaceNeededForUpload(upload.size))})`
					);
					reject(413, `There isn't enough room left for this one. Please tell ${config.adminName}.`);
				}
			} catch (e) {
				openUploads.delete(upload.id);
				throw e;
			}
			const lastModified = meta.lastModified && /^\d{1,16}$/.test(meta.lastModified) ? meta.lastModified : null;
			return {
				metadata: {
					filename: media.sanitizeSourceName(meta.filename ?? ''),
					lastModified,
					albumId: String(albumId),
					device: who.deviceId,
					name: who.name
				}
			};
		},

		async onIncomingRequest(req, id) {
			if (req.method !== 'HEAD' && req.method !== 'PATCH') return;
			if (!TOKEN_RE.test(id)) reject(404, 'Not found');
			const who = uploaderOf(req);
			let upload: Upload;
			try {
				upload = await s.datastore.getUpload(id);
			} catch {
				return; // gone or never existed: the handler answers 404/410 itself
			}
			if (upload.metadata?.device !== who.deviceId) reject(403, 'This upload belongs to someone else.');
		},

		async onUploadFinish(_req, upload) {
			openUploads.delete(upload.id); // its bytes are all on disk now
			return { headers: { 'X-Media-Id': recordFinished(upload) } };
		},

		onResponseError(_req, err) {
			if ('body' in err && err.body === ERRORS.ERR_MAX_SIZE_EXCEEDED.body) {
				return { status_code: 413, body: `This one is too big to send. The biggest file we can take is ${config.maxUploadGb} GB.` };
			}
			return undefined;
		}
	});
	server = s;
	return s;
}

/**
 * The media id of a complete upload, for a HEAD. An upload with no item yet is one whose finish
 * step failed (onUploadFinish threw, the client got a 500 and is now resuming): record it now.
 */
async function itemOfFinishedUpload(token: string): Promise<string> {
	const row = media.getByUploadToken(token);
	if (row) return row.id;
	const id = recordFinished(await tusServer().datastore.getUpload(token));
	console.warn(`[upload] ${id}: recorded on the uploader's retry, after its finish step had failed`);
	return id;
}

export const tusHandler: TusHandler = {
	async handle(event) {
		const req = event.request;
		if (req.headers.has('x-http-method-override')) return plain(400, 'Method override is not allowed');
		const res = await tusServer().handleWeb(req);
		res.headers.set('cache-control', 'no-store');
		if (req.method === 'HEAD' && res.status === 200) {
			const offset = res.headers.get('upload-offset');
			const token = new URL(req.url).pathname.split('/').pop() ?? '';
			if (offset !== null && offset === res.headers.get('upload-length') && TOKEN_RE.test(token)) {
				try {
					res.headers.set('X-Media-Id', await itemOfFinishedUpload(token));
				} catch (e) {
					console.error(`[upload] could not record finished upload ${token}; the uploader will retry:`, errorDetail(e, 500));
					return plain(500, 'Something went wrong. Please try again.');
				}
			}
		}
		return res;
	}
};
