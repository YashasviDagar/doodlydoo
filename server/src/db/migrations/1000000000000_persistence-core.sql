-- Up Migration

-- owner_id is nullable here on purpose: this migration runs before Phase 4 introduces the
-- users table and real board-creation flow. Boards created ad-hoc (client-minted id, Phase 2/3
-- dev flow) simply have no owner yet. Phase 4's migration adds the users table and the FK.
CREATE TABLE boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid,
  name text NOT NULL DEFAULT 'Untitled board',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only Yjs update log (WAL). Cheap durable writes; see board_snapshots for the
-- compaction side of this - see PLAN.md for the tradeoff writeup.
CREATE TABLE yjs_updates (
  id bigserial PRIMARY KEY,
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  update bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX yjs_updates_board_id_id_idx ON yjs_updates (board_id, id);

CREATE TABLE board_snapshots (
  board_id uuid PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
  snapshot bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS board_snapshots;
DROP TABLE IF EXISTS yjs_updates;
DROP TABLE IF EXISTS boards;
