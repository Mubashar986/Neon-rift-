import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * AFTERMATH is a client-side 3D vertical slice. These tests run against the
 * production bundle in headless Chromium with SwiftShader, so they keep the
 * viewport modest and use the documented `window.__aftermath` hooks to resolve
 * objectives deterministically instead of relying on pointer-lock mouse aim.
 */

test.use({
  viewport: { width: 1024, height: 640 },
  launchOptions: {
    args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
  },
});

interface AftermathState {
  phase: "planning" | "playing" | "complete" | "failed";
  health: number;
  armor: number;
  stamina: number;
  ammo: number;
  objective: string;
  enemiesAlive: number;
  alliesAlive: number;
  role: string | null;
  insertion: string | null;
  paused: boolean;
  position: { x: number; y: number; z: number };
  drawCalls: number;
}

interface AftermathMeta {
  xp: number;
  credits: number;
  missions: number;
  extracts: number;
}

interface AftermathApi {
  getState(): AftermathState;
  getMeta(): AftermathMeta;
  deploy(roleId?: string, insertionId?: string, record?: boolean): void;
  teleportTerminal(): void;
  teleportExtraction(): void;
  forceHack(): void;
  forceExtract(): void;
  killPlayer(): void;
  revealResults(): void;
  setPaused(paused: boolean): void;
}

declare global {
  interface Window {
    __aftermath?: AftermathApi;
  }
}

async function boot(page: Page): Promise<void> {
  await page.goto("/aftermath.html", { waitUntil: "load" });
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const api = window.__aftermath;
          if (!api) return null;
          const state = api.getState();
          return state.phase === "planning" ? "planning" : state.phase;
        }),
      { timeout: 30_000 },
    )
    .toBe("planning");
}

async function state(page: Page): Promise<AftermathState> {
  return page.evaluate(() => window.__aftermath!.getState());
}

async function waitForPhase(page: Page, phase: AftermathState["phase"], timeout = 45_000): Promise<void> {
  await expect.poll(async () => (await state(page)).phase, { timeout }).toBe(phase);
}

