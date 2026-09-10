import { execFileSync } from "node:child_process";
import "../config/env.js";

execFileSync(
  "node",
  [
    "node_modules/node-pg-migrate/bin/node-pg-migrate.js",
    "up",
    "--migrations-dir",
    "src/db/migrations",
    "--database-url-var",
    "DATABASE_URL",
  ],
  { stdio: "inherit", cwd: new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") },
);
