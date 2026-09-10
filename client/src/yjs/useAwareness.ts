import { useEffect, useState } from "react";
import type { Awareness } from "y-protocols/awareness";

export interface AwarenessUserState {
  userId: string;
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
}

/** Live-updating snapshot of every connected client's awareness state, keyed by Yjs clientID. */
export function useAwarenessStates(awareness: Awareness): Map<number, AwarenessUserState> {
  const [states, setStates] = useState<Map<number, AwarenessUserState>>(() => toStateMap(awareness));

  useEffect(() => {
    const onChange = () => setStates(toStateMap(awareness));
    onChange();
    awareness.on("change", onChange);
    return () => awareness.off("change", onChange);
  }, [awareness]);

  return states;
}

function toStateMap(awareness: Awareness): Map<number, AwarenessUserState> {
  const result = new Map<number, AwarenessUserState>();
  awareness.getStates().forEach((state, clientId) => {
    const user = (state as Record<string, unknown>)?.user as
      | { userId: string; name: string; color: string }
      | undefined;
    if (!user) return;
    result.set(clientId, {
      userId: user.userId,
      name: user.name,
      color: user.color,
      cursor: ((state as Record<string, unknown>)?.cursor as { x: number; y: number } | null) ?? null,
    });
  });
  return result;
}
