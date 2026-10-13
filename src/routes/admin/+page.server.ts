import fs from 'node:fs';
import type { Actions, PageServerLoad } from './$types';
import { getConfig } from '#lib/server/config';
import { cacheFile, outboxDir } from '#lib/server/paths';
import { rotateAccess } from '#lib/server/auth';
import { mailHealth, sendMail } from '#lib/server/mail';
import { resendRemovalEmail } from '#lib/server/removal';
import { getSelfCheck } from '#lib/server/selfcheck';
import { formatBytes } from '#lib/server/disk';
import {
	ERROR_CODE_LABELS,
	deleteAlbum,
	deleteArchivedOriginals,
	done,
	field,
	listOutdated,
	problem,
	reprocessOutdated,
	requireAdmin,
	retryItem
} from '#lib/server/admin';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import * as requests from '#lib/server/repo/requests';
import { albumTitles, listAlbums } from '#lib/server/repo/admin';
import { getDefaultAlbumId } from '#lib/server/repo/settings';
import { mediaUrl } from '#lib/client/dto';
import { ValidationError } from '#lib/shared/errors';
import { REMOVAL_REASON_LABELS, isMediaId } from '#lib/shared/media-types';

/** The cached thumbnail's URL, or null while there is none (failed items often have none). */
function thumbUrl(row: Pick<media.MediaRow, 'id' | 'pipeline_version'>): string | null {
	return fs.existsSync(cacheFile(row.id, 'thumb')) ? mediaUrl(row.id, 'thumb', { v: row.pipeline_version }) : null;
}

/**
 * Why recent emails didn't reach the admin, or null. (A missing ADMIN_EMAIL or SMTP_HOST is already
 * among the config warnings shown above it.)
 */
function emailProblem(failedRequests: number): string | null {
	const { lastFailure, lastSuccessAt } = mailHealth();
	if (lastFailure && (lastSuccessAt === null || lastFailure.at > lastSuccessAt)) {
		return `The last email could not be sent: ${lastFailure.error}`;
	}
	if (failedRequests > 0) {
		return `${failedRequests === 1 ? 'The email about a removal request' : `${failedRequests} emails about removal requests`} could not be sent.`;
	}
	return null;
}

export const load: PageServerLoad = ({ locals }) => {
	requireAdmin(locals);
	const c = getConfig();
	const titles = albumTitles();
	const defaultAlbumId = getDefaultAlbumId();
	const totals = media.storageTotals();
	const keptForReady = media.listKeptOriginals().filter((o) => o.status === 'ready');

	const pending = requests.listPending().map((r) => {
		const row = media.getById(r.media_id);
		return {
			id: r.id,
			kind: r.media_kind,
			thumbUrl: row ? thumbUrl(row) : null,
			requester: r.requester_name,
			reason: REMOVAL_REASON_LABELS[r.reason],
			details: r.details,
			album: r.album_title,
			createdAt: r.created_at,
			emailStatus: r.email_status
		};
	});

	const failed = media.listFailed({ limit: 100 }).map((r) => ({
		id: r.id,
		kind: r.kind,
		name: r.source_name,
		by: r.uploaded_by_name,
		album: titles.get(r.album_id) ?? '',
		code: r.error_code,
		problem: r.error_code ? ERROR_CODE_LABELS[r.error_code] : 'It did not work',
		detail: r.error_detail,
		failedAt: r.updated_at,
		thumbUrl: thumbUrl(r),
		hasSource: media.sourcePath(r) !== null
	}));

	// Without ADMIN_EMAIL every request email fails; resending can't help until it is set.
	const failedEmails = c.adminEmail
		? requests
				.listEmailUnsent()
				.filter((r) => r.email_status === 'failed' && r.status === 'pending')
				.map((r) => ({ id: r.id, requester: r.requester_name, error: r.email_error }))
		: [];

	return {
		warnings: c.warnings,
		requests: pending,
		failed,
		email: {
			to: c.adminEmail,
			smtp: c.smtp !== null,
			problem: emailProblem(failedEmails.length),
			failedRequests: failedEmails
		},
		selfCheck: getSelfCheck(),
		storage: {
			library: formatBytes(totals.canonicalBytes),
			photos: totals.photoCount,
			videos: totals.videoCount,
			originals: formatBytes(totals.originalsBytes),
			originalsCount: totals.originalsCount,
			deletableOriginals: keptForReady.length,
			deletableBytes: formatBytes(keptForReady.reduce((n, o) => n + o.source_size, 0)),
			keepOriginals: c.keepOriginals,
			outdated: listOutdated().length,
			trash: totals.trashCount
		},
		albums: listAlbums().map((a) => ({ ...a, isDefault: a.id === defaultAlbumId })),
		defaultAlbumTitle: (defaultAlbumId !== null && albums.get(defaultAlbumId)?.title) || 'Everyday Photos'
	};
};

/** The media id field of a form, if it is one. */
function mediaIdOf(form: FormData): string | null {
	const id = field(form, 'id');
	return isMediaId(id) ? id : null;
}

