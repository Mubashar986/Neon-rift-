import type { Obstacle, RectObstacle, Vec2 } from "./game-rules";

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const EPSILON = 1e-6;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(distanceSq(ax, ay, bx, by));
}

export function angleTo(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(by - ay, bx - ax);
}

export function normalizeAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  return ((angle % twoPi) + twoPi) % twoPi;
}

export function clampToBounds(x: number, y: number, radius: number, bounds: Bounds): Vec2 {
  return {
    x: clamp(x, bounds.left + radius, bounds.right - radius),
    y: clamp(y, bounds.top + radius, bounds.bottom - radius),
  };
}

function closestPointOnRect(px: number, py: number, rect: RectObstacle): Vec2 {
  return {
    x: clamp(px, rect.x, rect.x + rect.w),
    y: clamp(py, rect.y, rect.y + rect.h),
  };
}

/**
 * Resolve a single circle-vs-rect overlap by pushing the circle out.
 * Handles the degenerate "center inside the rect" case by selecting the
 * nearest face.
 */
export function resolveCircleRect(
  x: number,
  y: number,
  radius: number,
  rect: RectObstacle,
): Vec2 {
  const closest = closestPointOnRect(x, y, rect);
  let dx = x - closest.x;
  let dy = y - closest.y;
  let distSq = dx * dx + dy * dy;

  if (distSq > radius * radius) return { x, y };

  if (distSq > EPSILON) {
    const dist = Math.sqrt(distSq);
    const push = radius - dist;
    return { x: x + (dx / dist) * push, y: y + (dy / dist) * push };
  }

  // Center is inside the rectangle: push out through the closest face.
  const left = x - rect.x;
  const right = rect.x + rect.w - x;
  const top = y - rect.y;
  const bottom = rect.y + rect.h - y;
  const min = Math.min(left, right, top, bottom);

  if (min === left) return { x: rect.x - radius, y };
  if (min === right) return { x: rect.x + rect.w + radius, y };
  if (min === top) return { x, y: rect.y - radius };
  return { x, y: rect.y + rect.h + radius };
}

export function resolveObstacles(
  x: number,
  y: number,
  radius: number,
  obstacles: readonly Obstacle[],
  bounds: Bounds,
): Vec2 {
  let px = x;
  let py = y;

  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const obstacle of obstacles) {
      if (obstacle.kind === "rect") {
        const resolved = resolveCircleRect(px, py, radius, obstacle);
        if (resolved.x !== px || resolved.y !== py) {
          px = resolved.x;
          py = resolved.y;
          moved = true;
        }
      } else {
        const dx = px - obstacle.x;
        const dy = py - obstacle.y;
        const minDist = radius + obstacle.r;
        const distSq = dx * dx + dy * dy;
        if (distSq < minDist * minDist) {
          const dist = Math.sqrt(distSq);
          if (dist > EPSILON) {
            px = obstacle.x + (dx / dist) * minDist;
            py = obstacle.y + (dy / dist) * minDist;
          } else {
            px = obstacle.x + minDist;
          }
          moved = true;
        }
      }
    }
    const clamped = clampToBounds(px, py, radius, bounds);
    if (clamped.x !== px || clamped.y !== py) moved = true;
    px = clamped.x;
    py = clamped.y;
    if (!moved) break;
  }

  return { x: px, y: py };
}

/**
 * Move a circle through the world with sub-stepping. The sub-step cap keeps
 * fast dashes from tunnelling through the 36px cover pieces.
 */
export function moveCircle(
  x: number,
  y: number,
  dx: number,
  dy: number,
  radius: number,
  obstacles: readonly Obstacle[],
  bounds: Bounds,
): Vec2 {
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / 7));
  let px = x;
  let py = y;

  for (let i = 0; i < steps; i++) {
    const resolved = resolveObstacles(px + dx / steps, py + dy / steps, radius, obstacles, bounds);
    px = resolved.x;
    py = resolved.y;
  }

  return { x: px, y: py };
}

/**
 * First intersection of a segment with a circle, returned as a normalized
 * parameter t ∈ [0, 1], or null.
 */
export function segmentCircleIntersection(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  cx: number,
  cy: number,
  radius: number,
): number | null {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const fx = x1 - cx;
  const fy = y1 - cy;

  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - radius * radius;

  if (c <= 0) return 0;
  if (a < EPSILON) return null;

  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;

  const root = Math.sqrt(discriminant);
  const t1 = (-b - root) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;

  const t2 = (-b + root) / (2 * a);
  if (t2 >= 0 && t2 <= 1) return t2;

  return null;
}

/**
 * First intersection of a segment with an axis-aligned expanded rect,
 * returned as a normalized parameter t ∈ [0, 1], or null.
 */
export function segmentRectIntersection(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rect: RectObstacle,
  padding = 0,
): number | null {
  const minX = rect.x - padding;
  const minY = rect.y - padding;
  const maxX = rect.x + rect.w + padding;
  const maxY = rect.y + rect.h + padding;

  const dx = x2 - x1;
  const dy = y2 - y1;
  let tMin = 0;
  let tMax = 1;

  const axes: Array<[number, number, number, number]> = [
    [x1, dx, minX, maxX],
    [y1, dy, minY, maxY],
  ];

  for (const [origin, direction, min, max] of axes) {
    if (Math.abs(direction) < EPSILON) {
      if (origin < min || origin > max) return null;
    } else {
      let t1 = (min - origin) / direction;
      let t2 = (max - origin) / direction;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    }
  }

  return tMin;
}

export interface SegmentHit {
  t: number;
  kind: "rect" | "circle";
  obstacleId: string;
}

/** Nearest static-geometry intersection along a segment. */
export function firstObstacleHit(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  obstacles: readonly Obstacle[],
  padding = 0,
): SegmentHit | null {
  let best: SegmentHit | null = null;

  for (const obstacle of obstacles) {
    let t: number | null = null;
    if (obstacle.kind === "rect") {
      t = segmentRectIntersection(x1, y1, x2, y2, obstacle, padding);
    } else {
      t = segmentCircleIntersection(x1, y1, x2, y2, obstacle.x, obstacle.y, obstacle.r + padding);
    }
    if (t !== null && (best === null || t < best.t)) {
      best = { t, kind: obstacle.kind, obstacleId: obstacle.id };
    }
  }

  return best;
}

export function segmentBlocked(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  obstacles: readonly Obstacle[],
  padding = 0,
): boolean {
  return firstObstacleHit(x1, y1, x2, y2, obstacles, padding) !== null;
}

/** Circle-vs-obstacle overlap test (used by spawn selection). */
export function positionIsFree(
  x: number,
  y: number,
  radius: number,
  obstacles: readonly Obstacle[],
  bounds: Bounds,
): boolean {
  if (
    x - radius < bounds.left ||
    x + radius > bounds.right ||
    y - radius < bounds.top ||
    y + radius > bounds.bottom
  ) {
    return false;
  }

  for (const obstacle of obstacles) {
    if (obstacle.kind === "rect") {
      const closest = closestPointOnRect(x, y, obstacle);
      if (distanceSq(x, y, closest.x, closest.y) < radius * radius) return false;
    } else {
      const minDist = radius + obstacle.r;
      if (distanceSq(x, y, obstacle.x, obstacle.y) < minDist * minDist) return false;
    }
  }

  return true;
}
