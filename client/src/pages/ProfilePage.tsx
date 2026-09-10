import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../lib/api";
import { BrandLink } from "../components/Brand";

export function ProfilePage() {
  const { user, logout } = useAuth();

  return (
    <div className="page" style={{ maxWidth: 480, margin: "0 auto", width: "100%" }}>
      <nav className="navbar">
        <BrandLink />
        <button type="button" className="btn btn-sm" onClick={logout}>
          Log out
        </button>
      </nav>

      <div className="card" style={{ textAlign: "left" }}>
        <h2 style={{ marginTop: 0 }}>Profile</h2>
        {user && (
          <div className="stack" style={{ gap: 10 }}>
            <div>
              <span className="muted">Email: </span>
              {user.email ? <strong>{user.email}</strong> : <span className="badge">not set yet</span>}
            </div>
            <div>
              <span className="muted">Username: </span>
              <strong>{user.username}</strong>
            </div>
            <div>
              <span className="muted">Display name: </span>
              <strong>{user.displayName}</strong>
            </div>
          </div>
        )}
        {user && (
          <>
            {!user.email && <EmailEditor mode="add" />}
            <UsernameEditor key={user.username} currentUsername={user.username} />
          </>
        )}
        <p style={{ marginTop: 20 }}>
          <Link to="/">Back to your boards</Link>
        </p>
      </div>
    </div>
  );
}

/** Shared save logic for the email/username forms; field-specific error messages come from the
 * server's distinct 409 codes (email_taken vs username_taken). */
function useProfileField() {
  const { updateProfile } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(fields: { username?: string; email?: string }, onTaken: string, onInvalid: string) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await updateProfile(fields);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.message === "email_taken") setError("That email is already registered.");
      else if (err instanceof ApiError && err.message === "username_taken") setError(onTaken);
      else if (err instanceof ApiError && err.status === 400) setError(onInvalid);
      else setError("Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, saved, save };
}

function EmailEditor({ mode }: { mode: "add" | "edit" }) {
  const { user } = useAuth();
  const { busy, error, saved, save } = useProfileField();
  const [value, setValue] = useState(user?.email ?? "");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save({ email: value.trim() }, "That email is already registered.", "Enter a valid email address.");
      }}
      className="stack"
      style={{ marginTop: 20, gap: 8, alignItems: "flex-start" }}
    >
      <label className="field" style={{ width: "100%" }}>
        <span className="muted">{mode === "add" ? "Add your email" : "Change email"}</span>
        <input className="input" type="email" value={value} onChange={(e) => setValue(e.target.value)} required disabled={busy} />
      </label>
      {error && <p className="error-text">{error}</p>}
      {saved && <p className="muted">Email updated.</p>}
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
        {busy ? "Saving…" : mode === "add" ? "Add email" : "Save email"}
      </button>
    </form>
  );
}

function UsernameEditor({ currentUsername }: { currentUsername: string }) {
  const { busy, error, saved, save } = useProfileField();
  const [value, setValue] = useState(currentUsername);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save({ username: value.trim() }, "That username is already taken.", "Usernames are 2-40 characters.");
      }}
      className="stack"
      style={{ marginTop: 20, gap: 8, alignItems: "flex-start" }}
    >
      <label className="field" style={{ width: "100%" }}>
        <span className="muted">Change username</span>
        <input className="input" value={value} onChange={(e) => setValue(e.target.value)} maxLength={40} disabled={busy} />
      </label>
      {error && <p className="error-text">{error}</p>}
      {saved && <p className="muted">Username updated.</p>}
      <button
        type="submit"
        className="btn btn-primary btn-sm"
        disabled={busy || !value.trim() || value.trim() === currentUsername}
      >
        {busy ? "Saving…" : "Save username"}
      </button>
    </form>
  );
}
