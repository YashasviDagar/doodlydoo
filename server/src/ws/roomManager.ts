import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import { Room } from "./room.js";
import { InMemoryRelay, RedisRelay, type PubSubRelay } from "./relay.js";
import { appendUpdates, compactBoard, loadBoardUpdate, touchBoardActivity } from "../persistence/yjsStore.js";
import { logger } from "../logger.js";
import { env } from "../config/env.js";
import { MESSAGE_BOARD_RENAMED } from "./protocol.js";

// One relay for the whole process: InMemoryRelay is a correct no-op for a single instance;
// RedisRelay only turns on when REDIS_URL is set (Railway with 2+ instances). Every Room shares
// it rather than each opening its own Redis connections.
const relay: PubSubRelay = env.redisUrl ? new RedisRelay(env.redisUrl) : new InMemoryRelay();
logger.info({ relay: env.redisUrl ? "redis" : "in-memory" }, "ws pub/sub relay initialized");

const PERSIST_LOAD_ORIGIN = "persistence-load";
const COMPACT_THRESHOLD = 50; // force an early compaction if a room is unusually chatty
// Overridable via env for local testing (waiting 60s/30s in a verification script is wasteful);
// production/Railway just uses the defaults.
const COMPACT_INTERVAL_MS = Number(process.env.COMPACT_INTERVAL_MS ?? 30_000);
// Hard floor on how often ANY one board can compact, no matter how fast updates arrive. Without
// this, sustained heavy drawing hits COMPACT_THRESHOLD every fraction of a second and fires
// overlapping compactBoard() calls back-to-back - see PLAN.md deviation #29 for the incident
// (multiple compactions/sec eventually crashed PGlite under the overlap).
const COMPACT_MIN_INTERVAL_MS = Number(process.env.COMPACT_MIN_INTERVAL_MS ?? 2_000);
// Same principle applied to the append-log writes themselves, which turned out to be the bigger
// source of raw query volume: every single Yjs update (every point-push mid-stroke) used to fire
// its own INSERT immediately. Buffer briefly and flush as one batched insert instead - see
// PLAN.md deviation #29.
const APPEND_FLUSH_INTERVAL_MS = Number(process.env.APPEND_FLUSH_INTERVAL_MS ?? 250);
const APPEND_FLUSH_MAX_BUFFER = 30; // flush early if a burst piles up before the timer fires
const IDLE_EVICT_MS = Number(process.env.IDLE_EVICT_MS ?? 60_000); // no sockets for this long -> flush + free the in-memory Y.Doc

const rooms = new Map<string, Room>();
const loadingRooms = new Map<string, Promise<Room>>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

interface CompactionState {
  pendingUpdates: number;
  /** Set while a compaction is in flight; other callers await this instead of racing it. */
  inFlight: Promise<void> | null;
  lastCompactionAt: number;
}
const compactionState = new Map<string, CompactionState>();

interface AppendBufferState {
  buffer: Uint8Array[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Set while a flush is in flight; eviction awaits this instead of racing it. */
  inFlight: Promise<void> | null;
}
const appendBufferState = new Map<string, AppendBufferState>();

/** Runs at most one compaction per board at a time, and never more often than
 * COMPACT_MIN_INTERVAL_MS - the actual fix for deviation #29 (debounced, not per-update). */
function maybeCompact(boardId: string, state: CompactionState, force = false): void {
  if (state.inFlight) return; // one at a time per board
  if (state.pendingUpdates === 0) return; // nothing new since the last compaction
  if (!force && Date.now() - state.lastCompactionAt < COMPACT_MIN_INTERVAL_MS) return;

  state.pendingUpdates = 0;
  state.lastCompactionAt = Date.now();
  state.inFlight = compactBoard(boardId)
    .catch((err) => logger.warn({ err, boardId }, "compaction failed"))
    .finally(() => {
      state.inFlight = null;
    });
}

function flushAppendBuffer(boardId: string, state: AppendBufferState): void {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  if (state.buffer.length === 0) return;
  const batch = state.buffer;
  state.buffer = [];
  state.inFlight = appendUpdates(boardId, batch)
    .catch((err) => logger.warn({ err, boardId, count: batch.length }, "failed to append yjs update batch"))
    .finally(() => {
      state.inFlight = null;
    });
}

function bufferUpdate(boardId: string, state: AppendBufferState, update: Uint8Array): void {
  state.buffer.push(update);
  if (state.buffer.length >= APPEND_FLUSH_MAX_BUFFER) {
    flushAppendBuffer(boardId, state);
    return;
  }
  if (!state.flushTimer) {
    state.flushTimer = setTimeout(() => flushAppendBuffer(boardId, state), APPEND_FLUSH_INTERVAL_MS);
  }
}

export async function getOrCreateRoom(boardId: string): Promise<Room> {
  const existing = rooms.get(boardId);
  if (existing) return existing;

  const inFlight = loadingRooms.get(boardId);
  if (inFlight) return inFlight;

  const loadPromise = createAndLoadRoom(boardId);
  loadingRooms.set(boardId, loadPromise);
  try {
    return await loadPromise;
  } finally {
    loadingRooms.delete(boardId);
  }
}

async function createAndLoadRoom(boardId: string): Promise<Room> {
  await touchBoardActivity(boardId);
  const room = new Room(boardId, relay);

  const persisted = await loadBoardUpdate(boardId);
  if (persisted) Y.applyUpdate(room.doc, persisted, PERSIST_LOAD_ORIGIN);

  const compaction: CompactionState = { pendingUpdates: 0, inFlight: null, lastCompactionAt: 0 };
  compactionState.set(boardId, compaction);
  const appendBuffer: AppendBufferState = { buffer: [], flushTimer: null, inFlight: null };
  appendBufferState.set(boardId, appendBuffer);

  room.onUpdate = (update) => {
    bufferUpdate(boardId, appendBuffer, update);
    compaction.pendingUpdates++;
    if (compaction.pendingUpdates >= COMPACT_THRESHOLD) maybeCompact(boardId, compaction);
  };

  rooms.set(boardId, room);
  logger.info({ boardId }, "room loaded");
  return room;
}

export function cancelIdleEviction(boardId: string): void {
  const timer = idleTimers.get(boardId);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(boardId);
  }
}

