/**
 * Spawns pgliteServer.ts as a child process and respawns it if it exits, with backoff. This is
 * what `npm run db:dev` actually runs.
 *
 * Why a separate process instead of catching the error in-process: a first attempt at in-process
 * recovery (catch the fatal engine error, close + recreate the PGlite instance, keep the same
 * Node process alive) turned out to be unreliable - Node's uncaughtException-handler shutdown
 * semantics interact badly with async cleanup that itself may hang (closing a WASM engine that
 * just hit an internal trap), and the process exited before the restart could even happen. A real
 * OS process boundary sidesteps all of that: if the child dies for any reason, this supervisor
 * just starts a fresh one. Data on disk (server/.pgdata) survives across restarts - except in the
 * case handled below, see PLAN.md deviation #32.
 */
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import net from "node:net";

const serverScript = fileURLToPath(new URL("./pgliteServer.ts", import.meta.url));
const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
const dataDir = fileURLToPath(new URL("../../.pgdata", import.meta.url));
const DB_PORT = 5433;
const MIN_RESTART_DELAY_MS = 500;
const MAX_RESTART_DELAY_MS = 10_000;
// A crash this fast after starting almost never recovers on its own - it means the WASM engine's
// last abort left .pgdata itself in a state that re-triggers the same crash on every fresh
// instance trying to load it, not a transient overload. Plain exponential backoff loops forever
// in that case (each retry dies just as fast, so the delay stays pinned at its cap) - see
// PLAN.md deviation #32, this is exactly what got stuck for several minutes before this fix.
const FAST_CRASH_THRESHOLD_MS = 5_000;
const FAST_CRASHES_BEFORE_WIPE = 3;

let restartDelay = MIN_RESTART_DELAY_MS;
let consecutiveFastCrashes = 0;
let shuttingDown = false;
let child: ReturnType<typeof spawn> | null = null;
// Set when a wipe just happened - the next successful start has a BLANK schema (wiping the data
// directory wipes the tables too), so it needs migrations re-applied before the app can actually
// use it. Without this, deviation #32's recovery brought the DB "up" but left every query failing
// with "relation does not exist" - the wipe fixed the crash but not the app. See PLAN.md deviation
// #33 - the same "recovered" isn't the same as "working" gap, one layer up from #32.
let needsMigrationAfterStart = false;

function startChild(): void {
  const startedAt = Date.now();
  const migrateAfterThisStart = needsMigrationAfterStart;
  needsMigrationAfterStart = false;

  // shell:true so `tsx` resolves via PATH (npm prepends node_modules/.bin when it launched this
  // supervisor, and that inherited PATH carries through env below) - needed on Windows where
  // tsx is a .cmd/.ps1 shim, not something spawn() can exec directly without a shell.
  child = spawn(`tsx "${serverScript}"`, {
    stdio: "inherit",
    env: process.env,
    shell: true,
  });

  if (migrateAfterThisStart) runMigrationsOnceReady();

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    const ranForMs = Date.now() - startedAt;
    console.error(`[pglite-supervisor] child exited (code=${code}, signal=${signal}) after ${ranForMs}ms`);

    if (ranForMs > 30_000) {
      // Ran healthily for a while - reset everything, this crash is unrelated to prior ones.
      restartDelay = MIN_RESTART_DELAY_MS;
      consecutiveFastCrashes = 0;
      scheduleRestart();
      return;
    }

    restartDelay = Math.min(restartDelay * 2, MAX_RESTART_DELAY_MS);
    // Only crashes fast enough to look like "immediately re-triggering the same corrupted state"
    // count toward the wipe threshold - a crash between 5s and 30s is still concerning but isn't
    // the specific "every restart dies instantly" pattern the wipe is for.
    if (ranForMs < FAST_CRASH_THRESHOLD_MS) consecutiveFastCrashes++;
    else consecutiveFastCrashes = 0;

    if (consecutiveFastCrashes >= FAST_CRASHES_BEFORE_WIPE) {
      console.error(
        `[pglite-supervisor] ${consecutiveFastCrashes} fast crashes in a row - .pgdata is likely ` +
          `corrupted from the last abort, not just under transient load. Wiping it and starting fresh ` +
          `(this is disposable local dev state, never production data - see PLAN.md deviation #32).`,
      );
      restartDelay = MIN_RESTART_DELAY_MS;
      consecutiveFastCrashes = 0;
      rm(dataDir, { recursive: true, force: true })
        .catch((err) => console.error("[pglite-supervisor] failed to wipe .pgdata:", err))
        .finally(() => {
          needsMigrationAfterStart = true;
          scheduleRestart();
        });
      return;
    }

    scheduleRestart();
  });
}

async function waitForPortOpen(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function runMigrationsOnceReady(): void {
  waitForPortOpen(DB_PORT, 15_000).then((ready) => {
    if (!ready) {
      console.error("[pglite-supervisor] gave up waiting for fresh DB to accept connections, skipping migration run");
      return;
    }
    console.error("[pglite-supervisor] fresh DB is up after a wipe - applying migrations so the app actually works");
    const migrate = spawn("npm", ["run", "migrate"], { cwd: serverRoot, stdio: "inherit", shell: true });
    migrate.on("exit", (code) => {
      if (code === 0) console.error("[pglite-supervisor] migrations applied successfully");
      else console.error(`[pglite-supervisor] migration run exited with code ${code} - DB may still be unusable`);
    });
  });
}

function scheduleRestart(): void {
  console.error(`[pglite-supervisor] restarting in ${restartDelay}ms...`);
  setTimeout(startChild, restartDelay);
}

function shutdown(): void {
  shuttingDown = true;
  child?.kill("SIGINT");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startChild();
