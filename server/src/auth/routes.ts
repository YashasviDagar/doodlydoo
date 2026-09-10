import { Router } from "express";
import { z } from "zod";
import { pool } from "../persistence/db.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { signAuthToken } from "./jwt.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { logger } from "../logger.js";

export const authRouter = Router();

const signupSchema = z.object({
  username: z.string().min(2).max(40),
  email: z.string().trim().toLowerCase().email().max(200),
  displayName: z.string().min(1).max(60),
  password: z.string().min(8).max(200),
});

authRouter.post("/signup", asyncHandler(async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });
    return;
  }
  const { username, email, displayName, password } = parsed.data;

  try {
    const passwordHash = await hashPassword(password);
    const result = await pool.query<{ id: string; username: string; email: string; displayName: string }>(
      `INSERT INTO users (username, email, display_name, password_hash) VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, display_name AS "displayName"`,
      [username, email, displayName, passwordHash],
    );
    const user = result.rows[0];
    const token = signAuthToken({ sub: user.id, username: user.username, displayName: user.displayName });
    res.status(201).json({ token, user });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      // The users table has two unique identity constraints (username, lower(email)); tell them
      // apart so the UI can point at the right field. PGlite/Postgres expose the index name in
      // the error's constraint property.
      const constraint = (err as { constraint?: string }).constraint ?? "";
      res.status(409).json({ error: constraint.includes("email") ? "email_taken" : "username_taken" });
      return;
    }
    logger.error({ err }, "signup failed");
    res.status(500).json({ error: "internal_error" });
  }
}));

const loginSchema = z.object({
  // One identifier field: an email address or a username - both unique identities in the users
  // table, so a single lookup covering either keeps the login form to one box.
  username: z.string().min(1),
  password: z.string().min(1),
});

authRouter.post("/login", asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const { username, password } = parsed.data;

  const result = await pool.query<{ id: string; username: string; displayName: string; password_hash: string }>(
    `SELECT id, username, display_name AS "displayName", password_hash FROM users
     WHERE username = $1 OR email = lower($1)`,
    [username],
  );
  const row = result.rows[0];
  const ok = row ? await verifyPassword(password, row.password_hash) : false;
  if (!row || !ok) {
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }

  const token = signAuthToken({ sub: row.id, username: row.username, displayName: row.displayName });
  res.json({ token, user: { id: row.id, username: row.username, displayName: row.displayName } });
}));

authRouter.get("/me", requireAuth, asyncHandler(async (req, res) => {
  // Read from the DB rather than trusting the JWT's embedded identity: the token carries only
  // username/displayName (no email), and any of the three can change mid-token via /profile.
  const result = await pool.query<{ id: string; username: string; email: string | null; displayName: string }>(
    `SELECT id, username, email, display_name AS "displayName" FROM users WHERE id = $1`,
    [req.user!.sub],
  );
  if (result.rows.length === 0) {
    res.status(401).json({ error: "account_not_found" });
    return;
  }
  res.json(result.rows[0]);
}));

// Profile updates. The JWT embeds username/displayName (it's how /me and invite notifications get
// them without a DB round-trip), so a successful change re-issues a fresh token and the client
// must swap it in - otherwise the old token keeps reporting the stale identity until expiry.
const profileSchema = z.object({
  username: z.string().min(2).max(40).optional(),
  email: z.string().trim().toLowerCase().email().max(200).optional(),
  displayName: z.string().min(1).max(60).optional(),
});

authRouter.patch("/profile", requireAuth, asyncHandler(async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });
    return;
  }
  const { username, email, displayName } = parsed.data;
  if (username === undefined && email === undefined && displayName === undefined) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }

  const fields: string[] = [];
  const values: unknown[] = [req.user!.sub];
  if (username !== undefined) {
    fields.push(`username = $${values.length + 1}`);
    values.push(username);
  }
  if (email !== undefined) {
    fields.push(`email = $${values.length + 1}`);
    values.push(email);
  }
  if (displayName !== undefined) {
    fields.push(`display_name = $${values.length + 1}`);
    values.push(displayName);
  }

  try {
    const result = await pool.query<{ id: string; username: string; email: string | null; displayName: string }>(
      `UPDATE users SET ${fields.join(", ")} WHERE id = $1
       RETURNING id, username, email, display_name AS "displayName"`,
      values,
    );
    if (result.rows.length === 0) {
      res.status(401).json({ error: "account_not_found" });
      return;
    }
    const user = result.rows[0];
    const token = signAuthToken({ sub: user.id, username: user.username, displayName: user.displayName });
    res.json({ token, user });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      const constraint = (err as { constraint?: string }).constraint ?? "";
      res.status(409).json({ error: constraint.includes("email") ? "email_taken" : "username_taken" });
      return;
    }
    logger.error({ err }, "profile update failed");
    res.status(500).json({ error: "internal_error" });
  }
}));

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
