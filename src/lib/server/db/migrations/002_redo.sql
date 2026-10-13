-- 002_redo.sql — the admin's "Redo them" (reprocess from the archived original) is tracked apart
-- from `status`, so an item being redone stays 'ready' and visible the whole time, and a redo that
-- fails leaves the item exactly as the family sees it (docs/PLAN.md "Reprocess items below
-- pipeline version N").
--
--   redo_state      NULL = no redo; 'queued' = waiting for its lane; 'running' = a lane has it.
--   redo_queued_ms  When it was queued (redo lane order; pushed back after a retryable failure).
--   redo_attempts   Lane runs of the current redo (a graceful shutdown gives the attempt back).
--   redo_error      Why the last redo didn't work (admin only); cleared when the redo is queued
--                   again or succeeds. The item keeps its old file and pipeline_version, so it is
--                   still listed as outdated and can be redone again.

ALTER TABLE media ADD COLUMN redo_state TEXT CHECK (redo_state IN ('queued','running'));
ALTER TABLE media ADD COLUMN redo_queued_ms INTEGER;
ALTER TABLE media ADD COLUMN redo_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media ADD COLUMN redo_error TEXT;

-- Redo lane order (media.nextRedo), only rows that wait.
CREATE INDEX media_redo ON media(kind, redo_queued_ms, id) WHERE redo_state = 'queued';

-- Live Photo pairing by content id across albums: a photo moved or trashed before its video was
-- ready (media.pairLivePhoto).
CREATE INDEX media_content ON media(content_id) WHERE content_id IS NOT NULL;
