import { networkInterfaces } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import type { Server } from "bun";
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  SNAPSHOT_RATE,
  TICK_RATE,
} from "../shared/constants";
import { normalizeRoomCode } from "../shared/protocol";
import type { AppConfig } from "./config";
import { loadConfig } from "./config";
import { GameServer } from "./GameServer";
import type { WsData } from "./GameServer";
import { createLogger } from "./monitoring/logger";
import type { Logger } from "./monitoring/logger";
import { Metrics } from "./monitoring/metrics";
import { checkWsOrigin } from "./security/origin";

export interface NeonServer {
  server: Server<WsData>;
  gameServer: GameServer;
  config: AppConfig;
  logger: Logger;
  stop(): Promise<void>;
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

export function createNeonServer(overrides: Partial<AppConfig> = {}): NeonServer {
  const config = loadConfig(overrides);
  const logger = createLogger(config.logLevel);
  const metrics = new Metrics();
  const gameServer = new GameServer(config, logger, metrics);

  const server = Bun.serve<WsData>({
    port: config.port,
    hostname: config.host,
    development: !config.isProduction,
    fetch: async (request, bunServer) => {
      try {
        const url = new URL(request.url);

        if (url.pathname === "/ws") {
          return handleWebSocketUpgrade(request, bunServer, url, config, logger);
        }
        if (url.pathname === "/healthz") {
          return json(
            {
              ok: true,
              status: "healthy",
              service: "neon-rift-arena",
              uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000),
              version: config.version,
            },
            200,
            0,
          );
        }
        if (url.pathname === "/api/status") {
          return json(gameServer.status(), 200, 0);
        }
        if (url.pathname === "/api/test/finish" && request.method === "POST") {
          return handleTestFinish(request, gameServer, config, logger);
        }
        if (url.pathname.startsWith("/api/")) {
          return json({ ok: false, error: "not_found" }, 404, 0);
        }

        if (request.method !== "GET" && request.method !== "HEAD") {
          return text("Method not allowed", 405);
        }

        return await serveStatic(url, request, config);
      } catch (error) {
        metrics.errors++;
        logger.error("HTTP request failed", {
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : String(error),
        });
        return json({ ok: false, error: "internal_error" }, 500, 0);
      }
    },
    websocket: gameServer.websocketHandlers,
    error: (error) => {
      metrics.errors++;
      logger.error("Server error", { error: error.message });
      return new Response("Internal Server Error", { status: 500 });
    },
  });

  gameServer.start();
  logStartup(config, logger, server.port ?? config.port);

  return {
    server,
    gameServer,
    config,
    logger,
    async stop() {
      gameServer.stop();
      await server.stop(true);
      logger.info("server stopped");
    },
  };
}

function handleWebSocketUpgrade(
  request: Request,
  server: Server<WsData>,
  url: URL,
  config: AppConfig,
  logger: Logger,
): Response | undefined {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return text("WebSocket upgrade required", 426);
  }

  const originCheck = checkWsOrigin(
    request.headers.get("origin"),
    request.headers.get("host") ?? url.host,
    request.headers.get("x-forwarded-host"),
    config,
  );
  if (!originCheck.allowed) {
    logger.warn("WebSocket origin rejected", { reason: originCheck.reason, path: url.pathname });
    return text("Origin not allowed", 403);
  }

  const upgraded = server.upgrade(request, { data: { connectionId: -1 } });
  if (!upgraded) return text("WebSocket upgrade failed", 400);
  return undefined;
}

async function handleTestFinish(
  request: Request,
  gameServer: GameServer,
  config: AppConfig,
  logger: Logger,
): Promise<Response> {
  if (!config.enableTestEndpoints) {
    return json({ ok: false, error: "not_found" }, 404, 0);
  }

  const raw = await request.text();
  if (raw.length > 512) return json({ ok: false, error: "payload_too_large" }, 413, 0);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400, 0);
  }

  if (typeof body !== "object" || body === null || !("roomCode" in body)) {
    return json({ ok: false, error: "roomCode_required" }, 400, 0);
  }
  const code = normalizeRoomCode((body as { roomCode: unknown }).roomCode);
  if (!code) return json({ ok: false, error: "invalid_room_code" }, 400, 0);

  const finished = gameServer.finishRoomForTest(code);
  logger.info("test endpoint finished match", { room: code, finished });
  return json({ ok: finished }, finished ? 200 : 404, 0);
}

