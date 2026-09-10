import * as Y from "yjs";
import { pool } from "./db.js";
import { logger } from "../logger.js";

/**
 * Bookkeeping touch only - by the time a room is created, the WS upgrade gate has already
 * confirmed the board exists and this user owns it (see ws/server.ts + boards/access.ts), so
 * there's nothing left to "ensure". (Phase 3 had this insert the row itself, back when boards
 * were created ad-hoc with no owner; that path is gone now that owner_id is NOT NULL.)
 */
export async function touchBoardActivity(boardId: string): Promise<void> {
  await pool.query(`UPDATE boards SET last_active_at = now() WHERE id = $1`, [boardId]);
}

/**
 * Batched insert: one query for many updates instead of one query per update. Continuous fast
 * drawing can produce dozens of Yjs updates/sec per client (every point-push is its own update),
 * and firing an individual INSERT for each one turned out to be enough raw query volume to crash
 * PGlite on its own even with compaction properly debounced - see PLAN.md deviation #29. Callers
 * buffer updates and flush on a short timer (roomManager.ts) rather than calling this per-update.
 */
export async function appendUpdates(boardId: string, updates: Uint8Array[]): Promise<void> {
  if (updates.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [boardId];
  for (const update of updates) {
    values.push(`($1, $${params.length + 1})`);
    params.push(Buffer.from(update));
  }
  await pool.query(`INSERT INTO yjs_updates (board_id, update) VALUES ${values.join(", ")}`, params);
}

/**
 * Loads a board's persisted state as a single combined Yjs update: the last snapshot (if any)
 * plus any log rows written after it, replayed into a scratch doc. Returns null for a board with
 * no persisted history yet (brand new board).
 */
export async function loadBoardUpdate(boardId: string): Promise<Uint8Array | null> {
  const snapshotResult = await pool.query<{ snapshot: Buffer; through_update_id: string }>(
    `SELECT snapshot, through_update_id FROM board_snapshots WHERE board_id = $1`,
    [boardId],
  );
  const snapshotRow = snapshotResult.rows[0];
  const throughId = snapshotRow ? BigInt(snapshotRow.through_update_id) : 0n;

  const logResult = await pool.query<{ update: Buffer }>(
    `SELECT update FROM yjs_updates WHERE board_id = $1 AND id > $2 ORDER BY id ASC`,
    [boardId, throughId.toString()],
  );

  if (!snapshotRow && logResult.rows.length === 0) return null;

  const scratch = new Y.Doc();
  try {
    if (snapshotRow) Y.applyUpdate(scratch, snapshotRow.snapshot);
    for (const row of logResult.rows) Y.applyUpdate(scratch, row.update);
    return Y.encodeStateAsUpdate(scratch);
  } finally {
    scratch.destroy();
  }
}

/**
 * WAL-style compaction: merges every log row newer than the current snapshot into a new
 * snapshot, then deletes the rows it just folded in. Safe to call concurrently/redundantly from
 * multiple instances - Yjs updates are commutative, so at worst two compactions redo the same
 * merge; the result is never wrong. See PLAN.md for the full tradeoff writeup.
 */
export async function compactBoard(boardId: string): Promise<void> {
  const client = await pool.connect();
  // A checked-out client (pool.connect(), needed here for a real BEGIN/COMMIT transaction) is
  // NOT covered by pool.on('error', ...) - that only covers idle clients sitting in the pool
  // (see PLAN.md deviation #27). While checked out, the client is its own EventEmitter and can
  // emit 'error' asynchronously (a dropped connection) outside of any specific query's promise -
  // with no listener that crashes the whole process exactly like the pool did before deviation
  // #27, just on a different object.
  //
  // The pool REUSES Client instances across checkouts, so this listener must be removed before
  // release() - attaching a fresh one on every call without removing the old ones leaked a
  // listener per compaction onto whichever underlying Client object the pool handed back, until
  // Node's MaxListenersExceededWarning fired. See PLAN.md deviation #29 for the incident.
  const onClientError = (err: Error): void => {
    logger.warn({ err, boardId }, "pg client error during compaction (connection likely dropped)");
  };
  client.on("error", onClientError);
  const releaseClient = (err?: Error): void => {
    client.off("error", onClientError);
    client.release(err);
  };

  try {
    await client.query("BEGIN");

    const snapshotResult = await client.query<{ snapshot: Buffer; through_update_id: string }>(
      `SELECT snapshot, through_update_id FROM board_snapshots WHERE board_id = $1 FOR UPDATE`,
      [boardId],
    );
    const snapshotRow = snapshotResult.rows[0];
    const throughId = snapshotRow ? BigInt(snapshotRow.through_update_id) : 0n;

    const logResult = await client.query<{ id: string; update: Buffer }>(
      `SELECT id, update FROM yjs_updates WHERE board_id = $1 AND id > $2 ORDER BY id ASC`,
      [boardId, throughId.toString()],
    );

    if (logResult.rows.length === 0) {
      await client.query("COMMIT");
      releaseClient();
      return;
    }

    const updates = logResult.rows.map((r) => new Uint8Array(r.update));
    const merged = snapshotRow ? Y.mergeUpdates([new Uint8Array(snapshotRow.snapshot), ...updates]) : Y.mergeUpdates(updates);
    const newThroughId = logResult.rows[logResult.rows.length - 1].id;

    await client.query(
      `INSERT INTO board_snapshots (board_id, snapshot, through_update_id, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (board_id) DO UPDATE
         SET snapshot = excluded.snapshot, through_update_id = excluded.through_update_id, updated_at = now()`,
      [boardId, Buffer.from(merged), newThroughId],
    );
    await client.query(`DELETE FROM yjs_updates WHERE board_id = $1 AND id <= $2`, [boardId, newThroughId]);

    await client.query("COMMIT");
    releaseClient();
    logger.debug({ boardId, mergedRows: logResult.rows.length }, "compacted board update log");
  } catch (err) {
    // The connection may already be dead (that's often why we're here), in which case ROLLBACK
    // itself rejects too - guard it separately so that doesn't turn into a second, unrelated
    // unhandled rejection on top of the original error.
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      logger.warn({ err: rollbackErr, boardId }, "rollback also failed (connection likely dead)");
    }
    // Tell the pool this client is suspect so it's discarded instead of recycled for the next
    // caller - reusing a half-dead connection would just push this same failure downstream.
    releaseClient(err instanceof Error ? err : new Error(String(err)));
    logger.warn({ err, boardId }, "board compaction failed");
  }
}
