import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
import { env } from "../config/env.js";
import { logger } from "../logger.js";
import { pgConnectionConfig } from "../persistence/db.js";

// Migrations are normally run by hand (`npm run migrate`). That step is easy to forget on a fresh
// deploy - the server boots, /api/healthz even goes green (it only runs `select 1`), and then every
// signup dies with `relation "users" does not exist`. Running them at boot makes a fresh deploy
// self-heal. node-pg-migrate takes an advisory lock, so concurrent instances can't race each other.
export async function runMigrations(): Promise<void> {
  // Resolves to server/src/db/migrations both in dev (src/db/migrate.ts) and in the production
  // image (dist/db/migrate.js + the migrations dir copied to /app/src/db/migrations by the Dockerfile).
  const dir = fileURLToPath(new URL("../../src/db/migrations", import.meta.url));
  const applied = await runner({
    databaseUrl: pgConnectionConfig(env.databaseUrl),
    dir,
    migrationsTable: "pgmigrations",
    direction: "up",
    log: (msg: string) => logger.info(msg),
  });
  if (applied.length > 0) logger.info(`applied ${applied.length} migration(s)`);
}

/** Best-effort at boot: a DB that's temporarily unreachable shouldn't stop the HTTP server from
 * coming up (so /api/healthz can report the outage) - log and let the process start. */
export async function runMigrationsOnBoot(): Promise<void> {
  try {
    await runMigrations();
  } catch (err) {
    logger.error({ err }, "migrations failed at boot - continuing to start; db may be unavailable");
  }
}
