/**
 * Upload-pipeline writes that the core media repo doesn't cover (intake → queue hand-over).
 */
import { stmt } from '#lib/server/db';

/**
 * Records a queued video's source duration (from intake's ffprobe) in duration_ms, so the queue
 * can size the job's hard time cap (120 s + 30 × duration) without probing again, also after a
 * restart. markReady() later overwrites it with the canonical file's duration.
 */
export function setSourceDuration(id: string, durationMs: number): boolean {
	if (!Number.isFinite(durationMs) || durationMs < 0) return false;
	return (
		stmt(`UPDATE media SET duration_ms = ?, updated_at = ? WHERE id = ? AND status IN ('received','queued')`).run(
			Math.round(durationMs),
			Date.now(),
			id
		).changes > 0
	);
}
