import { pool } from "../persistence/db.js";

export interface BoardRow {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
}

/**
 * The single source of truth for "can this user touch this board" - used by both the REST
 * GET /api/boards/:id fast-check and the WS upgrade handler's join gate, so the two can't drift
 * out of sync. Returns null for "doesn't exist" AND "exists but not yours" on purpose: an object-
 * level access check shouldn't leak which boards exist to users who can't access them.
 *
 * Access is granted by ownership OR an explicit invite (invited_users).
 */
export async function getBoardIfAuthorized(boardId: string, userId: string): Promise<BoardRow | null> {
  const result = await pool.query<{ id: string; name: string; owner_id: string; created_at: string }>(
    `SELECT id, name, owner_id, created_at FROM boards
     WHERE id = $1
       AND (owner_id = $2 OR EXISTS (
         SELECT 1 FROM invited_users WHERE board_id = boards.id AND user_id = $2 AND status = 'accepted'
       ))`,
    [boardId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, name: row.name, ownerId: row.owner_id, createdAt: row.created_at };
}
