import { describe, expect, test } from "bun:test";
import { Match } from "../../src/server/simulation/Match";
import type { RoomSettings } from "../../src/shared/game-rules";
import { CRYSTAL_SPOTS, PLAYER_STATS, SCORING } from "../../src/shared/game-rules";

const BASE_SETTINGS: RoomSettings = { maxPlayers: 8, durationSec: 60, scoreLimit: 15 };

function makeMatch(overrides: Partial<RoomSettings> = {}): Match {
  return new Match({
    settings: { ...BASE_SETTINGS, ...overrides },
    roster: [
      { id: "p1", name: "Alpha", color: 0 },
      { id: "p2", name: "Beta", color: 1 },
    ],
    rng: () => 0.42,
  });
}

/** Countdown lasts 3s = 90 ticks at 30Hz; allow a small float margin. */
function playToLive(match: Match): void {
  for (let i = 0; i < 120 && match.phase === "countdown"; i += 1) match.step();
  expect(match.phase).toBe("playing");
}

function input(seq: number, patch: Partial<{ moveX: number; moveY: number; aim: number; fire: boolean; dash: boolean }> = {}) {
  return {
    t: "input" as const,
    v: 1 as const,
    seq,
    moveX: patch.moveX ?? 0,
    moveY: patch.moveY ?? 0,
    aim: patch.aim ?? 0,
    fire: patch.fire ?? false,
    dash: patch.dash ?? false,
  };
}

describe("Match lifecycle", () => {
  test("starts in countdown and transitions to playing", () => {
    const match = makeMatch();
    expect(match.phase).toBe("countdown");
    expect(match.buildSnapshot(0).countdownMs).toBeGreaterThan(0);
    playToLive(match);
    expect(match.phase).toBe("playing");
    expect(match.buildSnapshot(1).countdownMs).toBe(0);
  });

  test("does not advance after finishing", () => {
    const match = makeMatch();
    playToLive(match);
    match.finish("aborted");
    const before = match.buildSnapshot(0).elapsedMs;
    match.step();
    expect(match.buildSnapshot(0).elapsedMs).toBe(before);
    expect(match.reason).toBe("aborted");
  });

  test("ends on the time limit", () => {
    const match = makeMatch({ durationSec: 30 });
    playToLive(match);
    match.elapsedMs = match.durationMs - 10;
    match.step();
    expect(match.phase).toBe("finished");
    expect(match.reason).toBe("time");
    const results = match.getResults();
    expect(results.reason).toBe("time");
    expect(results.durationMs).toBe(match.durationMs);
  });
});

describe("movement and dash", () => {
  test("movement input moves the player and updates aim", () => {
    const match = makeMatch();
    playToLive(match);
    const player = match.players.get("p1")!;
    player.x = 600;
    player.y = 700;
    const startX = player.x;

    match.applyInput("p1", input(1, { moveX: 1, aim: Math.PI / 2 }));
    match.step();
    expect(player.x).toBeGreaterThan(startX);
    expect(player.aim).toBeCloseTo(Math.PI / 2, 5);
  });

  test("dash is faster than walking, has a cooldown and emits an effect", () => {
    const match = makeMatch();
    playToLive(match);
    const player = match.players.get("p1")!;
    player.x = 500;
    player.y = 500;
    player.dashReadyAt = 0;

    match.applyInput("p1", input(1, { moveX: 1, dash: true }));
    match.step();
    const dashDistance = player.x - 500;
    expect(player.dashReadyAt).toBeGreaterThan(0);
    expect(dashDistance).toBeGreaterThan((PLAYER_STATS.moveSpeed / 30) * 2);

    // Holding dash must not trigger a second dash.
    match.applyInput("p1", input(2, { moveX: 1, dash: true }));
    match.step();
    const dashStillActive = player.dashUntil > match.elapsedMs;

    match.applyInput("p1", input(3, { moveX: 0, dash: false }));
    for (let i = 0; i < 8; i += 1) match.step();
    match.applyInput("p1", input(4, { moveX: 1, dash: true }));
    const before = player.x;
    match.step();
    const postCooldownStep = player.x - before;
    expect(dashStillActive).toBe(true);
    expect(postCooldownStep).toBeLessThan(PLAYER_STATS.dash.speed / 30);
  });

  test("bounds and obstacles constrain movement", () => {
    const match = makeMatch();
    playToLive(match);
    const player = match.players.get("p1")!;
    player.x = 70;
    player.y = 700;
    match.applyInput("p1", input(1, { moveX: -1 }));
    for (let i = 0; i < 10; i += 1) match.step();
    expect(player.x).toBeGreaterThanOrEqual(48 + PLAYER_STATS.radius - 0.001);
  });
});