test.describe("AFTERMATH vertical slice", () => {
  test("plans a squad, breaches the vault, extracts and redeploys", async ({ page }) => {
    test.setTimeout(360_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await boot(page);

    // Planning screen is populated from real role/insertion data.
    await expect(page.locator("#aw-planning")).not.toHaveClass(/is-hidden/);
    await expect(page.locator("#aw-role-list .aw-role")).toHaveCount(3);
    await expect(page.locator("#aw-insertion-list .aw-insertion")).toHaveCount(3);
    await expect(page.locator("#aw-deploy")).toBeEnabled();
    await expect(page.locator("#aw-contract-label")).not.toBeEmpty();
    const missionsBefore = (await page.evaluate(() => window.__aftermath!.getMeta())).missions;

    // Exercise real selection controls before deploying.
    await page.locator('#aw-role-list .aw-role[data-role="recon"]').click();
    await expect(page.locator('#aw-role-list .aw-role[data-role="recon"]')).toHaveClass(/is-selected/);
    await page.locator('#aw-insertion-list .aw-insertion[data-insertion="west"]').click();
    await expect(page.locator('#aw-insertion-list .aw-insertion[data-insertion="west"]')).toHaveClass(
      /is-selected/,
    );
    await page.locator("#aw-record").uncheck({ force: true });
    // Building the scene blocks the main thread for tens of seconds on
    // SwiftShader, past Playwright's default action timeout. Trigger the
    // real click handler from the page instead of a synthetic mouse gesture.
    await page.evaluate(() => document.getElementById("aw-deploy")!.click());

    await waitForPhase(page, "playing");
    await page.evaluate(() => window.__aftermath!.setPaused(false));
    const deployed = await state(page);
    expect(deployed.paused).toBe(false);
    expect(deployed.role).toBe("recon");
    expect(deployed.insertion).toBe("west");
    expect(deployed.health).toBeGreaterThan(0);
    expect(deployed.armor).toBeGreaterThan(0);
    expect(deployed.enemiesAlive).toBeGreaterThanOrEqual(8);
    expect(deployed.alliesAlive).toBe(3);
    expect(deployed.objective.toLowerCase()).toContain("vault");

    await expect(page.locator("#aw-hud")).not.toHaveClass(/is-hidden/);
    await expect(page.locator("#aw-planning")).toHaveClass(/is-hidden/);
    await expect(page.locator("#aw-loading")).toHaveClass(/is-hidden/);

    // The scene is real WebGL geometry, not a static mock.
    await expect.poll(async () => (await state(page)).drawCalls, { timeout: 30_000 }).toBeGreaterThan(50);

    // Terminal interaction -> exfil objective.
    await page.evaluate(() => window.__aftermath!.teleportTerminal());
    await page.waitForTimeout(350);
    const atTerminal = await state(page);
    expect(Math.abs(atTerminal.position.x + 33)).toBeLessThan(2);
    expect(atTerminal.position.z).toBeGreaterThan(-33);
    expect(atTerminal.position.z).toBeLessThan(-30);
    await page.evaluate(() => window.__aftermath!.forceHack());
    await expect.poll(async () => (await state(page)).objective, { timeout: 20_000 }).toMatch(/EXFIL/i);

    // The waypoint marker only renders its label while it is on-screen. At the
    // terminal the extraction pad is behind the player, so assert the label
    // after the pad teleport, when the marker is guaranteed to be projected.
    await page.evaluate(() => window.__aftermath!.teleportExtraction());
    await expect(page.locator("#aw-waypoint")).toBeVisible();
    await expect(page.locator("#aw-waypoint-label")).toHaveText(/EXTRACT/i);

    // Extraction -> results.
    await page.evaluate(() => {
      window.__aftermath!.forceExtract();
      window.__aftermath!.revealResults();
    });
    await waitForPhase(page, "complete");
    await expect(page.locator("#aw-results")).not.toHaveClass(/is-hidden/);
    await expect(page.locator("#aw-result-title")).toHaveText("EXTRACTED");
    await expect(page.locator("#aw-result-kicker")).toContainText("OPERATION COMPLETE");
    await expect(page.locator("#aw-results-stats .aw-stat")).toHaveCount(8);
    await expect(page.locator("#aw-reward-xp")).toHaveText(/^\+\d+$/);
    await expect(page.locator("#aw-reward-rank")).not.toBeEmpty();

    const meta = await page.evaluate(() => window.__aftermath!.getMeta());
    expect(meta.missions).toBe(missionsBefore + 1);
    expect(meta.xp).toBeGreaterThan(0);
    expect(errors).toEqual([]);

    // Redeploy returns to a fresh planning screen.
    await page.evaluate(() => document.getElementById("aw-redeploy")!.click());
    await waitForPhase(page, "planning");
    await expect(page.locator("#aw-planning")).not.toHaveClass(/is-hidden/);
    await expect(page.locator("#aw-results")).toHaveClass(/is-hidden/);
    await expect(page.locator("#aw-role-list .aw-role")).toHaveCount(3);
  });

  test("losing the operator shows the failed-run results", async ({ page }) => {
    test.setTimeout(300_000);
    await boot(page);
    await page.locator("#aw-record").uncheck({ force: true });
    await page.evaluate(() => document.getElementById("aw-deploy")!.click());
    await waitForPhase(page, "playing");
    await page.evaluate(() => window.__aftermath!.setPaused(false));

    await page.evaluate(() => {
      window.__aftermath!.killPlayer();
      window.__aftermath!.revealResults();
    });
    await waitForPhase(page, "failed");
    await expect(page.locator("#aw-results")).not.toHaveClass(/is-hidden/);
    await expect(page.locator(".aw-modal--results")).toHaveClass(/is-failed/);
    await expect(page.locator("#aw-result-title")).toHaveText("KIA");
    await expect(page.locator("#aw-result-kicker")).toContainText("OPERATION FAILED");

    await page.evaluate(() => document.getElementById("aw-redeploy")!.click());
    await waitForPhase(page, "planning");
    await expect(page.locator("#aw-results")).toHaveClass(/is-hidden/);
  });
});

test.describe("AFTERMATH input honesty", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("touch devices see the desktop-required notice", async ({ page }) => {
    await page.goto("/aftermath.html", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#aw-desktop-note")).toBeVisible();
  });
});
