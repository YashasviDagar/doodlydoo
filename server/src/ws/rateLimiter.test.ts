import { describe, expect, it, vi } from "vitest";
import { TokenBucket } from "./rateLimiter.js";

describe("TokenBucket", () => {
  it("allows bursts up to capacity", () => {
    const bucket = new TokenBucket(5, 10);
    for (let i = 0; i < 5; i++) expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it("refills over time", async () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket(2, 10); // 10/sec -> 1 token every 100ms
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);

    vi.advanceTimersByTime(150);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
    vi.useRealTimers();
  });

  it("never exceeds capacity even after a long idle period", () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket(3, 100);
    bucket.tryConsume();
    vi.advanceTimersByTime(60_000);
    let allowed = 0;
    for (let i = 0; i < 10; i++) if (bucket.tryConsume()) allowed++;
    expect(allowed).toBe(3);
    vi.useRealTimers();
  });
});