describe("combat", () => {
  test("spawn protection blocks damage", () => {
    const match = makeMatch();
    playToLive(match);
    const shooter = match.players.get("p1")!;
    const target = match.players.get("p2")!;
    shooter.x = 400;
    shooter.y = 700;
    target.x = 700;
    target.y = 700;
    target.protectedUntil = match.elapsedMs + 2_000;

    match.applyInput("p1", input(1, { fire: true }));
    for (let i = 0; i < 12; i += 1) match.step();
    expect(target.hp).toBe(PLAYER_STATS.maxHealth);
    expect(target.alive).toBe(true);
  });

  test("projectiles damage, kill and award score; victim respawns", () => {
    const match = makeMatch();
    playToLive(match);
    const shooter = match.players.get("p1")!;
    const target = match.players.get("p2")!;
    shooter.x = 400;
    shooter.y = 700;
    shooter.protectedUntil = 0;
    target.x = 700;
    target.y = 700;
    target.protectedUntil = 0;

    match.applyInput("p1", input(1, { fire: true }));
    let sawProjectile = false;
    let seq = 1;
    for (let i = 0; i < 120 && target.alive; i += 1) {
      // The client streams input at 30Hz; refresh it so firing stays active.
      if (i % 5 === 0) match.applyInput("p1", input(++seq, { fire: true }));
      match.step();
      if (match.projectiles.length > 0) sawProjectile = true;
    }

    expect(sawProjectile).toBe(true);
    expect(target.alive).toBe(false);
    expect(target.deaths).toBe(1);
    expect(shooter.kills).toBe(1);
    expect(shooter.score).toBe(SCORING.pointsPerKill);
    expect(target.respawnAt).toBeGreaterThan(0);

    match.applyInput("p1", input(2));
    for (let i = 0; i < 100 && !target.alive; i += 1) match.step();
    expect(target.alive).toBe(true);
    expect(target.hp).toBe(PLAYER_STATS.maxHealth);
    expect(target.protectedUntil).toBeGreaterThan(match.elapsedMs);
  });

  test("shots collide with cover and do not hit through walls", () => {
    const match = makeMatch();
    playToLive(match);
    const shooter = match.players.get("p1")!;
    const target = match.players.get("p2")!;
    // wall-west spans x 309–351 at y 650–950.
    shooter.x = 200;
    shooter.y = 800;
    shooter.protectedUntil = 0;
    target.x = 500;
    target.y = 800;
    target.protectedUntil = 0;

    match.applyInput("p1", input(1, { fire: true }));
    for (let i = 0; i < 30; i += 1) match.step();
    expect(target.hp).toBe(PLAYER_STATS.maxHealth);
    const snapshot = match.buildSnapshot(1);
    expect(snapshot.fx.some((fx) => fx.kind === "wall")).toBe(true);
  });

  test("projectiles stop at the arena wall and expire", () => {
    const match = makeMatch();
    playToLive(match);
    const shooter = match.players.get("p1")!;
    shooter.x = 1100;
    shooter.y = 200;
    shooter.protectedUntil = 0;
    match.applyInput("p1", input(1, { fire: true, aim: 0 }));
    for (let i = 0; i < 10; i += 1) match.step();
    expect(match.projectiles.length).toBeGreaterThan(0);
    // Projectile lifetime is 1.25s; after two more seconds nothing remains.
    for (let i = 0; i < 60; i += 1) match.step();
    expect(match.projectiles.length).toBe(0);
  });
});

