# doodlydoo — Build Log & Living Plan

Full design plan (architecture, schema, rationale) lives at:
`C:\Users\HP\.claude\plans\i-m-building-a-project-dapper-cocoa.md`

This file tracks actual build progress, deviations from that plan, and anything that needs
Yashasvi's attention. Updated as each phase completes.

## Phase status

- [x] Phase 0 — Setup & skeleton
- [x] Phase 1 — Local single-user canvas
- [x] Phase 2 — Realtime multiplayer core
- [x] Phase 3 — Persistence
- [x] Phase 4 — Auth & access control (MVP) — **MVP reached**
- [x] Phase 5a — `invited_users` + owner invite flow
- [x] Phase 5b — Redis pub/sub cross-instance relay
- [x] Phase 5c — structured logging + healthz metrics
- [x] Phase 5d — rate limiting on WS updates
- [x] Phase 6a — single-service static serving + Dockerfile/railway.toml
- [x] Phase 6b — reconnect/resync verified against a real server restart
- [x] Phase 6c — synthetic multi-client demo script (`npm run demo`)
- [x] Phase 6d — README + final PLAN.md pass — **build complete, all 6 phases + full stretch list**

## Deviations from the original plan (with reasoning)

### 1. No Docker locally — swapped local Postgres/Redis for zero-install equivalents

This machine has no Docker, no WSL distro installed, no native Postgres/Redis, and the shell
doesn't have admin rights (installers like the Postgres MSI or Docker Desktop need elevation and
would hang waiting for a UAC prompt that can't be answered non-interactively). Rather than block
on that, here's the swap:

- **Postgres → PGlite (`@electric-sql/pglite`) via `@electric-sql/pglite-socket`.** PGlite is
  actual Postgres compiled to WASM, not a reimplementation, so it supports real SQL (uuid, bytea,
  FKs, indexes, transactions). `pglite-socket` exposes it over the real Postgres wire protocol on
  `localhost:5433`, so the app's normal `pg` client code doesn't know the difference — same code
  path works against real Postgres in production. Data persists to `server/.pgdata/` (gitignored).
  Started via `npm run db:dev` in `server/`.
- **Redis → provider interface, in-memory by default locally.** The relay code is written against
  a small `PubSubRelay` interface (`ws/redisRelay.ts` exports both `InMemoryRelay` and
  `RedisRelay`). `RedisRelay` uses real `ioredis` and is what runs on Railway once `REDIS_URL` is
  set. Locally, with no `REDIS_URL`, `InMemoryRelay` is used automatically — correct behavior for
  a single dev instance, and it's the same interface either way so swapping is zero-risk.
- `docker-compose.yml` is still included (real Postgres + Redis) for parity/reference and in case
  Docker becomes available later, but local dev does **not** depend on it.

### 2. Health route and future REST routes live under `/api/*`

Vite's dev proxy forwards `/api/**` to the Express server and `/ws` (upgrade) separately, so the
client never needs CORS in dev and the same `/api` prefix carries into production behind one
Railway service. `GET /api/healthz` checks real DB connectivity (not just process liveness).

### 3. Yjs schema decided in Phase 1, used unchanged through later phases

`client/src/yjs/schema.ts`: `strokes: Y.Map<id, Y.Map<{id,userId,tool,color,width,points:Y.Array<number>,createdAt,finishedAt}>>`
plus `meta: Y.Map<{clearedAt}>`. `finishedAt` (null while drawing) is what lets the renderer -
and later Phase 2's per-user undo and Phase 3's persistence - distinguish "still live" strokes
from "committed" ones without any extra bookkeeping structure.

### 4. Two-layer canvas implemented exactly as planned, with one refinement

Committed (bitmap) canvas + live (overlay) canvas, per PLAN's risk mitigation. Refinement made
while building: the committed layer is only ever (a) fully repainted once on mount/bootstrap, or
(b) has exactly one newly-finished stroke baked onto it (`bakeStrokeById`, no clear+redraw). A
full clear+redraw on every finished stroke would have silently reintroduced the O(total history)
cost the two-layer design exists to avoid - worth remembering if this gets refactored later.

### 5. Verified Phase 1 with a real headless browser, not just typecheck

No project "run" skill existed yet, and `chromium-cli` wasn't available on this machine, so used
Playwright (`chromium.launch()`) directly - installed as a root devDependency since it'll be
reused for Phase 2's multi-client convergence check and the Phase 6 demo script. Confirmed via
screenshot: pen stroke draws, eraser cuts a real gap (`destination-out` compositing), clear wipes
the bitmap, zero console errors.

### 6. Own WS/Yjs protocol implementation, not the canned y-websocket server

`server/src/ws/{protocol,room,roomManager,server}.ts` implement the y-websocket wire format
(sync + awareness sub-protocols via `y-protocols` + `lib0`) by hand against the raw `ws` package,
exactly as planned - this is what makes the Phase 4 auth gate possible (`server.on('upgrade', ...)`
rejects before `wss.handleUpgrade` is ever called; currently checks only that `boardId` is present,
Phase 4 adds the JWT + membership check in that same spot). Client side mirrors it in
`client/src/yjs/wsProvider.ts` with exponential-backoff reconnect built in from the start.

### 7. Per-user undo needed no extra bookkeeping - just origin discipline

