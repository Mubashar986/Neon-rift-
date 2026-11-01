/**
 * Builds the production bundle, boots the E2E server on loopback and runs the
 * Playwright suite against it. Running everything from one Bun process means
 * the suite does not depend on `bun` being present on PATH for Playwright's
 * webServer helper, and there is exactly one server lifecycle to clean up.
 *
 * Usage: bun run test:e2e
 */
import { resolve } from "node:path";
import { E2E_ORIGIN, E2E_PORT, startE2eServer } from "./start-e2e";

const root = resolve(import.meta.dir, "..");

console.log("[e2e] building production bundle...");
const build = Bun.spawnSync([process.execPath, "run", "build"], {
  cwd: root,
  env: process.env,
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) {
  console.error("[e2e] build failed");
  process.exit(build.exitCode ?? 1);
}

const app = startE2eServer(E2E_PORT);
console.log(`[e2e] server ready at ${E2E_ORIGIN}`);

const cli = resolve(root, "node_modules/@playwright/test/cli.js");
const node = Bun.which("node") ?? process.execPath;
const forwardArgs = process.argv.slice(2);
const child = Bun.spawn([node, cli, "test", ...forwardArgs], {
  cwd: root,
  env: {
    ...process.env,
    E2E_BASE_URL: E2E_ORIGIN,
    E2E_PORT: String(E2E_PORT),
  },
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await child.exited;
await app.stop();
console.log(`[e2e] playwright exited with code ${exitCode}`);
process.exit(exitCode);
