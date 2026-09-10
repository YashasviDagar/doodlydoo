import type { Awareness } from "y-protocols/awareness";
import { useAwarenessStates } from "../yjs/useAwareness";
import { BOARD_WIDTH, BOARD_HEIGHT } from "./constants";

interface Props {
  awareness: Awareness;
  localClientId: number;
}

export function CursorsOverlay({ awareness, localClientId }: Props) {
  const states = useAwarenessStates(awareness);

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {Array.from(states.entries()).map(([clientId, state]) => {
        if (clientId === localClientId || !state.cursor) return null;
        return (
          <div
            key={clientId}
            style={{
              position: "absolute",
              left: `${(state.cursor.x / BOARD_WIDTH) * 100}%`,
              top: `${(state.cursor.y / BOARD_HEIGHT) * 100}%`,
              transform: "translate(-2px, -2px)",
              transition: "left 60ms linear, top 60ms linear",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" style={{ display: "block" }}>
              <path d="M1 1 L1 15 L5.5 11.5 L8 17 L10.5 16 L8 10.5 L14 10.5 Z" fill={state.color} stroke="white" strokeWidth="1" />
            </svg>
            <span
              style={{
                background: state.color,
                color: "white",
                fontSize: 11,
                padding: "1px 6px",
                borderRadius: 3,
                whiteSpace: "nowrap",
                marginLeft: 14,
                marginTop: -6,
                display: "inline-block",
              }}
            >
              {state.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}
