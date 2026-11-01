/**
 * Captures documentation screenshots from the real production build.
 * Usage: bun run build && bun scripts/screenshots.ts
 *
 * Every simulated player gets its own browser context: session tokens live in
 * localStorage, and two tabs of the same profile would fight over the single
 * owner of one session (the server treats a replayed token as a takeover).
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, devices } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { E2E_ORIGIN, startE2eServer } from "./start-e2e";

const outDir = resolve(import.meta.dir, "../docs/screenshots");
mkdirSync(outDir, { recursive: true });

const app = startE2eServer();
const browser = await chromium.launch();

async function newPlayer(
  options: Parameters<Browser["newContext"]>[0],
): Promise<{ context: Awaited<ReturnType<Browser["newContext"]>>; page: Page }> {
  const context = await browser.newContext({ baseURL: E2E_ORIGIN, ...options });
  const page = await context.newPage();
  return { context, page };
}

async function boot(page: Page): Promise<void> {
  page.on("pageerror", (error) => console.error("[pageerror]", error.message));
  await page.goto("/");
  await page.locator("#boot-screen.is-hidden").waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const menu = document.getElementById("screen-menu");
      const button = document.getElementById("btn-quick-match") as HTMLButtonElement | null;
      return menu?.classList.contains("is-active") === true && button !== null && !button.disabled;
    },
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(700);
}

async function startSolo(page: Page, name: string): Promise<string> {
  await page.fill("#nickname", name);
  await page.click("#btn-create-room");
  await page.locator("#screen-lobby").waitFor({ state: "visible" });
  const code = ((await page.locator("#lobby-code").textContent()) ?? "").trim();
  await page.click("#btn-start-match");
  await page.locator("#screen-game").waitFor({ state: "visible" });
  await page.waitForFunction(
    () => {
      const api = (
        window as unknown as {
          __NEON_RIFT__?: { getState(): { snapshot: { phase: string } | null } };
        }
      ).__NEON_RIFT__;
      return api?.getState().snapshot?.phase === "playing";
    },
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(900);
  return code;
}

interface DebugPlayer {
  id: string;
  x: number;
  y: number;
}

interface DebugState {
  selfId: string | null;
  snapshot: { players: DebugPlayer[] } | null;
}

async function readState(page: Page): Promise<DebugState | null> {
  return page.evaluate(() => {
    const api = (window as unknown as { __NEON_RIFT__?: { getState(): DebugState } }).__NEON_RIFT__;
    return api ? api.getState() : null;
  });
}

/**
 * Walks the pilot away from its (random) spawn and toward the arena centre so
 * the captured frame shows representative combat space instead of a corner.
 */
async function moveToCentre(page: Page, touch: boolean): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const state = await readState(page);
    const self = state?.snapshot?.players.find((player) => player.id === state.selfId);
    if (!self) return;
    const dx = 1200 - self.x;
    const dy = 800 - self.y;
    if (Math.hypot(dx, dy) < 200) break;

    if (touch) {
      const box = await page.locator("#move-stick").boundingBox();
      if (!box) return;
      const centreX = box.x + box.width / 2;
      const centreY = box.y + box.height / 2;
      const length = Math.hypot(dx, dy) || 1;
      await page.mouse.move(centreX, centreY);
      await page.mouse.down();
      await page.mouse.move(centreX + (dx / length) * 42, centreY + (dy / length) * 42, {
        steps: 3,
      });
      await page.waitForTimeout(400);
      await page.mouse.up();
    } else {
      const keys = [dx > 0 ? "d" : "a", dy > 0 ? "s" : "w"];
      for (const key of keys) await page.keyboard.down(key);
      await page.waitForTimeout(400);
      for (const key of keys) await page.keyboard.up(key);
    }
    await page.waitForTimeout(260);
  }
  await page.waitForTimeout(700);
}

try {
  const { context: desktop, page } = await newPlayer({ viewport: { width: 1440, height: 900 } });
  await boot(page);
  await page.screenshot({ path: resolve(outDir, "menu.png") });

  const code = await startSolo(page, "Nova");
  await moveToCentre(page, false);
  await page.screenshot({ path: resolve(outDir, "arena.png") });

  // Fire toward the arena centre for a lively action frame.
  const canvas = page.locator("#game-root canvas");
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.42);
    await page.mouse.down();
    await page.waitForTimeout(420);
    await page.mouse.up();
  }
  await page.screenshot({ path: resolve(outDir, "arena-action.png") });

  // Lobby shot from an isolated profile so the live match is untouched.
  const { context: lobbyContext, page: lobbyPage } = await newPlayer({
    viewport: { width: 1440, height: 900 },
  });
  await boot(lobbyPage);
  await lobbyPage.fill("#nickname", "Nova");
  await lobbyPage.click("#btn-create-room");
  await lobbyPage.locator("#screen-lobby").waitFor({ state: "visible" });
  await lobbyPage.waitForTimeout(500);
  await lobbyPage.screenshot({ path: resolve(outDir, "lobby.png") });
  await lobbyContext.close();

  await fetch(`${E2E_ORIGIN}/api/test/finish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomCode: code }),
  });
  await page.locator("#screen-results").waitFor({ state: "visible" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(outDir, "results.png") });
  await desktop.close();

  const { context: mobile, page: mobilePage } = await newPlayer({ ...devices["iPhone 13"] });
  await boot(mobilePage);
  await mobilePage.screenshot({ path: resolve(outDir, "mobile-menu.png") });
  await startSolo(mobilePage, "Nova");
  await moveToCentre(mobilePage, true);
  await mobilePage.screenshot({ path: resolve(outDir, "mobile-arena.png") });
  await mobile.close();

  console.log(`screenshots written to ${outDir}`);
} finally {
  await browser.close();
  await app.stop();
}
