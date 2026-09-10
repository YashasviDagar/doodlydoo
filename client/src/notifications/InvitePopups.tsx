import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { InviteItem } from "./NotificationsProvider";

export function InvitePopups({
  invites,
  accept,
  decline,
}: {
  invites: InviteItem[];
  accept: (boardId: string) => Promise<void>;
  decline: (boardId: string) => Promise<void>;
}) {
  if (invites.length === 0) return null;

  return (
    <div className="popup-stack">
      {invites.map((invite) => (
        <InvitePopupCard key={invite.boardId} invite={invite} accept={accept} decline={decline} />
      ))}
    </div>
  );
}

function InvitePopupCard({
  invite,
  accept,
  decline,
}: {
  invite: InviteItem;
  accept: (boardId: string) => Promise<void>;
  decline: (boardId: string) => Promise<void>;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);

  async function handleAccept() {
    setBusy("accept");
    try {
      await accept(invite.boardId);
      navigate(`/board/${invite.boardId}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleDecline() {
    setBusy("decline");
    try {
      await decline(invite.boardId);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="popup-card" style={{ fontSize: 13 }}>
      <p style={{ margin: "0 0 12px 0" }}>
        <strong>{invite.inviterDisplayName}</strong> invited you to <strong>{invite.boardName}</strong>
      </p>
      <div className="row">
        <button type="button" className="btn btn-primary btn-sm" onClick={handleAccept} disabled={busy !== null}>
          {busy === "accept" ? "Accepting…" : "Accept"}
        </button>
        <button type="button" className="btn btn-sm" onClick={handleDecline} disabled={busy !== null}>
          {busy === "decline" ? "Declining…" : "Decline"}
        </button>
      </div>
    </div>
  );
}
