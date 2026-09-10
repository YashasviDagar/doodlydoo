import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import type { WebSocket } from "ws";
import { MESSAGE_AWARENESS, MESSAGE_SYNC } from "./protocol.js";
import type { PubSubRelay } from "./relay.js";
import { InMemoryRelay } from "./relay.js";
import { logger } from "../logger.js";

type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

// Marks a doc/awareness change as having come from another server instance via the relay, so
// this instance doesn't publish it right back out (which would echo forever across instances).
const RELAY_ORIGIN = Symbol("relay");

function describeOrigin(origin: unknown): string {
  if (origin === RELAY_ORIGIN) return "relay";
  if (origin === null || origin === undefined) return "null";
  if (typeof origin === "string") return origin; // e.g. "persistence-load"
  if (typeof origin === "object") return "ws-client";
  return String(origin);
}

/**
 * One board's live collaboration state: the authoritative in-memory Y.Doc, Awareness (cursors/
 * presence - never persisted, see PLAN.md), and the sockets currently connected to it. Broadcasts
 * doc/awareness changes to every LOCAL socket except whichever one caused them, and - via the
 * relay - to every other server instance holding this same board open (see ws/relay.ts).
 */
export class Room {
  readonly boardId: string;
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly sockets = new Set<WebSocket>();
  private readonly connControlledIds = new Map<WebSocket, Set<number>>();
  private readonly unsubscribeRelay: () => void;

  /** Phase 3 persistence hooks into this instead of the room reaching into the DB itself. */
  onUpdate?: (update: Uint8Array) => void;

  constructor(boardId: string, relay: PubSubRelay = new InMemoryRelay()) {
    this.boardId = boardId;

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const recipientCount = Math.max(0, this.sockets.size - (this.sockets.has(origin as WebSocket) ? 1 : 0));
      logger.debug(
        {
          boardId,
          bytes: update.length,
          origin: describeOrigin(origin),
          sockets: this.sockets.size,
          recipients: recipientCount,
          t: Date.now(),
        },
        "doc update: broadcasting",
      );
      this.broadcast(encoding.toUint8Array(encoder), origin);
      this.onUpdate?.(update);
      if (origin !== RELAY_ORIGIN) relay.publish(boardId, encoding.toUint8Array(encoder));
    });

    this.awareness.on("update", (change: AwarenessChange, origin: unknown) => {
      const changed = change.added.concat(change.updated, change.removed);
      if (origin && this.connControlledIds.has(origin as WebSocket)) {
        const ids = this.connControlledIds.get(origin as WebSocket)!;
        change.added.forEach((id) => ids.add(id));
        change.removed.forEach((id) => ids.delete(id));
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      const message = encoding.toUint8Array(encoder);
      this.broadcast(message, origin);
      if (origin !== RELAY_ORIGIN) relay.publish(boardId, message);
    });

    // Messages arriving from another instance are already framed exactly like the ones we send
    // over WebSocket (MESSAGE_SYNC/MESSAGE_AWARENESS) - decode with the same switch as server.ts.
    this.unsubscribeRelay = relay.subscribe(boardId, (message) => {
      const decoder = decoding.createDecoder(message);
      const messageType = decoding.readVarUint(decoder);
      if (messageType === MESSAGE_SYNC) {
        syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), this.doc, RELAY_ORIGIN);
      } else if (messageType === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), RELAY_ORIGIN);
      }
    });
  }

  addSocket(ws: WebSocket): void {
    this.sockets.add(ws);
    this.connControlledIds.set(ws, new Set());
  }

  removeSocket(ws: WebSocket): void {
    this.sockets.delete(ws);
    const ids = this.connControlledIds.get(ws);
    this.connControlledIds.delete(ws);
    if (ids && ids.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(ids), null);
    }
  }

  broadcast(message: Uint8Array, origin: unknown): void {
    for (const ws of this.sockets) {
      if (ws === origin) continue;
      if (ws.readyState === ws.OPEN) ws.send(message);
    }
  }

  get isEmpty(): boolean {
    return this.sockets.size === 0;
  }

  destroy(): void {
    this.unsubscribeRelay();
    this.awareness.destroy();
    this.doc.destroy();
  }
}
