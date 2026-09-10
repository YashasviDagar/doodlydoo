import { useEffect, useRef, useState } from "react";import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { nanoid } from "nanoid";
import { useToolStore } from "../state/toolStore";
import {
  clearCanvas,
  createStroke,
  finishStroke,
  getMetaMap,
  getStrokesMap,
  pushPoints,
  readStroke,
  setText,
  updateShapeEnd,
  isShapeTool,
} from "../yjs/schema";
import { clearCanvasEl, drawStroke, setupCanvasDpr, estimateTextWidth } from "./strokeRenderer";
import { PointCapture } from "./pointCapture";
import { CursorsOverlay } from "./CursorsOverlay";
import { BOARD_WIDTH, BOARD_HEIGHT } from "./constants";

const CURSOR_THROTTLE_MS = 40;
/** Hit radius (logical px) for double-click-to-edit on text strokes. */
const TEXT_HIT_RADIUS = 40;

export interface CanvasBoardHandle {
  clear: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

interface Props {
  doc: Y.Doc;
  awareness: Awareness;
  localUserId: string;
  /** Exposes imperative controls to the toolbar without lifting canvas state into React. */
  onReady?: (handle: CanvasBoardHandle) => void;
}

export function CanvasBoard({ doc, awareness, localUserId, onReady }: Props) {
  const committedRef = useRef<HTMLCanvasElement | null>(null);
  const liveRef = useRef<HTMLCanvasElement | null>(null);
  const activeStrokeIds = useRef<Set<string>>(new Set());
  const currentStrokeId = useRef<string | null>(null);
  const pointCapture = useRef<PointCapture | null>(null);
  const activePointerId = useRef<number | null>(null);
  const lastCursorSent = useRef(0);
  const undoManagerRef = useRef<Y.UndoManager | null>(null);
  const tool = useToolStore((s) => s.tool);
  const color = useToolStore((s) => s.color);
  const width = useToolStore((s) => s.width);
  const filled = useToolStore((s) => s.filled);
  const toolRef = useRef({ tool, color, width, filled });
  toolRef.current = { tool, color, width, filled };

  // Text tool: an overlay input floats over the canvas at the click point until committed.
  const [textEditor, setTextEditor] = useState<{ x: number; y: number; value: string; strokeId: string | null } | null>(null);
  // Focus race fix: the editor mounts while the pointer is still down on the canvas, and the
  // browser's remaining click/focus handling would immediately blur an autoFocus'd input - whose
  // onBlur commit (empty value) cancels the editor before a single keystroke. Instead we focus
  // programmatically on the NEXT frame (after the gesture fully settles) and ignore blurs that
  // arrive in the same tick the editor opened.
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const textEditorJustOpened = useRef(false);
  // Latest-editor mirror so imperative commits (blur, click-elsewhere) never read a stale closure.
  const textEditorRef = useRef(textEditor);
  textEditorRef.current = textEditor;

  useEffect(() => {
    if (!textEditor) return;
    textEditorJustOpened.current = true;
    const raf = requestAnimationFrame(() => {
      textInputRef.current?.focus();
      // Only after focus has actually settled may a blur commit/cancel.
      requestAnimationFrame(() => {
        textEditorJustOpened.current = false;
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [textEditor?.strokeId, textEditor?.x, textEditor?.y]);

  useEffect(() => {
    const committedCanvas = committedRef.current!;
    const liveCanvas = liveRef.current!;
    const committedCtx = setupCanvasDpr(committedCanvas, BOARD_WIDTH, BOARD_HEIGHT);
    const liveCtx = setupCanvasDpr(liveCanvas, BOARD_WIDTH, BOARD_HEIGHT);

    const strokes = getStrokesMap(doc);
    const meta = getMetaMap(doc);

    // Per-user undo/redo: scoped to the strokes map, and by default Y.UndoManager only tracks
    // transactions with origin === null. Local edits below are transacted with no origin (=null);
    // the WsProvider applies all remote-sourced updates with itself as origin (non-null) - so a
    // user's undo stack only ever contains their own strokes, with zero extra bookkeeping.
    const undoManager = new Y.UndoManager(strokes);
    undoManagerRef.current = undoManager;

    function bakeStrokeById(id: string) {
      const strokeMap = strokes.get(id);
      if (!strokeMap) return;
      drawStroke(committedCtx, readStroke(strokeMap));
    }

    function repaintLive() {
      clearCanvasEl(liveCtx);
      for (const id of activeStrokeIds.current) {
        const strokeMap = strokes.get(id);
        if (!strokeMap) continue;
        drawStroke(liveCtx, readStroke(strokeMap));
      }
    }

    function repaintCommittedAll() {
      clearCanvasEl(committedCtx);
      const clearedAt = (meta.get("clearedAt") as number) ?? 0;
      strokes.forEach((strokeMap, id) => {
        if (activeStrokeIds.current.has(id)) return;
        const snap = readStroke(strokeMap);
        if (snap.createdAt < clearedAt) return;
        drawStroke(committedCtx, snap);
      });
    }

    // Initial paint: covers page load with pre-existing state (local-only now; synced state
    // arrives the same way once the WsProvider applies the server's bootstrap update, Phase 2/3).
    repaintCommittedAll();

    const strokesObserver = (events: Y.YEvent<any>[]) => {
      let liveDirty = false;
      const bakeIds: string[] = [];
      let sawDelete = false;

      for (const event of events) {
        if (event.path.length === 0) {
          for (const [id, change] of event.changes.keys) {
            if (change.action === "delete") {
              sawDelete = true;
              activeStrokeIds.current.delete(id);
              continue;
            }
            if (change.action !== "add") continue;
            const strokeMap = strokes.get(id);
            const finishedAt = strokeMap?.get("finishedAt");
            if (finishedAt == null) {
              activeStrokeIds.current.add(id);
              liveDirty = true;
            } else {
              bakeIds.push(id);
            }
          }
        } else if (event.path.length === 1) {
          const id = event.path[0] as string;
          if (!activeStrokeIds.current.has(id)) {
            // A finished stroke whose metadata changed (double-click text edit is the only way
            // this happens today) needs re-baking - without this, the committed canvas keeps
            // showing the old text and the edit looks like it "didn't save".
            const textChanged = event.changes.keys.has("text");
            if (textChanged) bakeIds.push(id);
            continue;
          }
          const strokeMap = strokes.get(id);
          if (strokeMap?.get("finishedAt") != null) {
            activeStrokeIds.current.delete(id);
            bakeIds.push(id);
            liveDirty = true;
          }
        } else if (event.path.length === 2 && event.path[1] === "points") {
          const id = event.path[0] as string;
          if (activeStrokeIds.current.has(id)) liveDirty = true;
        }
      }

      for (const id of bakeIds) bakeStrokeById(id);
      // An undo can delete a stroke that's already baked onto the committed bitmap; the only
      // correct fix short of tracking per-stroke bitmap regions is a full repaint in that case.
      if (sawDelete) repaintCommittedAll();
      if (liveDirty || sawDelete) repaintLive();
    };
    strokes.observeDeep(strokesObserver);

    const metaObserver = () => {
      // Logical clear: wipe the bitmap and redraw from scratch rather than deleting/replaying
      // stroke entries (avoids tombstone/race issues if another user is mid-stroke concurrently -
      // see PLAN.md). A full repaint, not a bare wipe, so this can never race an "add" event for
      // a stroke created after the clear (e.g. on the very first sync of a board whose history
      // includes both a clear and later strokes) into leaving surviving content unpainted.
      repaintCommittedAll();
    };
    meta.observe(metaObserver);

    onReady?.({
      clear: () => clearCanvas(doc),
      undo: () => undoManager.undo(),
      redo: () => undoManager.redo(),
      canUndo: () => undoManager.undoStack.length > 0,
      canRedo: () => undoManager.redoStack.length > 0,
    });

    return () => {
      strokes.unobserveDeep(strokesObserver);
      meta.unobserve(metaObserver);
      undoManager.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // The canvas is rendered responsively (CSS can shrink it on narrow viewports - see the wrapper
  // below), but strokes are always stored in the fixed BOARD_WIDTH x BOARD_HEIGHT logical space,
  // so pointer coordinates have to be scaled from "however big it's rendered" back to that space.
  function getPos(e: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const rect = liveRef.current!.getBoundingClientRect();
    const scaleX = BOARD_WIDTH / rect.width;
    const scaleY = BOARD_HEIGHT / rect.height;
    return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
  }

  function sendCursor(x: number | null, y: number | null, force = false) {
    const now = performance.now();
    if (!force && now - lastCursorSent.current < CURSOR_THROTTLE_MS) return;
    lastCursorSent.current = now;
    awareness.setLocalStateField("cursor", x === null ? null : { x, y });
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    // Real hardware (trackpad palm contact, a second touch point, stylus quirks) can fire a
    // pointerdown for a SECOND pointer while the first is still down mid-stroke - a synthetic
    // single-pointer mouse (every earlier test here) can never produce that. Without this guard,
    // the stray pointer's id would silently overwrite currentStrokeId, permanently abandoning the
    // real in-progress stroke (it never gets finishStroke'd, so whatever few points it had render
    // as a truncated fragment) while the stray pointer's own single point renders as an isolated
    // dot - exactly the "fragments and dots instead of continuous lines" symptom. Confirmed by
    // reproducing it with a dispatched second PointerEvent mid-drag before this fix existed.
    if (activePointerId.current !== null) return;
    const { tool, color, width, filled } = toolRef.current;
    const [x, y] = getPos(e);

    // Text tool: click with no editor open starts one at the clicked spot; clicking elsewhere
    // while an editor is open just COMMITS and closes - otherwise every stray click teleports the
    // editor around the canvas, which reads as the box "moving by itself". To reposition text,
    // re-select the tool and click deliberately.
    if (tool === "text") {
      if (textEditorRef.current) commitText();
      else setTextEditor({ x, y, value: "", strokeId: null });
      return;
    }

    activePointerId.current = e.pointerId;
    const id = nanoid();
    currentStrokeId.current = id;
    createStroke(doc, { id, userId: localUserId, tool, color, width, filled });
    pushPoints(doc, id, [x, y]);
    if (!isShapeTool(tool)) pointCapture.current = new PointCapture((pts) => pushPoints(doc, id, pts));
    sendCursor(x, y, true);
    liveRef.current!.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const [x, y] = getPos(e);
    sendCursor(x, y);
    if (!currentStrokeId.current || e.pointerId !== activePointerId.current) return;
    if (isShapeTool(toolRef.current.tool)) updateShapeEnd(doc, currentStrokeId.current, x, y);
    else pointCapture.current?.add(x, y);
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.pointerId !== activePointerId.current) return; // a stray second pointer lifting - not ours
    activePointerId.current = null;
    sendCursor(null, null, true);
    if (!currentStrokeId.current) return;
    const id = currentStrokeId.current;
    pointCapture.current?.reset();
    finishStroke(doc, id);
    currentStrokeId.current = null;
    // Without this, two strokes drawn within Y.UndoManager's default 500ms capture window merge
    // into one undo step - correct for "coalesce rapid edits" in general, wrong for "each stroke
    // is its own undo unit" (a real user drawing fast, or a scripted test, can easily land two
    // pointerup->pointerdown cycles inside 500ms). stopCapturing() draws an explicit boundary so
    // the next stroke always starts a fresh undo entry regardless of timing.
    undoManagerRef.current?.stopCapturing();
  }

  /** Commits the current text editor: creates a brand-new stroke, or (edit mode) updates the
   * existing stroke's text. Empty text on a new stroke is a cancel; empty on an edit leaves it
   * untouched. Reads the editor through a ref so callers during a re-render race (blur vs
   * pointerdown opening the next editor) always commit the text actually on screen. */
  function commitText() {
    const editor = textEditorRef.current;
    if (!editor) return;
    const { x, y, value, strokeId } = editor;
    const { color, width } = toolRef.current;
    if (strokeId) {
      if (value) setText(doc, strokeId, value);
    } else if (value) {
      const id = nanoid();
      createStroke(doc, { id, userId: localUserId, tool: "text", color, width });
      pushPoints(doc, id, [x, y]);
      setText(doc, id, value);
      finishStroke(doc, id);
      undoManagerRef.current?.stopCapturing();
    }
    setTextEditor(null);
  }

  /** Finds a committed text stroke under a logical-space point, for double-click-to-edit. */
  function findTextStrokeAt(x: number, y: number): { id: string; x: number; y: number; text: string } | null {
    const strokes = getStrokesMap(doc);
    let hit: { id: string; x: number; y: number; text: string } | null = null;
    strokes.forEach((strokeMap) => {
      const snap = readStroke(strokeMap);
      if (snap.tool !== "text" || !snap.text) return;
      const w = Math.max(estimateTextWidth(snap.text, snap.width), TEXT_HIT_RADIUS);
      const h = Math.max(12, snap.width * 4);
      if (x >= snap.points[0] - TEXT_HIT_RADIUS && x <= snap.points[0] + w + TEXT_HIT_RADIUS && y >= snap.points[1] - TEXT_HIT_RADIUS && y <= snap.points[1] + h + TEXT_HIT_RADIUS) {
        hit = { id: snap.id, x: snap.points[0], y: snap.points[1], text: snap.text };
      }
    });
    return hit;
  }

  /** Double-click on an existing text stroke re-opens the editor pre-filled at that position.
   * Two paths reach here: a closed editor (canvas dblclick bubbles to the wrapper), and an OPEN
   * blank editor (the input covers the stroke's origin, so the dblclick fires on the input - it
   * forwards by committing the empty value, which is a no-op cancel, then re-opening prefilled). */
  function handleDoubleClick(e: React.MouseEvent) {
    const rect = liveRef.current!.getBoundingClientRect();
    const scaleX = BOARD_WIDTH / rect.width;
    const scaleY = BOARD_HEIGHT / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const wasOpen = textEditorRef.current != null;
    if (wasOpen) commitText();
    const hit = findTextStrokeAt(x, y);
    if (hit) setTextEditor({ x: hit.x, y: hit.y, value: hit.text, strokeId: hit.id });
  }

  return (
    <div
      className="canvas-scale-wrap"
      onDoubleClick={handleDoubleClick}
      style={{
        position: "relative",
        width: "100%",
        maxWidth: BOARD_WIDTH,
        aspectRatio: `${BOARD_WIDTH} / ${BOARD_HEIGHT}`,
      }}
    >
      <canvas
        ref={committedRef}
        style={{ position: "absolute", inset: 0, border: "1px solid #ccc", background: "#fff" }}
      />
      <canvas
        ref={liveRef}
        style={{ position: "absolute", inset: 0, touchAction: "none", cursor: "crosshair" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => sendCursor(null, null, true)}
      />
      {textEditor && (
        <input
          ref={textInputRef}
          value={textEditor.value}
          onChange={(e) => setTextEditor({ ...textEditor, value: e.target.value })}
          onBlur={() => {
            // A blur before the focus race settles is the browser's own doing, not the user
            // leaving the field - ignore it instead of instantly committing an empty editor.
            if (textEditorJustOpened.current) {
              textInputRef.current?.focus();
              return;
            }
            commitText();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitText();
            if (e.key === "Escape") setTextEditor(null);
          }}
          onDoubleClick={handleDoubleClick}
          placeholder="Type, then press Enter"
          style={{
            position: "absolute",
            left: `${(textEditor.x / BOARD_WIDTH) * 100}%`,
            top: `${(textEditor.y / BOARD_HEIGHT) * 100}%`,
            zIndex: 10,
            font: `${Math.max(12, width * 4)}px system-ui, sans-serif`,
            color: color,
            background: "#fff",
            border: "1px solid rgba(0,0,0,0.55)",
            outline: "2px solid var(--accent)",
            outlineOffset: 1,
            // Hug the typed text instead of a fixed arbitrary width - so the box visibly grows
            // and shrinks with the content rather than feeling like it resizes at random.
            width: `${Math.max(8, textEditor.value.length + 1)}ch`,
            padding: "0 2px",
          }}
        />
      )}
      <CursorsOverlay awareness={awareness} localClientId={doc.clientID} />
    </div>
  );
}
