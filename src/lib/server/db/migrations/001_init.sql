-- 001_init.sql — Family Photos schema (authoritative; see docs/PLAN.md "Data model").
--
-- Conventions
--   * Timestamps are INTEGER epoch milliseconds (UTC) unless the column says otherwise.
--     media.taken_at is TEXT: local wall time plus offset when known, e.g. "2024-07-04T11:22:31-07:00"
--     or "2024-07-04T11:22:31" (no offset known). media.taken_ms is the UTC sort key.
--   * Booleans are INTEGER 0/1.
--   * Media ids are ULIDs (TEXT). Album, memory and request ids are INTEGER.
--   * Applied inside one transaction by src/lib/server/db/index.ts, which then sets
--     PRAGMA user_version = 1. Never edit a released migration; add 002_*.sql instead.

CREATE TABLE settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
) STRICT;
-- Seeded on first boot: secret (32 random bytes, hex), access_gen ('1'), default_album_id.

CREATE TABLE albums (
	id                INTEGER PRIMARY KEY AUTOINCREMENT,
	title             TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
	when_text         TEXT CHECK (when_text IS NULL OR length(when_text) <= 200),
	description       TEXT CHECK (description IS NULL OR length(description) <= 5000),
	cover_media_id    TEXT REFERENCES media(id) ON DELETE SET NULL,
	created_by_name   TEXT,
	created_by_device TEXT,
	created_at        INTEGER NOT NULL,
	updated_at        INTEGER NOT NULL,
	deleted_at        INTEGER
) STRICT;