describe("crystals and scoring", () => {
  test("collecting a crystal awards a point and schedules a respawn", () => {
    const match = makeMatch();
    playToLive(match);
    const player = match.players.get("p1")!;
    const spot = CRYSTAL_SPOTS[1];
    player.x = spot.x;
    player.y = spot.y;

    match.step();
    expect(player.crystals).toBe(1);
    expect(player.score).toBe(SCORING.pointsPerCrystal);
    const crystal = match.crystals.find((entry) => entry.spot === 1)!;
    expect(crystal.active).toBe(false);

    for (let i = 0; i < Math.ceil(SCORING.crystalRespawnMs / (1000 / 30)) + 2; i += 1) {
      match.step();
      if (crystal.active) break;
    }
    expect(crystal.active).toBe(true);
  });

  test("a score limit ends the match immediately", () => {
    const match = makeMatch({ scoreLimit: 1 });
    playToLive(match);
    const player = match.players.get("p1")!;
    const spot = CRYSTAL_SPOTS[0];
    player.x = spot.x;
    player.y = spot.y;
    match.step();
    expect(match.phase).toBe("finished");
    expect(match.reason).toBe("score");
    expect(match.getResults().reason).toBe("score");
  });

  test("ties share rank 1 and both players are winners", () => {
    const match = makeMatch();
    match.finish("time");
    const results = match.getResults();
    expect(results.rankings.every((entry) => entry.rank === 1)).toBe(true);
    expect(results.winners.sort()).toEqual(["p1", "p2"]);
  });

  test("ranking orders equal scores by kills, deaths then crystals", () => {
    const match = makeMatch();
    const first = match.players.get("p1")!;
    const second = match.players.get("p2")!;
    first.score = 5;
    second.score = 5;
    first.kills = 2;
    second.kills = 1;
    match.finish("time");
    const results = match.getResults();
    expect(results.rankings[0].playerId).toBe("p1");
    // Equal scores share first place; tiebreaks only decide display order.
    expect(results.rankings[0].rank).toBe(1);
    expect(results.rankings[1].rank).toBe(1);
    expect(results.winners.sort()).toEqual(["p1", "p2"]);
  });
});

describe("input handling and snapshots", () => {
  test("equal sequence numbers are ignored and acks reflect the last input", () => {
    const match = makeMatch();
    playToLive(match);
    expect(match.applyInput("p1", input(7, { moveX: 1 }))).toBe(true);
    expect(match.applyInput("p1", input(7, { moveX: -1 }))).toBe(false);
    expect(match.players.get("p1")!.input.moveX).toBe(1);

    const snapshot = match.buildSnapshot(42);
    expect(snapshot.acks.p1).toBe(7);
    expect(snapshot.tick).toBe(42);
  });

  test("input expires after the activity window", () => {
    const match = makeMatch();
    playToLive(match);
    const player = match.players.get("p1")!;
    player.x = 500;
    player.y = 700;
    match.applyInput("p1", input(1, { moveX: 1 }));
    for (let i = 0; i < 12; i += 1) match.step();
    const restingX = player.x;
    match.step();
    expect(player.x).toBeCloseTo(restingX, 5);
  });

  test("snapshot effects are flushed exactly once", () => {
    const match = makeMatch();
    playToLive(match);
    const first = match.buildSnapshot(1);
    expect(first.fx.some((fx) => fx.kind === "match_live")).toBe(true);
    const second = match.buildSnapshot(2);
    expect(second.fx.length).toBe(0);
  });

  test("unknown players cannot inject input", () => {
    const match = makeMatch();
    expect(match.applyInput("ghost", input(1))).toBe(false);
  });

  test("disconnected players stop moving and firing", () => {
    const match = makeMatch();
    playToLive(match);
    const player = match.players.get("p1")!;
    player.x = 500;
    player.y = 500;
    match.applyInput("p1", input(1, { moveX: 1, fire: true }));
    match.setConnected("p1", false);
    match.step();
    expect(player.x).toBe(500);
    expect(match.projectiles.length).toBe(0);
  });

  test("removing a player removes their projectiles", () => {
    const match = makeMatch();
    playToLive(match);
    const shooter = match.players.get("p1")!;
    shooter.x = 600;
    shooter.y = 400;
    shooter.protectedUntil = 0;
    match.applyInput("p1", input(1, { fire: true, aim: -Math.PI / 2 }));
    match.step();
    expect(match.projectiles.length).toBeGreaterThan(0);
    match.removePlayer("p1");
    expect(match.projectiles.every((projectile) => projectile.owner !== "p1")).toBe(true);
  });
});
