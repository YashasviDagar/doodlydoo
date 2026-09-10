import type { WebSocket } from "ws";
import { logger } from "../logger.js";

/**
 * Per-user notification sockets (distinct from the per-board Room sockets in roomManager.ts) -
 * lets the server push things like "you were invited to a board" while the user is online.
 * Per-process only, same "correct no-op for a single instance" philosophy as InMemoryRelay (see
 * ws/relay.ts): this app currently deploys as one instance. Multi-instance would need the same
 * Redis relay pattern already used for board updates, layered on top of this later - not needed
 * yet, so not built now.
 */
const connectionsByUser = new Map<string, Set<WebSocket>>();

export function registerNotificationSocket(userId: string, ws: WebSocket): void {
  let sockets = connectionsByUser.get(userId);
  if (!sockets) {
    sockets = new Set();
    connectionsByUser.set(userId, sockets);
  }
  sockets.add(ws);
}

export function unregisterNotificationSocket(userId: string, ws: WebSocket): void {
  const sockets = connectionsByUser.get(userId);
  if (!sockets) return;
  sockets.delete(ws);
  if (sockets.size === 0) connectionsByUser.delete(userId);
}

export interface InviteNotification {
  type: "invite";
  boardId: string;
  boardName: string;
  inviterDisplayName: string;
}

/** Pushed to a board's owner when someone they invited accepts, so an InvitePanel they already
 * have open updates live instead of showing "pending" until they happen to reload. */
export interface InviteAcceptedNotification {
  type: "invite_accepted";
  boardId: string;
  displayName: string;
}

/** Best-effort: if the user isn't currently connected, this is a no-op - the invite (or its
 * accepted status) is still correct in the DB, just not pushed live; the next load picks it up
 * via GET /api/invites or GET /boards/:id/invites instead. */
export function notifyUser(userId: string, payload: InviteNotification | InviteAcceptedNotification): void {
  const sockets = connectionsByUser.get(userId);
  if (!sockets || sockets.size === 0) return;
  const message = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState !== ws.OPEN) continue;
    ws.send(message, (err) => {
      if (err) logger.warn({ err, userId }, "notification send failed");
    });
  }
}
