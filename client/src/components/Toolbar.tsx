import { useToolStore } from "../state/toolStore";
import type { CanvasBoardHandle } from "../canvas/CanvasBoard";
import type { Tool } from "../yjs/schema";
import { ToolPreview } from "./ToolPreview";

interface Props {
  board: CanvasBoardHandle | null;
}

const SWATCHES = ["#1a1a1a", "#e03131", "#2f9e44", "#1971c2", "#f08c00", "#9c36b5"];

const TOOLS: { id: Tool; label: string }[] = [
  { id: "pen", label: "Pen" },
  { id: "fountain", label: "Fountain" },
  { id: "marker", label: "Marker" },
  { id: "highlighter", label: "Highlighter" },
  { id: "eraser", label: "Eraser" },
  { id: "rectangle", label: "Rect" },
  { id: "ellipse", label: "Ellipse" },
  { id: "line", label: "Line" },
  { id: "arrow", label: "Arrow" },
  { id: "diamond", label: "Diamond" },
  { id: "star", label: "Star" },
  { id: "text", label: "Text" },
];

export function Toolbar({ board }: Props) {
  const { tool, color, width, filled, setTool, setColor, setWidth, setFilled } = useToolStore();
  const shapeSelected = ["rectangle", "ellipse", "diamond", "star"].includes(tool);

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="tool-btn"
            onClick={() => setTool(t.id)}
            aria-pressed={tool === t.id}
            title={t.label}
          >
            <ToolPreview tool={t.id} color={color} />
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      <div className="toolbar-group">
        {SWATCHES.map((sw) => (
          <button
            key={sw}
            type="button"
            className="swatch"
            onClick={() => setColor(sw)}
            title={sw}
            aria-pressed={color === sw}
            style={{ background: sw }}
          />
        ))}
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          title="Custom color"
          style={{ width: 24, height: 24, padding: 0, border: "none", background: "none", cursor: "pointer" }}
        />
      </div>

      {shapeSelected && (
        <div className="toolbar-group">
          <button type="button" className="tool-btn" onClick={() => setFilled(false)} aria-pressed={!filled} title="Outline only">
            <svg width="26" height="16" viewBox="0 0 26 16" aria-hidden="true">
              <rect x="4" y="3" width="18" height="10" rx="2" fill="none" stroke={color} strokeWidth="2" />
            </svg>
            <span>Stroke</span>
          </button>
          <button type="button" className="tool-btn" onClick={() => setFilled(true)} aria-pressed={filled} title="Filled solid">
            <svg width="26" height="16" viewBox="0 0 26 16" aria-hidden="true">
              <rect x="4" y="3" width="18" height="10" rx="2" fill={color} />
            </svg>
            <span>Fill</span>
          </button>
        </div>
      )}

      <label className="toolbar-group muted" style={{ gap: 8 }}>
        Brush size
        <input type="range" min={1} max={48} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
        <span>{width}px</span>
      </label>

      <div className="toolbar-group">
        <button type="button" className="btn btn-sm" onClick={() => board?.undo()} title="Undo your last stroke">
          Undo
        </button>
        <button type="button" className="btn btn-sm" onClick={() => board?.redo()} title="Redo">
          Redo
        </button>
      </div>

      <button type="button" className="btn btn-sm" onClick={() => board?.clear()}>
        Clear canvas
      </button>
    </div>
  );
}
