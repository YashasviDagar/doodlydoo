import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { ApiError } from "../lib/api";
import { BrandLockup } from "../components/Brand";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username, password);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "Invalid username or password." : "Something went wrong.");
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
            type="text"
            placeholder="Email or username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            className="input"
            type="password"
            placeholder="Password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="error-text">{error}</p>}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Logging in…" : "Log in"}
          </button>
        </form>
        <p className="muted" style={{ marginTop: 16 }}>
          No account? <Link to="/signup">Sign up</Link>
        </p>
      </div>
    </main>
  );
}