`Y.UndoManager`'s default `trackedOrigins` is `{null}`. Local edits transact with the default
origin (`null`); `WsProvider` applies every remote-sourced update with itself (`this`) as the
transaction origin. That alone means each client's undo stack only ever contains its own strokes -
verified by having two tabs draw concurrently and confirming one tab's undo removed only its own
stroke on both tabs. No per-user filtering code needed.

### 8. No board creation/auth yet - client mints its own board id and guest identity

`/` redirects to `/board/<nanoid>` and identity is a random per-tab guest (`sessionStorage`), both
explicitly temporary per the phase plan. Phase 4 replaces board-id minting with a real
`POST /api/boards` call and guest identity with the authenticated user.

### 9. Verified Phase 2 with two real, independent browser contexts

Same Playwright setup as Phase 1, extended to two `BrowserContext`s hitting the same board URL
concurrently. Confirmed via screenshot: mid-drag live rendering on the *other* tab (not just on
pointerup), labeled remote cursor, presence list, byte-identical convergence after concurrent
strokes from both tabs, and correct per-user undo isolation in both directions.

### 10. `boards.owner_id` is nullable; schema built incrementally across migrations

Phase 3 needs a `boards` row to exist before auth (Phase 4) does, so `owner_id uuid` has no FK/
NOT NULL yet (`server/src/db/migrations/1000000000000_persistence-core.sql`). A board is
auto-created (`ensureBoard`, upsert, owner_id null) the first time anything connects to its id -
this is what makes the Phase 2/3 "client mints its own board id" dev flow work without a real
`users` table existing yet. Phase 4 adds `users` + the FK + `NOT NULL` via a follow-up migration,
matching how the schema would actually evolve feature-by-feature rather than one big-bang DDL.
Also added a second migration (`..._snapshot-compaction-cursor.sql`) rather than editing the
first one after it had already run, on the same "never edit an applied migration" principle.

### 11. Room bootstrap made the *first* connection to a cold board `await` its DB load

`roomManager.getOrCreateRoom` is async: a board with no in-memory room yet loads snapshot + log
tail from Postgres and applies it to a fresh `Y.Doc` *before* the connecting socket gets its
sync-step-1 handshake, so a joining client's first sync already has full history - no flash of an
empty canvas that then suddenly fills in. Concurrent connects to the same cold board share one
in-flight load promise instead of racing duplicate loads.

### 12. Idle-room eviction implemented in Phase 3 (moved up from the Phase 5 stretch list)

Persistence existing is what makes eviction safe (nothing to lose), so it made more sense to build
it alongside persistence than defer it - `IDLE_EVICT_MS` (60s prod default) after a room's last
socket closes, cancelled if anyone reconnects first, does a final compaction flush before freeing
the `Y.Doc`/`Awareness`. Verified for real (not just read from the code) by temporarily running the
server with `IDLE_EVICT_MS=5000 COMPACT_INTERVAL_MS=5000` and watching the log sequence
`room loaded -> compacted -> evicted after idle timeout -> room loaded` (fresh reconnect) in one
run - confirms the reload after eviction is genuinely coming from Postgres, not a lingering
in-memory room that happened to survive.

### 13. `@electric-sql/pglite-socket` serves one active connection at a time - dev-only caveat

Discovered while writing a verification script that opened a second, separate `pg` connection
alongside the app's own connection pool: pglite-socket queues extra connections rather than
serving them concurrently (real Postgres has no such limit). Only affects local dev tooling/ad-hoc
scripts hitting the DB outside the app; the app itself uses a single shared `pg.Pool` and never
hit this. Noting it in case a future local script seems to hang for ~10s for no obvious reason -
it's queued behind another open connection, not broken.

### 14. JWT transported as a WebSocket subprotocol, not a query string

Went with the plan's original recommendation rather than the simpler query-string approach:
client sends `new WebSocket(url, [jwt])`; server's `handleProtocols` echoes it back to complete
the handshake, while the *actual* verification reads `Sec-WebSocket-Protocol` straight off the
upgrade request, before `wss.handleUpgrade`. JWTs (base64url segments joined by `.`) are valid
subprotocol tokens per RFC 6455's token grammar, so this needed no encoding tricks. Avoids the
token ever landing in server access logs or browser history.

### 15. `ensureBoard`'s Phase-3 auto-insert had to be replaced, not just left alone

