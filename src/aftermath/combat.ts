import * as THREE from "three";

/** Distance along a normalized ray to a sphere, or null when it misses. */
export function raySphere(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  center: THREE.Vector3,
  radius: number,
): number | null {
  const toCenter = new THREE.Vector3().subVectors(center, origin);
  const projected = toCenter.dot(direction);
  if (projected < 0) return null;
  const closestSq = toCenter.lengthSq() - projected * projected;
  const radiusSq = radius * radius;
  if (closestSq > radiusSq) return null;
  const offset = Math.sqrt(Math.max(0, radiusSq - closestSq));
  const enter = projected - offset;
  return enter >= 0 ? enter : projected + offset;
}

/** Random point inside a cone of the given half-angle (degrees). */
export function coneDirection(direction: THREE.Vector3, halfAngleDegrees: number): THREE.Vector3 {
  const halfAngle = (Math.max(0, halfAngleDegrees) * Math.PI) / 180;
  if (halfAngle <= 0.00001) return direction.clone().normalize();
  const up =
    Math.abs(direction.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(direction, up).normalize();
  const vertical = new THREE.Vector3().crossVectors(right, direction).normalize();
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.sqrt(Math.random()) * Math.tan(halfAngle);
  return direction
    .clone()
    .addScaledVector(right, Math.cos(angle) * radius)
    .addScaledVector(vertical, Math.sin(angle) * radius)
    .normalize();
}

export interface WallHit {
  distance: number;
  point: THREE.Vector3;
}

/** Nearest solid-world hit along a ray, or null if the ray escapes. */
export function worldHit(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  meshes: THREE.Object3D[],
  maxDistance: number,
): WallHit | null {
  const raycaster = new THREE.Raycaster(origin, direction, 0, maxDistance);
  const hits = raycaster.intersectObjects(meshes, false);
  if (hits.length === 0) return null;
  return { distance: hits[0].distance, point: hits[0].point.clone() };
}

export function horizontalDistance(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
