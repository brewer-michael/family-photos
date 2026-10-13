/**
 * Admin operations shared by the /admin pages and daily maintenance (docs/PLAN.md "Permissions",
 * docs/media-pipeline.md §4 "Source files").
 *
 * File deletes tolerate ENOENT and only ever touch paths built by #lib/server/paths (which validate
 * ids, extensions and tokens) that also resolve inside their app root. Operations that delete files
 * of items, or restore items, run one at a time (`exclusive`), so "Restore" can't interleave with a
 * trash purge that is deleting that item's files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { error, fail } from '@sveltejs/kit';
import {
	cacheDir,
	cacheRoot,
	incomingDir,
	incomingPath,
	libraryPath,
	libraryRoot,
	originalsPath,
	originalsRoot
} from './paths';
import * as albums from './repo/albums';
import * as media from './repo/media';
import * as adminRepo from './repo/admin';
import { getDefaultAlbumId } from './repo/settings';
import { wakeIntake } from './intake';
import { wakeQueue } from './queue';
import { tx } from './db';
import { PIPELINE_VERSION, type ErrorCode, type Status } from '#lib/shared/media-types';

const DAY_MS = 24 * 3600_000;
/** Trashed items are deleted for good after this long. */
export const TRASH_KEEP_MS = 30 * DAY_MS;

/** Defence in depth behind the /admin gate: every admin load and action calls this first. */
export function requireAdmin(locals: App.Locals): void {
	if (locals.role !== 'admin') error(403, 'Only the admin can do that.');
}

/** An admin action's outcome, shown next to the controls of `section`. */
export function done<S extends string>(section: S, message: string) {
	return { section, ok: true as const, message };
}

/**
 * A failed admin action (HTTP `status`), shown next to the controls of `section`. `conflictId` is
 * the item that already holds the same photo or video when a move or restore would duplicate it.
 */
export function problem<S extends string>(status: number, section: S, message: string, conflictId?: string) {
	return fail(status, { section, ok: false as const, message, ...(conflictId ? { conflictId } : {}) });
}

/** A text field of a submitted form ('' when missing). */
export function field(form: FormData, name: string): string {
	const v = form.get(name);
	return typeof v === 'string' ? v : '';
}

