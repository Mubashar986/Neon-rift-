import { DEFAULT_ROOM_SETTINGS, PLAYER_COLORS } from "../../shared/game-rules";
import type { RoomSettings } from "../../shared/game-rules";
import { MAX_PLAYERS_PER_ROOM } from "../../shared/constants";
import type {
  MatchResults,
  MatchStartInfo,
  RoomPlayerView,
  RoomPhase,
  RoomView,
} from "../../shared/types";
import { Match } from "../simulation/Match";

export interface RoomPlayerInternal {
  id: string;
  name: string;
  color: number;
  ready: boolean;
  connected: boolean;
  joinedAt: number;
  disconnectedAt: number | null;
}

export interface CreateRoomOptions {
  code: string;
  isPrivate: boolean;
  hostId: string;
  hostName: string;
  settings?: Partial<RoomSettings>;
  now: number;
}

/**
 * A room owns its lobby roster and exactly one match at a time. It is a pure
 * data structure — all network I/O lives in GameServer so this is easy to
 * test and reason about.
 */
export class Room {
  readonly code: string;
  readonly isPrivate: boolean;
  readonly createdAt: number;
  hostId: string;
  phase: RoomPhase = "lobby";
  settings: RoomSettings;
  players = new Map<string, RoomPlayerInternal>();
  match: Match | null = null;
  matchStart: MatchStartInfo | null = null;
  results: MatchResults | null = null;
  updatedAt: number;
  autoStartAt: number | null = null;

  constructor(options: CreateRoomOptions) {
    this.code = options.code;
    this.isPrivate = options.isPrivate;
    this.createdAt = options.now;
    this.updatedAt = options.now;
    this.hostId = options.hostId;
    this.settings = {
      ...DEFAULT_ROOM_SETTINGS,
      ...options.settings,
      maxPlayers: Math.min(
        MAX_PLAYERS_PER_ROOM,
        Math.max(2, options.settings?.maxPlayers ?? DEFAULT_ROOM_SETTINGS.maxPlayers),
      ),
    };
    this.addPlayer(options.hostId, options.hostName, options.now);
  }

  get connectedPlayers(): RoomPlayerInternal[] {
    return [...this.players.values()].filter((player) => player.connected);
  }

  addPlayer(id: string, name: string, now: number): RoomPlayerInternal | null {
    if (this.players.size >= this.settings.maxPlayers) return null;

    const used = new Set([...this.players.values()].map((player) => player.color));
    let color = 0;
    while (color < PLAYER_COLORS.length && used.has(color)) color++;
    if (color >= PLAYER_COLORS.length) color = this.players.size % PLAYER_COLORS.length;

    const player: RoomPlayerInternal = {
      id,
      name,
      color,
      ready: false,
      connected: true,
      joinedAt: now,
      disconnectedAt: null,
    };
    this.players.set(id, player);
    this.updatedAt = now;
    return player;
  }

  removePlayer(id: string, now: number): boolean {
    const removed = this.players.delete(id);
    if (removed) {
      this.updatedAt = now;
      if (this.match) this.match.removePlayer(id);
      if (this.hostId === id) this.ensureHost();
    }
    return removed;
  }

  setConnected(id: string, connected: boolean, now: number): void {
    const player = this.players.get(id);
    if (!player) return;
    player.connected = connected;
    player.disconnectedAt = connected ? null : now;
    this.updatedAt = now;
    if (this.match) this.match.setConnected(id, connected);
    if (!connected && this.phase === "lobby" && this.hostId === id) {
      this.ensureHost();
    }
  }

  setReady(id: string, ready: boolean, now: number): boolean {
    const player = this.players.get(id);
    if (!player) return false;
    player.ready = ready;
    this.updatedAt = now;
    return true;
  }

  setName(id: string, name: string, now: number): boolean {
    const player = this.players.get(id);
    if (!player) return false;
    player.name = name;
    this.updatedAt = now;
    return true;
  }

  setSettings(settings: RoomSettings, now: number): boolean {
    if (settings.maxPlayers < this.players.size) return false;
    this.settings = { ...settings };
    this.updatedAt = now;
    return true;
  }

  ensureHost(): void {
    if (this.players.size === 0) return;
    const current = this.players.get(this.hostId);
    if (current && current.connected) return;
    const connected = this.connectedPlayers[0];
    if (connected) {
      this.hostId = connected.id;
      return;
    }
    if (!current) {
      const first = this.players.values().next();
      if (!first.done) this.hostId = first.value.id;
    }
  }

  /** Starts a fresh match with all currently connected players. */
  startMatch(now: number): MatchStartInfo | null {
    const roster = this.connectedPlayers
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((player) => ({ id: player.id, name: player.name, color: player.color }));

    if (roster.length === 0) return null;

    this.match = new Match({ settings: this.settings, roster });
    this.phase = "playing";
    this.results = null;
    this.autoStartAt = null;
    this.updatedAt = now;
    for (const player of this.players.values()) player.ready = false;

    this.matchStart = {
      roomCode: this.code,
      arenaId: "rift-01",
      durationSec: this.settings.durationSec,
      scoreLimit: this.settings.scoreLimit,
      countdownMs: this.match.countdownRemainingMs,
      roster,
      startedAt: now,
    };
    return this.matchStart;
  }

  finishMatch(now: number): MatchResults | null {
    if (!this.match) return null;
    const results = this.match.getResults();
    results.roomCode = this.code;
    results.endedAt = now;
    this.phase = "finished";
    this.results = results;
    this.autoStartAt = null;
    this.updatedAt = now;
    return results;
  }

  returnToLobby(now: number): void {
    this.phase = "lobby";
    this.match = null;
    this.matchStart = null;
    this.results = null;
    this.autoStartAt = null;
    this.updatedAt = now;
    for (const player of this.players.values()) player.ready = false;
  }

  toView(now: number): RoomView {
    const players: RoomPlayerView[] = [...this.players.values()]
      .sort((a, b) => {
        if (a.id === this.hostId) return -1;
        if (b.id === this.hostId) return 1;
        return a.joinedAt - b.joinedAt;
      })
      .map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        ready: player.ready,
        connected: player.connected,
        isHost: player.id === this.hostId,
      }));

    return {
      code: this.code,
      isPrivate: this.isPrivate,
      hostId: this.hostId,
      phase: this.phase,
      settings: { ...this.settings },
      players,
      autoStartInMs:
        this.autoStartAt !== null ? Math.max(0, Math.round(this.autoStartAt - now)) : null,
      createdAt: this.createdAt,
    };
  }

  get isEmpty(): boolean {
    return this.players.size === 0;
  }
}
