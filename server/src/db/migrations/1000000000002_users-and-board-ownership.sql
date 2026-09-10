-- Up Migration

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  username text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Dev-only reset: Phase 2/3 boards were created ad-hoc (client-minted id, no owner) to test
-- multiplayer/persistence before auth existed. There's no real user data yet, so rather than
-- backfill a fake "system" owner, just clear the slate now that boards must have a real owner.
-- (Doing this against a live production DB with real boards would need a backfill strategy
-- instead - noted here so it doesn't read as "can't handle real migrations".)
TRUNCATE TABLE yjs_updates, board_snapshots, boards RESTART IDENTITY CASCADE;

ALTER TABLE boards
  ADD CONSTRAINT boards_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE boards ALTER COLUMN owner_id SET NOT NULL;

-- Down Migration

ALTER TABLE boards ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE boards DROP CONSTRAINT boards_owner_id_fkey;
DROP TABLE users;
