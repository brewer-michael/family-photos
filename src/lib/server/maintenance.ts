/**
 * Daily maintenance (main process). STUB — the admin/maintenance track implements this.
 *
 * Final contract: startMaintenance() schedules (unref'd timers):
 *   - nightly db.backup() to paths.backupPath(), keep 7
 *   - purge trash older than 30 days: media.purgeTrashOlderThan(30 d) → delete library/originals/cache files
 *   - media.purgeDuplicatesOlderThan(24 h) → for each returned row with source_kept = 1, delete
 *     media.sourcePath(row) (an archived original left by retry() turning a failed item into a duplicate)
 *   - .incoming sweep: files older than 48 h whose token is not in media.tokensInUse()
 *   - hourly batched "failed items" admin email
 */
export function startMaintenance(): void {
	// TODO(admin track)
}

export function stopMaintenance(): void {
	// TODO(admin track): clear timers.
}
