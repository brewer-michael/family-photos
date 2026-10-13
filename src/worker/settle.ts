/**
 * The source's side of the commit order (src/worker/README.md): the lanes never move or delete
 * an upload before media.markReady() has committed (synchronous = FULL, so it is on disk). Only
 * then is the source archived in originals/ (rename + fsync) or deleted, and only after that does
 * the row let go of its upload token (media.sourceSettled). Until then the .incoming sweep keeps
 * the file, and a lane that died in between finishes the job when it starts (settleInterrupted).
 */
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { incomingPath, originalsPath } from '#lib/server/paths';
import * as media from '#lib/server/repo/media';
import { errorDetail } from '#lib/shared/errors';
import type { Kind } from '#lib/shared/media-types';
import type { WorkerLogger } from './context';

export async function fsyncPath(p: string): Promise<void> {
	const fh = await fs.open(p, 'r');
	try {
		await fh.sync();
	} finally {
		await fh.close();
	}
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * The source file a lane reads: the upload while the row holds its token, else the archived
 * original (media.sourcePath's order), or the other of the two when only that one exists (a lane
 * that died between archiving and releasing the token). null when the row names neither.
 */
export async function locateSource(row: Pick<media.MediaRow, 'id' | 'upload_token' | 'source_kept' | 'source_ext'>): Promise<string | null> {
	const candidates = [row.upload_token ? incomingPath(row.upload_token) : null];
	if (row.source_kept && row.source_ext) {
		try {
			candidates.push(originalsPath(row.id, row.source_ext));
		} catch {
			// an extension originals/ refuses: never archived
		}
	}
	const named = candidates.filter((p): p is string => p !== null);
	for (const p of named) if (await exists(p)) return p;
	return named[0] ?? null;
}

/**
 * The canonical file of a passthrough item, as a second name for the source's bytes in .work/
 * (a hard link; a copy where linking fails). The source itself stays where the row says until
 * the commit.
 */
export async function linkSource(src: string, dest: string): Promise<string> {
	await fs.rm(dest, { force: true });
	try {
		await fs.link(src, dest);
	} catch {
		await fs.copyFile(src, dest, constants.COPYFILE_FICLONE);
	}
	return dest;
}

/**
 * After the commit; never throws (every failure is logged). keep: the source is renamed to
 * originals/<sh>/<id>.<sourceExt> and that folder fsynced; if that fails the row is corrected to
 * "no original kept". Otherwise the source is deleted. Then the row releases its upload token.
 */
export async function settleSource(id: string, src: string, keep: boolean, sourceExt: string, log: WorkerLogger, label: string): Promise<void> {
	let archived: string | null = null;
	try {
		if (!keep) await fs.rm(src, { force: true });
		else {
			archived = originalsPath(id, sourceExt);
			if (src !== archived) {
				await fs.mkdir(path.dirname(archived), { recursive: true });
				await fs.rename(src, archived);
				await fsyncPath(path.dirname(archived));
			}
		}
	} catch (e) {
		const kept = archived !== null && (await exists(archived));
		log.error(`${label}: could not ${keep ? 'archive' : 'delete'} the source`, { error: errorDetail(e, 500), ...(kept ? { archived: true } : {}) });
		if (keep && !kept) {
			try {
				media.markOriginalDeleted(id);
			} catch (e2) {
				log.error(`${label}: could not record that the source was not kept`, { error: errorDetail(e2, 500) });
			}
		}
	}
	try {
		media.sourceSettled(id);
	} catch (e) {
		log.error(`${label}: could not release the upload token`, { error: errorDetail(e, 500) });
	}
}

/**
 * When a lane starts: ready rows of its kind whose lane died after the commit but before the
 * source was settled. Each is finished now (archived, or deleted, then its token released).
 * Returns how many rows it settled.
 */
export async function settleInterrupted(kind: Kind, log: WorkerLogger): Promise<number> {
	let n = 0;
	for (const row of media.listUnsettled(kind)) {
		const label = `${kind} ${row.id}`;
		try {
			const keep = row.source_kept === 1 && row.source_ext !== null;
			const archived = keep ? originalsPath(row.id, row.source_ext!) : null;
			// Archived before the lane died: only the token is left to release.
			const src = archived !== null && (await exists(archived)) ? archived : incomingPath(row.upload_token!);
			await settleSource(row.id, src, keep, row.source_ext ?? 'bin', log, label);
			n++;
		} catch (e) {
			log.error(`${label}: could not settle the source of an interrupted job`, { error: errorDetail(e, 500) });
		}
	}
	return n;
}