/** What went wrong with a failed item, in words for the admin. */
export const ERROR_CODE_LABELS: Readonly<Record<ErrorCode, string>> = {
	retryable: 'Something went wrong while getting it ready',
	unsupported: "It isn't a photo or video we can use",
	corrupt: 'The file is damaged',
	too_large: 'It is too big or too long'
};

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function inside(root: string, p: string): boolean {
	const rel = path.relative(path.resolve(root), path.resolve(p));
	return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Deletes a file or directory below `root`; missing is fine, anything outside `root` is refused. */
export async function removeInside(root: string, p: string): Promise<void> {
	if (!inside(root, p)) throw new Error(`Refusing to delete ${p}: it is not inside ${root}`);
	await fs.promises.rm(p, { recursive: true, force: true });
}

/** Every file an item has: canonical file, archived original, tus upload (+ .json) and cache dir. */
export async function deleteItemFiles(
	row: Pick<media.MediaRow, 'id' | 'canonical_ext' | 'source_ext' | 'upload_token'>
): Promise<void> {
	const jobs: Promise<void>[] = [removeInside(cacheRoot(), cacheDir(row.id))];
	if (row.canonical_ext) jobs.push(removeInside(libraryRoot(), libraryPath(row.id, row.canonical_ext)));
	if (row.source_ext) jobs.push(removeInside(originalsRoot(), originalsPath(row.id, row.source_ext)));
	if (row.upload_token) {
		const upload = incomingPath(row.upload_token);
		jobs.push(removeInside(incomingDir(), upload), removeInside(incomingDir(), `${upload}.json`));
	}
	await Promise.all(jobs);
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs `fn` after every earlier exclusive operation has finished. */
function exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
	const run = queue.then(() => fn());
	queue = run.catch(() => undefined);
	return run;
}

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

/**
 * Deletes items trashed more than `olderThanMs` ago for good: files first, then rows (a crash in
 * between leaves rows whose files are gone, and the next purge finishes them). Returns how many
 * items (not counting hidden Live Photo videos) were deleted.
 */
export function purgeTrash(olderThanMs: number, now: number = Date.now()): Promise<number> {
	return exclusive(async () => {
		const rows = adminRepo.trashedBefore(now - olderThanMs);
		for (const row of rows) await deleteItemFiles(row);
		adminRepo.deleteMedia(rows.map((r) => r.id));
		const items = rows.filter((r) => r.live_photo_of === null).length;
		if (rows.length > 0) console.log(`[admin] deleted ${items} item(s) from the trash for good`);
		return items;
	});
}

/** "Empty trash now". */
export function emptyTrash(): Promise<number> {
	return purgeTrash(0, Date.now() + 1);
}

/** Restore from the trash (after any purge in progress). */
export function restoreItem(id: string): Promise<media.RestoreResult> {
	return exclusive(() => media.restore(id));
}

/** Days until a trashed item is deleted for good (at least 0). */
export function daysLeftInTrash(deletedAt: number, now: number = Date.now()): number {
	return Math.max(0, Math.ceil((deletedAt + TRASH_KEEP_MS - now) / DAY_MS));
}

// ---------------------------------------------------------------------------
// Archived originals and reprocessing
// ---------------------------------------------------------------------------

/**
 * "Delete all archived originals" for items that are ready. Items that failed keep theirs so they
 * can be tried again, and items being (re)processed need theirs. Returns count and bytes freed.
 */
export function deleteArchivedOriginals(): Promise<{ count: number; bytes: number }> {
	return exclusive(async () => {
		let count = 0;
		let bytes = 0;
		for (const kept of media.listKeptOriginals()) {
			if (media.getById(kept.id)?.status !== 'ready') continue;
			if (kept.source_ext) await removeInside(originalsRoot(), originalsPath(kept.id, kept.source_ext));
			media.markOriginalDeleted(kept.id);
			count++;
			bytes += kept.source_size;
		}
		if (count > 0) console.log(`[admin] deleted ${count} archived original(s)`);
		return { count, bytes };
	});
}

/** Ready items made by an older pipeline whose archived original lets them be redone. */
export function listOutdated(): media.MediaRow[] {
	return media.listBelowPipelineVersion(PIPELINE_VERSION).filter((r) => r.source_kept === 1 && r.source_ext);
}

/** Queues every outdated item again from its archived original. Returns how many. */
export function reprocessOutdated(): Promise<number> {
	return exclusive(() => {
		const n = listOutdated().filter((r) => media.markForReprocess(r.id)).length;
		if (n > 0) wakeQueue();
		return n;
	});
}

/** "Try again" for a failed item; wakes the step it goes back to. null = it can't be retried. */
export function retryItem(id: string): Status | null {
	const status = media.retry(id);
	if (status === 'received') void wakeIntake();
	if (status === 'queued') wakeQueue();
	return status;
}

// ---------------------------------------------------------------------------
// Albums
// ---------------------------------------------------------------------------

export type DeleteAlbumResult =
	| { ok: true; moved: number; trashed: number }
	| { ok: false; reason: 'not_found' | 'default_album' }
	| { ok: false; reason: 'not_empty'; count: number };

/**
 * Deletes an album. One with items is only deleted with `moveItems`: everything in it (unfinished,
 * failed and trashed items too) goes to "Everyday Photos" first; an item whose copy is already
 * there goes to the trash instead (with the reason).
 */
export function deleteAlbum(id: number, opts: { moveItems: boolean }): DeleteAlbumResult {
	return tx((): DeleteAlbumResult => {
		const album = albums.get(id);
		const defaultId = getDefaultAlbumId();
		if (!album) return { ok: false, reason: 'not_found' };
		if (id === defaultId || defaultId === null) return { ok: false, reason: 'default_album' };
		const ids = adminRepo.albumItemIds(id);
		if (ids.length > 0 && !opts.moveItems) return { ok: false, reason: 'not_empty', count: ids.length };
		let moved = 0;
		let trashed = 0;
		const target = albums.get(defaultId)?.title ?? 'Everyday Photos';
		for (const itemId of ids) {
			let r = media.move(itemId, defaultId);
			if (!r.ok && r.reason === 'duplicate') {
				media.softDelete(itemId, `Already in "${target}" when "${album.title}" was deleted`);
				trashed++;
				r = media.move(itemId, defaultId);
			} else if (r.ok) {
				moved++;
			}
			if (!r.ok) throw new Error(`Could not move ${itemId} out of album ${id}: ${r.reason}`);
		}
		if (adminRepo.countAlbumRows(id) > 0) throw new Error(`Album ${id} still has items`);
		albums.softDelete(id);
		return { ok: true, moved, trashed };
	});
}
