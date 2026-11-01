export type RoleId = "assault" | "recon" | "support";
export type Stance = "stand" | "crouch";
export type MissionPhase = "planning" | "playing" | "paused" | "complete" | "failed";

export interface RoleSpec {
  id: RoleId;
  name: string;
  codename: string;
  tagline: string;
  description: string;
  weapon: string;
  magazine: number;
  reserve: number;
  rpm: number;
  damage: number;
  armor: number;
  speed: number;
  stamina: number;
  adsZoom: number;
  color: string;
}

export interface InsertionSpec {
  id: string;
  name: string;
  subtitle: string;
  x: number;
  z: number;
  angle: number;
}

export interface MissionStats {
  success: boolean;
  timeSec: number;
  kills: number;
  headshots: number;
  shotsFired: number;
  shotsHit: number;
  damageDealt: number;
  damageTaken: number;
  revives: number;
  alliesLost: number;
  objectiveComplete: boolean;
  extracted: boolean;
}

export interface ContractState {
  date: string;
  id: string;
  complete: boolean;
}

export interface MetaState {
  callsign: string;
  xp: number;
  credits: number;
  missions: number;
  extracts: number;
  kills: number;
  headshots: number;
  deaths: number;
  bestTimeSec: number | null;
  contract: ContractState | null;
}

export interface MissionConfig {
  role: RoleSpec;
  insertion: InsertionSpec;
  record: boolean;
}

export interface RewardReport {
  xp: number;
  credits: number;
  rankUp: boolean;
  contractComplete: boolean;
  contractLabel: string;
  rankName: string;
  rankProgress: number;
  nextRankXp: number | null;
}

export const ALLY_CALLSIGNS = ["ECHO", "KITE", "VALE"];

export interface AftermathDebugState {
  phase: MissionPhase;
  health: number;
  armor: number;
  stamina: number;
  ammo: number;
  reserve: number;
  objective: string;
  timerSec: number;
  enemiesAlive: number;
  alliesAlive: number;
  kills: number;
  shotsFired: number;
  shotsHit: number;
  position: { x: number; y: number; z: number };
  role: RoleId | null;
  insertion: string | null;
  paused: boolean;
  pointerLocked: boolean;
  drawCalls: number;
  fps: number;
}
