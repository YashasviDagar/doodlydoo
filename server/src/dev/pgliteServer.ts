/**
 * Zero-install local Postgres for dev: PGlite (real Postgres compiled to WASM) exposed over
 * the standard Postgres wire protocol, so the app's normal `pg` client connects to it exactly
 * like it would to Railway Postgres in production. See PLAN.md deviation #1 for why this
 * replaces docker-compose's postgres service on this machine.
 *
 * Run via `npm run db:dev` (server/), which goes through pgliteSupervisor.ts - see that file for
 * why this one doesn't try to recover in-process from a fatal PGlite engine error.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const dataDir = new URL("../../.pgdata", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const port = 5433;

const db = await PGlite.create(dataDir);
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });

await server.start();
console.log(`[pglite] listening on postgres://127.0.0.1:${port} (data dir: ${dataDir})`);

// pglite-socket doesn't attach an 'error' listener to the raw client socket, so an abrupt
// disconnect (a CLI tool like node-pg-migrate exiting right after its last query) surfaces as
// an ECONNRESET that Node treats as uncaught and kills this whole process. That's a real bug
// worth reporting upstream, but here it's dev-only infrastructure (never shipped, never runs in
// prod against Railway's real Postgres), so we swallow just this one error class rather than
// let a single reset connection take down the local dev database and its in-memory state.
//
// Anything else here is presumed a fatal PGlite engine error (e.g. an internal WASM
// "RuntimeError: unreachable" under sustained heavy concurrent write load - see PLAN.md
// deviation #29, a PGlite-specific ceiling real Postgres in production doesn't have). We
// deliberately let the process exit on those rather than try to recover in-process: a WASM trap
// likely leaves the engine instance unrecoverable, and process-level restart (pgliteSupervisor.ts)
// gives a clean slate far more reliably than juggling Node's uncaughtException/event-loop
// shutdown semantics while the engine may already be wedged.
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err.code === "ECONNRESET") {
    console.warn("[pglite] client disconnected abruptly (ECONNRESET) - ignoring, server still up");
    return;
  }
  throw err;
});

process.on("SIGINT", async () => {
  await server.stop();
  await db.close();
  process.exit(0);
});
