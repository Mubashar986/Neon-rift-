/**
 * Development orchestrator: Bun API/WS server with hot reload + Vite dev server
 * with HMR. The Vite proxy forwards /ws, /api and /healthz to Bun, so the
 * browser only ever talks to http://localhost:5173 during development.
 *
 * Usage: bun run dev
 */
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const bun = process.execPath;
const backendPort = process.env.PORT ?? "3000";
const clientPort = process.env.VITE_PORT ?? "5173";

const env = {
  ...process.env,
  PORT: backendPort,
  HOST: process.env.HOST ?? "0.0.0.0",
  NODE_ENV: process.env.NODE_ENV ?? "development",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
};

console.log(`\n  NEON RIFT dev\n  client  http://localhost:${clientPort}\n  server  http://localhost:${backendPort}\n`);

const server = Bun.spawn([bun, "--watch", resolve(root, "src/server/index.ts")], {
  cwd: root,
  env,
  stdout: "inherit",
  stderr: "inherit",
});

const client = Bun.spawn(
  [bun, resolve(root, "node_modules/vite/bin/vite.js"), "--port", clientPort, "--strictPort"],
  {
    cwd: root,
    env,
    stdout: "inherit",
    stderr: "inherit",
  },
);

let shuttingDown = false;
async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.kill();
  client.kill();
  await Promise.allSettled([server.exited, client.exited]);
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

const firstExit = await Promise.race([
  server.exited.then((code) => ({ name: "server", code })),
  client.exited.then((code) => ({ name: "client", code })),
]);

if (!shuttingDown) {
  console.error(`\n[dev] ${firstExit.name} exited with code ${firstExit.code}. Stopping the other process.`);
  await shutdown(firstExit.code === 0 ? 1 : firstExit.code);
}
