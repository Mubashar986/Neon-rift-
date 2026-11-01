/**
 * Bun entry point. Start with `bun run start` (production build required).
 * All configuration comes from environment variables — see docs/DEPLOYMENT.md.
 */
import { createNeonServer } from "./app";

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
