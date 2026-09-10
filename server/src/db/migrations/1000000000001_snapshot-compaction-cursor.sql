-- Up Migration

-- Tracks the highest yjs_updates.id already folded into the snapshot, so loading a board is
-- "snapshot + any log rows newer than this cursor" instead of replaying the whole log every time.
ALTER TABLE board_snapshots ADD COLUMN through_update_id bigint NOT NULL DEFAULT 0;

-- Down Migration

ALTER TABLE board_snapshots DROP COLUMN through_update_id;
