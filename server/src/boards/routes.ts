import { Router } from "express";
import { z } from "zod";
import { pool } from "../persistence/db.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { getBoardIfAuthorized } from "./access.js";
import { notifyUser } from "../ws/notifications.js";
import { notifyBoardRenamed, closeBoardRoom } from "../ws/roomManager.js";

export const boardsRouter = Router();
boardsRouter.use(requireAuth);

const createBoardSchema = z.object({
  name: z.string().min(1).max(200).optional(),
});

boardsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = createBoardSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const name = parsed.data.name ?? "Untitled board";

    // A JWT is stateless and self-verifying (see auth/jwt.ts) - it stays "valid" even if the
    // account it names was deleted after the token was issued (e.g. a dev DB wipe while a
    // browser tab was still logged in - see PLAN.md). Checked explicitly, up front, with a fast
    // indexed lookup: the alternative (let the INSERT hit the owner_id foreign key and catch the
    // violation) also works, but measured at 10+ seconds for PGlite to actually report that
    // violation, which is its own live-status-affecting problem, not just "the wrong error
    // message" - see PLAN.md if this needs a real fix in PGlite itself. This check is cheap.
    const owner = await pool.query<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [req.user!.sub]);
    if (owner.rows.length === 0) {
      res.status(401).json({ error: "account_not_found" });
      return;
    }

    const result = await pool.query<{ id: string; name: string; created_at: string }>(
      `INSERT INTO boards (owner_id, name) VALUES ($1, $2) RETURNING id, name, created_at`,
      [req.user!.sub, name],
    );
    const board = result.rows[0];
    res.status(201).json({ id: board.id, name: board.name, createdAt: board.created_at, isOwner: true });
  }),
);

// Boards you own, plus boards someone has explicitly invited you to.
boardsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const result = await pool.query<{
      id: string;
      name: string;
      created_at: string;
      last_active_at: string;
      is_owner: boolean;
    }>(
      `SELECT id, name, created_at, last_active_at, true AS is_owner FROM boards WHERE owner_id = $1
     UNION ALL
     SELECT b.id, b.name, b.created_at, b.last_active_at, false AS is_owner
       FROM boards b JOIN invited_users iu ON iu.board_id = b.id
       WHERE iu.user_id = $1 AND iu.status = 'accepted'
     ORDER BY last_active_at DESC`,
      [req.user!.sub],
    );
    res.json(
      result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        lastActiveAt: r.last_active_at,
        isOwner: r.is_owner,
      })),
    );
  }),
);

// Owner-only delete. All child rows (yjs_updates, board_snapshots, invited_users) cascade via
// FK, so the single row delete is the whole cleanup - but any LIVE room for this board must be
// evicted first, or its in-memory Y.Doc keeps accepting strokes that get persisted into
// now-orphaned rows (roomManager's eviction path also flushes/compacts, which we must NOT let
// write after the delete).
boardsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const boardId = req.params.id;
    if (!UUID_RE.test(boardId)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const result = await pool.query<{ id: string }>(
      `DELETE FROM boards WHERE id = $1 AND owner_id = $2 RETURNING id`,
      [boardId, req.user!.sub],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    closeBoardRoom(boardId);
    res.json({ ok: true });
  }),
);

// A non-owner removes their own access to a shared board (leaves it). The board itself and every
// other collaborator's access is untouched. Idempotent in effect: leaving a board you don't have
// an accepted invite for is a 404, same collapsed not-found/no-access semantics as above.
boardsRouter.post(
  "/:id/leave",
  asyncHandler(async (req, res) => {
    const boardId = req.params.id;
    if (!UUID_RE.test(boardId)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const result = await pool.query<{ board_id: string }>(
      `DELETE FROM invited_users WHERE board_id = $1 AND user_id = $2 AND status = 'accepted' RETURNING board_id`,
      [boardId, req.user!.sub],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ok: true });
  }),
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The fast HTTP pre-check from the bootstrap flow: confirms access BEFORE the client ever
// attempts a WebSocket connection, so a denied user gets a clean error instead of a socket
// that opens and then gets rejected.
boardsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const boardId = req.params.id;
    if (!UUID_RE.test(boardId)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const board = await getBoardIfAuthorized(boardId, req.user!.sub);
    if (!board) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ...board, isOwner: board.ownerId === req.user!.sub });
  }),
);

