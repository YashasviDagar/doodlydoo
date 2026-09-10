import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProduction: process.env.NODE_ENV === "production",
  port: Number(process.env.PORT ?? 4000),
  clientOrigin: required("CLIENT_ORIGIN", "http://localhost:5173"),
  databaseUrl: required("DATABASE_URL"),
  // node-postgres defaults to 10. PGlite (this project's zero-install local dev DB - see PLAN.md
  // deviation #1) serializes at the connection level and has shown it can't reliably sustain
  // many truly-concurrent connections under heavy write load (deviation #29) - default low here
  // and let production (real Postgres on Railway) override it higher via env if ever needed.
  pgPoolMax: Number(process.env.PG_POOL_MAX ?? 3),
  redisUrl: process.env.REDIS_URL || undefined,
  jwtSecret: required("JWT_SECRET"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
};