export const actions: Actions = {
	/** "Try again" for a failed item. */
	retry: async ({ request, locals }) => {
		requireAdmin(locals);
		const id = mediaIdOf(await request.formData());
		const row = id ? media.getById(id) : undefined;
		if (!row) return problem(404, 'failed', "We couldn't find that item.");
		switch (retryItem(row.id)) {
			case 'received':
			case 'queued':
				return done('failed', `Trying ${row.source_name} again.`);
			case 'duplicate':
				return done('failed', `${row.source_name} is already in its album, so there is nothing to redo.`);
			default:
				return problem(409, 'failed', `${row.source_name} can't be tried again: its file is gone.`);
		}
	},

	/** Moves a failed item to the trash (deleted for good after 30 days, with its file). */
	trashFailed: async ({ request, locals }) => {
		requireAdmin(locals);
		const id = mediaIdOf(await request.formData());
		const row = id ? media.getById(id) : undefined;
		if (!row) return problem(404, 'failed', "We couldn't find that item.");
		media.softDelete(row.id, 'Upload that did not work, removed by the admin');
		return done('failed', `${row.source_name} is in the trash now.`);
	},

	testEmail: async ({ locals }) => {
		requireAdmin(locals);
		const c = getConfig();
		if (!c.adminEmail) return problem(400, 'email', 'Set ADMIN_EMAIL in the Unraid template first, then restart.');
		try {
			const result = await sendMail({
				to: c.adminEmail,
				subject: `Test email from ${c.siteTitle}`,
				text: `It works: emails from ${c.siteTitle} reach you at ${c.adminEmail}.\n`
			});
			return done(
				'email',
				result === 'sent' ? `Test email sent to ${c.adminEmail}.` : `Test email saved as a file in ${outboxDir()} (no email server is set up).`
			);
		} catch (e) {
			return problem(502, 'email', `The test email could not be sent: ${(e as Error).message}`);
		}
	},

	/** Sends a removal request's email again. */
	resendEmail: async ({ request, locals }) => {
		requireAdmin(locals);
		const id = Number(field(await request.formData(), 'id'));
		if (!Number.isInteger(id) || !requests.get(id)) return problem(404, 'email', "We couldn't find that request.");
		const status = await resendRemovalEmail(id);
		if (status === 'failed') {
			return problem(502, 'email', `It still could not be sent: ${requests.get(id)?.email_error ?? 'unknown error'}`);
		}
		return done('email', status === 'sent' ? 'Sent again.' : `Saved as a file in ${outboxDir()}.`);
	},

	deleteOriginals: async ({ locals }) => {
		requireAdmin(locals);
		const { count, bytes } = await deleteArchivedOriginals();
		return done('storage', count === 0 ? 'There were no archived originals to delete.' : `Deleted ${count} archived originals and freed ${formatBytes(bytes)}.`);
	},

	reprocessOutdated: async ({ locals }) => {
		requireAdmin(locals);
		const n = await reprocessOutdated();
		return done('storage', n === 0 ? 'Nothing needs redoing.' : `${n} ${n === 1 ? 'item is' : 'items are'} being redone. They come back by themselves when ready.`);
	},

	/** access_gen++: every cookie and printed QR code stops working; the admin gets a fresh cookie. */
	resetAccess: ({ cookies, url, locals }) => {
		requireAdmin(locals);
		rotateAccess({ cookies, url });
		return done('access', 'Done. Everyone has to type the family code again, and the old QR cards no longer work. Print new ones.');
	},

	renameAlbum: async ({ request, locals }) => {
		requireAdmin(locals);
		const form = await request.formData();
		const id = Number(field(form, 'id'));
		try {
			const album = Number.isInteger(id) ? albums.update(id, { title: field(form, 'title') }) : undefined;
			if (!album) return problem(404, 'albums', "We couldn't find that album.");
			return done('albums', `Renamed to "${album.title}".`);
		} catch (e) {
			if (e instanceof ValidationError) return problem(400, 'albums', e.message);
			throw e;
		}
	},

	/** Deletes an empty album, or (move=1) moves its items to "Everyday Photos" first. */
	deleteAlbum: async ({ request, locals }) => {
		requireAdmin(locals);
		const form = await request.formData();
		const id = Number(field(form, 'id'));
		const title = Number.isInteger(id) ? albums.get(id)?.title : undefined;
		const r = title ? deleteAlbum(id, { moveItems: field(form, 'move') === '1' }) : ({ ok: false, reason: 'not_found' } as const);
		if (r.ok) {
			const target = albums.get(getDefaultAlbumId() ?? NaN)?.title ?? 'Everyday Photos';
			const moved = r.moved > 0 ? ` ${r.moved} ${r.moved === 1 ? 'item was' : 'items were'} moved to "${target}".` : '';
			const trashed = r.trashed > 0 ? ` ${r.trashed} already there went to the trash.` : '';
			return done('albums', `"${title}" is deleted.${moved}${trashed}`);
		}
		switch (r.reason) {
			case 'default_album':
				return problem(400, 'albums', "This album can't be deleted: new photos go here when no album is picked.");
			case 'not_empty':
				return problem(409, 'albums', `"${title}" still has ${r.count} ${r.count === 1 ? 'item' : 'items'}.`);
			default:
				return problem(404, 'albums', "We couldn't find that album.");
		}
	}
};
