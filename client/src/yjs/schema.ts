import * as Y from "yjs";

export type Tool =
  | "pen"
  | "marker"
  | "highlighter"
  | "fountain"
  | "eraser"
  | "rectangle"
  | "ellipse"
  | "line"
  | "arrow"
  | "diamond"
  | "star"
  | "text";

/** Tools whose stroke is a drag-defined geometric shape: points = [x0,y0,x1,y1] (drag start ->
 * current corner), not a freehand path. */
export const SHAPE_TOOLS: ReadonlySet<Tool> = new Set(["rectangle", "ellipse", "line", "arrow", "diamond", "star"]);

export function isShapeTool(tool: Tool): boolean {
  return SHAPE_TOOLS.has(tool);
}

export interface StrokeMeta {
  id: string;
  userId: string;
  tool: Tool;
  color: string;
  width: number;
  /** Shape tools only: fill solid vs outline. */
  filled?: boolean;
  /** Text tool only: the committed string. */
  text?: string;
}

export interface StrokeSnapshot extends StrokeMeta {
  points: number[];
  createdAt: number;
  finishedAt: number | null;
}

// Y.Doc top-level shape:
//   strokes: Y.Map<string, Y.Map<...>>   id -> { id, userId, tool, color, width, points: Y.Array<number>, createdAt, finishedAt }
//   meta:    Y.Map<...>                  { clearedAt: number }
// Awareness (cursors/presence) is NOT part of this doc - it's ephemeral protocol state, wired up in Phase 2.

export function getStrokesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap("strokes");
}

export function getMetaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap("meta");
}

export function createStroke(doc: Y.Doc, meta: StrokeMeta, origin?: unknown): void {
  doc.transact(() => {
    const strokes = getStrokesMap(doc);
    const strokeMap = new Y.Map<unknown>();
    strokeMap.set("id", meta.id);
    strokeMap.set("userId", meta.userId);
    strokeMap.set("tool", meta.tool);
    strokeMap.set("color", meta.color);
    strokeMap.set("width", meta.width);
    strokeMap.set("filled", meta.filled ?? false);
    if (meta.text !== undefined) strokeMap.set("text", meta.text);
    strokeMap.set("points", new Y.Array<number>());
    strokeMap.set("createdAt", Date.now());
    strokeMap.set("finishedAt", null);
    strokes.set(meta.id, strokeMap);
  }, origin);
}

export function pushPoints(doc: Y.Doc, strokeId: string, pts: number[], origin?: unknown): void {
  if (pts.length === 0) return;
  doc.transact(() => {
    const strokeMap = getStrokesMap(doc).get(strokeId);
    if (!strokeMap) return;
    (strokeMap.get("points") as Y.Array<number>).push(pts);
  }, origin);
}

export function finishStroke(doc: Y.Doc, strokeId: string, origin?: unknown): void {
  doc.transact(() => {
    const strokeMap = getStrokesMap(doc).get(strokeId);
    if (!strokeMap) return;
    strokeMap.set("finishedAt", Date.now());
  }, origin);
}

/** Live-update a shape's drag end point: points stays [x0,y0,x1,y1] - the first move appends the
 * end pair, every later one replaces it, so remote clients see the shape resize in real time. */
export function updateShapeEnd(doc: Y.Doc, strokeId: string, x1: number, y1: number, origin?: unknown): void {
  doc.transact(() => {
    const strokeMap = getStrokesMap(doc).get(strokeId);
    if (!strokeMap) return;
    const points = strokeMap.get("points") as Y.Array<number>;
    if (points.length < 4) points.push([x1, y1]);
    else {
      points.delete(2, points.length - 2);
      points.push([x1, y1]);
    }
  }, origin);
}

/** Live-update a text stroke's position while dragging: points stays [x,y] - delete the stale
 * pair first, then append the new one, so remote clients see the text move in real time (same
 * delete-then-append pattern as updateShapeEnd). Fires normal Y events, so it syncs and lands
 * in the mover's own undo stack like any other edit. */
export function moveTextOrigin(doc: Y.Doc, strokeId: string, x: number, y: number, origin?: unknown): void {
  doc.transact(() => {
    const strokeMap = getStrokesMap(doc).get(strokeId);
    if (!strokeMap) return;
    const points = strokeMap.get("points") as Y.Array<number>;
    if (points.length >= 2) points.delete(0, points.length - 2);
    points.push([x, y]);
  }, origin);
}

/** Commits (or edits) a text stroke's string. Editing fires normal Y events, so collaborators
 * see the change live and it lands in the editor's own undo stack. */
export function setText(doc: Y.Doc, strokeId: string, text: string, origin?: unknown): void {
  doc.transact(() => {
    const strokeMap = getStrokesMap(doc).get(strokeId);
    if (!strokeMap) return;
    strokeMap.set("text", text);
  }, origin);
}

export function clearCanvas(doc: Y.Doc, origin?: unknown): void {
  doc.transact(() => {
    getMetaMap(doc).set("clearedAt", Date.now());
  }, origin);
}

export function readStroke(strokeMap: Y.Map<unknown>): StrokeSnapshot {
  return {
    id: strokeMap.get("id") as string,
    userId: strokeMap.get("userId") as string,
    tool: strokeMap.get("tool") as Tool,
    color: strokeMap.get("color") as string,
    width: strokeMap.get("width") as number,
    filled: (strokeMap.get("filled") as boolean | undefined) ?? false,
    text: strokeMap.get("text") as string | undefined,
    points: (strokeMap.get("points") as Y.Array<number>).toArray(),
    createdAt: strokeMap.get("createdAt") as number,
    finishedAt: (strokeMap.get("finishedAt") as number | null) ?? null,
  };
}
