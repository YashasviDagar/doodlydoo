import type { Awareness } from "y-protocols/awareness";
import { useAwarenessStates } from "../yjs/useAwareness";

interface Props {
  awareness: Awareness;
  localIdentity: { userId: string; name: string; color: string };
}

export function PresenceList({ awareness, localIdentity }: Props) {
  const states = useAwarenessStates(awareness);
  // Keyed by Yjs clientID, not userId: the same account open in two tabs/devices is two
  // presence entries (two Awareness connections), not one - collapsing them onto the same React
  // key caused duplicate-key warnings and unstable rendering.
  const entries = Array.from(states.entries());

  return (
    <div className="row" style={{ padding: "6px 0", flexWrap: "wrap" }}>
      <span className="muted">Online ({entries.length || 1}):</span>
      {entries.length === 0 && <Badge color={localIdentity.color} name={`${localIdentity.name} (you)`} />}
      {entries.map(([clientId, u]) => (
        <Badge key={clientId} color={u.color} name={u.userId === localIdentity.userId ? `${u.name} (you)` : u.name} />
      ))}
    </div>
  );
}

function Badge({ color, name }: { color: string; name: string }) {
  return (
    <span className="pill">
      <span className="pill-dot" style={{ background: color }} />
      {name}
    </span>
  );
}
