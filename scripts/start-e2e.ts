/**
 * Boots the production server for Playwright E2E runs. The build is produced by
 * scripts/test-e2e.ts before this module starts. Can also be run directly:
 *
 *   bun run start:e2e
 *
 * It listens on loopback only and enables the isolated match-finish hook so the
 * browser tests can end a match deterministically without waiting out the timer.
 */
import { resolve } from "node:path";
import { createNeonServer } from "../src/server/app";
import type { NeonServer } from "../src/server/app";

export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORT}`;

export function startE2eServer(port = E2E_PORT): NeonServer {
  return createNeonServer({
    port,
    host: "127.0.0.1",
    isProduction: true,
    staticDir: resolve(import.meta.dir, "../dist/client"),
    publicOrigin: `http://127.0.0.1:${port}`,
    allowedOrigins: [],
    enableTestEndpoints: true,
    logLevel: process.env.E2E_LOG_LEVEL === "debug" ? "debug" : "warn",
    version: "e2e",
  });
}

if (import.meta.main) {
  const app = startE2eServer();
  console.log(`NEON RIFT E2E server listening on ${E2E_ORIGIN}`);
  const shutdown = async () => {
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
