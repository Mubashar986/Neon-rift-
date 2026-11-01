import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  accuracyPercent,
  applyDamage,
  fireIntervalMs,
  nextStamina,
  rankForXp,
  spreadDegrees,
} from "../src/aftermath/ballistics";
import { MissionState, HACK_SECONDS, EXTRACT_SECONDS } from "../src/aftermath/mission";
import { coneDirection, formatClock, horizontalDistance, raySphere } from "../src/aftermath/combat";
import { resolveWorldCollision, clampToWorld } from "../src/aftermath/world";
import { contractForDate, normalizeCallsign, applyMissionResult, defaultMeta } from "../src/aftermath/meta";
import type { MissionStats } from "../src/aftermath/types";

function stats(overrides: Partial<MissionStats> = {}): MissionStats {
  return {
    success: true,
    timeSec: 120,
    kills: 3,
    headshots: 1,
    shotsFired: 40,
    shotsHit: 12,
    damageDealt: 320,
    damageTaken: 45,
    revives: 1,
    alliesLost: 0,
    objectiveComplete: true,
    extracted: true,
    ...overrides,
  };
}

describe("aftermath ballistics", () => {
  test("armor absorbs most of a body shot before health", () => {
    const result = applyDamage(100, 60, 40, false, 0);
    expect(result.armorLost).toBeGreaterThan(0);
    expect(result.armor).toBeLessThan(60);
    expect(result.health).toBeLessThan(100);
    expect(result.armorLost).toBeGreaterThan(result.healthLost);
  });

  test("armor depletes and then health takes damage", () => {
    const first = applyDamage(100, 10, 60, false, 0);
    expect(first.armor).toBe(0);
    expect(first.health).toBeLessThan(100);
    expect(first.penetrated).toBe(true);
  });

  test("headshots and range falloff change damage", () => {
    const body = applyDamage(100, 0, 30, false, 10);
    const head = applyDamage(100, 0, 30, true, 10);
    const far = applyDamage(100, 0, 30, false, 60);
    expect(head.healthLost).toBeGreaterThan(body.healthLost);
    expect(far.healthLost).toBeLessThan(body.healthLost);
  });

  test("damage never drops health below zero", () => {
    const result = applyDamage(5, 0, 500, true, 0);
    expect(result.health).toBe(0);
  });

  test("posture and aim tighten spread", () => {
    const standing = spreadDegrees({
      stance: "stand",
      ads: false,
      moving: false,
      sprinting: false,
      stamina01: 1,
      suppressed: false,
    });
    const crouchedAds = spreadDegrees({
      stance: "crouch",
      ads: true,
      moving: false,
      sprinting: false,
      stamina01: 1,
      suppressed: false,
    });
    const sprinting = spreadDegrees({
      stance: "stand",
      ads: false,
      moving: true,
      sprinting: true,
      stamina01: 1,
      suppressed: false,
    });
    expect(crouchedAds).toBeLessThan(standing);
    expect(sprinting).toBeGreaterThan(standing);
  });

  test("stamina drains while sprinting and regenerates at rest", () => {
    const drained = nextStamina(0.5, {
      current: 100,
      max: 100,
      sprinting: true,
      moving: true,
      crouching: false,
      restingForSec: 0,
    });
    expect(drained).toBeLessThan(100);
    const recovered = nextStamina(1, {
      current: 20,
      max: 100,
      sprinting: false,
      moving: false,
      crouching: false,
      restingForSec: 2,
    });
    expect(recovered).toBeGreaterThan(20);
    const clamped = nextStamina(100, {
      current: 99,
      max: 100,
      sprinting: false,
      moving: false,
      crouching: false,
      restingForSec: 2,
    });
    expect(clamped).toBe(100);
  });

  test("ranks advance at documented thresholds", () => {
    expect(rankForXp(0).name).toBe("RECRUIT");
    expect(rankForXp(600).name).toBe("OPERATIVE");
    expect(rankForXp(15_000).name).toBe("RIFTWALKER");
    expect(rankForXp(15_000).nextXp).toBeNull();
    expect(rankForXp(800).progress).toBeGreaterThan(0);
  });

  test("rpm, accuracy and fallback math", () => {
    expect(fireIntervalMs(600)).toBe(100);
    expect(accuracyPercent(12, 40)).toBe(30);
    expect(accuracyPercent(0, 0)).toBe(0);
  });
});

