/**
 * Pure combat math for AFTERMATH. Kept free of Three.js and DOM so the same
 * formulas can move to a server simulation later and are unit-testable today.
 */

export interface DamageResult {
  health: number;
  armor: number;
  healthLost: number;
  armorLost: number;
  penetrated: boolean;
}

/** Armor absorbs most of a hit until it is depleted, then health takes over. */
export function applyDamage(
  health: number,
  armor: number,
  baseDamage: number,
  headshot: boolean,
  distanceMeters: number,
): DamageResult {
  const falloff = Math.max(0.55, 1 - Math.max(0, distanceMeters - 12) * 0.006);
  let incoming = Math.max(0, baseDamage) * falloff * (headshot ? 2.6 : 1);
  const armorBefore = Math.max(0, armor);
  const armorAbsorb = Math.min(armorBefore, incoming * 0.62);
  incoming -= armorAbsorb;
  const healthLost = Math.min(Math.max(0, health), incoming);
  return {
    health: Math.max(0, health - healthLost),
    armor: Math.max(0, armorBefore - armorAbsorb),
    healthLost,
    armorLost: armorAbsorb,
    penetrated: healthLost > 0,
  };
}

export interface SpreadInput {
  stance: "stand" | "crouch";
  ads: boolean;
  moving: boolean;
  sprinting: boolean;
  stamina01: number;
  suppressed: boolean;
}

/** Base cone half-angle in degrees for the current posture and state. */
export function spreadDegrees(input: SpreadInput): number {
  let spread = 1.15;
  if (input.stance === "crouch") spread *= 0.68;
  if (input.ads) spread *= 0.42;
  if (input.moving) spread *= 1.55;
  if (input.sprinting) spread *= 2.2;
  if (input.stamina01 < 0.25) spread *= 1.35;
  if (input.suppressed) spread *= 1.5;
  return spread;
}

export interface StaminaInput {
  current: number;
  max: number;
  sprinting: boolean;
  moving: boolean;
  crouching: boolean;
  restingForSec: number;
}

export function nextStamina(dt: number, input: StaminaInput): number {
  const max = Math.max(1, input.max);
  let value = input.current;
  if (input.sprinting) {
    value -= dt * (17 + (input.crouching ? 0 : 3));
  } else if (input.moving) {
    value -= dt * 1.4;
  } else if (input.restingForSec > 0.7) {
    value += dt * 19;
  } else {
    value += dt * 6;
  }
  return Math.min(max, Math.max(0, value));
}

export const RANKS: ReadonlyArray<{ name: string; minXp: number }> = [
  { name: "RECRUIT", minXp: 0 },
  { name: "OPERATIVE", minXp: 600 },
  { name: "SPECIALIST", minXp: 1_800 },
  { name: "VETERAN", minXp: 4_000 },
  { name: "GHOST", minXp: 8_000 },
  { name: "RIFTWALKER", minXp: 15_000 },
];

export interface RankInfo {
  index: number;
  name: string;
  progress: number;
  nextXp: number | null;
}

export function rankForXp(xp: number): RankInfo {
  const safeXp = Math.max(0, xp);
  let index = 0;
  for (let i = 0; i < RANKS.length; i += 1) {
    if (safeXp >= RANKS[i].minXp) index = i;
  }
  const current = RANKS[index];
  const next = RANKS[index + 1] ?? null;
  const span = next ? next.minXp - current.minXp : 1;
  const into = safeXp - current.minXp;
  return {
    index,
    name: current.name,
    progress: next ? Math.min(1, Math.max(0, into / span)) : 1,
    nextXp: next ? next.minXp : null,
  };
}

/** Milliseconds until the next shot is allowed for a rounds-per-minute weapon. */
export function fireIntervalMs(rpm: number): number {
  return 60_000 / Math.max(1, rpm);
}

/** Accuracy as a human-readable percentage. */
export function accuracyPercent(hits: number, shots: number): number {
  if (shots <= 0) return 0;
  return Math.round((hits / shots) * 100);
}
