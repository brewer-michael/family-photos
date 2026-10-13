/**
 * Photo lane job. STUB — the photo track replaces this.
 *
 * Contract: called by main.ts for a row the main process already claimed (status
 * 'processing'). Read the source via media.sourcePath(row), write the canonical file in
 * ctx.paths.workDir(id), verify, fsync, rename into ctx.paths.libraryPath(id, ext), then
 * media.markReady(id, {...}), then archive/delete the source; derivatives go to
 * ctx.paths.cacheFile(id, 'thumb'|'display'). Clean ctx.paths.tmpDir(id)/workDir(id) in finally.
 * Throw MediaError(code, detail) for known failures; anything else counts as 'retryable'.
 */
import { MediaError } from '#lib/shared/errors';
import type { WorkerContext } from './context';

export async function processPhoto(id: string, ctx: WorkerContext): Promise<void> {
	void id;
	void ctx;
	throw new MediaError('unsupported', 'not implemented');
}
