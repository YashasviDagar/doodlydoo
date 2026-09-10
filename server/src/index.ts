import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./logger.js";
import { checkDbConnection } from "./persistence/db.js";
import { attachWsServer } from "./ws/server.js";
import { activeConnectionCount, activeRoomCount } from "./ws/roomManager.js";
import { authRouter } from "./auth/routes.js";
import { boardsRouter } from "./boards/routes.js";
import { invitesRouter } from "./invites/routes.js";

// Safety net, not a substitute for fixing call sites: an unhandled rejection anywhere we missed
// (see PLAN.md for the incident that prompted this - a dropped DB connection during a WS upgrade
// crashed the whole process and disconnected every client). Logs and keeps the process alive
// instead of Node's default of crashing.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection - process staying up");
});

const app = express();
app.use(cors({ origin: env.clientOrigin }));
app.use(express.json());
app.use(pinoHttp({ logger }));

app.use("/api/auth", authRouter);
app.use("/api/boards", boardsRouter);
app.use("/api/invites", invitesRouter);

// Doubles as the ops/observability endpoint for a project this size - a dedicated /metrics with
// its own auth would be the answer at a larger scale, but that's more surface area than a single
// small instance needs. See PLAN.md for that tradeoff note.
app.get("/api/healthz", async (_req, res) => {
  const dbOk = await checkDbConnection();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? "ok" : "degraded",
    db: dbOk ? "up" : "down",
    activeRooms: activeRoomCount(),
    activeConnections: activeConnectionCount(),
    memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    uptimeSeconds: process.uptime(),
  });
});

// Single-service deploy: in production, this same process serves the built client too, so
// Railway only needs one service instead of separately hosting a static site (keeping HTTP+WS+
// static all on one process/port is also why the WS auth gate matters so much - see ws/server.ts).
if (env.isProduction) {
  const clientDist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client-dist");
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

// Registered last on purpose (Express error middleware is matched by position, not path):
// catches anything routed here via asyncHandler's `.catch(next)` - e.g. a DB error mid-request -
// so it becomes a clean 500 response instead of an unhandled rejection.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err, path: req.path }, "unhandled error in request handler");
  if (res.headersSent) return;
  res.status(500).json({ error: "internal_error" });
});

const server = http.createServer(app);
attachWsServer(server);

server.listen(env.port, () => {
  logger.info(`doodlydoo server listening on :${env.port} (${env.nodeEnv})`);
});
