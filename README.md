```
      █████   ████   ████  █████  ██     ██  ██ █████   ████   ████
      ██  ██ ██  ██ ██  ██ ██  ██ ██     ██  ██ ██  ██ ██  ██ ██  ██
      ██  ██ ██  ██ ██  ██ ██  ██ ██      ████  ██  ██ ██  ██ ██  ██
      ██  ██ ██  ██ ██  ██ ██  ██ ██       ██   ██  ██ ██  ██ ██  ██
      ██  ██ ██  ██ ██  ██ ██  ██ ██       ██   ██  ██ ██  ██ ██  ██
      ██  ██ ██  ██ ██  ██ ██  ██ ██       ██   ██  ██ ██  ██ ██  ██
      █████   ████   ████  █████  ██████   ██   █████   ████   ████
```

<div align="center">

*Real-time collaborative painting — draw together, see every stroke live, sync like magic.*

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![Node.js](https://img.shields.io/badge/Node.js-22-green?logo=node.js&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-000000?logo=express&logoColor=white)](https://expressjs.com)
[![Yjs CRDT](https://img.shields.io/badge/Yjs-CRDT-FED148)](https://github.com/yjs/yjs)
[![WebSocket](https://img.shields.io/badge/WebSocket-ws-0085CC)](https://github.com/websockets/ws)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Redis](https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white)](https://redis.io)
[![Vitest](https://img.shields.io/badge/Vitest-tested-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com)
[![Render](https://img.shields.io/badge/Deploy-Render-46E3B7?logo=render&logoColor=white)](https://render.com)

</div>

> Multiple people draw on the same canvas simultaneously and see each other's strokes live, with
> per-user undo, presence/cursors, durable persistence, and access-controlled private boards.

Built as a backend-focused portfolio project: the interesting part isn't the UI, it's the CRDT
sync protocol, the WebSocket auth gate, the persistence/compaction pipeline, and the horizontal
scaling story. See [`PLAN.md`](./PLAN.md) for the full build log, every deviation from the original
plan (with reasoning), and what's still open. The original design plan (architecture rationale,
ranked feature list, phased build plan) lives at
`C:\Users\HP\.claude\plans\i-m-building-a-project-dapper-cocoa.md`.

## Features

- Pen, marker, highlighter, fountain + eraser, color picker, brush size, clear canvas
- Shape tools (rectangle, ellipse, line, arrow, diamond, star) with fill/stroke toggle, plus a
  text tool (click to place, double-click to edit) - all synced live like freehand strokes
- Live collaborative drawing - strokes appear on other clients *while being drawn*, not just on
  release
- Presence: online users list + live cursor positions
- Per-user undo/redo (a user only ever undoes their own strokes)
- Boards persist across restarts and everyone disconnecting; a joining client loads saved state,
  then live updates
- Private boards: JWT auth, board ownership, and an explicit invite flow - invites are sent by
  email or username; collaborators only ever see each other's display name, never the email
- Accounts: signup with email + username + display name; login with either email or username;
  username/email editable from the profile page
- Cross-instance scaling via Redis pub/sub (falls back to a correct in-memory relay for a single
  instance / local dev - no Redis required to run this locally)

## Architecture

```
                       ┌───────────────────────────┐
                       │        React Client         │
                       │  Canvas: bitmap + live layer │
                       │  Yjs Doc + Awareness         │
                       │  Custom WS provider          │
                       └───────────────┬───────────────┘
                    HTTPS (REST: auth, │  WSS (binary Yjs sync +
                    boards, invites)   │  awareness frames)
                                       │
                       ┌───────────────▼───────────────┐
                       │      Node.js (Express + ws)     │
                       │  HTTP: auth / boards / invites   │
                       │  WS upgrade: verify JWT + board   │
                       │  membership BEFORE joining room    │
                       │  RoomManager: Y.Doc + Awareness    │
                       │  + sockets per active board         │
                       └─────┬─────────────────┬─────────────┘
                             │                 │
                  publish/subscribe     append update / load
                  raw update bytes      snapshot+log on join
                             │                 │
                    ┌────────▼───────┐  ┌──────▼──────────────┐
                    │      Redis       │  │      PostgreSQL       │
                    │ pub/sub relay,   │  │ users, boards,         │
                    │ cross-instance   │  │ invited_users,         │
                    │ fan-out          │  │ yjs_updates (log),     │
                    │                  │  │ board_snapshots        │
                    └──────────────────┘  └────────────────────────┘
```

**Why Yjs (CRDT) over hand-rolled merge logic:** convergence is mathematically guaranteed,
including offline/out-of-order delivery, without writing conflict-resolution code by hand.

**Why a custom WebSocket server instead of the stock `y-websocket` binary:** room join has to be
gated on JWT + board authorization *before* a socket ever touches shared state - the canned server
has no hook for that.

**Why append-only update log + periodic snapshot compaction instead of one overwritten blob:**
cheap durable writes, bounded replay-on-load cost, and safe under concurrent compaction because
Yjs updates are commutative - the same tradeoff real databases make with WAL + checkpoint.

Full rationale for every major decision (11 of them, one line each) is in `PLAN.md`.

## Repo layout

```
server/   Express + ws API/WebSocket server, Postgres persistence, migrations
client/   React + Vite + HTML5 Canvas frontend
scripts/  demo-convergence.mjs - synthetic multi-client demo/verification script
```

See `server/src/` and `client/src/` for the detailed module breakdown - it matches the plan's
folder structure exactly.

## Running locally

Requires Node 22+. No Docker or local Postgres/Redis install needed - see `PLAN.md` deviation #1
for why (short version: a zero-install WASM Postgres stands in for local dev, Redis relay has a
correct in-memory fallback when `REDIS_URL` is unset).

```bash
# one-time
cd server && npm install && cd ../client && npm install && cd ..

# three terminals, each from the repo root:
cd server && npm run db:dev     # local Postgres on :5433
cd server && npm run migrate    # first run / after any schema change
cd server && npm run dev        # API + WS server on :4000
cd client && npm run dev        # Vite dev server on :5173 (proxies /api and /ws)
```

Open `http://localhost:5173`, sign up, create a board, and share the link. Open it in a second
browser profile to see live collaboration.

## Demo script

```bash
npm run demo -- 4 45   # 4 synthetic users, drawing for 45 seconds
```

Signs up N users, creates one shared board, invites everyone to it, opens N real browser windows
tiled on screen, and has each one draw continuously - useful for recording a demo video of live
convergence, in-progress strokes, and presence. Saves a final screenshot per client to
`demo-screenshots/` (gitignored) as evidence of convergence. Set `HEADLESS=1` to run it without
visible windows.

## Tests

```bash
cd server && npm test        # RedisRelay + rate limiter unit tests (vitest)
cd server && npm run typecheck
cd client && npx tsc -b
```

Every phase of the build was also verified against the running app with headless-browser scripts
(signup/login, multi-tab convergence, persistence-through-restart, access-control denial, invite
flow, reconnect-after-real-disconnect) - see `PLAN.md` for what was checked at each phase.

## Deployment

Single Railway service (see root `Dockerfile` + `railway.toml`): the client is built to static
assets and served by the same Express/WS process, so one service handles HTTP, WebSocket, and the
frontend together. Needs a Postgres addon, a Redis addon (only required for 2+ instances), and
these env vars (see `server/.env.example`):

- `DATABASE_URL`, `REDIS_URL` - from the respective Railway addon's variables tab
- `JWT_SECRET` - generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- `CLIENT_ORIGIN` - the deployed URL itself (same-origin in production, so this mostly matters for
  any cross-origin dev/staging setup)

Run `npm run migrate` (from `server/`, pointed at the production `DATABASE_URL`) once before first
deploy and after any schema change.

## Known limitations (deliberate, see `PLAN.md` for the reasoning)

- JWT expiry is checked at WS-connect time only, not enforced mid-session on an already-open socket
- No CI pipeline, no Douglas-Peucker point simplification, no real multi-instance load test - all
  explicitly scoped out given the project timeline; ranked alongside what *was* built in `PLAN.md`