const renameBoardSchema = z.object({ name: z.string().min(1).max(200) });

// Any accepted collaborator (owner OR invited-and-accepted) can rename, done inline from the
// board itself rather than a separate settings page.
boardsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const boardId = req.params.id;
    if (!UUID_RE.test(boardId)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = renameBoardSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const board = await getBoardIfAuthorized(boardId, req.user!.sub);
    if (!board) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const result = await pool.query<{ id: string; name: string }>(
      `UPDATE boards SET name = $1 WHERE id = $2 RETURNING id, name`,
      [parsed.data.name, boardId],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Live-push to anyone currently on this board (including the renaming client's own open
    // board socket) - without this, only the REST caller's own optimistic UI update reflects the
    // new name, and every other collaborator (and the renaming client's own board socket) shows
    // the old one until a manual reload.
    notifyBoardRenamed(boardId, result.rows[0].name);
    res.json(result.rows[0]);
  }),
);

const inviteSchema = z.object({
  // Email or username - both are unique identities in the users table. Email is the intended
  // path; username still works. Only the invitee's display_name is ever shown to collaborators,
  // never the email itself.
  username: z.string().min(1),
});

// Owner-only: invite another registered user by username. Deliberately does not reveal whether a
// username belongs to a registered user beyond "not_found" (no account enumeration). Creates a
// *pending* invite rather than granting access immediately - the invitee has to accept it (see
// invites/routes.ts) - and pushes a live notification if they're online (ws/notifications.ts).
boardsRouter.post(
  "/:id/invites",
  asyncHandler(async (req, res) => {
    const boardId = req.params.id;
    if (!UUID_RE.test(boardId)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const owned = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM boards WHERE id = $1 AND owner_id = $2`,
      [boardId, req.user!.sub],
    );
    const board = owned.rows[0];
    if (!board) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }

    const userResult = await pool.query<{ id: string; username: string; displayName: string }>(
      `SELECT id, username, display_name AS "displayName" FROM users WHERE username = $1 OR email = lower($1)`,
      [parsed.data.username],
    );
    const invitee = userResult.rows[0];
    if (!invitee) {
      res.status(404).json({ error: "user_not_found" });
      return;
    }
    if (invitee.id === req.user!.sub) {
      res.status(400).json({ error: "cannot_invite_self" });
      return;
    }

    const insertResult = await pool.query<{ status: string }>(
      `INSERT INTO invited_users (board_id, user_id, status) VALUES ($1, $2, 'pending')
       ON CONFLICT (board_id, user_id) DO NOTHING
       RETURNING status`,
      [boardId, invitee.id],
    );
    let status = insertResult.rows[0]?.status;
    if (!status) {
      const existing = await pool.query<{ status: string }>(
        `SELECT status FROM invited_users WHERE board_id = $1 AND user_id = $2`,
        [boardId, invitee.id],
      );
      status = existing.rows[0]?.status ?? "pending";
    } else {
      notifyUser(invitee.id, {
        type: "invite",
        boardId,
        boardName: board.name,
        inviterDisplayName: req.user!.displayName,
      });
    }
    res.status(201).json({ id: invitee.id, username: invitee.username, displayName: invitee.displayName, status });
  }),
);

boardsRouter.get(
  "/:id/invites",
  asyncHandler(async (req, res) => {
    const boardId = req.params.id;
    const owned = await pool.query<{ id: string }>(`SELECT id FROM boards WHERE id = $1 AND owner_id = $2`, [
      boardId,
      req.user!.sub,
    ]);
    if (owned.rows.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const result = await pool.query<{ id: string; username: string; displayName: string; status: string }>(
      `SELECT u.id, u.username, u.display_name AS "displayName", iu.status FROM invited_users iu JOIN users u ON u.id = iu.user_id
     WHERE iu.board_id = $1 ORDER BY iu.invited_at ASC`,
      [boardId],
    );
    res.json(result.rows);
  }),
);
