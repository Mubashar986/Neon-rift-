import { resolve } from "node:path";
import { DEFAULT_SERVER_PORT } from "../shared/constants";
import type { LogLevel } from "./monitoring/logger";

export interface AppConfig {
  port: number;
  host: string;
  isProduction: boolean;
  staticDir: string;
  publicOrigin: string | null;
  allowedOrigins: string[];
  enableTestEndpoints: boolean;
  logLevel: LogLevel;
  version: string;
}

function parsePort(raw: string | undefined): number {
  if (!raw) return DEFAULT_SERVER_PORT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0 || value > 65_535) return DEFAULT_SERVER_PORT;
  return value;
}

function parseLogLevel(raw: string | undefined): LogLevel {
  const normalized = (raw ?? "info").toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error" || normalized === "silent") {
    return normalized;
  }
  return "info";
}

function normalizeConfiguredOrigin(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol}//${url.host}`.replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * Environment contract:
 *   PORT                    listening port (default 3000, 0 = random for tests)
 *   HOST                    bind address (default 0.0.0.0)
 *   NODE_ENV                production | development | test
 *   PUBLIC_ORIGIN           e.g. https://neon-rift.up.railway.app
 *   ALLOWED_ORIGINS         comma-separated extra WS origins
 *   ENABLE_TEST_ENDPOINTS   1 = enable the isolated E2E match-finish hook
 *   LOG_LEVEL               debug | info | warn | error | silent
 */
export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const env = process.env;
  const nodeEnv = overrides.isProduction !== undefined
    ? overrides.isProduction ? "production" : "development"
    : env.NODE_ENV ?? "development";

  const publicOrigin = normalizeConfiguredOrigin(env.PUBLIC_ORIGIN ?? null);
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => normalizeConfiguredOrigin(origin))
    .filter((origin): origin is string => origin !== null);

  return {
    port: overrides.port ?? parsePort(env.PORT),
    host: overrides.host ?? env.HOST ?? "0.0.0.0",
    isProduction: nodeEnv === "production",
    staticDir: overrides.staticDir ?? resolve(import.meta.dir, "../../dist/client"),
    publicOrigin: overrides.publicOrigin ?? publicOrigin,
    allowedOrigins: overrides.allowedOrigins ?? allowedOrigins,
    enableTestEndpoints: overrides.enableTestEndpoints ?? env.ENABLE_TEST_ENDPOINTS === "1",
    logLevel: overrides.logLevel ?? parseLogLevel(env.LOG_LEVEL),
    version: overrides.version ?? "1.0.0",
  };
}
