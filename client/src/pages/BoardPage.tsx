import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { WsProvider, type ConnectionStatus } from "../yjs/wsProvider";
import { colorForUserId } from "../yjs/identity";
import { CanvasBoard, type CanvasBoardHandle } from "../canvas/CanvasBoard";
import { Toolbar } from "../components/Toolbar";
import { PresenceList } from "../components/PresenceList";
import { InvitePanel } from "../components/InvitePanel";
import { useAuth } from "../auth/AuthContext";
import { apiFetch, getToken, ApiError } from "../lib/api";
import { BrandLink } from "../components/Brand";

function wsUrl(boardId: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws?boardId=${encodeURIComponent(boardId)}`;
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: "connecting…",
  connected: "live",
  disconnected: "reconnecting…",
};

type Access =
  | { state: "checking" }
  | { state: "denied" }
  | { state: "error" }
  | { state: "ok"; name: string; isOwner: boolean };

export function BoardPage() {
  const { boardId = "" } = useParams();
  const { user } = useAuth();
  const [access, setAccess] = useState<Access>({ state: "checking" });
  const [retryToken, setRetryToken] = useState(0);

  // The fast HTTP pre-check from the bootstrap flow: confirm access BEFORE ever attempting a
  // WebSocket connection, so a denied user gets a clean message instead of a socket that opens
  // and then gets rejected by the WS upgrade gate.
  useEffect(() => {
    setAccess({ state: "checking" });
    apiFetch<{ id: string; name: string; isOwner: boolean }>(`/boards/${boardId}`)
      .then((board) => setAccess({ state: "ok", name: board.name, isOwner: board.isOwner }))
      .catch((err) => {
        // A 404 here really does mean "doesn't exist or you're not authorized" (see boards/routes.ts
        // - both cases are deliberately collapsed server-side to avoid leaking which boards exist).
        // Anything else (a 500, a network blip) is NOT the same thing and shouldn't show the same
        // message - conflating them once already caused real confusion when a transient DB error
        // got reported as "this board doesn't exist".
        if (err instanceof ApiError && err.status === 404) setAccess({ state: "denied" });
        else setAccess({ state: "error" });
      });
  }, [boardId, retryToken]);

  if (access.state === "checking")
    return (
      <div className="page">
        <p className="muted">Loading board…</p>
      </div>
    );
  if (access.state === "denied") {
    return (
      <div className="page" style={{ maxWidth: 480, margin: "0 auto", width: "100%" }}>
        <nav className="navbar">
          <BrandLink />
        </nav>
        <p>This board doesn't exist, or you don't have access to it.</p>
        <p style={{ marginTop: 12 }}>
          <Link to="/">Back to your boards</Link>
        </p>
      </div>
    );
  }
  if (access.state === "error") {
    return (
      <div className="page" style={{ maxWidth: 480, margin: "0 auto", width: "100%" }}>
        <nav className="navbar">
          <BrandLink />
        </nav>
        <p className="error-text">Something went wrong loading this board. This isn't a permissions issue - try again.</p>
        <p className="row" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-sm" onClick={() => setRetryToken((t) => t + 1)}>
            Try again
          </button>
          <Link to="/">Back to your boards</Link>
        </p>
      </div>
    );
  }

  return (
    <ConnectedBoard
      boardId={boardId}
      boardName={access.name}
      isOwner={access.isOwner}
      userId={user!.id}
      displayName={user!.displayName}
    />
  );
}

function ConnectedBoard({
  boardId,
  boardName,
  isOwner,
  userId,
  displayName,
}: {
  boardId: string;
  boardName: string;
  isOwner: boolean;
  userId: string;
  displayName: string;
}) {
  const docRef = useRef<Y.Doc | null>(null);
  if (!docRef.current) docRef.current = new Y.Doc();
  const awarenessRef = useRef<Awareness | null>(null);
  if (!awarenessRef.current) awarenessRef.current = new Awareness(docRef.current);

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [board, setBoard] = useState<CanvasBoardHandle | null>(null);
  const [name, setName] = useState(boardName);
  const color = colorForUserId(userId);

  useEffect(() => {
    const doc = docRef.current!;
    const awareness = awarenessRef.current!;
    const token = getToken()!;
    const provider = new WsProvider(wsUrl(boardId), token, doc, awareness);
    awareness.setLocalStateField("user", { userId, name: displayName, color });
    const offStatus = provider.onStatus(setStatus);
    const offRename = provider.onBoardRenamed(setName);
    return () => {
      offStatus();
      offRename();
      provider.destroy();
    };
  }, [boardId, userId, displayName, color]);

  const isLive = status === "connected";

  return (
    <div className="page">
      <nav className="navbar">
        <BrandLink />
        <div className="row">
          <Link to="/profile" className="muted">
            {displayName}
          </Link>
          <Link to="/" className="muted">
            Your boards
          </Link>
        </div>
      </nav>

      <div className="row" style={{ marginBottom: 4 }}>
        <BoardTitle boardId={boardId} name={name} onRenamed={setName} />
        <span className="row muted" style={{ gap: 6 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              // Live is a real semantic "good" state (green); anything else (connecting,
              // reconnecting) genuinely warrants a second look, so it gets the same amber used
              // for other "worth noticing" states (pending invites, the invited badge) rather
              // than a plain neutral dot.
              background: isLive ? "#10b981" : "var(--highlight)",
              display: "inline-block",
            }}
          />
          {STATUS_LABEL[status]}
        </span>
      </div>

      <Toolbar board={board} />
      <PresenceList awareness={awarenessRef.current} localIdentity={{ userId, name: displayName, color }} />
      {isOwner && <InvitePanel boardId={boardId} />}
      <div style={{ marginTop: 12 }}>
        <CanvasBoard doc={docRef.current} awareness={awarenessRef.current} localUserId={userId} onReady={setBoard} />
      </div>
    </div>
  );
}

// Inline rename, right on the board - any accepted collaborator (owner or invited) can give a
// board a real name (for organization/privacy) without leaving the page or hunting for a
// separate settings screen. The server enforces the same rule (see boards/routes.ts PATCH).
function BoardTitle({
  boardId,
  name,
  onRenamed,
}: {
  boardId: string;
  name: string;
  onRenamed: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);

  if (!editing) {
    return (
      <span className="row">
        <h2 style={{ margin: 0, fontSize: 18 }}>{name}</h2>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setValue(name);
            setEditing(true);
          }}
        >
          rename
        </button>
      </span>
    );
  }

  async function save() {
    const trimmed = value.trim();
    if (!trimmed || trimmed === name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      const updated = await apiFetch<{ id: string; name: string }>(`/boards/${boardId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: trimmed }),
      });
      onRenamed(updated.name);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="row">
      <input
        className="input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        autoFocus
        disabled={busy}
        maxLength={200}
        style={{ fontSize: 14, padding: "5px 8px", width: 220 }}
      />
      <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </button>
      <button type="button" className="btn btn-sm" onClick={() => setEditing(false)} disabled={busy}>
        Cancel
      </button>
    </span>
  );
}
