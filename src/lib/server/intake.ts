/**
 * Intake (main process): received → queued | duplicate | failed. STUB — the uploads track implements this.
 *
 * Final contract, one item at a time, never inside a request:
 *   for row of media.listReceived():
 *     sha = streaming SHA-256 of paths.incomingPath(row.upload_token)
 *     dup = media.findDuplicate(row.album_id, sha, row.id) → media.markDuplicate(); delete the upload
 *     det = await detectFile(path)            (#lib/server/media/detect)
 *     det.kind === null → media.markFailed(id, 'unsupported', …, { sourceSha256: sha, sourceMime: det.mime })
 *     video → probe = await probeVideo(path); estCostS = estimateCostS(probe)   (#lib/server/media/probe)
 *     media.markQueued(id, { kind, sourceMime, sourceExt, sourceSha256: sha, estCostS }) → wakeQueue()
 * - startIntake(): process any rows left in `received` (startup), then wait for wakeIntake().
 * - wakeIntake(): called by the tus onUploadFinish hook after media.insertReceived().
 */
export function startIntake(): void {
	// TODO(uploads track)
}

export function wakeIntake(): void {
	// TODO(uploads track)
}
