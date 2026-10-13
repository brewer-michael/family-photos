-- 003_admin_counts_file_deletions.sql — admin upkeep.

-- Per-album counts. repo/admin listAlbums counts every item of an album (hidden Live Photo videos
-- aside), which no other index can answer: without this it scans the whole media table once per
-- album on every admin page load. Partial on exactly that predicate and covering status, deleted_at
-- and kind, so that count, the admin's "showing" count and the album list's photo/video counts
-- (repo/albums) are all read from the index alone. The album grid keeps media_album_view (its order).
CREATE INDEX media_album_items ON media(album_id, status, deleted_at, kind) WHERE live_photo_of IS NULL;

-- Files of items deleted for good (trash purge, old duplicates) that are still to be deleted
-- (#lib/server/admin deleteQueuedFiles). The rows go and this list is written in one transaction,
-- and the files go after, so a failure or a crash part way leaves only files that the next run
-- deletes, never an item in the trash (with a Restore button) whose files are already gone. Paths
-- are rebuilt from these columns by #lib/server/paths, so moving PHOTOS_DIR or CONFIG_DIR in
-- between is harmless.
CREATE TABLE file_deletions (
	media_id      TEXT PRIMARY KEY,           -- the deleted item's id (no foreign key: the row is gone)
	canonical_ext TEXT,
	source_ext    TEXT,
	upload_token  TEXT,
	queued_at     INTEGER NOT NULL,
	last_error    TEXT                        -- why the last attempt failed (admin page); NULL = not tried yet
) STRICT;
