import pino from "pino";
import { env } from "./config/env.js";

export const logger = pino({
  level: env.isProduction ? "info" : "debug",
  transport: env.isProduction
    ? undefined
    : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
});
