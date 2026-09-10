import { Redis } from "ioredis";
import { logger } from "../logger.js";

/**
 * Fans a board's Yjs updates out to OTHER server instances. A Room's local sockets are already
 * handled directly by Room.broadcast - this is only for the cross-process hop, which is what
 * scaling a WebSocket server beyond one instance actually requires (connections are sticky to
 * whichever process accepted them).
 */
export interface PubSubRelay {
  publish(boardId: string, update: Uint8Array): void;
  /** Returns an unsubscribe function. */
  subscribe(boardId: string, handler: (update: Uint8Array) => void): () => void;
}

/** Single-instance default: nothing to relay to, so both operations are no-ops. This is exactly
 * correct for local dev and for a single-instance deployment - not a stub standing in for missing
 * functionality. */
export class InMemoryRelay implements PubSubRelay {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

function channelFor(boardId: string): string {
  return `doodlydoo:board:${boardId}:updates`;
}

/** Real cross-instance relay backed by Redis pub/sub. Used whenever REDIS_URL is set (Railway
 * with 2+ instances); see PLAN.md for why this is the standard answer to scaling sticky WS
 * connections horizontally. */
export class RedisRelay implements PubSubRelay {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly handlers = new Map<string, Set<(update: Uint8Array) => void>>();

  constructor(redisUrl: string, RedisClient: typeof Redis = Redis) {
    this.publisher = new RedisClient(redisUrl, { lazyConnect: false });
    this.subscriber = new RedisClient(redisUrl, { lazyConnect: false });
    this.subscriber.on("message", (channel: string, message: string) => {
      const set = this.handlers.get(channel);
      if (!set) return;
      const update = new Uint8Array(Buffer.from(message, "base64"));
      for (const handler of set) handler(update);
    });
    this.publisher.on("error", (err: Error) => logger.warn({ err }, "redis publisher error"));
    this.subscriber.on("error", (err: Error) => logger.warn({ err }, "redis subscriber error"));
  }

  publish(boardId: string, update: Uint8Array): void {
    this.publisher.publish(channelFor(boardId), Buffer.from(update).toString("base64")).catch((err: Error) => {
      logger.warn({ err, boardId }, "redis publish failed");
    });
  }

  subscribe(boardId: string, handler: (update: Uint8Array) => void): () => void {
    const channel = channelFor(boardId);
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      this.subscriber
        .subscribe(channel)
        .catch((err: Error) => logger.warn({ err, boardId }, "redis subscribe failed"));
    }
    set.add(handler);

    return () => {
      set!.delete(handler);
      if (set!.size === 0) {
        this.handlers.delete(channel);
        this.subscriber.unsubscribe(channel).catch(() => {});
      }
    };
  }
}
