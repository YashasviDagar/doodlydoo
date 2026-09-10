import type { Server as HttpServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import { cancelIdleEviction, getOrCreateRoom, scheduleIdleEvictionIfEmpty } from "./roomManager.js";
import { MESSAGE_AWARENESS, MESSAGE_SYNC } from "./protocol.js";
import { logger } from "../logger.js";
import { verifyAuthToken } from "../auth/jwt.js";
import { getBoardIfAuthorized } from "../boards/access.js";
import { TokenBucket } from "./rateLimiter.js";
import { registerNotificationSocket, unregisterNotificationSocket } from "./notifications.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Two separate buckets, not one shared one - see PLAN.md deviation #31. Awareness (cursor/
// presence) is ephemeral and self-correcting, so it's fine to actually rate-limit it as abuse
// protection. Doc/sync updates are NOT safe to drop - each one is irreplaceable drawn content
// with no resync mechanism to recover it later - so its ceiling is sized purely as a backstop
// against a genuine flood (thousands/sec from a broken or malicious client), not a limit real
// drawing should ever approach even on a high refresh-rate display. A single shared bucket let a
// burst of high-frequency point-updates starve the much lower-volume awareness stream's share of
// tokens, silently and permanently dropping stroke data while cursors kept working.
const SYNC_RATE_LIMIT_CAPACITY = 3000;
const SYNC_RATE_LIMIT_REFILL_PER_SECOND = 1500;
const AWARENESS_RATE_LIMIT_CAPACITY = 150;
const AWARENESS_RATE_LIMIT_REFILL_PER_SECOND = 75;
const MAX_CONSECUTIVE_DROPS = 100; // close the connection if it keeps hammering past the limit

function send(ws: WebSocket, message: Uint8Array): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(message, (err) => {
    if (err) logger.warn({ err }, "ws send failed");
  });
}

function reject(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
  socket.destroy();
}

export function attachWsServer(server: HttpServer): WebSocketServer {
  // The client sends its JWT as a WebSocket subprotocol (not a query string, which would land
  // in server access logs / browser history) - handleProtocols just needs to echo one of the
  // offered values back so the browser completes the handshake; the actual verification happens
  // below, before wss.handleUpgrade is ever called.
  const handleProtocols = (protocols: Set<string>) => protocols.values().next().value ?? false;
  const wss = new WebSocketServer({ noServer: true, handleProtocols });
  // Separate socket server for the per-user notification channel (invite popups etc.) - distinct
  // from the per-board room sockets above, so a user gets pushes independent of which/whether a
  // board is open. See ws/notifications.ts.
  const notificationsWss = new WebSocketServer({ noServer: true, handleProtocols });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Root cause of a real crash: this raw socket had no 'error' listener, and the upgrade path
    // below does async work (verifyAuthToken, DB lookups) before ever calling wss.handleUpgrade.
    // If the client disconnects abruptly during that window, the socket emits an unhandled
    // ECONNRESET - Node's default for an EventEmitter 'error' with zero listeners is to throw,
    // which took down the entire process (see server log: "Emitted 'error' event on Socket
    // instance", right after a client disconnect). Same class of gap already documented for the
    // PGlite dev socket in pgliteServer.ts, just on the app server's own upgrade socket instead.
    socket.on("error", (err) => {
      logger.warn({ err }, "ws upgrade socket error - client likely disconnected mid-handshake");
    });

    const url = new URL(req.url ?? "", "http://internal");
    if (url.pathname === "/ws") {
      handleUpgrade(req, socket, head, wss).catch((err) => {
        logger.error({ err }, "unhandled error during ws upgrade");
        try {
          reject(socket, "500 Internal Server Error");
        } catch {
          socket.destroy();
        }
      });
    } else if (url.pathname === "/ws/notifications") {
      handleNotificationsUpgrade(req, socket, head, notificationsWss).catch((err) => {
        logger.error({ err }, "unhandled error during notifications ws upgrade");
        try {
          reject(socket, "500 Internal Server Error");
        } catch {
          socket.destroy();
        }
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws: WebSocket, boardId: string) => {
    handleConnection(ws, boardId).catch((err) => {
      logger.error({ err, boardId }, "failed to establish ws connection");
      ws.close();
    });
  });

  notificationsWss.on("connection", (ws: WebSocket, userId: string) => {
    registerNotificationSocket(userId, ws);
    logger.debug({ userId }, "notifications ws client connected");
    ws.on("close", () => {
      unregisterNotificationSocket(userId, ws);
      logger.debug({ userId }, "notifications ws client disconnected");
    });
    ws.on("error", (err) => {
      logger.warn({ err, userId }, "notifications ws connection error");
    });
  });

  return wss;
}

async function handleNotificationsUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
): Promise<void> {
  const token = req.headers["sec-websocket-protocol"]?.split(",")[0]?.trim();
  if (!token) {
    reject(socket, "400 Bad Request");
    return;
  }
  const payload = verifyAuthToken(token);
  if (!payload) {
    reject(socket, "401 Unauthorized");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, payload.sub);
  });
}

