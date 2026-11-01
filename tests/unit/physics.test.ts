import { describe, expect, test } from "bun:test";
import {
  clamp,
  clampToBounds,
  distance,
  firstObstacleHit,
  moveCircle,
  normalizeAngle,
  positionIsFree,
  resolveCircleRect,
  segmentCircleIntersection,
  segmentRectIntersection,
} from "../../src/shared/physics";
import type { RectObstacle } from "../../src/shared/game-rules";

const BOX: RectObstacle = { id: "box", kind: "rect", x: 100, y: 100, w: 100, h: 100 };

describe("scalar helpers", () => {
  test("clamp respects both edges", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  test("distance is Euclidean", () => {
    expect(distance(0, 0, 3, 4)).toBe(5);
  });

  test("normalizeAngle wraps into [0, 2π)", () => {
    expect(normalizeAngle(0)).toBeCloseTo(0);
    expect(normalizeAngle(Math.PI * 2)).toBeCloseTo(0);
    expect(normalizeAngle(-Math.PI / 2)).toBeCloseTo((Math.PI * 3) / 2);
    const value = normalizeAngle(Math.PI * 5);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(Math.PI * 2);
  });

  test("clampToBounds accounts for radius", () => {
    expect(clampToBounds(0, 0, 10, { left: 0, top: 0, right: 100, bottom: 100 })).toEqual({
      x: 10,
      y: 10,
    });
    expect(clampToBounds(200, 200, 10, { left: 0, top: 0, right: 100, bottom: 100 })).toEqual({
      x: 90,
      y: 90,
    });
  });
});

describe("circle vs rectangle resolution", () => {
  test("overlapping circle is pushed out along the nearest face", () => {
    const resolved = resolveCircleRect(90, 150, 18, BOX);
    expect(resolved.x).toBe(82);
    expect(resolved.y).toBe(150);
  });

  test("circle far away is untouched", () => {
    expect(resolveCircleRect(0, 0, 18, BOX)).toEqual({ x: 0, y: 0 });
  });

  test("center inside the box exits through the closest face", () => {
    const resolved = resolveCircleRect(110, 150, 18, BOX);
    expect(resolved.x).toBe(82);
    expect(resolved.y).toBe(150);
  });
});

describe("movement", () => {
  test("moves freely in open space", () => {
    const moved = moveCircle(400, 400, 30, 0, 18, [], {
      left: 0,
      top: 0,
      right: 1000,
      bottom: 1000,
    });
    expect(moved.x).toBeCloseTo(430, 6);
    expect(moved.y).toBeCloseTo(400, 6);
  });

  test("cannot leave the arena bounds", () => {
    const moved = moveCircle(50, 50, -500, -500, 18, [], {
      left: 48,
      top: 48,
      right: 2352,
      bottom: 1552,
    });
    expect(moved.x).toBeCloseTo(66);
    expect(moved.y).toBeCloseTo(66);
  });

  test("sweeps through a wall instead of tunnelling", () => {
    const wall: RectObstacle = { id: "w", kind: "rect", x: 500, y: 0, w: 40, h: 1000 };
    // A 600px step (roughly a dash tick budget) must not pass the 40px wall.
    const moved = moveCircle(400, 500, 600, 0, 18, [wall], {
      left: 0,
      top: 0,
      right: 2000,
      bottom: 1000,
    });
    expect(moved.x).toBeLessThanOrEqual(500 - 18 + 0.001);
  });

  test("circular obstacle blocks movement", () => {
    const core = { id: "core", kind: "circle" as const, x: 300, y: 300, r: 50 };
    const moved = moveCircle(300, 100, 0, 400, 18, [core], {
      left: 0,
      top: 0,
      right: 1000,
      bottom: 1000,
    });
    expect(distance(moved.x, moved.y, 300, 300)).toBeGreaterThanOrEqual(67.9);
  });
});

describe("raycasts", () => {
  test("segment-circle intersection parameter", () => {
    // Segment from (0,0) to (100,0) against a circle at (50,0) r=10.
    const t = segmentCircleIntersection(0, 0, 100, 0, 50, 0, 10);
    expect(t).not.toBeNull();
    expect(t as number).toBeCloseTo(0.4, 5);
  });

  test("segment-circle returns 0 when starting inside", () => {
    expect(segmentCircleIntersection(50, 0, 100, 0, 50, 0, 10)).toBe(0);
  });

  test("segment-circle misses cleanly", () => {
    expect(segmentCircleIntersection(0, 0, 100, 0, 50, 200, 10)).toBeNull();
  });

  test("segment-rect intersection parameter", () => {
    const t = segmentRectIntersection(0, 150, 300, 150, BOX);
    expect(t).not.toBeNull();
    expect(t as number).toBeCloseTo(1 / 3, 5);
  });

  test("nearest obstacle wins", () => {
    const near: RectObstacle = { id: "near", kind: "rect", x: 50, y: 0, w: 10, h: 100 };
    const far: RectObstacle = { id: "far", kind: "rect", x: 200, y: 0, w: 10, h: 100 };
    const hit = firstObstacleHit(0, 50, 300, 50, [far, near]);
    expect(hit?.obstacleId).toBe("near");
    expect(hit?.kind).toBe("rect");
  });

  test("no hit in free space", () => {
    expect(firstObstacleHit(0, 0, 10, 10, [])).toBeNull();
  });
});

describe("free-space checks", () => {
  const bounds = { left: 0, top: 0, right: 1000, bottom: 1000 };

  test("inside an obstacle is occupied", () => {
    expect(positionIsFree(150, 150, 18, [BOX], bounds)).toBe(false);
  });

  test("outside the arena is occupied", () => {
    expect(positionIsFree(-5, 100, 18, [], bounds)).toBe(false);
  });

  test("open space is free", () => {
    expect(positionIsFree(500, 500, 18, [BOX], bounds)).toBe(true);
  });
});