async function serveStatic(url: URL, request: Request, config: AppConfig): Promise<Response> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return text("Bad request", 400);
  }

  if (pathname.includes("\0") || pathname.includes("\\")) {
    return text("Bad request", 400);
  }

  const indexPath = join(config.staticDir, "index.html");
  const indexFile = Bun.file(indexPath);
  if (!(await indexFile.exists())) {
    return frontendNotBuilt();
  }

  const relative = pathname === "/" ? "/index.html" : pathname;
  const requestedPath = resolve(config.staticDir, `.${relative}`);
  const staticRoot = resolve(config.staticDir) + sep;
  if (!requestedPath.startsWith(staticRoot)) {
    return text("Not found", 404);
  }

  const file = Bun.file(requestedPath);
  if (await file.exists()) {
    if ((await file.stat()).isDirectory()) {
      return text("Not found", 404);
    }
    return new Response(request.method === "HEAD" ? null : file, {
      headers: staticHeaders(requestedPath, pathname),
    });
  }

  // SPA fallback: /play?room=ABC123 and friends all load the game shell.
  const acceptsHtml = request.headers.get("accept")?.includes("text/html") ?? false;
  const hasExtension = extname(pathname) !== "";
  if (!hasExtension && acceptsHtml) {
    return new Response(request.method === "HEAD" ? null : indexFile, {
      headers: staticHeaders(indexPath, "/index.html"),
    });
  }

  return text("Not found", 404);
}

function staticHeaders(filePath: string, pathname: string): Record<string, string> {
  const extension = extname(filePath).toLowerCase();
  const contentType = STATIC_CONTENT_TYPES[extension] ?? "application/octet-stream";
  const isHashedAsset = pathname.startsWith("/assets/");
  return {
    ...SECURITY_HEADERS,
    "Content-Type": contentType,
    "Cache-Control": isHashedAsset
      ? "public, max-age=31536000, immutable"
      : "no-cache, no-store, must-revalidate",
  };
}

function json(payload: unknown, status: number, cacheSeconds: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-store",
    },
  });
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function frontendNotBuilt(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>NEON RIFT: ARENA — build required</title>
<style>
  body{background:#05060d;color:#cfe9ff;font-family:ui-monospace,monospace;display:grid;place-items:center;min-height:100vh;margin:0}
  main{max-width:640px;padding:32px;border:1px solid #1d3050;border-radius:16px;background:#0a1020;box-shadow:0 0 40px #123}
  h1{font-size:20px;letter-spacing:.14em;color:#33f6ff}
  code{color:#ffb03b}
</style>
</head>
<body><main>
<h1>NEON RIFT: ARENA</h1>
<p>The Bun server is running, but the production frontend has not been built yet.</p>
<p>Build it with <code>bun run build</code>, then restart this server. For development run <code>bun run dev</code> and open the Vite URL.</p>
<p>API health check: <a style="color:#33f6ff" href="/healthz">/healthz</a></p>
</main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function logStartup(config: AppConfig, logger: Logger, actualPort: number): void {
  const lanUrls = getLanUrls(actualPort);
  logger.info("NEON RIFT server online", {
    host: config.host,
    port: actualPort,
    mode: config.isProduction ? "production" : "development",
    tickRate: TICK_RATE,
    snapshotRate: SNAPSHOT_RATE,
    protocol: PROTOCOL_VERSION,
    maxMessageBytes: MAX_MESSAGE_BYTES,
  });
  logger.info(`local: http://localhost:${actualPort}`);
  for (const url of lanUrls) {
    logger.info(`network: ${url}`);
  }
  if (config.publicOrigin) {
    logger.info(`public origin configured: ${config.publicOrigin}`);
  } else {
    logger.info("public origin not configured (set PUBLIC_ORIGIN when deploying)");
  }
}

function getLanUrls(port: number): string[] {
  const urls = new Set<string>();
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.internal || entry.family !== "IPv4") continue;
      urls.add(`http://${entry.address}:${port}`);
    }
  }
  return [...urls];
}

if (import.meta.main) {
  const app = createNeonServer();
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.logger.info(`received ${signal}, shutting down`);
    try {
      await app.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
