import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { devices } from "@playwright/test";

interface DebugSnapshot {
  phase: "countdown" | "playing" | "finished";
  players: Array<{ id: string; x: number; y: number; hp: number; connected: boolean }>;
}

interface DebugState {
  screen: "menu" | "lobby" | "game" | "results";
  online: boolean;
  selfId: string | null;
  roomCode: string | null;
  match: { startedAt: number; roomCode: string } | null;
  snapshot: DebugSnapshot | null;
  arenaActive: boolean;
}

interface DebugApi {
  getState(): DebugState;
}

async function readState(page: Page): Promise<DebugState | null> {
  return page.evaluate(() => {
    const api = (window as unknown as { __NEON_RIFT__?: DebugApi }).__NEON_RIFT__;
    return api ? api.getState() : null;
  });
}

async function waitForState(
  page: Page,
  predicate: (state: DebugState) => boolean,
  timeout = 20_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await readState(page);
        return state ? predicate(state) : false;
      },
      { timeout, message: "client debug state never matched" },
    )
    .toBe(true);
}

async function openMenu(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#boot-screen")).toHaveClass(/is-hidden/, { timeout: 25_000 });
  await expect(page.locator("#btn-quick-match")).toBeEnabled({ timeout: 15_000 });
}

async function createPrivateRoom(page: Page, callsign: string): Promise<string> {
  await page.fill("#nickname", callsign);
  await page.click("#btn-create-room");
  await expect(page.locator("#screen-lobby")).toBeVisible();
  const code = (await page.locator("#lobby-code").textContent())?.trim() ?? "";
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  return code;
}

test("solo flow: menu, private lobby, live match, pause stack, results, lobby", async ({ page, request }) => {
  await openMenu(page);
  const code = await createPrivateRoom(page, "E2E Alpha");

  await page.click("#btn-start-match");
  await expect(page.locator("#screen-game")).toBeVisible();
  await expect(page.locator("#game-root canvas")).toBeVisible();
  await waitForState(page, (state) => state.snapshot?.phase === "playing" && state.arenaActive);

  // The authoritative snapshot must reflect real keyboard movement.
  const before = await readState(page);
  const selfBefore = before?.snapshot?.players.find((player) => player.id === before.selfId);
  expect(selfBefore).toBeTruthy();
  const key = (selfBefore?.x ?? 0) > 1200 ? "a" : "d";
  await page.keyboard.down(key);
  await page.waitForTimeout(450);
  await page.keyboard.up(key);
  await waitForState(page, (state) => {
    const player = state.snapshot?.players.find((entry) => entry.id === state.selfId);
    if (!player || !selfBefore) return false;
    return key === "d" ? player.x > selfBefore.x + 2 : player.x < selfBefore.x - 2;
  });

  // Pause modal: opens over the arena and closes with Escape.
  await page.click("#btn-pause");
  await expect(page.locator("#modal-pause")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#modal-pause")).toBeHidden();

  const finish = await request.post("/api/test/finish", { data: { roomCode: code } });
  expect(finish.ok()).toBe(true);

  await expect(page.locator("#screen-results")).toBeVisible();
  await expect(page.locator("#results-body tr")).toHaveCount(1);
  await expect(page.locator("#results-reason")).toHaveText("TIMER");

  await page.click("#btn-return-lobby");
  await expect(page.locator("#screen-lobby")).toBeVisible();
  await expect(page.locator("#lobby-code")).toHaveText(code);
});

test("invite link joins a two-player match, results render for both, rematch relaunches", async ({ browser, request }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  try {
    await openMenu(host);
    const code = await createPrivateRoom(host, "E2E Host");

    await guest.goto(`/play?room=${code}`);
    await expect(guest.locator("#boot-screen")).toHaveClass(/is-hidden/, { timeout: 25_000 });
    await expect(guest.locator("#modal-join")).toBeVisible();
    await expect(guest.locator("#join-code")).toHaveValue(code);
    await guest.fill("#join-name", "E2E Guest");
    await guest.click("#join-submit");

    await expect(guest.locator("#screen-lobby")).toBeVisible();
    await expect(host.locator("#lobby-count")).toHaveText(/2\s*\/\s*8/);

    const hostState = await readState(host);
    const matchBefore = hostState?.match?.startedAt ?? 0;

    await host.click("#btn-start-match");
    await expect(host.locator("#screen-game")).toBeVisible();
    await expect(guest.locator("#screen-game")).toBeVisible();
    await waitForState(host, (state) => state.snapshot?.phase === "playing" && state.snapshot.players.length === 2);
    await waitForState(guest, (state) => state.snapshot?.phase === "playing" && state.snapshot.players.length === 2);

    const finish = await request.post("/api/test/finish", { data: { roomCode: code } });
    expect(finish.ok()).toBe(true);

    await expect(host.locator("#screen-results")).toBeVisible();
    await expect(guest.locator("#screen-results")).toBeVisible();
    await expect(host.locator("#results-body tr")).toHaveCount(2);
    await expect(guest.locator("#results-body tr")).toHaveCount(2);

    await guest.click("#btn-rematch");
    await waitForState(
      guest,
      (state) =>
        state.screen === "game" &&
        (state.match?.startedAt ?? 0) > matchBefore &&
        state.snapshot?.phase !== "finished",
      25_000,
    );
    await waitForState(
      host,
      (state) => state.screen === "game" && (state.match?.startedAt ?? 0) > matchBefore,
      25_000,
    );
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test("phone viewport exposes the dual-stick touch controls", async ({ browser }) => {
  const context = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await context.newPage();
  try {
    await openMenu(page);
    await createPrivateRoom(page, "Touch Pilot");
    await page.click("#btn-start-match");
    await expect(page.locator("#screen-game")).toBeVisible();
    await expect(page.locator("#mobile-controls")).toBeVisible();
    await expect(page.locator("#move-stick")).toBeVisible();
    await expect(page.locator("#aim-stick")).toBeVisible();
    await expect(page.locator("#btn-touch-fire")).toBeVisible();
    await expect(page.locator("#btn-touch-dash")).toBeVisible();
    await page.locator("#btn-touch-dash").tap();
  } finally {
    await context.close();
  }
});

test("callsign survives a reload", async ({ page }) => {
  await openMenu(page);
  await page.fill("#nickname", "Persist Pilot");
  await page.waitForTimeout(250);
  await page.reload();
  await expect(page.locator("#boot-screen")).toHaveClass(/is-hidden/, { timeout: 25_000 });
  await expect(page.locator("#nickname")).toHaveValue("Persist Pilot");
});