async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): Promise<void> {
  const url = new URL(req.url ?? "", "http://internal");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const boardId = url.searchParams.get("boardId");
  const token = req.headers["sec-websocket-protocol"]?.split(",")[0]?.trim();
  if (!boardId || !UUID_RE.test(boardId) || !token) {
    reject(socket, "400 Bad Request");
    return;
  }

  // The real access-control gate: verify the JWT AND that this user owns (or, from Phase 5, is
  // invited to) this specific board - fully before wss.handleUpgrade, so an unauthorized socket
  // never joins the in-memory room even momentarily. This is what stops boards from leaking into
  // each other.
  const payload = verifyAuthToken(token);
  if (!payload) {
    reject(socket, "401 Unauthorized");
    return;
  }
  let board;
  try {
    board = await getBoardIfAuthorized(boardId, payload.sub);
  } catch (err) {
    // A dropped DB connection here must fail just THIS upgrade, not take the whole server down
    // with it - see PLAN.md for the incident this fixes.
    logger.error({ err, boardId }, "db error while checking board access on ws upgrade");
    reject(socket, "503 Service Unavailable");
    return;
  }
  if (!board) {
    reject(socket, "403 Forbidden");
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, boardId);
  });
}

async function handleConnection(ws: WebSocket, boardId: string): Promise<void> {
  // Room bootstrap (Phase 3): first connection to a board loads its persisted state - snapshot +
  // any log tail - from Postgres BEFORE we ever send sync step 1, so a joining client's very
  // first sync already contains full history instead of arriving empty-then-updated.
  const room = await getOrCreateRoom(boardId);
  if (ws.readyState !== ws.OPEN) return; // client disconnected while we were loading
  cancelIdleEviction(boardId);
  room.addSocket(ws);
  logger.debug({ boardId, sockets: room.sockets.size }, "ws client joined room");

  // Kick off the handshake: send our state vector so the client can tell us what it's missing.
  {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    send(ws, encoding.toUint8Array(encoder));
  }

  const awarenessStates = room.awareness.getStates();
  if (awarenessStates.size > 0) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(awarenessStates.keys())),
    );
    send(ws, encoding.toUint8Array(encoder));
  }

  const syncRateLimiter = new TokenBucket(SYNC_RATE_LIMIT_CAPACITY, SYNC_RATE_LIMIT_REFILL_PER_SECOND);
  const awarenessRateLimiter = new TokenBucket(AWARENESS_RATE_LIMIT_CAPACITY, AWARENESS_RATE_LIMIT_REFILL_PER_SECOND);
  let consecutiveDrops = 0;

  ws.on("message", (data: ArrayBuffer, isBinary: boolean) => {
    if (!isBinary) return;

    const message = new Uint8Array(data);
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);

    const limiter = messageType === MESSAGE_AWARENESS ? awarenessRateLimiter : syncRateLimiter;
    if (!limiter.tryConsume()) {
      consecutiveDrops++;
      if (consecutiveDrops === 1) logger.warn({ boardId, messageType }, "ws client rate-limited, dropping messages");
      if (consecutiveDrops >= MAX_CONSECUTIVE_DROPS) {
        logger.warn({ boardId }, "ws client exceeded rate limit repeatedly, closing connection");
        ws.close(1008, "rate limit exceeded");
      }
      return;
    }
    consecutiveDrops = 0;

    switch (messageType) {
      case MESSAGE_SYNC: {
        logger.debug({ boardId, bytes: message.length, t: Date.now() }, "doc update: received from client");
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
        if (encoding.length(encoder) > 1) send(ws, encoding.toUint8Array(encoder));
        break;
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), ws);
        break;
      }
      default:
        logger.warn({ messageType }, "unknown ws message type");
    }
  });

  ws.on("close", () => {
    room.removeSocket(ws);
    logger.debug({ boardId, sockets: room.sockets.size }, "ws client left room");
    scheduleIdleEvictionIfEmpty(boardId);
  });

  ws.on("error", (err) => {
    logger.warn({ err, boardId }, "ws connection error");
  });
}