Once `boards.owner_id` became `NOT NULL` (this phase's migration), the old "insert a board row on
first WS connection if it doesn't exist" convenience broke (`null value in column "owner_id"`) -
caught immediately by the Phase 4 verification run, not by inspection. Fixed by replacing it with
`touchBoardActivity` (an `UPDATE ... last_active_at`, no insert): by the time a room is created
now, the WS upgrade gate has already confirmed the board exists and this user owns it, so there
was never anything left for that function to "ensure" - it just hadn't been deleted yet.

### 16. Local PGlite data directory got corrupted once by a force-kill, and had to be wiped

Cleaning up a tangle of duplicate background dev processes (see below), I force-killed the PGlite
process via `Stop-Process -Force` instead of letting it catch `SIGINT` and checkpoint - WASM
Postgres doesn't like being killed mid-write. It crashed on next start with a wasm-level abort.
Fix was to delete `server/.pgdata/` and re-run migrations from scratch - safe because it's
disposable local dev state, never production data. Lesson for later: stop this process via its
task ID (SIGINT) if possible, not a forceful OS-level kill.

### 17. Accidentally ran the root `concurrently` dev script on top of already-running individual
### processes, producing 4 duplicate servers all fighting over :4000

Root cause: a background command's cwd reset doesn't carry to the next Bash call, and I ran a bare
`npm run dev` right after a command that had `cd`'d to the repo root - which silently ran the
*root* package.json's `concurrently`-based dev script instead of the server's. Symptom was
`EADDRINUSE` crash-loops. Fixed by killing every doodlydoo-related `node.exe` process and
restarting the three dev processes individually, each with an explicit `cd` in the same command.
Going forward, every background dev-server launch in this project uses an explicit
`cd /d/doodlydoo/<app> && npm run dev` in one command rather than relying on prior `cd` state.

### 18. Invite access check reused the exact same `getBoardIfAuthorized` function from Phase 4

`invited_users` just extended that one function's `WHERE` clause with an `OR EXISTS` - the REST
`GET /api/boards/:id` check and the WS upgrade gate both picked up invite support automatically,
with no changes needed at either call site. This is the payoff of having made that a single shared
function back in Phase 4 instead of duplicating the check.

### 19. Redis relay: a real regression surfaced by the same-account-two-tabs test, not the relay itself

The relay logic itself (verified with 3 `ioredis-mock`-backed unit tests: cross-instance delivery,
per-board channel isolation, unsubscribe) was correct on the first pass. What the *end-to-end*
regression check caught was a pre-existing bug in `PresenceList`: it keyed React list items by
`userId`, which collides when one account has two tabs/devices open (same `userId`, different Yjs
`clientId`). Fixed by keying by `clientId` instead - a good reminder that presence is fundamentally
per-*connection*, not per-*user*. `CursorsOverlay` already did this correctly, which is why only
`PresenceList` needed the fix.

### 20. Awareness state now relays cross-instance too, not just Yjs doc updates

The plan's Redis relay description focused on canvas strokes, but presence/cursors need the same
treatment - a user on instance B should see cursors from instance A. `Room` publishes both
`doc.on('update')` and `awareness.on('update')` through the relay using the same `MESSAGE_SYNC` /
`MESSAGE_AWARENESS` framing already used on the WebSocket wire, so `Room`'s relay-message handler
is just the same decode switch as the client/server WS handlers reused a third time.

### 21. `/api/healthz` doubles as the metrics endpoint rather than a separate `/metrics`

Added `activeConnections` and `memoryRssMb` to the existing health payload instead of standing up
a second endpoint - at this project's scale a dedicated `/metrics` would just be extra surface
area (and would need its own auth story to avoid leaking operational data publicly) for no real
benefit over one well-structured JSON payload. Worth mentioning as a deliberate scope call in an
interview, not an oversight.

### 22. Rate limiting is a token bucket per WebSocket connection, tuned from real usage numbers

Capacity 200 / refill 100 per second, chosen by working backward from what the client can actually
produce (point capture throttled to animation-frame rate ≈60/s, cursor updates throttled to 25/s -
see `client/src/canvas/pointCapture.ts` and `CanvasBoard`'s `CURSOR_THROTTLE_MS`), so it never
fires during real drawing but comfortably catches a scripted flood. Verified both ends: unit tests
for the bucket math itself, and a real headless-browser session doing six fast 40-point strokes
back-to-back with zero drops logged and the connection staying live throughout.

**Correction (deviation #31): this "never fires during real drawing" claim was wrong.** The
"animation-frame rate ≈60/s" assumption doesn't hold on higher refresh-rate displays
(`requestAnimationFrame` tracks the display's actual refresh rate, not a fixed 60Hz), and a single
shared bucket for both message types meant a burst on one starved the other. Real usage hit this
and silently lost stroke data. Fixed properly in deviation #31 - two separate buckets, sized by
what's actually safe to drop (awareness: yes) versus never safe to drop (doc updates: no).

### 23. Single-service deploy: server serves the built client as static files in production

Rather than two Railway services (API+WS and a static site), `server/src/index.ts` serves
`client-dist/` and does an SPA fallback (`app.get(/^(?!\/api).*/, ...)` -> `index.html`) whenever
`NODE_ENV=production`. One Dockerfile at the repo root multi-stage-builds both apps into one image
(`Dockerfile`). Verified locally by actually building both (`npm run build` in each) and running
`NODE_ENV=production node server/dist/index.js` against the copied client build on a spare port:
confirmed `/api/healthz`, the static `index.html`, and the `/board/:id` SPA fallback all work
correctly before writing the Dockerfile around it. Couldn't verify the Dockerfile itself builds
(no Docker on this machine - deviation #1) - flagged in Yashasvi TODO below.

### 24. `setOffline()` doesn't reliably kill an already-open WebSocket in this Playwright/Chromium
### setup - had to actually restart the real dev server to test reconnect

First attempt at testing reconnect-after-disconnect used `browserContext.setOffline(true)`,
expecting it to close the WS like a real network drop would; it didn't trigger `onclose` within
20s in this environment. Fell back to what actually proves the behavior end-to-end: ran the
verification script in the background with a 30-second sleep window, force-killed the real server
process mid-script, confirmed the client's status flipped to "reconnecting…", restarted the server,
and confirmed it auto-reconnected (exponential backoff), rejoined the room, and kept working -
including drawing successfully immediately after reconnecting.

### 25. Demo script's own `page.goto(..., { waitUntil: "networkidle" })` hung - same WS gotcha
### called out in the project's own `run` skill reference, hit for real

A board page opens a WebSocket immediately, which keeps the network "busy" forever from
Playwright's point of view, so `networkidle` never resolves once a WS is open (it worked on a
*fresh* page the very first time only by luck of timing; became a reliable hang once several demo
runs had chromium instances contending for resources). Fixed by dropping `waitUntil: "networkidle"`
and relying on the existing `waitForSelector("text=live")` instead - the same pattern already used
correctly in every other verification script this session.

### 26. Real bug found by the final end-to-end pass: fast successive strokes shared one undo step

`Y.UndoManager`'s default `captureTimeout` (500ms) merges any transactions that close together in
time into a single undo entry - correct for "coalesce a rapid burst of edits," wrong for "each
stroke is its own undo unit" when two strokes happen to land within 500ms of each other (an
enthusiastic real user, or anything scripted, easily does this). Caught by the final golden-path
verification: two quick strokes, one "Undo" click, and *both* strokes vanished together on every
client. Fixed with `undoManager.stopCapturing()` in `handlePointerUp` right after `finishStroke` -
an explicit boundary marker so the next stroke always starts a fresh undo entry regardless of
timing, rather than tuning the timeout number down and hoping. Re-verified the exact scenario that
found it: two strokes at the same tight timing, two separate undos, two strokes removed one at a
time. This is exactly the kind of thing that only a real running-app check catches - the code
looked correct and typechecked fine.

### 27. Production incident: dropped DB connection crashed the whole server, disconnecting everyone

**Symptom** (reported against the running dev app): `Error: Connection terminated unexpectedly` at
`getBoardIfAuthorized` -> `handleUpgrade`, and the entire Node process died, dropping every
connected client - not just the one WS upgrade that hit the error.

**Root causes, two independent gaps:**

1. **The real crash trigger**: `server/src/persistence/db.ts`'s `pg.Pool` had no `pool.on('error',
   ...)` listener. node-postgres emits `'error'` on the *pool itself* for problems with an *idle*
   pooled connection (exactly what "Connection terminated unexpectedly" is - the DB dropped a
   connection sitting in the pool, unrelated to any specific in-flight query). An `EventEmitter`
   `'error'` event with zero listeners is fatal to the whole Node process by default - this bypasses
   every try/catch anywhere else in the codebase, because it isn't a rejected promise at all.
2. **A secondary real bug**: `ws/server.ts`'s upgrade handler called `void handleUpgrade(...)` -
   `void` only silences the "unused promise" lint/type warning, it does **not** attach a
   `.catch()`. If `getBoardIfAuthorized`'s query rejected for any reason, that became a genuine
   unhandled promise rejection.

**Fixes:**
- `db.ts`: added `pool.on('error', ...)` - logs and lets the pool recover (this is the fix that
  actually matters; node-postgres is designed to survive and replace a bad idle connection once
  something is listening for the error).
- `ws/server.ts`: `getBoardIfAuthorized` now wrapped in try/catch inside `handleUpgrade`, failing
  *only that one upgrade* with `503` and a clear log line; the outer `server.on('upgrade', ...)`
  listener now does `handleUpgrade(...).catch(...)` instead of `void handleUpgrade(...)`.
- **Broader-gap check** (as asked): Express 4 does not catch rejected promises from `async` route
  handlers at all - every DB call in `auth/routes.ts` and `boards/routes.ts` had the same exposure.
  Added `middleware/asyncHandler.ts` (wraps a handler, routes rejections to `next(err)`), applied
  it to every async route, and added a final Express error-handling middleware in `index.ts` that
  returns a clean `500` instead of leaking an unhandled rejection.
- Added `process.on('unhandledRejection', ...)` in `index.ts` as an explicit safety net on top of
  the above - logs and keeps the process alive. Deliberately did **not** add a matching
  `uncaughtException` handler: that indicates potentially corrupted process state and swallowing it
  is a different, riskier tradeoff than a rejected promise; out of scope for this fix.

**Verified**: typecheck + existing unit tests still pass; restarted the full dev stack; two
authenticated tabs on the same (invited) board drawing *continuously and concurrently* for 20
seconds - both stayed `live` throughout, `/api/healthz` afterward showed the same server process
still up (`uptimeSeconds` continuous, no restart), zero errors in server logs or either browser
console.

### 28. Same PGlite corruption as #16 recurred, same fix - now documented as a recognizable pattern

The root `npm run dev` (concurrently) got started on top of already-running individual dev
processes again, causing port collisions that led to more force-kills of the PGlite process mid-
write, which corrupted `.pgdata` again with the same wasm-abort signature as deviation #16. Same
fix: delete `server/.pgdata/`, restart, re-run `npm run migrate`. This wipes local dev data (any
test accounts/boards from that session) but is always safe - never production data. If this
`RuntimeError: Aborted()` / wasm-abort signature shows up in `[db]` logs again, this is the known
cause and fix, not a new investigation. Consolidated onto the root `npm run dev` for this session
going forward rather than three separately-launched processes, to remove the port-collision risk
this kept causing.

### 29. Compaction firing on every update + two more crash sources found chasing it down

**Reported**: with two users drawing continuously, `"compacted board update log"` was logging
multiple times per second, and the server eventually crashed with `Error: Connection terminated
unexpectedly` on a raw `pg.Client` - different from deviation #27's pool-level fix. Right after,
PGlite itself hard-crashed (`RuntimeError: unreachable`, `npm run db:dev` exiting).

**Root causes - three separate things, found in sequence as each fix exposed the next:**

1. **Compaction had a threshold but no cooldown.** `roomManager.ts`'s `onUpdate` fired
   `compactBoard()` immediately every time 50 updates accumulated, with nothing stopping several
   compactions from overlapping. A single long continuous drag pushes a Yjs update on every
   animation frame (~60/s) per client; two clients drawing continuously blew past the threshold
   every fraction of a second, firing overlapping DB transactions back-to-back.
2. **`compactBoard`'s checked-out `pg.Client` had no `'error'` listener** - the same class of bug
   as deviation #27, but on a *different* object. `pool.on('error', ...)` only covers *idle*
   clients sitting in the pool; a client checked out via `pool.connect()` (needed here for a real
   `BEGIN`/`COMMIT` transaction) is its own `EventEmitter` and can emit `'error'` asynchronously,
   outside any specific query's promise. With no listener, that's fatal to the whole process.
3. **The fix for #2 introduced a listener leak.** node-postgres *reuses* `Client` objects across
   `pool.connect()` checkouts. Attaching a fresh `client.on('error', ...)` every compaction without
   removing it piled a new listener onto whatever underlying `Client` the pool handed back, until
   Node's `MaxListenersExceededWarning` fired. Fixed by naming the handler and calling
   `client.off('error', handler)` before every `release()` (all three exit paths: clean commit,
   the "nothing to do" early return, and the error/rollback path).

**Fixes shipped:**
- `roomManager.ts`: per-board `CompactionState` (`pendingUpdates`, `inFlight` promise,
  `lastCompactionAt`) behind a `maybeCompact()` gate - one compaction in flight per board at a
  time, never more often than `COMPACT_MIN_INTERVAL_MS` (2s default, env-overridable). The
  periodic 30s sweep goes through the same gate.
- `compactBoard`: named `client.on('error', ...)` handler, removed via `client.off(...)` before
  every `release()`; on error, `client.release(err)` so the pool discards the suspect connection
  instead of recycling it; the `ROLLBACK` call is itself wrapped so a dead connection failing to
  roll back doesn't produce a second, different unhandled error.

**A fourth thing found only by the 2-minute sustained-load verification, not by inspection:**
even with compaction properly debounced, `appendUpdate` (the WAL-style log write) was still firing
one `INSERT` per single Yjs update with zero batching - the actual bulk of query volume under
continuous drawing, and enough on its own to still crash PGlite. Added `appendUpdates` (one
multi-row `INSERT` for a batch) plus a per-board buffer in `roomManager.ts` that flushes on a
250ms timer or at 30 buffered updates, whichever comes first (flushed for real, bypassing the
timer, on room eviction so nothing buffered is lost). Also capped `pg.Pool`'s `max` via a new
`PG_POOL_MAX` env var (default 3) - sized for what PGlite can actually sustain; production against
real Postgres can raise it.

**What stayed broken despite all four fixes, and why that's OK:** PGlite's own WASM engine still
hits an internal `RuntimeError: unreachable` under ~20-70s of sustained continuous heavy writes
from two clients - a PGlite-specific ceiling, not a bug in this app's code (real Postgres on
Railway has no such limit). Crucially, **the server process itself never crashed once, across four
separate 2-minute stress runs** - `/api/healthz` correctly reported `degraded`/`db: down` while
PGlite was out, both browser tabs stayed connected and `live` the entire time in every run, and
zero browser-console errors ever appeared. That was the actual thing being asked for ("survives...
without disconnecting people"), and it now reliably holds.

Went one step further for local-dev quality of life: added `server/src/dev/pgliteSupervisor.ts`,
a small process supervisor that `db:dev` now runs instead of `pgliteServer.ts` directly - it spawns
the real PGlite process as a child and restarts it with exponential backoff (500ms → 10s cap) if
it ever exits, so a PGlite crash self-heals within seconds instead of needing someone to notice and
manually restart it. (An earlier attempt at recovering *in-process* - catching the fatal error,
closing and recreating the PGlite instance in the same Node process - turned out to be unreliable:
Node's `uncaughtException`-handler shutdown semantics interact badly with async cleanup that may
itself hang, and the process exited before the recovery could even run. A real OS process boundary
sidesteps that class of problem entirely.) Verified the supervisor for real: it correctly detected
and restarted PGlite through a whole cascade of crashes during the stress test (visible in logs as
`child exited ... restarting in 500ms/1000ms/2000ms/4000ms/8000ms/10000ms`), and once the
synthetic load stopped, PGlite settled back to a stable `up` state on its own with the server's own
`uptimeSeconds` continuous throughout - never restarted.

### 30. Investigated a reported "strokes don't sync live, only cursors do" bug - could not
### reproduce it against a verified-clean server; added permanent diagnostic logging instead

**Reported**: with one user drawing continuously and a second user only watching, the watcher's
live cursor tracking worked, but the drawer's actual strokes didn't appear promptly (or at all) on
the watcher's canvas, with canvases diverging over a longer session.

**What was added** (all four things asked for):
- `server/src/ws/room.ts`: `doc.on('update')` now logs `boardId`, `bytes`, `origin`
  (`ws-client`/`relay`/`persistence-load`/`null`), current socket count, and recipient count on
  every broadcast.
- `server/src/ws/server.ts`: logs `boardId`, `bytes`, and timestamp on every `MESSAGE_SYNC` frame
  received from a client, before it's applied.
- `client/src/yjs/wsProvider.ts`: `console.debug('[doc-sync] sending', ...)` on every outgoing doc
  update (size, origin, timestamp) and `console.debug('[doc-sync] received', ...)` on every
  incoming one - visible in the browser DevTools console. This logging is permanent, not a one-off
  debug script - if this is seen again, open both browsers' consoles and filter for `[doc-sync]`.

**Investigation, with evidence:** reviewed the client send path (`wsProvider.ts`), server receive/
broadcast path (`server.ts` + `room.ts`), and the client render path (`CanvasBoard.tsx`'s
`strokes.observeDeep` handler) line by line - awareness and doc updates go through structurally
identical code (same message framing, same broadcast-excluding-origin logic, same relay wiring;
see deviation #20). No asymmetry found by inspection. Ran two independent controlled reproductions
against a verified single, freshly-restarted server process (see below for why "verified" matters
here):
1. **Exact match to the report**: one client draws one continuous ~4s stroke, the other only
   watches. Screenshots taken mid-draw show the watcher's canvas rendering the stroke
   progressively, in step with the drawer. Console logs show every `sending` on the drawer's side
   matched by a `received` on the watcher's side 1-6ms later - no delay, no drops.
2. **Broader match to "over a longer session"**: one client draws 20 separate strokes (distinct
   pointerup/pointerdown cycles, random 0.2-2s pauses between them, matching natural human pacing)
   over ~35-50s while the other only watches. 245 doc-sync messages sent, 245 broadcast by the
   server (confirmed via server-side logs: `origin: "ws-client"`, `recipients: 1`, matching exactly
   what 2 connected sockets excluding the sender should produce), 247-248 received by the watcher
   (the +2/3 are the watcher's own initial handshake messages, not a mismatch). Final canvases
   were pixel-identical between both clients.

**A real mistake found along the way, in my own test setup, not the app**: the first attempt at
this investigation showed client-side logs proving correct sends/receives, but the server log file
I was checking showed almost none of that traffic. Root cause: two full `npm run dev` stacks were
running simultaneously (a duplicate-process mistake of my own, made during the Phase 5
compaction-crash investigation's many restarts - see deviation #29's restart history), so the log
file I was tailing belonged to a different, mostly-idle server process than the one actually
serving the browsers' WebSocket connections. Cleaned up to a single verified stack and reran both
reproductions - see above. This was noise in my debugging process, not a mechanism that could
explain the originally reported symptom (only one process can ever bind the port actively serving
both users, so this can't cause two live users on the same board to diverge from each other).

**Conclusion: could not reproduce.** The doc-update sync path works correctly and promptly in both
scenarios tested, with byte-level evidence at every hop (client send -> server receive -> server
broadcast -> client receive -> client render). No code change to the actual sync mechanism was
made, since I could not find or reproduce a defect to fix - changing working code based on
unreproduced symptoms would be guessing, not engineering. What was shipped instead: the permanent
`[doc-sync]` logging above, so if this recurs, it can be diagnosed directly from evidence in a real
session rather than needing another from-scratch investigation.

**If this is still seen in practice**, the most likely explanations that automated headless-browser
testing wouldn't surface (untested, offered as starting points rather than confirmed causes):
- **Backgrounded/inactive browser tab throttling.** Chrome (and others) throttle JS timers and
  execution for tabs not currently visible/focused - if the "watching" tab was in the background
  while observing, this could plausibly delay message processing in a way a headless Playwright
  session (which doesn't experience the same visibility-driven throttling) wouldn't reproduce.
  Worth testing with both tabs visible/foregrounded side by side.
- **A stale cached client bundle** from before one of this session's several `wsProvider.ts`/
  `CanvasBoard.tsx` changes - a hard refresh (not just a normal reload) on both tabs rules this out.
- **A duplicate/stale server process** on whichever machine reproduced it, same class of issue as
  found in my own testing above - `curl localhost:4000/api/healthz` and check `uptimeSeconds` looks
  sane / there's only one process on port 4000, per the recurring `EADDRINUSE`-family issue logged
  in deviation #17.

### 31. Found it for real: the WS rate limiter (deviation from Phase 5d) was silently dropping
### stroke data, sized for an assumption that didn't hold - deviation #30's conclusion was wrong

Deviation #30 concluded this bug couldn't be reproduced. That conclusion was wrong - the
automated Playwright reproductions in #30 paced mouse movement with `await` delays between steps,
which (accidentally) never generated a burst dense enough to trigger the real mechanism. A later
real (human, side-by-side, both tabs foregrounded) test hit it, ruling out the backgrounded-tab-
throttling hypothesis, and this time there was a real server log to trace with the deviation #30
logging - which is what actually found it.

**Root cause, confirmed from the log, not inferred:** `ws/server.ts` had ONE shared `TokenBucket`
(capacity 200, refill 100/s) gating *every* incoming WS message regardless of type, sized on the
assumption that combined traffic (point-pushes throttled to animation-frame rate, ~60/s, plus
cursor updates throttled to ~25/s) would stay around ~85/s and "never get near" the limit. The
real log showed **33 consecutive `"ws client rate-limited, dropping messages"` warnings inside
about one second** on one connection - a genuine fast/bursty pointer input stream (a real mouse or
a high refresh-rate display can push far more than 60 events/s; `requestAnimationFrame` itself
runs at the *display's* refresh rate, not a fixed 60Hz, so a 120/144Hz+ monitor alone breaks the
sizing assumption) drained the shared bucket. Because doc/stroke updates are naturally far higher-
volume than the throttled cursor stream during a burst, they dominated *which* messages were
in-flight when the bucket was empty - so drops landed almost entirely on stroke data while
occasional awareness messages still slipped through in the gaps. That produces exactly the
reported asymmetry ("cursors work, strokes don't") **without the two message types ever being
handled differently** - the asymmetry was emergent from shared capacity under uneven traffic
volume, not a routing bug. And because dropped messages are just gone (fire-and-forget, no
retry/resync), this was permanent, cumulative data loss over a session, not just visible lag.

**Fix:** split into two independent `TokenBucket`s per connection instead of one shared one
(`ws/server.ts`):
- **Awareness bucket** (capacity 150, refill 75/s): kept as real rate limiting, because dropping
  awareness is safe - it's ephemeral and self-correcting, the next cursor update supersedes a lost
  one, so this remains genuine abuse protection.
- **Sync/doc bucket** (capacity 3000, refill 1500/s): raised by an order of magnitude and up.
  Doc updates are irreplaceable drawn content with no resync mechanism to recover a dropped one
  later, so dropping them is close to always the wrong tradeoff for this app - the new ceiling is
  sized purely as a backstop against a genuine flood (thousands/sec from a broken or malicious
  client), effectively unreachable by any real drawing UI even on a very high refresh-rate display,
  while the append-batching/debounced-compaction pipeline from deviation #29 already absorbs high
  legitimate write volume gracefully downstream.

**Verified** (Playwright again, since I have no hands to operate a real mouse - but deliberately
designed this time to reproduce the *mechanism*, not just imitate the surface scenario): 3 minutes
of continuous drawing, 197 strokes, each stroke's points sent as a tight burst of `mouse.move`
calls with **no artificial delay between them** (removing the pacing that made deviation #30's
attempts miss the bug) while a second client only watched. Zero `"rate-limited"` warnings in the
server log for the entire run (the 33 from the original incident are all timestamped before the
fix), zero console errors on either client, and final canvases pixel-identical between both -
every one of the 197 strokes present on both sides.

**Lesson for next time**: a synthetic reproduction that fails to reproduce a bug is evidence the
*repro* was insufficient, not that the bug doesn't exist - deviation #30 treated an unreproduced
symptom as grounds to stop looking, when the actual gap was that the test's `await`-paced timing
didn't generate the traffic shape that matters. The fix this time came from tracing real evidence
(the log), not from a better guess.

### 32. The pglite-supervisor (deviation #29) could get stuck in an infinite crash loop -
### exponential backoff alone doesn't recover from corrupted on-disk state

Right after deviation #31's rate-limit fix finished verifying successfully, PGlite crashed again
(the same known WASM `RuntimeError: unreachable` under sustained write load from deviation #29's
3-minute stress test) - but this time the supervisor didn't recover. It kept restarting, and every
restart died again within ~1.4 seconds, so the backoff delay grew to its 10s cap and stayed there
- crash, wait 10s, crash again in 1.4s, wait 10s, forever. Stuck for several minutes before this
was noticed and fixed.

**Root cause:** deviation #29's supervisor only implements backoff for *transient* failures (an
overloaded engine that needs a moment to recover). It had no way to distinguish that from a
*persistent* failure: once a WASM abort leaves `.pgdata` itself in a state that re-triggers the
same crash on load, every fresh `PGlite.create(dataDir)` against that same corrupted directory
fails the same way, no matter how long you wait between attempts. Backoff timing doesn't help when
the problem isn't timing.

**Fix:** `pgliteSupervisor.ts` now tracks consecutive *fast* crashes (child ran for under 5s). On
the 3rd one in a row, instead of just retrying again, it deletes `server/.pgdata/` before the next
restart - safe because this is disposable local dev state (never production; production runs
against Railway's real Postgres, which doesn't have this WASM engine at all), and a corrupted
local dev database blocking the whole dev loop is worse than losing whatever was drawn on local
test boards. Logs clearly when it does this so it's never a silent surprise. A crash that runs
healthily for 30s+ still resets both the backoff delay and the fast-crash counter, so this only
triggers for the specific "immediately re-crashing" pattern, not for occasional real crashes under
genuine load spread further apart.

**Verified:** manually reproduced the exact stuck state (repeated sub-2s crashes, backoff pinned
at 10s, `/api/healthz` stuck on `db: down`) before writing the fix, confirmed the new code compiles
and the logic path is reachable, then wiped the already-corrupted `.pgdata` by hand to unblock the
current session immediately (equivalent to what the supervisor will now do on its own next time)
and restarted clean - `db: up` within seconds. The next time three fast crashes happen in a row,
the supervisor recovers itself instead of needing manual intervention again.

Separately: this DB crash happened *after* deviation #31's 3-minute rate-limit verification had
already completed successfully (197 strokes, zero drops, pixel-identical canvases - that data was
captured before PGlite crashed). It doesn't call those results into question; it's the same
already-understood PGlite write-load ceiling from deviation #29, now with a supervisor that
actually self-heals from it instead of getting stuck.

### 33. Deviation #32's auto-wipe recovery brought PGlite back "up" with a blank schema - found
### from a real `42P01 undefined_table` error, fixed, verification of this one is incomplete

Right after deviation #32 shipped, the dev stack hit exactly the crash-loop-then-wipe path it was
built for - and recovered into a database that accepted connections but had **no tables at all**.
Every subsequent query failed with Postgres error `42P01` (`relation does not exist`), surfacing as
a real 500 on `GET /api/boards/:id/invites` in a live session. Root cause: wiping `.pgdata` deletes
the schema along with the corrupted data, and deviation #32 never re-ran migrations against the
fresh instance - "the DB responds" isn't the same as "the DB works."

**Fix:** `pgliteSupervisor.ts` now sets a flag when it wipes, and after the next successful child
start, polls `localhost:5433` until it accepts TCP connections (up to 15s) and then spawns
`npm run migrate` as its own child process, logging success/failure. Also tightened a loose end
from #32 while touching this file: `FAST_CRASH_THRESHOLD_MS` was defined but never actually used to
gate the fast-crash counter (anything under the 30s "healthy" bar counted, not just genuinely fast
crashes) - now a crash only counts toward the wipe threshold if it's under 5s, and anything between
5-30s resets the counter without triggering a wipe.

**Verification is honestly incomplete.** Typechecks cleanly and the logic was reviewed carefully
(wait-for-port loop, spawning the exact same `npm run migrate` command used everywhere else in this
project, correct flag sequencing). Attempted to force the real 3-fast-crashes-in-a-row trigger by
repeatedly killing the live PGlite child process, but couldn't land the precise timing reliably
through this tool's process-management latency, and backed off partway through on realizing the
server logs showed real (non-automated) browser traffic - likely an actual in-progress session -
that repeatedly killing the shared local dev DB risked disrupting. Restored a clean, fully-migrated,
healthy state instead of continuing to force it. If this exact path (wipe → blank schema → broken
queries) is hit again, it's now the known, already-fixed issue from this entry - check for
`"fresh DB is up after a wipe - applying migrations"` / `"migrations applied successfully"` in the
`[db]` log lines to confirm the fix actually ran.

### (more deviations logged below as they happen)

---

## How to run it locally

Run the three dev processes individually, each in its own terminal (the root `concurrently`
script exists but see deviation #17 - safest to just run these three directly):
- `cd server && npm run db:dev` — zero-install Postgres on `localhost:5433`
- `cd server && npm run migrate` — applies all migrations (only needed after schema changes or a
  fresh `.pgdata`)
- `cd server && npm run dev` — API/WS server on `localhost:4000`
- `cd client && npm run dev` — Vite client on `localhost:5173` (proxies `/api` and `/ws`)

Then open `http://localhost:5173` — it redirects to `/signup` if you have no account yet. Sign up,
create a board, and share the URL with a second account to see the access-control denial in
action, then use the board's "Invite by email" box (owner only) to grant that second account
access and watch it become a real collaborator.

For a scripted multi-user demo (e.g. to record): `npm run demo -- 4 45` from the repo root - see
README.md.

## Build status: all 6 phases complete, MVP + full stretch list delivered

Every phase (0 through 6, including all four Phase 5 stretch items) was implemented and verified
against the actually-running app, not just typechecked - headless-browser scripts for: local
drawing (pen/eraser/clear), two-tab live convergence + presence + per-user undo, persistence
surviving real room eviction, signup/login + cross-user access denial at both the HTTP and WS
layers, the invite flow making a second user a real collaborator, Redis relay logic (unit tests)
plus the regression it surfaced, rate-limit tuning against real drawing traffic, and reconnect
after an actual server restart. Full narrative and reasoning for every deviation is above (25
entries) - nothing here was silently changed without a documented reason.

---

## Yashasvi TODO

*(nothing here blocked the build - everything is stubbed/documented so it kept moving. This is
what's left for you.)*

1. **Fill in real secrets before deploying anywhere real.** `server/.env` currently has a
   placeholder `JWT_SECRET` fine for local dev only. Generate a real one before production:
   `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
2. **Railway setup** (none of this was done - needs your account):
   - Create a Railway project, add a Postgres addon and (optional, only needed for 2+ instances) a
     Redis addon.
   - Connect this repo; Railway should auto-detect the root `Dockerfile` (there's also a
     `railway.toml` pinning the healthcheck path to `/api/healthz`).
   - Set env vars on the service: `DATABASE_URL` and `REDIS_URL` from the addons' own variable
     tabs, `JWT_SECRET` (generated above), `CLIENT_ORIGIN` (the deployed URL once you have it).
   - Before or right after first deploy, run `npm run migrate` from `server/` with `DATABASE_URL`
     pointed at the production database (e.g. via `railway run npm run migrate` from `server/`, or
     temporarily export the Railway Postgres URL locally).
3. **I could not verify the Dockerfile actually builds** - no Docker available in this dev
   environment (deviation #1). The single-service static-serving path it depends on *was* verified
   by running the equivalent production build directly with Node (deviation #23), so the app logic
   is confirmed correct, but the Docker build itself (`docker build .` at the repo root) has not
   been run by me. Worth doing once before the first real deploy, or just let Railway's first
   deploy attempt be that test.
4. **Nothing else is blocking.** Auth, boards, invites, persistence, reconnect, and the demo script
   are all built and verified against the running app - see the phase-by-phase writeup above.
