/**
 * Video lane job. STUB — the video track replaces this.
 *
 * Contract: same as processPhoto (see photo.ts). Generate the poster first
 * (ctx.paths.cacheFile(id, 'poster' | 'thumb')), report ffmpeg progress through
 * ctx.progress(pct, etaS), honour ctx.signal (kill ffmpeg on abort).
 */
import { MediaError } from '#lib/shared/errors';
import type { WorkerContext } from './context';

export async function processVideo(id: string, ctx: WorkerContext): Promise<void> {
	void id;
	void ctx;
	throw new MediaError('unsupported', 'not implemented');
}
