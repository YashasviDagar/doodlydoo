/**
 * Buffers pointermove points and flushes at most once per animation frame, dropping points
 * closer than minDistance to the last accepted point. Keeps Yjs update volume and point-array
 * size bounded instead of firing on every raw pointermove (see PLAN.md risk: "large stroke
 * arrays / update chatter").
 */
export class PointCapture {
  private pending: number[] = [];
  private lastX: number | null = null;
  private lastY: number | null = null;
  private rafHandle: number | null = null;
  private readonly onFlush: (points: number[]) => void;
  private readonly minDistance: number;

  constructor(onFlush: (points: number[]) => void, minDistance = 2) {
    this.onFlush = onFlush;
    this.minDistance = minDistance;
  }

  add(x: number, y: number): void {
    if (this.lastX !== null && this.lastY !== null) {
      const dx = x - this.lastX;
      const dy = y - this.lastY;
      if (dx * dx + dy * dy < this.minDistance * this.minDistance) return;
    }
    this.lastX = x;
    this.lastY = y;
    this.pending.push(x, y);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.rafHandle !== null) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      if (this.pending.length > 0) {
        const batch = this.pending;
        this.pending = [];
        this.onFlush(batch);
      }
    });
  }

  /** Called at the end of a stroke (pointerup). Cancels the pending animation-frame flush but -
   * critically - flushes whatever points it was going to deliver first, synchronously, instead of
   * just discarding them. A cancelled rAF is not a "nothing happened" no-op: if the pointer lifts
   * before the next frame paints (a fast flick, or - as found by directly reproducing this with a
   * dispatched pointerup right after a burst of pointermoves with zero yields between them - any
   * time no animation frame gets a chance to run between the last move and the up), whatever
   * points were sitting in `pending` used to just vanish, silently truncating or fully emptying
   * the stroke depending on how much of it hadn't been flushed yet. That's the actual mechanism
   * behind strokes rendering as fragments/dots instead of continuous lines. */
  reset(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.pending.length > 0) {
      const batch = this.pending;
      this.pending = [];
      this.onFlush(batch);
    }
    this.lastX = null;
    this.lastY = null;
  }
}
