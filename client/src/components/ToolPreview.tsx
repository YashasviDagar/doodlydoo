import type { Tool } from "../yjs/schema";

/** Hairline underlay drawn behind every color stroke sample: dark inks (the default #1a1a1a
 * swatch especially) were invisible against the dark toolbar - the light halo makes ANY selected
 * color readable without changing what the preview is previewing. */
function Visible({ children }: { children: React.ReactNode }) {
  return (
    <svg width="26" height="16" viewBox="0 0 26 16" aria-hidden="true" style={{ filter: "drop-shadow(0 0 1px rgba(255,255,255,0.9))" }}>
      {children}
    </svg>
  );
}

/** Small stroke-sample icon per tool, styled to visually match how strokeRenderer.ts actually
 * draws that tool (same relative weight/opacity/blend), so the button preview isn't just
 * decorative - it's a preview of the real ink. */
export function ToolPreview({ tool, color }: { tool: Tool; color: string }) {
  if (tool === "eraser") {
    return (
      <Visible>
        <rect x="3" y="4" width="16" height="9" rx="2" fill="#f3a6b5" stroke="#8a5060" strokeWidth="1" transform="rotate(-10 11 8)" />
      </Visible>
    );
  }

  if (tool === "rectangle") {
    return (
      <Visible>
        <rect x="3" y="3" width="20" height="10" fill="none" stroke={color} strokeWidth="2" />
      </Visible>
    );
  }

  if (tool === "ellipse") {
    return (
      <Visible>
        <ellipse cx="13" cy="8" rx="10" ry="5.5" fill="none" stroke={color} strokeWidth="2" />
      </Visible>
    );
  }

  if (tool === "line") {
    return (
      <Visible>
        <path d="M3 13 L23 3" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
      </Visible>
    );
  }

  if (tool === "arrow") {
    return (
      <Visible>
        <path d="M3 13 L21 4" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
        <path d="M23 3 L17.5 3.5 L21.5 8.5 Z" fill={color} />
      </Visible>
    );
  }

  if (tool === "diamond") {
    return (
      <Visible>
        <path d="M13 2 L23 8 L13 14 L3 8 Z" fill="none" stroke={color} strokeWidth="2" />
      </Visible>
    );
  }

  if (tool === "star") {
    return (
      <Visible>
        <path
          d="M13 1.5 L15.7 6 L21 6.8 L17 10.3 L18 15.5 L13 13 L8 15.5 L9 10.3 L5 6.8 L10.3 6 Z"
          fill="none"
          stroke={color}
          strokeWidth="1.6"
        />
      </Visible>
    );
  }

  if (tool === "text") {
    return (
      <Visible>
        <text x="4" y="13" fontSize="13" fontFamily="system-ui, sans-serif" fill={color}>
          Aa
        </text>
      </Visible>
    );
  }

  if (tool === "fountain") {
    return (
      <Visible>
        <path
          d="M3 12.5 C 9 12, 11 4.5, 23 6.5"
          fill="none"
          stroke={color}
          strokeLinecap="round"
          strokeWidth="4.5"
          style={{ opacity: 0.9 }}
        />
        <path d="M3 12.5 C 9 12, 11 4.5, 23 6.5" fill="none" stroke={color} strokeLinecap="round" strokeWidth="1.5" />
      </Visible>
    );
  }

  if (tool === "highlighter") {
    return (
      <Visible>
        <path d="M3 9 Q 13 3 23 9" fill="none" stroke={color} strokeWidth="8" strokeLinecap="square" style={{ opacity: 0.55 }} />
      </Visible>
    );
  }

  if (tool === "marker") {
    return (
      <Visible>
        <path d="M3 9 Q 13 2 23 9" fill="none" stroke={color} strokeWidth="6.5" strokeLinecap="round" opacity={0.92} />
      </Visible>
    );
  }

  return (
    <Visible>
      <path d="M3 9 Q 13 2 23 9" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
    </Visible>
  );
}
