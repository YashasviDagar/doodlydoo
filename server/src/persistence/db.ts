import pg from "pg";
import { env } from "../config/env.js";
import { logger } from "../logger.js";

// Managed Postgres providers (Render, Neon, Supabase, Railway) require TLS. node-postgres only
// turns on SSL when the connection string carries an `sslmode` parameter, and Render's URLs don't
// by default - so a plain "copy the database URL" deploy fails with a refused connection and a
// useless "db:down" health check. Local dev (127.0.0.1/localhost, e.g. the PGlite dev DB on :5433)
// has no TLS, so it's excluded. If the URL already specifies sslmode, leave it to pg's parser.
export function pgConnectionConfig(url: string): pg.ClientConfig {
  const isLocal = /(^|\/\/)(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
  const hasSslMode = /[?&]sslmode=/i.test(url);
  return {
    connectionString: url,
    ssl: isLocal || hasSslMode ? undefined : { rejectUnauthorized: false },
  };
}

export const pool = new pg.Pool({ ...pgConnectionConfig(env.databaseUrl), max: env.pgPoolMax });

// Critical: node-postgres emits 'error' on the pool for problems with IDLE clients (e.g. the
// server dropping a pooled connection that isn't in the middle of a query) - not just rejected
// query promises. An EventEmitter 'error' with no listener is fatal to the whole process by
// default, bypassing every try/catch in the codebase. This is what actually crashed the server -
// see PLAN.md for the root-cause writeup.
pool.on("error", (err) => {
  logger.error({ err }, "unexpected error on idle pg client - pool recovers automatically");
});

export async function checkDbConnection(): Promise<boolean> {
  try {
    await pool.query("select 1");
    return true;
  } catch (err) {
    // Swallowing this silently made a production "db:down" health check undiagnosable - the
    // only signal was the degraded status, with no reason in the logs. Log it so the actual
    // connection error (bad URL, missing SSL, unreachable host) is visible.
    logger.error({ err }, "db connection check failed");
    return false;
  }
}
