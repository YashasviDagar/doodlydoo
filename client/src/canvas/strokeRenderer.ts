import type { StrokeSnapshot, Tool } from "../yjs/schema";
import { SHAPE_TOOLS } from "../yjs/schema";

const SHAPE_SET: ReadonlySet<string> = SHAPE_TOOLS;

/** Per-tool width multiplier on top of the user's chosen brush size, and how opaque the ink is. */
const TOOL_STYLE: Record<Tool, { widthFactor: number; alpha: number; cap: CanvasLineCap }> = {
  pen: { widthFactor: 1, alpha: 1, cap: "round" },
  marker: { widthFactor: 2.2, alpha: 0.92, cap: "round" },
  highlighter: { widthFactor: 3, alpha: 0.35, cap: "square" },
  fountain: { widthFactor: 1, alpha: 1, cap: "round" },
  eraser: { widthFactor: 1, alpha: 1, cap: "round" },
  rectangle: { widthFactor: 1, alpha: 1, cap: "round" },
  ellipse: { widthFactor: 1, alpha: 1, cap: "round" },
  line: { widthFactor: 1, alpha: 1, cap: "round" },
  arrow: { widthFactor: 1, alpha: 1, cap: "round" },
  diamond: { widthFactor: 1, alpha: 1, cap: "round" },
  star: { widthFactor: 1, alpha: 1, cap: "round" },
  text: { widthFactor: 1, alpha: 1, cap: "round" },
};

function strokePath(ctx: CanvasRenderingContext2D, points: number[]): void {
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) {
    ctx.lineTo(points[i], points[i + 1]);
  }
  // A single point (no movement yet) still shows as a dot.
  if (points.length === 2) {
    ctx.lineTo(points[0] + 0.01, points[1] + 0.01);
  }
  ctx.stroke();
}

const FOUNTAIN_MIN_FACTOR = 0.4;
const FOUNTAIN_MAX_FACTOR = 1.7;
// Distance between points at "neutral" drawing speed - closer together reads as slower/heavier
// pressure (thicker), further apart as faster (thinner). Points already come batched one flush
// per animation frame (see pointCapture.ts), so spacing is a reasonable proxy for speed without
// needing to store per-point timestamps in the shared doc.
const FOUNTAIN_REFERENCE_DISTANCE = 14;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Fountain-pen taper: redraws the path as many short segments, each with its own width derived
 * from how far apart its two points are, instead of one fixed-width path. */
function drawTaperedPath(ctx: CanvasRenderingContext2D, points: number[], baseWidth: number): void {
  if (points.length === 2) {
    ctx.lineWidth = baseWidth;
    ctx.beginPath();
    ctx.moveTo(points[0], points[1]);
    ctx.lineTo(points[0] + 0.01, points[1] + 0.01);
    ctx.stroke();
    return;
  }
  for (let i = 2; i < points.length; i += 2) {
    const x0 = points[i - 2];
    const y0 = points[i - 1];
    const x1 = points[i];
    const y1 = points[i + 1];
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const factor = clamp(FOUNTAIN_REFERENCE_DISTANCE / Math.max(dist, 1), FOUNTAIN_MIN_FACTOR, FOUNTAIN_MAX_FACTOR);
    ctx.lineWidth = baseWidth * factor;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
}

/** Shape strokes carry exactly [x0,y0,x1,y1] - the drag's start and current corner. */
function shapeBox(points: number[]): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: points[0], y0: points[1], x1: points[points.length - 2], y1: points[points.length - 1] };
}

function traceRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.beginPath();
  ctx.rect(x, y, w, h);
}

function traceEllipsePath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
}

function traceDiamondPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.beginPath();
  ctx.moveTo(cx, y);
  ctx.lineTo(x + w, cy);
  ctx.lineTo(cx, y + h);
  ctx.lineTo(x, cy);
  ctx.closePath();
}

function traceStarPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  // 5-pointed star inscribed in the drag box; outer radius from the center, inner radius ~38%.
  const cx = x + w / 2;
  const cy = y + h / 2;
  const outer = Math.max(Math.abs(w), Math.abs(h)) / 2;
  const inner = outer * 0.382;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = cx + r * Math.cos(angle);
    const py = cy + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawArrowHead(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, width: number, filled: boolean): void {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const head = Math.max(10, width * 3);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - head * Math.cos(angle - Math.PI / 7), y1 - head * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(x1 - head * Math.cos(angle + Math.PI / 7), y1 - head * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  if (filled) ctx.fill();
  else ctx.stroke();
}

const TEXT_FONT = (width: number): string => `${Math.max(12, width * 4)}px system-ui, sans-serif`;
export function estimateTextWidth(text: string, width: number): number {
  return text.length * Math.max(12, width * 4) * 0.55;
}

/** Draws a flattened [x0,y0,x1,y1,...] point list as one smooth stroke path. */
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: StrokeSnapshot): void {
  const { points, color, width, tool, filled } = stroke;

  // Text strokes: anchor point + committed string, drawn with the canvas font.
  if (tool === "text") {
    if (points.length < 2 || !stroke.text) return;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = color;
    ctx.font = TEXT_FONT(width);
    ctx.textBaseline = "top";
    ctx.fillText(stroke.text, points[0], points[1]);
    ctx.restore();
    return;
  }

  // Geometric shapes: two anchor points, fill or outline per the stroke's filled flag.
  if (SHAPE_SET.has(tool)) {
    if (points.length < 4) return;
    const { x0, y0, x1, y1 } = shapeBox(points);
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (tool === "line") {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    } else if (tool === "arrow") {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      drawArrowHead(ctx, x0, y0, x1, y1, width, false);
    } else {
      if (tool === "rectangle") traceRectPath(ctx, x, y, w, h);
      else if (tool === "ellipse") traceEllipsePath(ctx, x, y, w, h);
      else if (tool === "diamond") traceDiamondPath(ctx, x, y, w, h);
      else traceStarPath(ctx, x, y, w, h);
      if (filled) ctx.fill();
      else ctx.stroke();
    }
    ctx.restore();
    return;
  }

  if (points.length < 2) return;

  const style = TOOL_STYLE[tool];
  ctx.save();
  ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : tool === "highlighter" ? "multiply" : "source-over";
  ctx.globalAlpha = tool === "eraser" ? 1 : style.alpha;
  ctx.strokeStyle = color;
  ctx.lineCap = style.cap;
  ctx.lineJoin = "round";

  if (tool === "fountain") {
    drawTaperedPath(ctx, points, width);
  } else {
    ctx.lineWidth = width * style.widthFactor;
    strokePath(ctx, points);
  }
  ctx.restore();
}

export function clearCanvasEl(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

/** Sets up a canvas element's backing resolution for crisp rendering at the current DPR. */
export function setupCanvasDpr(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
