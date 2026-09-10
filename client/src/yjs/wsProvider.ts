import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import { Awareness } from "y-protocols/awareness";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
// Keep in sync with server/src/ws/protocol.ts's MESSAGE_BOARD_RENAMED.
const MESSAGE_BOARD_RENAMED = 2;

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

/**
 * Custom Yjs WebSocket client provider (mirrors the y-websocket reference protocol so it talks
 * to our own server, see server/src/ws). Owns reconnect-with-backoff; because Yjs updates are
 * commutative, a state-vector-based re-sync on reconnect is enough - no special "catch up"
 * logic needed beyond sending sync step 1 again on every (re)connect.
 */
export class WsProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  private readonly url: string;
  private readonly authToken: string;
  private ws: WebSocket | null = null;
  private shouldReconnect = true;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();
  private readonly renameListeners = new Set<(name: string) => void>();

  constructor(url: string, authToken: string, doc: Y.Doc, awareness: Awareness) {
    this.url = url;
    this.authToken = authToken;
    this.doc = doc;
    this.awareness = awareness;
    this.doc.on("update", this.handleDocUpdate);
    this.awareness.on("update", this.handleAwarenessUpdate);
    this.connect();
  }

  onStatus(fn: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  onBoardRenamed(fn: (name: string) => void): () => void {
    this.renameListeners.add(fn);
    return () => this.renameListeners.delete(fn);
  }

  private setStatus(s: ConnectionStatus): void {
    for (const fn of this.statusListeners) fn(s);
  }

  private connect(): void {
    this.setStatus("connecting");
    const ws = new WebSocket(this.url, [this.authToken]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setStatus("connected");

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      ws.send(encoding.toUint8Array(encoder));

      if (this.awareness.getLocalState() !== null) {
        const awEncoder = encoding.createEncoder();
        encoding.writeVarUint(awEncoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          awEncoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
        );
        ws.send(encoding.toUint8Array(awEncoder));
      }
    };

    ws.onmessage = (event) => {
      const message = new Uint8Array(event.data as ArrayBuffer);
      const decoder = decoding.createDecoder(message);
      const messageType = decoding.readVarUint(decoder);

      switch (messageType) {
        case MESSAGE_SYNC: {
          // eslint-disable-next-line no-console
          console.debug("[doc-sync] received", { bytes: message.length, t: Date.now() });
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
          if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
          break;
        }
        case MESSAGE_AWARENESS: {
          awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
          break;
        }
        case MESSAGE_BOARD_RENAMED: {
          const name = decoding.readVarString(decoder);
          for (const fn of this.renameListeners) fn(name);
          break;
        }
      }
    };

    ws.onclose = () => {
      this.ws = null;
      this.setStatus("disconnected");
      const remoteIds = Array.from(this.awareness.getStates().keys()).filter((id) => id !== this.doc.clientID);
      if (remoteIds.length > 0) {
        awarenessProtocol.removeAwarenessStates(this.awareness, remoteIds, this);
      }
      if (this.shouldReconnect) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose always follows onerror for browser WebSocket; nothing extra to do here.
    };
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 10000);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      if (this.shouldReconnect) this.connect();
    }, delay);
  }

  private handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return; // don't echo server-originated updates back to the server
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // eslint-disable-next-line no-console
      console.debug("[doc-sync] update dropped, socket not open", { readyState: this.ws?.readyState, t: Date.now() });
      return;
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const bytes = encoding.toUint8Array(encoder);
    // eslint-disable-next-line no-console
    console.debug("[doc-sync] sending", { bytes: bytes.length, origin: origin === null ? "local" : String(origin), t: Date.now() });
    this.ws.send(bytes);
  };

  private handleAwarenessUpdate = (change: AwarenessChange, origin: unknown): void => {
    if (origin === this) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const changed = change.added.concat(change.updated, change.removed);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
    this.ws.send(encoding.toUint8Array(encoder));
  };

  destroy(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.doc.off("update", this.handleDocUpdate);
    this.awareness.off("update", this.handleAwarenessUpdate);
    this.ws?.close();
  }
}