describe("aftermath mission state machine", () => {
  test("hacking needs the terminal and a held interact", () => {
    const mission = new MissionState();
    const events = mission.update({
      dt: HACK_SECONDS,
      playerAlive: true,
      atTerminal: true,
      atExtraction: false,
      holding: false,
    });
    expect(events).toEqual([]);
    expect(mission.hacked).toBe(false);
    expect(mission.hackProgress).toBe(0);
  });

  test("holding at the terminal completes the hack", () => {
    const mission = new MissionState();
    const first = mission.update({
      dt: HACK_SECONDS / 2,
      playerAlive: true,
      atTerminal: true,
      atExtraction: false,
      holding: true,
    });
    expect(first).toEqual([]);
    const events = mission.update({
      dt: HACK_SECONDS,
      playerAlive: true,
      atTerminal: true,
      atExtraction: false,
      holding: true,
    });
    expect(events).toEqual([{ type: "hacked" }]);
    expect(mission.hacked).toBe(true);
    expect(mission.objective).toBe("extract");
    expect(mission.hackProgress).toBe(1);
  });

  test("extraction requires the core and a held position", () => {
    const mission = new MissionState();
    const early = mission.update({
      dt: EXTRACT_SECONDS * 2,
      playerAlive: true,
      atTerminal: false,
      atExtraction: true,
      holding: true,
    });
    expect(early).toEqual([]);
    expect(mission.extracted).toBe(false);

    mission.hacked = true;
    mission.objective = "extract";
    mission.hackProgress = 1;
    const notHolding = mission.update({
      dt: EXTRACT_SECONDS * 2,
      playerAlive: true,
      atTerminal: false,
      atExtraction: true,
      holding: false,
    });
    expect(notHolding).toEqual([]);
    expect(mission.extractProgress).toBe(0);

    const events = mission.update({
      dt: EXTRACT_SECONDS,
      playerAlive: true,
      atTerminal: false,
      atExtraction: true,
      holding: true,
    });
    expect(events).toEqual([{ type: "extracted" }]);
    expect(mission.phase).toBe("complete");
    expect(mission.objective as string).toBe("done");
  });

  test("leaving the pad drains extraction progress", () => {
    const mission = new MissionState();
    mission.hacked = true;
    mission.objective = "extract";
    mission.update({ dt: 3, playerAlive: true, atTerminal: false, atExtraction: true, holding: true });
    const progress = mission.extractProgress;
    expect(progress).toBeGreaterThan(0);
    mission.update({ dt: 0.5, playerAlive: true, atTerminal: false, atExtraction: false, holding: true });
    expect(mission.extractProgress).toBeLessThan(progress);
  });

  test("death ends the mission exactly once", () => {
    const mission = new MissionState();
    const events = mission.update({
      dt: 0.016,
      playerAlive: false,
      atTerminal: false,
      atExtraction: false,
      holding: false,
    });
    expect(events).toEqual([{ type: "failed", reason: "killed" }]);
    expect(mission.phase).toBe("failed");
    expect(
      mission.update({ dt: 1, playerAlive: true, atTerminal: true, atExtraction: false, holding: true }),
    ).toEqual([]);
  });

  test("mission timer only advances while playing", () => {
    const mission = new MissionState();
    mission.update({ dt: 1.5, playerAlive: true, atTerminal: false, atExtraction: false, holding: false });
    expect(mission.elapsed).toBeCloseTo(1.5, 5);
    mission.phase = "complete";
    mission.update({ dt: 10, playerAlive: true, atTerminal: false, atExtraction: false, holding: false });
    expect(mission.elapsed).toBeCloseTo(1.5, 5);
  });

  test("objective copy changes after the hack", () => {
    const mission = new MissionState();
    expect(mission.objectiveTitle).toBe("BREACH THE DATA VAULT");
    mission.hacked = true;
    expect(mission.objectiveTitle).toBe("EXFILTRATE");
    expect(mission.objectiveDetail).toContain("extraction");
  });
});