export function scheduleIdleEvictionIfEmpty(boardId: string): void {
  const room = rooms.get(boardId);
  if (!room || !room.isEmpty) return;
  cancelIdleEviction(boardId);
  const timer = setTimeout(() => evictIfStillEmpty(boardId), IDLE_EVICT_MS);
  idleTimers.set(boardId, timer);
}

async function evictIfStillEmpty(boardId: string): Promise<void> {
  idleTimers.delete(boardId);
  const room = rooms.get(boardId);
  if (!room || !room.isEmpty) return; // someone reconnected while we waited

  // Flush any buffered-but-not-yet-written updates FIRST, so the final compaction actually sees
  // everything. Both steps bypass their normal throttle (this is a one-shot "about to free this
  // room's memory" flush, not part of the steady-state firehose) but still wait out anything
  // already in flight rather than racing it.
  const appendBuffer = appendBufferState.get(boardId);
  if (appendBuffer) {
    if (appendBuffer.inFlight) await appendBuffer.inFlight;
    flushAppendBuffer(boardId, appendBuffer);
    if (appendBuffer.inFlight) await appendBuffer.inFlight;
  }
  appendBufferState.delete(boardId);

  const compaction = compactionState.get(boardId);
  if (compaction) {
    if (compaction.inFlight) await compaction.inFlight;
    maybeCompact(boardId, compaction, true);
    if (compaction.inFlight) await compaction.inFlight;
  }
  compactionState.delete(boardId);

  // Re-check right before the point of no return: flush and compaction above are real async DB
  // round-trips, not instantaneous, and a client can reconnect to this exact room while they're
  // in flight (getOrCreateRoom finds it still sitting in `rooms` - it isn't removed until the
  // line below). The stale top-of-function check only guarded the wait for the idle timer itself,
  // not this second wait. Without this re-check, that reconnecting client got attached to a room
  // whose Y.Doc was then unconditionally destroyed under it: doc.destroy() tears down the
  // 'update' listener the room depends on for both broadcasting AND persistence (see the
  // constructor above), so the socket stayed open and looked fine while every subsequent stroke
  // or clear that client made silently vanished - never sent to other clients, never written to
  // Postgres - which is exactly the "drew something this session, it's just gone" symptom.
  if (!room.isEmpty) {
    logger.info({ boardId }, "room eviction aborted - a client reconnected during flush/compaction");
    return;
  }

  room.destroy();
  rooms.delete(boardId);
  logger.info({ boardId }, "room evicted after idle timeout");
}

/** Periodic sweep so rooms with steady-but-below-threshold traffic still get compacted, still
 * subject to the same one-at-a-time/min-interval guard as the threshold trigger. */
setInterval(() => {
  for (const room of rooms.values()) {
    const state = compactionState.get(room.boardId);
    if (state) maybeCompact(room.boardId, state);
  }
}, COMPACT_INTERVAL_MS).unref();

/**
 * Live-pushes a rename to everyone currently connected to this board (boards/routes.ts calls this
 * after a successful PATCH). Postgres stays the single source of truth for the name - if no room
 * is loaded right now, there's nothing to push to, and the next person to open the board picks up
 * the new name from the ordinary GET /boards/:id fetch. This is purely a best-effort "don't make
 * an already-open tab go stale" nudge, same philosophy as ws/notifications.ts's notifyUser.
 */
export function notifyBoardRenamed(boardId: string, name: string): void {
  const room = rooms.get(boardId);
  if (!room) return;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_BOARD_RENAMED);
  encoding.writeVarString(encoder, name);
  room.broadcast(encoding.toUint8Array(encoder), null);
}

export function activeRoomCount(): number {
  return rooms.size;
}

/**
 * Force-evicts a board's live room (boards/routes.ts DELETE /:id calls this right after the DB
 * row is gone). Closes every connected socket so clients get the disconnect state instead of
 * silently continuing to draw into a doc whose persistence is now orphaned, and skips the normal
 * flush/compact-on-evict path on purpose: the board no longer exists, so flushing buffered
 * updates or compacting would just write rows for a deleted board.
 */
export function closeBoardRoom(boardId: string): void {
  cancelIdleEviction(boardId);
  const room = rooms.get(boardId);
  if (!room) return;
  for (const ws of room.sockets) {
    try {
      ws.close(4004, "board_deleted");
    } catch {
      // already closing/closed - nothing to do
    }
  }
  room.sockets.clear();
  room.destroy();
  rooms.delete(boardId);
  appendBufferState.delete(boardId);
  compactionState.delete(boardId);
  logger.info({ boardId }, "room closed (board deleted)");
}

export function activeConnectionCount(): number {
  let total = 0;
  for (const room of rooms.values()) total += room.sockets.size;
  return total;
}
