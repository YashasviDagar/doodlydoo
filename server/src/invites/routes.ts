import { Router } from "express";
import { pool } from "../persistence/db.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { notifyUser } from "../ws/notifications.js";

export const invitesRouter = Router();
invitesRouter.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// This user's own pending invites, across all boards - populates the notification popup for
// invites that arrived while they were offline (the live push in ws/notifications.ts only
// reaches a currently-connected socket).
invitesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const result = await pool.query<{
      boardId: string;
      boardName: string;
      inviterDisplayName: string;
      invitedAt: string;
    }>(
      `SELECT iu.board_id AS "boardId", b.name AS "boardName", u.display_name AS "inviterDisplayName", iu.invited_at AS "invitedAt"
       FROM invited_users iu
       JOIN boards b ON b.id = iu.board_id
       JOIN users u ON u.id = b.owner_id
       WHERE iu.user_id = $1 AND iu.status = 'pending'
       ORDER BY iu.invited_at ASC`,
      [req.user!.sub],
    );
    res.json(result.rows);
  }),
);

invitesRouter.post(
  "/:boardId/accept",
  asyncHandler(async (req, res) => {
    const boardId = req.params.boardId;
    if (!UUID_RE.test(boardId)) {
      res.status(404).json({ error: "invite_not_found" });
      return;
    }
    const result = await pool.query<{ board_id: string }>(
      `UPDATE invited_users SET status = 'accepted'
       WHERE board_id = $1 AND user_id = $2 AND status = 'pending'
       RETURNING board_id`,
      [boardId, req.user!.sub],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "invite_not_found" });
      return;
    }

    // Live-update the owner's InvitePanel if they have the board open, instead of leaving it
    // showing "pending" until they happen to reload (see ws/notifications.ts). Best-effort - if
    // this fails, the accept itself already succeeded above, so still answer 200.
    try {
      const owner = await pool.query<{ owner_id: string }>(`SELECT owner_id FROM boards WHERE id = $1`, [boardId]);
      if (owner.rows[0]) {
        notifyUser(owner.rows[0].owner_id, { type: "invite_accepted", boardId, displayName: req.user!.displayName });
      }
    } catch {
      // Non-fatal - see comment above.
    }

    res.json({ boardId });
  }),
);

invitesRouter.post(
  "/:boardId/decline",
  asyncHandler(async (req, res) => {
    const boardId = req.params.boardId;
    if (!UUID_RE.test(boardId)) {
      res.status(404).json({ error: "invite_not_found" });
      return;
    }
    // Deleting (not just marking declined) means the owner can invite this person again later
    // instead of the decline being permanent.
    const result = await pool.query<{ board_id: string }>(
      `DELETE FROM invited_users WHERE board_id = $1 AND user_id = $2 AND status = 'pending' RETURNING board_id`,
      [boardId, req.user!.sub],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "invite_not_found" });
      return;
    }
    res.json({ boardId });
  }),
);
