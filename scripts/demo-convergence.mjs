#!/usr/bin/env node
/**
 * Spins up N synthetic users, one shared board (owner invites the rest), and N real browser
 * windows all drawing on it at once - for recording a demo of live convergence, in-progress
 * strokes, presence/cursors, and multi-user editing without conflicts.
 *
 * Usage:
 *   node scripts/demo-convergence.mjs [clientCount] [durationSeconds]
 *   node scripts/demo-convergence.mjs 4 45
 *
 * Env:
 *   APP_URL     defaults to http://localhost:5173
 *   HEADLESS    set to "1" to run without visible windows (used by the automated check in
 *               PLAN.md; leave unset for an actual recording)
 *
 * Requires the app already running (npm run dev at the repo root, or the three dev processes
 * individually - see PLAN.md).
 */
import { chromium } from "playwright";

const APP_URL = process.env.APP_URL ?? "http://localhost:5173";
const HEADLESS = process.env.HEADLESS === "1";
const CLIENT_COUNT = Number(process.argv[2] ?? 3);
const DURATION_SECONDS = Number(process.argv[3] ?? 30);

const PALETTE = ["#e03131", "#2f9e44", "#1971c2", "#f08c00", "#9c36b5", "#0c8599"];
const WINDOW_SIZE = { width: 640, height: 520 };
const GRID_COLS = 3;

async function signup(baseUrl, username, displayName, password) {
  const res = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, displayName, password }),
  });
  if (!res.ok) throw new Error(`signup failed for ${username}: ${res.status} ${await res.text()}`);
  return res.json(); // { token, user }
}

async function createBoard(baseUrl, token, name) {
  const res = await fetch(`${baseUrl}/api/boards`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`create board failed: ${res.status} ${await res.text()}`);
  return res.json(); // { id, name, createdAt }
}

async function invite(baseUrl, ownerToken, boardId, username) {
  const res = await fetch(`${baseUrl}/api/boards/${boardId}/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) throw new Error(`invite failed for ${username}: ${res.status} ${await res.text()}`);
}

function apiBaseFromAppUrl(appUrl) {
  // Dev: Vite proxies /api to the server on :4000. Same-origin in prod. Either way `${appUrl}/api/...`
  // through the running app's own origin is correct - no separate server URL needed.
  return appUrl;
}

async function main() {
  if (CLIENT_COUNT < 1 || CLIENT_COUNT > PALETTE.length) {
    throw new Error(`clientCount must be between 1 and ${PALETTE.length}`);
  }
  const apiBase = apiBaseFromAppUrl(APP_URL);
  const runId = Math.random().toString(36).slice(2, 8);
  const users = Array.from({ length: CLIENT_COUNT }, (_, i) => ({
    // Username is the unique login credential (see the username-only-auth migration) - embed
    // runId the same way email used to, so repeated runs of this script don't collide. Display
    // name (see the display-name migration) is what actually renders in the UI/on cursors.
    username: `demo-${runId}-${i + 1}`,
    displayName: `Demo-${i + 1}`,
    password: "demo-password-not-real",
    color: PALETTE[i],
  }));

  console.log(`Signing up ${CLIENT_COUNT} synthetic users...`);
  const signedUp = [];
  for (const u of users) signedUp.push({ ...u, ...(await signup(apiBase, u.username, u.displayName, u.password)) });

  console.log("Creating shared board and inviting the rest...");
  const owner = signedUp[0];
  const board = await createBoard(apiBase, owner.token, "Live demo board");
  for (const u of signedUp.slice(1)) await invite(apiBase, owner.token, board.id, u.username);

  const boardUrl = `${APP_URL}/board/${board.id}`;
  console.log(`Board ready: ${boardUrl}`);

  console.log(`Launching ${CLIENT_COUNT} browser window(s)...`);
  const browsers = [];
  const pages = [];
  for (let i = 0; i < signedUp.length; i++) {
    const col = i % GRID_COLS;
    const row = Math.floor(i / GRID_COLS);
    const browser = await chromium.launch({
      headless: HEADLESS,
      args: HEADLESS
        ? []
        : [
            `--window-position=${col * (WINDOW_SIZE.width + 10)},${row * (WINDOW_SIZE.height + 40)}`,
            `--window-size=${WINDOW_SIZE.width},${WINDOW_SIZE.height}`,
          ],
    });
    browsers.push(browser);
    const context = await browser.newContext({ viewport: HEADLESS ? WINDOW_SIZE : null });
    const page = await context.newPage();
    const token = signedUp[i].token;
    await page.addInitScript((t) => localStorage.setItem("doodlydoo:token", t), token);
    // Not networkidle: the WS connection this page opens keeps the network "busy" forever, so
    // networkidle would never resolve. Wait for the actual content instead.
    await page.goto(boardUrl);
    await page.waitForSelector("text=live", { timeout: 15000 });
    pages.push(page);
  }
  console.log("All clients connected and live.");

  console.log(`Drawing for ${DURATION_SECONDS}s - watch the windows (or record now)...`);
  const stop = { value: false };
  setTimeout(() => (stop.value = true), DURATION_SECONDS * 1000);

  await Promise.all(
    pages.map((page, i) => drawLoop(page, i, stop)),
  );

  const { fileURLToPath } = await import("node:url");
  const outDir = fileURLToPath(new URL("../demo-screenshots/", import.meta.url));
  await import("node:fs/promises").then((fs) => fs.mkdir(outDir, { recursive: true }));
  for (let i = 0; i < pages.length; i++) {
    await pages[i].screenshot({ path: `${outDir}client-${i + 1}.png` });
  }
  console.log(`Final screenshots of each client saved to demo-screenshots/ (proves convergence).`);

  console.log("Done. Closing browsers.");
  for (const b of browsers) await b.close();
}

async function drawLoop(page, index, stop) {
  const canvas = (await page.$$("canvas"))[1];
  if (!canvas) return;
  const box = await canvas.boundingBox();
  if (!box) return;

  let originX = 40 + (index % GRID_COLS) * 5;
  let originY = 40 + Math.floor(index / GRID_COLS) * 5;

  while (!stop.value) {
    const x0 = box.x + ((originX + Math.random() * 400) % (box.width - 20));
    const y0 = box.y + ((originY + Math.random() * 400) % (box.height - 20));
    const dx = (Math.random() - 0.5) * 160;
    const dy = (Math.random() - 0.5) * 160;

    await page.mouse.move(x0, y0);
    await page.mouse.down();
    const steps = 6 + Math.floor(Math.random() * 6);
    for (let s = 1; s <= steps; s++) {
      await page.mouse.move(x0 + (dx * s) / steps, y0 + (dy * s) / steps, { steps: 1 });
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
    await page.waitForTimeout(150 + Math.random() * 300);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
