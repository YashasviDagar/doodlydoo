import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiFetch, ApiError } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { BrandLink } from "../components/Brand";

interface BoardSummary {
  id: string;
  name: string;
  createdAt: string;
  lastActiveAt: string;
  isOwner: boolean;
}

export function HomePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    setBoards(null);
    setLoadError(false);
    apiFetch<BoardSummary[]>("/boards")
      .then(setBoards)
      .catch(() => setLoadError(true));
  }, [reloadToken]);

  async function createBoard() {
    setCreating(true);
    setCreateError(null);
    try {
      const board = await apiFetch<BoardSummary>("/boards", { method: "POST", body: JSON.stringify({}) });
      navigate(`/board/${board.id}`);
    } catch (err) {
      // The JWT can outlive the account it names (e.g. a dev DB reset while still logged in) -
      // the server detects that specifically and answers with this code (see boards/routes.ts).
      // The only real fix is a fresh session, so force one instead of leaving the user stuck
      // clicking a button that can never work with their current token.
      if (err instanceof ApiError && err.message === "account_not_found") {
        logout();
        navigate("/login");
        return;
      }
      setCreateError("Couldn't create a new board. Try again.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 640, margin: "0 auto", width: "100%" }}>
      <nav className="navbar">
        <BrandLink />
        <div className="row">
          <Link to="/profile" className="muted">
            {user?.displayName}
          </Link>
          <button type="button" className="btn btn-sm" onClick={logout}>
            Log out
          </button>
        </div>
      </nav>

      <div className="row" style={{ alignSelf: "flex-start" }}>
        <button type="button" className="btn btn-primary" onClick={createBoard} disabled={creating}>
          {creating ? "Creating…" : "+ New board"}
        </button>
        {createError && <span className="error-text">{createError}</span>}
      </div>

      <h2 style={{ fontSize: 15, marginTop: 32, marginBottom: 4, color: "var(--text)" }}>Your boards</h2>
      {boards === null && !loadError && <p className="muted">Loading…</p>}
      {loadError && (
        <p className="error-text">
          Couldn't load your boards.{" "}
          <button type="button" className="btn btn-sm" onClick={() => setReloadToken((t) => t + 1)}>
            Try again
          </button>
        </p>
      )}
      {boards?.length === 0 && <p className="muted">No boards yet - create one above.</p>}
      <ul className="board-list">
        {boards?.map((b) => (
          <BoardListItem key={b.id} board={b} onChanged={() => setReloadToken((t) => t + 1)} />
        ))}
      </ul>
    </div>
  );
}

// One board row. The actions live outside the Link (clicks on them must not navigate) and each
// destructive action confirms inline first - deletion is permanent (the board's document history
// is cascade-deleted server-side), so an accidental single click shouldn't be able to do it.
function BoardListItem({ board, onChanged }: { board: BoardSummary; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function run(method: "DELETE" | "POST", path: string) {
    setBusy(true);
    setError(false);
    try {
      await apiFetch(`/boards/${board.id}${path}`, { method });
      onChanged();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  const verb = board.isOwner ? "Delete" : "Leave";

  return (
    <li>
      <span className="board-list-item" style={{ display: "flex", gap: 8 }}>
        <Link to={`/board/${board.id}`} style={{ color: "inherit", textDecoration: "none", flex: 1 }}>
          {board.name}
        </Link>
        {!board.isOwner && <span className="badge">invited</span>}
        {confirming ? (
          <>
            <span className="muted" style={{ fontSize: 12 }}>
              {verb} “{board.name}”?
            </span>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(board.isOwner ? "DELETE" : "POST", board.isOwner ? "" : "/leave")}>
              {busy ? "…" : "Yes"}
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirming(false)}>
              No
            </button>
          </>
        ) : (
          <>
            {error && <span className="error-text">failed</span>}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title={board.isOwner ? "Delete this board permanently" : "Leave this board"}
              onClick={() => setConfirming(true)}
            >
              {board.isOwner ? "delete" : "leave"}
            </button>
          </>
        )}
      </span>
    </li>
  );
}
