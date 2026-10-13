/**
 * A redo's side of the commit (admin "Redo them", media.isRedo()). The item stays ready and
 * visible while it is redone, so its live library file may only be replaced together with the row
 * (media.markRedone()). Before the new canonical file is renamed onto the live one, the live file
 * gets a second name in the job's .work/<id>/ (a hard link, same filesystem); if the commit doesn't
 * happen, that name is renamed back over the new file, so library/ always holds the file the row
 * describes. (Previews in cache/ may already show the new version: they are the same picture and
 * can always be rebuilt.)
 */
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Keeps the live file at `dest` as .work/<id>/live-before-redo. null when there is none at that path. */
export async function keepLive(dest: string, workDir: string): Promise<string | null> {
	const kept = path.join(workDir, 'live-before-redo');
	await fs.rm(kept, { force: true });
	try {
		await fs.link(dest, kept);
	} catch (e) {
		// No file at this path (the new version has another extension): nothing live is overwritten.
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
		await fs.copyFile(dest, kept, constants.COPYFILE_FICLONE);
	}
	return kept;
}

/** Not committed: the live file goes back to `dest` (or, when there was none, the new file is removed). */
export async function undoInstall(dest: string, kept: string | null): Promise<void> {
	if (kept) await fs.rename(kept, dest);
	else await fs.rm(dest, { force: true });
}
