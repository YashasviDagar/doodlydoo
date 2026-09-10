/**
 * Simple per-connection token bucket, protecting the room/DB from a broken or malicious client
 * flooding messages (e.g. a buggy client stuck in a pointermove loop with no throttling, or
 * someone deliberately hammering the socket). Capacity allows normal drawing bursts through
 * untouched; refill rate is well above anything a real UI could produce (the client already
 * throttles point capture to animation-frame rate, see client/src/canvas/pointCapture.ts) but
 * far below what a scripted flood would send.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
  }

  /** Returns true if a message may proceed (and consumes a token), false if it should be dropped. */
  tryConsume(): boolean {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    if (elapsedSeconds > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
      this.lastRefill = now;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
