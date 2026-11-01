/**
 * Gameplay tuning lives here — never inside rendering code.
 * The server is the source of truth; the client uses the same constants
 * for movement prediction so that prediction matches simulation.
 */
export const ARENA_ID = "rift-01";

export const ARENA = {
  id: ARENA_ID,
  name: "The Rift",
  width: 2400,
  height: 1600,
  wallThickness: 48,
  bounds: {
    left: 48,
    top: 48,
    right: 2400 - 48,
    bottom: 1600 - 48,
  },
} as const;

export const PLAYER_STATS = {
  radius: 18,
  maxHealth: 100,
  moveSpeed: 285,
  dash: {
    speed: 940,
    durationMs: 150,
    cooldownMs: 2_400,
  },
  weapon: {
    cooldownMs: 210,
    projectileSpeed: 1_050,
    projectileRadius: 5,
    projectileLifeMs: 1_250,
    damage: 20,
    muzzleOffset: 26,
    maxRange: 1_200,
  },
  respawnMs: 3_000,
  spawnProtectionMs: 2_000,
} as const;

export const SCORING = {
  pointsPerKill: 3,
  pointsPerCrystal: 1,
  crystalRespawnMs: 7_000,
  pickupRadius: 32,
  maxCrystals: 10,
} as const;

export const MATCH = {
  countdownMs: 3_000,
  defaultDurationSec: 180,
  minDurationSec: 30,
  maxDurationSec: 300,
  durationPresets: [60, 120, 180, 300],
  defaultScoreLimit: 30,
  scoreLimitOptions: [0, 15, 30, 50],
} as const;

export const ROOM_LIMITS = {
  minPlayers: 1,
  maxPlayers: 8,
  maxNameLength: 16,
} as const;

/** Nine canonical player colors — index 0–7 are used. */
export const PLAYER_COLORS = [
  "#33f6ff",
  "#ff3bd4",
  "#b06bff",
  "#7dff6b",
  "#ffb03b",
  "#ff5a5a",
  "#5f8cff",
  "#fff36b",
] as const;

export const PLAYER_SKINS = [
  { name: "Cyan Vector", primary: "#33f6ff", accent: "#b9fdff" },
  { name: "Magenta Pulse", primary: "#ff3bd4", accent: "#ffd0f5" },
  { name: "Violet Wraith", primary: "#b06bff", accent: "#e7d4ff" },
  { name: "Acid Runner", primary: "#7dff6b", accent: "#dcffd5" },
  { name: "Solar Flare", primary: "#ffb03b", accent: "#ffe9c2" },
  { name: "Crimson Echo", primary: "#ff5a5a", accent: "#ffd1d1" },
  { name: "Cobalt Ghost", primary: "#5f8cff", accent: "#cfdbff" },
  { name: "Photon Spark", primary: "#fff36b", accent: "#fffbd1" },
] as const;

export interface Vec2 {
  x: number;
  y: number;
}

export interface RectObstacle {
  id: string;
  kind: "rect";
  /** Top-left corner. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Visual flavour only — no gameplay impact. */
  tone?: "cyan" | "violet" | "amber";
}

export interface CircleObstacle {
  id: string;
  kind: "circle";
  x: number;
  y: number;
  r: number;
  tone?: "cyan" | "violet" | "amber";
}

export type Obstacle = RectObstacle | CircleObstacle;

const rect = (
  id: string,
  cx: number,
  cy: number,
  w: number,
  h: number,
  tone: RectObstacle["tone"] = "cyan",
): RectObstacle => ({ id, kind: "rect", x: cx - w / 2, y: cy - h / 2, w, h, tone });

const circle = (
  id: string,
  x: number,
  y: number,
  r: number,
  tone: CircleObstacle["tone"] = "violet",
): CircleObstacle => ({ id, kind: "circle", x, y, r, tone });

/**
 * Symmetric arena layout. Lanes and cover are intentionally readable:
 * no spawn point is inside geometry, and every crystal is reachable.
 */
export const OBSTACLES: Obstacle[] = [
  // The Rift Core — central landmark.
  circle("core", 1200, 800, 96, "violet"),

  // Four inner pillars framing the core.
  rect("pillar-nw", 830, 560, 100, 100, "cyan"),
  rect("pillar-ne", 1570, 560, 100, 100, "cyan"),
  rect("pillar-sw", 830, 1040, 100, 100, "cyan"),
  rect("pillar-se", 1570, 1040, 100, 100, "cyan"),

  // Long central cover, top and bottom.
  rect("wall-north", 1200, 330, 300, 42, "amber"),
  rect("wall-south", 1200, 1270, 300, 42, "amber"),

  // Side lane cover.
  rect("wall-west", 330, 800, 42, 300, "violet"),
  rect("wall-east", 2070, 800, 42, 300, "violet"),
  rect("wall-midwest", 760, 800, 42, 200, "cyan"),
  rect("wall-mideast", 1640, 800, 42, 200, "cyan"),

  // Corner L-shaped cover.
  rect("l-nw-h", 620, 300, 160, 36, "violet"),
  rect("l-nw-v", 560, 360, 36, 160, "violet"),
  rect("l-ne-h", 1780, 300, 160, 36, "violet"),
  rect("l-ne-v", 1840, 360, 36, 160, "violet"),
  rect("l-sw-h", 620, 1300, 160, 36, "violet"),
  rect("l-sw-v", 560, 1240, 36, 160, "violet"),
  rect("l-se-h", 1780, 1300, 160, 36, "violet"),
  rect("l-se-v", 1840, 1240, 36, 160, "violet"),

  // Small flank chips add texture to the open lanes.
  rect("chip-nw", 980, 470, 54, 54, "cyan"),
  rect("chip-ne", 1420, 470, 54, 54, "cyan"),
  rect("chip-sw", 980, 1130, 54, 54, "cyan"),
  rect("chip-se", 1420, 1130, 54, 54, "cyan"),
];

export const SPAWN_POINTS: Vec2[] = [
  { x: 220, y: 220 },
  { x: 1200, y: 188 },
  { x: 2180, y: 220 },
  { x: 2210, y: 800 },
  { x: 2180, y: 1380 },
  { x: 1200, y: 1412 },
  { x: 220, y: 1380 },
  { x: 190, y: 800 },
];

export const CRYSTAL_SPOTS: Vec2[] = [
  { x: 1200, y: 540 },
  { x: 1460, y: 800 },
  { x: 1200, y: 1060 },
  { x: 940, y: 800 },
  { x: 600, y: 220 },
  { x: 1800, y: 220 },
  { x: 1800, y: 1380 },
  { x: 600, y: 1380 },
  { x: 260, y: 800 },
  { x: 2140, y: 800 },
];

export interface RoomSettings {
  maxPlayers: number;
  durationSec: number;
  scoreLimit: number;
}

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  maxPlayers: 8,
  durationSec: MATCH.defaultDurationSec,
  scoreLimit: MATCH.defaultScoreLimit,
};

/** Spawn protection tint/fx duration is shared so the client can render it. */
export const SPAWN_PROTECTION_MS = PLAYER_STATS.spawnProtectionMs;
