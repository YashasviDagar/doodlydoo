import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { apiFetch, ApiError, getToken, setToken } from "../lib/api";

export interface AuthUser {
  id: string;
  username: string;
  /** NULL for accounts created before email existed; the profile page lets them add one. */
  email: string | null;
  displayName: string;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  signup: (username: string, email: string, displayName: string, password: string) => Promise<void>;
  /** Profile updates re-issue a token (the JWT embeds username/displayName), so this swaps both. */
  updateProfile: (fields: { username?: string; email?: string; displayName?: string }) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    apiFetch<AuthUser>("/auth/me")
      .then(setUser)
      .catch((err) => {
        // Only a genuine 401 (bad signature, actually expired, or - see boards/routes.ts -
        // account_not_found on later requests) means the token is truly invalid and the user is
        // really logged out. Anything else (a network blip, the dev server mid hot-reload, a
        // transient 500/503 from a dropped DB connection - all things this app's own PLAN.md notes
        // as real occurrences) is NOT proof the session is bad, just that this one check failed.
        // Wiping the token here used to treat every one of those as a hard logout, which is
        // exactly the "unpredictable, repeated logout" symptom - a perfectly valid session got
        // discarded because of an unrelated transient failure, and there was no way back short of
        // logging in again. Leaving the token in place lets the next reload (or the next request
        // that actually needs it) re-check cleanly instead.
        if (err instanceof ApiError && err.status === 401) setToken(null);
      })
      .finally(() => setLoading(false));
  }, []);

  async function login(username: string, password: string) {
    const { token, user } = await apiFetch<{ token: string; user: AuthUser }>(
      "/auth/login",
      { method: "POST", body: JSON.stringify({ username, password }) },
    );
    setToken(token);
    setUser(user);
  }

  async function signup(username: string, email: string, displayName: string, password: string) {
    const { token, user } = await apiFetch<{ token: string; user: AuthUser }>(
      "/auth/signup",
      { method: "POST", body: JSON.stringify({ username, email, displayName, password }) },
    );
    setToken(token);
    setUser(user);
  }

  async function updateProfile(fields: { username?: string; email?: string; displayName?: string }) {
    const { token, user } = await apiFetch<{ token: string; user: AuthUser }>("/auth/profile", {
      method: "PATCH",
      body: JSON.stringify(fields),
    });
    setToken(token);
    setUser(user);
  }

  function logout() {
    setToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, updateProfile, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
