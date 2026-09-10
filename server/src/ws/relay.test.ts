import { describe, expect, it } from "vitest";
import RedisMock from "ioredis-mock";
import { RedisRelay } from "./relay.js";

// ioredis-mock instances pointed at the same host:port share their in-memory pub/sub bus, so two
// RedisRelay instances here stand in for two separate server processes both connected to the same
// real Redis in production - proving the fan-out logic itself without needing a live Redis server
// (which this dev machine doesn't have; see PLAN.md deviation #1).
describe("RedisRelay", () => {
  it("delivers a published update to a subscriber on a different relay instance", async () => {
    const url = "redis://mock-shared:6379";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const relayA = new RedisRelay(url, RedisMock as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const relayB = new RedisRelay(url, RedisMock as any);

    const received: Uint8Array[] = [];
    relayB.subscribe("board-1", (update) => received.push(update));
    await new Promise((r) => setTimeout(r, 20)); // let the SUBSCRIBE land before publishing

    const payload = new Uint8Array([1, 2, 3, 4]);
    relayA.publish("board-1", payload);
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toHaveLength(1);
    expect(Array.from(received[0])).toEqual([1, 2, 3, 4]);
  });

  it("does not deliver updates published on a different board's channel", async () => {
    const url = "redis://mock-shared-2:6379";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const relayA = new RedisRelay(url, RedisMock as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const relayB = new RedisRelay(url, RedisMock as any);

    const received: Uint8Array[] = [];
    relayB.subscribe("board-1", (update) => received.push(update));
    await new Promise((r) => setTimeout(r, 20));

    relayA.publish("board-2", new Uint8Array([9, 9]));
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toHaveLength(0);
  });

  it("stops delivering after unsubscribe", async () => {
    const url = "redis://mock-shared-3:6379";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const relayA = new RedisRelay(url, RedisMock as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const relayB = new RedisRelay(url, RedisMock as any);

    const received: Uint8Array[] = [];
    const unsubscribe = relayB.subscribe("board-1", (update) => received.push(update));
    await new Promise((r) => setTimeout(r, 20));
    unsubscribe();
    await new Promise((r) => setTimeout(r, 20));

    relayA.publish("board-1", new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toHaveLength(0);
  });
});
