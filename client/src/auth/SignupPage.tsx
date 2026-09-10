import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { ApiError } from "../lib/api";
import { BrandLockup } from "../components/Brand";

export function SignupPage() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signup(username, email, displayName, password);
      navigate("/");
    } catch (err) {
      if (err instanceof ApiError && err.message === "email_taken") setError("That email is already registered.");
      else if (err instanceof ApiError && err.status === 409) setError("That username is already taken.");
      else if (err instanceof ApiError && err.status === 400) setError("Check your username, email, display name, and password (min 8 characters).");
      else setError("Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <div className="auth-card card">
        <h1 style={{ marginBottom: 20, textAlign: "center" }}>
          <BrandLockup variant="hero" />
        </h1>
        <form onSubmit={handleSubmit} className="stack">
          <input
            className="input"
            type="email"
            placeholder="Email (for logging in and invites)"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="input"
            type="text"
            placeholder="Username (unique, for invites too)"
            required
            minLength={2}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            className="input"
            type="text"
            placeholder="Display name (shown to others)"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <input
            className="input"
            type="password"
            placeholder="Password (min 8 characters)"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="error-text">{error}</p>}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Creating account…" : "Sign up"}
          </button>
        </form>
        <p className="muted" style={{ marginTop: 16 }}>
          Already have an account? <Link to="/login">Log in</Link>
        </p>
      </div>
    </main>
  );
}
