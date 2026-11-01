import { resolve } from "node:path";
import type { AppConfig } from "../../src/server/config";
import { createNeonServer } from "../../src/server/app";
import type { NeonServer } from "../../src/server/app";

/**
 * Boots the real Bun server on an ephemeral loopback port. Tests never mock
 * the WebSocket layer: they exercise the same code path production uses.
 */
export function startTestServer(overrides: Partial<AppConfig> = {}): NeonServer {
  return createNeonServer({
    port: 0,
    host: "127.0.0.1",
    isProduction: false,
    staticDir: resolve(import.meta.dir, "../../dist/client"),
    publicOrigin: null,
    allowedOrigins: [],
    enableTestEndpoints: true,
    logLevel: "silent",
    version: "test",
    ...overrides,
  });
}

export function wsUrl(app: NeonServer): string {
  return `ws://127.0.0.1:${app.server.port}/ws`;
}

export function httpBase(app: NeonServer): string {
  return `http://127.0.0.1:${app.server.port}`;
}

export function pageOrigin(app: NeonServer): string {
  return `http://127.0.0.1:${app.server.port}`;
}
