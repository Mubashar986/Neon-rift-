import type { PROTOCOL_VERSION } from "./constants";
import type { RoomSettings, Vec2 } from "./game-rules";

export type ProtocolVersion = typeof PROTOCOL_VERSION;

export type RoomPhase = "lobby" | "playing" | "finished";
export type MatchPhase = "countdown" | "playing" | "finished";

export interface RoomPlayerView {
  id: string;
  name: string;
  color: number;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  score?: number;
}

export interface RoomView {
  code: string;
  isPrivate: boolean;
  hostId: string;
  phase: RoomPhase;
  settings: RoomSettings;
  players: RoomPlayerView[];
  /** Milliseconds until a public lobby auto-starts, if one is pending. */
  autoStartInMs: number | null;
  createdAt: number;
}

export interface MatchRosterEntry {
  id: string;
  name: string;
  color: number;
}

export interface MatchStartInfo {
  roomCode: string;
  arenaId: string;
  durationSec: number;
  scoreLimit: number;
  countdownMs: number;
  roster: MatchRosterEntry[];
  startedAt: number;
}

export interface RankingEntry {
  playerId: string;
  name: string;
  color: number;
  score: number;
  kills: number;
  deaths: number;
  crystals: number;
  rank: number;
}

export interface MatchResults {
  roomCode: string;
  durationMs: number;
  scoreLimit: number;
  reason: "time" | "score" | "aborted";
  winners: string[];
  rankings: RankingEntry[];
  endedAt: number;
}

export interface SnapshotPlayer {
  id: string;
  x: number;
  y: number;
  aim: number;
  hp: number;
  score: number;
  kills: number;
  deaths: number;
  crystals: number;
  alive: boolean;
  /** Remaining spawn-protection time. */
  spawnProtMs: number;
  /** Remaining dash cooldown. */
  dashCooldownMs: number;
  /** Remaining respawn time when dead. */
  respawnInMs: number;
  connected: boolean;
}

export interface SnapshotProjectile {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  owner: string;
}

export interface SnapshotCrystal {
  id: number;
  x: number;
  y: number;
  active: boolean;
}

export type FxEvent =
  | { id: number; kind: "shot"; x: number; y: number; aim: number; owner: string }
  | {
      id: number;
      kind: "hit";
      x: number;
      y: number;
      target: string;
      attacker: string;
      damage: number;
    }
  | {
      id: number;
      kind: "death";
      x: number;
      y: number;
      victim: string;
      killer: string;
      color: number;
    }
  | { id: number; kind: "respawn"; x: number; y: number; player: string }
  | { id: number; kind: "dash"; x: number; y: number; player: string; aim: number }
  | {
      id: number;
      kind: "crystal";
      x: number;
      y: number;
      player: string;
      amount: number;
      spot: number;
    }
  | { id: number; kind: "wall"; x: number; y: number }
  | { id: number; kind: "match_live" }
  | { id: number; kind: "countdown"; value: number };

export interface WorldSnapshot {
  tick: number;
  phase: MatchPhase;
  countdownMs: number;
  remainMs: number;
  elapsedMs: number;
  players: SnapshotPlayer[];
  projectiles: SnapshotProjectile[];
  crystals: SnapshotCrystal[];
  fx: FxEvent[];
  acks: Record<string, number>;
}

/* ------------------------------------------------------------------ */
/* Client → server                                                     */
/* ------------------------------------------------------------------ */

export interface IdentifyMsg {
  t: "identify";
  v: ProtocolVersion;
  token?: string;
  name?: string;
}

export interface CreateRoomMsg {
  t: "create_room";
  v: ProtocolVersion;
  isPrivate: boolean;
  settings?: Partial<RoomSettings>;
}

export interface JoinRoomMsg {
  t: "join_room";
  v: ProtocolVersion;
  code: string;
}

export interface QuickMatchMsg {
  t: "quick_match";
  v: ProtocolVersion;
}

export interface LeaveRoomMsg {
  t: "leave_room";
  v: ProtocolVersion;
}

export interface SetReadyMsg {
  t: "set_ready";
  v: ProtocolVersion;
  ready: boolean;
}

export interface UpdateSettingsMsg {
  t: "update_settings";
  v: ProtocolVersion;
  settings: RoomSettings;
}

export interface StartMatchMsg {
  t: "start_match";
  v: ProtocolVersion;
}

export interface PlayerInputMsg {
  t: "input";
  v: ProtocolVersion;
  seq: number;
  moveX: number;
  moveY: number;
  aim: number;
  fire: boolean;
  dash: boolean;
}

export interface PingMsg {
  t: "ping";
  v: ProtocolVersion;
  id: number;
  clientTime: number;
}

export interface RematchMsg {
  t: "rematch";
  v: ProtocolVersion;
}

export interface ReturnToLobbyMsg {
  t: "return_to_lobby";
  v: ProtocolVersion;
}

export interface SetNameMsg {
  t: "set_name";
  v: ProtocolVersion;
  name: string;
}

export type ClientMessage =
  | IdentifyMsg
  | CreateRoomMsg
  | JoinRoomMsg
  | QuickMatchMsg
  | LeaveRoomMsg
  | SetReadyMsg
  | UpdateSettingsMsg
  | StartMatchMsg
  | PlayerInputMsg
  | PingMsg
  | RematchMsg
  | ReturnToLobbyMsg
  | SetNameMsg;

export type ClientMessageType = ClientMessage["t"];

/* ------------------------------------------------------------------ */
/* Server → client                                                     */
/* ------------------------------------------------------------------ */

export interface WelcomeMsg {
  t: "welcome";
  v: ProtocolVersion;
  you: string;
  name: string;
  token: string;
  resumed: boolean;
  serverTime: number;
  room: RoomView | null;
  match: MatchStartInfo | null;
  results: MatchResults | null;
}

export interface RoomStateMsg {
  t: "room_state";
  v: ProtocolVersion;
  room: RoomView;
}

export interface MatchStartMsg {
  t: "match_start";
  v: ProtocolVersion;
  match: MatchStartInfo;
}

export interface SnapshotMsg extends WorldSnapshot {
  t: "snapshot";
  v: ProtocolVersion;
}

export interface MatchEndMsg {
  t: "match_end";
  v: ProtocolVersion;
  results: MatchResults;
}

export interface PongMsg {
  t: "pong";
  v: ProtocolVersion;
  id: number;
  clientTime: number;
  serverTime: number;
}

export interface ServerErrorMsg {
  t: "error";
  v: ProtocolVersion;
  code: string;
  message: string;
  fatal: boolean;
}

export interface LeftRoomMsg {
  t: "left_room";
  v: ProtocolVersion;
  roomCode: string;
  reason: "voluntary" | "closed" | "expired";
  message?: string;
}

export interface NoticeMsg {
  t: "notice";
  v: ProtocolVersion;
  message: string;
  tone: "info" | "warn";
}

export type ServerMessage =
  | WelcomeMsg
  | RoomStateMsg
  | MatchStartMsg
  | SnapshotMsg
  | MatchEndMsg
  | PongMsg
  | ServerErrorMsg
  | LeftRoomMsg
  | NoticeMsg;

/* ------------------------------------------------------------------ */
/* Diagnostics (E2E tests read this from the browser)                   */
/* ------------------------------------------------------------------ */

export interface DebugSnapshot extends WorldSnapshot {
  receivedAt: number;
}

export interface SerializedVec extends Vec2 {}