describe("aftermath ray helpers", () => {
  test("raySphere reports the near intersection", () => {
    const origin = new THREE.Vector3(0, 0, 0);
    const direction = new THREE.Vector3(0, 0, -1);
    const center = new THREE.Vector3(0, 0, -10);
    const distance = raySphere(origin, direction, center, 1);
    expect(distance).toBeCloseTo(9, 5);
  });

  test("raySphere rejects misses and targets behind the ray", () => {
    const origin = new THREE.Vector3(0, 0, 0);
    const direction = new THREE.Vector3(0, 0, -1);
    expect(raySphere(origin, direction, new THREE.Vector3(5, 0, -10), 1)).toBeNull();
    expect(raySphere(origin, direction, new THREE.Vector3(0, 0, 10), 1)).toBeNull();
  });

  test("coneDirection stays inside the requested cone", () => {
    const forward = new THREE.Vector3(0, 0, -1);
    const halfAngle = 3;
    for (let i = 0; i < 50; i += 1) {
      const direction = coneDirection(forward, halfAngle);
      expect(direction.length()).toBeCloseTo(1, 5);
      const degrees = (Math.acos(Math.max(-1, Math.min(1, direction.dot(forward)))) * 180) / Math.PI;
      expect(degrees).toBeLessThanOrEqual(halfAngle + 0.001);
    }
  });

  test("horizontal distance ignores height", () => {
    const a = new THREE.Vector3(0, 9, 0);
    const b = new THREE.Vector3(3, -2, 4);
    expect(horizontalDistance(a, b)).toBe(5);
  });

  test("clock formatting", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(65.9)).toBe("01:05");
    expect(formatClock(-2)).toBe("00:00");
  });
});

describe("aftermath world collision", () => {
  test("pushes a circle out of a solid box", () => {
    const position = new THREE.Vector3(0.8, 0, 0);
    resolveWorldCollision(position, 0.4, [{ minX: -1, maxX: 1, minZ: -1, maxZ: 1 }]);
    expect(position.x).toBeCloseTo(1.4, 5);
  });

  test("leaves a circle outside the box untouched", () => {
    const position = new THREE.Vector3(4, 0, 4);
    resolveWorldCollision(position, 0.4, [{ minX: -1, maxX: 1, minZ: -1, maxZ: 1 }]);
    expect(position.x).toBe(4);
    expect(position.z).toBe(4);
  });

  test("clamps positions to the district bounds", () => {
    const position = new THREE.Vector3(500, 0, -500);
    clampToWorld(position);
    expect(position.x).toBe(58);
    expect(position.z).toBe(-58);
  });
});

describe("aftermath meta", () => {
  test("contract selection is deterministic per date and varies across days", () => {
    const today = contractForDate("2026-10-31");
    expect(contractForDate("2026-10-31").id).toBe(today.id);
    const ids = new Set<string>();
    for (let day = 1; day <= 28; day += 1) {
      const date = `2026-11-${String(day).padStart(2, "0")}`;
      ids.add(contractForDate(date).id);
    }
    expect(ids.size).toBeGreaterThan(1);
    for (const id of ids) {
      expect(["first_light", "clean_run", "headhunter", "ghost_protocol", "collector"]).toContain(id);
    }
  });

  test("callsign sanitization strips control characters and limits length", () => {
    expect(normalizeCallsign("  Nova Prime  ")).toBe("Nova Prime");
    expect(normalizeCallsign("\u0000\u001f")).toBe("NOVA");
    expect(normalizeCallsign("ABCDEFGHIJKLMNOPQRSTUVWXYZ")).toHaveLength(16);
  });

  test("successful missions grant xp, credits and increment counters", () => {
    const meta = { ...defaultMeta(), contract: null };
    const result = applyMissionResult(meta, stats());
    expect(result.meta.missions).toBe(1);
    expect(result.meta.extracts).toBe(1);
    expect(result.meta.bestTimeSec).toBe(120);
    expect(result.rewards.xp).toBeGreaterThan(200);
    expect(result.rewards.credits).toBeGreaterThan(100);
  });

  test("failed missions still grant a small amount of xp", () => {
    const meta = { ...defaultMeta(), contract: null };
    const result = applyMissionResult(meta, stats({ success: false, extracted: false, kills: 0 }));
    expect(result.meta.deaths).toBe(1);
    expect(result.meta.extracts).toBe(0);
    expect(result.rewards.xp).toBeGreaterThan(0);
  });
});