CREATE INDEX albums_live ON albums(updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE media (
	-- identity & placement
	id                 TEXT PRIMARY KEY,                -- ULID; the on-disk key; never the tus id
	upload_token       TEXT UNIQUE,                     -- tus id (random 128-bit); NULL after intake
	album_id           INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
	uploaded_by_name   TEXT NOT NULL,
	uploaded_by_device TEXT NOT NULL,

	-- type & status
	kind               TEXT CHECK (kind IN ('photo','video')),          -- NULL until detected
	status             TEXT NOT NULL DEFAULT 'received'
	                     CHECK (status IN ('received','queued','processing','ready','failed','duplicate')),
	attempts           INTEGER NOT NULL DEFAULT 0,
	error_code         TEXT CHECK (error_code IN ('retryable','unsupported','corrupt','too_large')),
	error_detail       TEXT,                            -- admin only
	pipeline_version   INTEGER NOT NULL DEFAULT 0,      -- set by markReady()

	-- source (the uploaded file)
	source_name        TEXT NOT NULL,                   -- sanitized basename, e.g. 'IMG_1234.HEIC'
	source_mime        TEXT,                            -- detected from bytes
	source_ext         TEXT,                            -- detected extension (originals/<sh>/<id>.<source_ext>)
	source_size        INTEGER NOT NULL,
	source_sha256      TEXT,                            -- hex; set by intake
	source_kept        INTEGER NOT NULL DEFAULT 0,      -- 1 = archived in originals/
	client_mtime_ms    INTEGER,                         -- from tus metadata; last-resort date

	-- canonical result
	conversion         TEXT CHECK (conversion IN ('none','remux','transcode')),
	canonical_ext      TEXT CHECK (canonical_ext IN ('jpg','png','gif','mp4')),
	canonical_size     INTEGER,
	width              INTEGER,                         -- as displayed (after rotation)
	height             INTEGER,
	duration_ms        INTEGER,

	-- conversion flags & queue
	hdr_tonemapped     INTEGER NOT NULL DEFAULT 0,
	audio_dropped      INTEGER NOT NULL DEFAULT 0,
	slowmo_retimed     INTEGER NOT NULL DEFAULT 0,
	est_cost_s         REAL,                            -- video lane ordering
	queued_ms          INTEGER,                         -- when it entered 'queued'

	-- date & place
	taken_at           TEXT,                            -- local wall time (+offset when known)
	taken_ms           INTEGER,                         -- UTC epoch ms; sort key; always set when ready
	gps_lat            REAL,
	gps_lon            REAL,
	gps_alt            REAL,

	-- links & lifecycle
	content_id         TEXT,                            -- Apple ContentIdentifier
	live_photo_of      TEXT REFERENCES media(id) ON DELETE CASCADE,
	duplicate_of       TEXT REFERENCES media(id) ON DELETE SET NULL,
	created_at         INTEGER NOT NULL,
	updated_at         INTEGER NOT NULL,
	deleted_at         INTEGER,                         -- in trash since
	deleted_reason     TEXT
) STRICT;

-- Duplicate strategy (replaces a plain UNIQUE(album_id, source_sha256)):
--
--   The same bytes may appear only once among an album's *live* items, but rows that
--   merely record a duplicate upload (status 'duplicate'), failed attempts
--   (status 'failed') and trashed items (deleted_at NOT NULL) are exempt, so:
--     * a duplicate upload is stored as its own row with status='duplicate',
--       source_sha256 = the hash, duplicate_of = the live item's id;
--     * re-uploading a file whose earlier attempt failed creates a fresh attempt;
--     * re-uploading something that is in the trash works, and restoring the trashed
--       copy afterwards is reported as a conflict by repo/media.restore().
--   Rows in 'received' have no hash yet (NULL never conflicts). media.markQueued()
--   re-checks inside its transaction and turns the row into a duplicate instead of
--   violating the index.
CREATE UNIQUE INDEX media_album_sha ON media(album_id, source_sha256)
	WHERE source_sha256 IS NOT NULL AND status NOT IN ('duplicate','failed') AND deleted_at IS NULL;

-- Album grid (visible items only), newest first, keyset paging on (taken_ms, id).
CREATE INDEX media_album_view ON media(album_id, taken_ms DESC, id DESC)
	WHERE status = 'ready' AND deleted_at IS NULL AND live_photo_of IS NULL;

-- "New photos" on the home page.
CREATE INDEX media_recent ON media(created_at DESC)
	WHERE status = 'ready' AND deleted_at IS NULL AND live_photo_of IS NULL;

-- Worker lanes.
CREATE INDEX media_queue ON media(status, kind, queued_ms)
	WHERE status IN ('received','queued','processing');

-- Live Photo pairing.
CREATE INDEX media_live ON media(album_id, content_id) WHERE content_id IS NOT NULL;
CREATE INDEX media_live_child ON media(live_photo_of) WHERE live_photo_of IS NOT NULL;

-- Unfinished tiles for an uploader's device.
CREATE INDEX media_device ON media(uploaded_by_device, created_at DESC) WHERE status <> 'ready';

-- Admin: failed items, trash.
CREATE INDEX media_failed ON media(updated_at DESC) WHERE status = 'failed';
CREATE INDEX media_trash ON media(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX media_dup_of ON media(duplicate_of) WHERE duplicate_of IS NOT NULL;

CREATE TABLE memories (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	media_id      TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
	author_name   TEXT NOT NULL,
	author_device TEXT NOT NULL,
	body          TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
	created_at    INTEGER NOT NULL,
	updated_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX memories_media ON memories(media_id, created_at);

CREATE TABLE deletion_requests (
	id               INTEGER PRIMARY KEY AUTOINCREMENT,
	media_id         TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
	requester_name   TEXT NOT NULL,
	requester_device TEXT NOT NULL,
	reason           TEXT NOT NULL CHECK (reason IN ('in_it','blurry_or_duplicate','wrong_album','other')),
	details          TEXT CHECK (details IS NULL OR length(details) <= 2000),  -- required for 'other' (enforced in repo)
	status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','dismissed')),
	resolved_action  TEXT CHECK (resolved_action IN ('removed','moved')),
	email_status     TEXT NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending','sent','saved','failed')),
	email_error      TEXT,
	created_at       INTEGER NOT NULL,
	updated_at       INTEGER NOT NULL,
	resolved_at      INTEGER
) STRICT;

-- One pending request per device per item.
CREATE UNIQUE INDEX deletion_requests_one_pending ON deletion_requests(media_id, requester_device)
	WHERE status = 'pending';
CREATE INDEX deletion_requests_status ON deletion_requests(status, created_at);
