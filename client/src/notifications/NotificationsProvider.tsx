import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { apiFetch, getToken } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { InvitePopups } from "./InvitePopups";

export interface InviteItem {
  boardId: string;
  boardName: string;
  inviterDisplayName: string;
}

/** Fired when someone the current user invited accepts. `at` is a receipt timestamp (not an
 * event id) purely so two accepts for the same board/display name still register as distinct
 * updates to anything watching this with a useEffect. */
export interface InviteAcceptedEvent {
  boardId: string;
  displayName: string;
  at: number;
}

interface NotificationsState {
  invites: InviteItem[];
  lastAccepted: InviteAcceptedEvent | null;
  accept: (boardId: string) => Promise<void>;
  decline: (boardId: string) => Promise<void>;
}

const NotificationsContext = createContext<NotificationsState | null>(null);

function notificationsWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws/notifications`;
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [invites, setInvites] = useState<InviteItem[]>([]);
  const [lastAccepted, setLastAccepted] = useState<InviteAcceptedEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const shouldReconnectRef = useRef(true);

  useEffect(() => {
    if (!user) {
      setInvites([]);
      return;
    }

    shouldReconnectRef.current = true;

    // Backlog: an invite sent while this user was offline has no live push to trigger on, so
    // load whatever's still pending whenever the app starts / they log in.
    apiFetch<InviteItem[]>("/invites")
      .then(setInvites)
      .catch(() => {});

    function connect() {
      const token = getToken();
      if (!token) return;
      const ws = new WebSocket(notificationsWsUrl(), [token]);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
      };

      ws.onmessage = (event) => {
        let payload: { type?: string; boardId?: string; boardName?: string; inviterDisplayName?: string; displayName?: string };
        try {
          payload = JSON.parse(event.data as string);
        } catch {
          return;
        }
        if (payload.type === "invite_accepted" && payload.boardId && payload.displayName) {
          setLastAccepted({ boardId: payload.boardId, displayName: payload.displayName, at: Date.now() });
          return;
        }
        if (payload.type !== "invite" || !payload.boardId) return;
        const invite: InviteItem = {
          boardId: payload.boardId,
          boardName: payload.boardName ?? "Untitled board",
          inviterDisplayName: payload.inviterDisplayName ?? "Someone",
        };
        setInvites((prev) => (prev.some((i) => i.boardId === invite.boardId) ? prev : [...prev, invite]));
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!shouldReconnectRef.current) return;
        const delay = Math.min(1000 * 2 ** reconnectAttemptRef.current, 10000);
        reconnectAttemptRef.current++;
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [user]);

  async function accept(boardId: string): Promise<void> {
    await apiFetch(`/invites/${boardId}/accept`, { method: "POST" });
    setInvites((prev) => prev.filter((i) => i.boardId !== boardId));
  }

  async function decline(boardId: string): Promise<void> {
    await apiFetch(`/invites/${boardId}/decline`, { method: "POST" });
    setInvites((prev) => prev.filter((i) => i.boardId !== boardId));
  }

  return (
    <NotificationsContext.Provider value={{ invites, lastAccepted, accept, decline }}>
      {children}
      <InvitePopups invites={invites} accept={accept} decline={decline} />
    </NotificationsContext.Provider>
  );
}

export function useNotifications(): NotificationsState {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications must be used within NotificationsProvider");
  return ctx;
}
