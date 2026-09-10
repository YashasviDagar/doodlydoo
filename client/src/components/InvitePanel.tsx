import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../lib/api";
import { useNotifications } from "../notifications/NotificationsProvider";

interface Invitee {
  id: string;
  username: string;
  displayName: string;
  status: "pending" | "accepted";
}

export function InvitePanel({ boardId }: { boardId: string }) {
  const [invitees, setInvitees] = useState<Invitee[]>([]);
  const [username, setUsername] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { lastAccepted } = useNotifications();

  function refresh() {
    return apiFetch<Invitee[]>(`/boards/${boardId}/invites`).then(setInvitees).catch(() => {});
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);

  // Live update instead of staying stuck on "pending" until this panel happens to remount - see
  // ws/notifications.ts's invite_accepted push, sent to the board owner the moment someone
  // accepts. Re-fetches from the server (the source of truth) rather than patching the local
  // list by username in place: patching left a real gap where the fetch on mount could resolve
  // *after* this event and clobber the just-applied "accepted" status with whatever the list
  // looked like at the moment the fetch was issued, plus it never touched the free-text `status`
  // banner below, which stayed on "waiting for them to accept" forever.
  useEffect(() => {
    if (!lastAccepted || lastAccepted.boardId !== boardId) return;
    refresh();
    setStatus(`${lastAccepted.displayName} accepted the invite.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastAccepted, boardId]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    setBusy(true);
    try {
      const invitee = await apiFetch<Invitee>(`/boards/${boardId}/invites`, {
        method: "POST",
        body: JSON.stringify({ username }),
      });
      setInvitees((prev) =>
        prev.some((p) => p.id === invitee.id) ? prev.map((p) => (p.id === invitee.id ? invitee : p)) : [...prev, invitee],
      );
      setUsername("");
      setStatus(
        invitee.status === "accepted" ? `${invitee.displayName} is already a collaborator.` : `Invited ${invitee.displayName} - waiting for them to accept.`,
      );
    } catch (err) {
      // The server returns 404 for two unrelated cases - a board the caller doesn't own AND a
      // username with no matching account - so status code alone can't distinguish them; branch on
      // the error code from the response body instead (see ApiError, which carries it as .message).
      if (err instanceof ApiError && err.message === "user_not_found") setStatus("No account with that email or username.");
      else if (err instanceof ApiError && err.message === "cannot_invite_self") setStatus("That's you.");
      else if (err instanceof ApiError && err.message === "not_found") setStatus("You don't have permission to invite to this board.");
      else if (err instanceof ApiError && err.message === "invalid_input") setStatus("Enter an email or username.");
      else setStatus("Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: "10px 0" }}>
      <form onSubmit={handleInvite} className="row">
        <input
          type="text"
          placeholder="Invite by email or username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="input"
          style={{ fontSize: 13, padding: "6px 10px", width: 220 }}
        />
        <button type="submit" className="btn btn-sm" disabled={busy}>
          Invite
        </button>
        {status && <span className="muted">{status}</span>}
      </form>
      {invitees.length > 0 && (
        <p className="muted row" style={{ marginTop: 6, flexWrap: "wrap" }}>
          <span>Invited:</span>
          {invitees.map((i) => (
            <span key={i.id} className="row" style={{ gap: 4 }}>
              {i.displayName}
              {i.status === "pending" && <span className="badge">pending</span>}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
