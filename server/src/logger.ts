import pino from "pino";
import { env } from "./config/env.js";

// Pretty logging is explicitly opt-in via PINO_PRETTY, NOT inferred from NODE_ENV. Inferring it
// crashed production once: NODE_ENV was set to a value that wasn't exactly "production" (a
// Render typo), so the pino-pretty transport was requested - but pino-pretty is a devDependency
// and absent from the production image, so pino threw at boot and the service crash-looped.
// A config typo should degrade to plain JSON logs, never take the service down.
export const logger = pino({
  level: env.isProduction ? "info" : "debug",
  transport: process.env.PINO_PRETTY
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
    : undefined,
});
