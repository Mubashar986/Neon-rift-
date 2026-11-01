import { TICK_MS } from "../../shared/constants";
import {
  ARENA,
  CRYSTAL_SPOTS,
  MATCH,
  OBSTACLES,
  PLAYER_STATS,
  SCORING,
  SPAWN_POINTS,
} from "../../shared/game-rules";
import type { RoomSettings, Vec2 } from "../../shared/game-rules";
import {
  distanceSq,
  firstObstacleHit,
  moveCircle,
  normalizeAngle,
  segmentCircleIntersection,
} from "../../shared/physics";
import type {
  FxEvent,
  MatchPhase,
  MatchResults,
  MatchRosterEntry,
  PlayerInputMsg,
  RankingEntry,
  SnapshotCrystal,
  SnapshotPlayer,
  SnapshotProjectile,
  WorldSnapshot,
} from "../../shared/types";

/** Distributes Omit across the FxEvent union so payload fields survive. */
type FxPayload = FxEvent extends infer Event
  ? Event extends FxEvent
    ? Omit<Event, "id">
    : never
  : never;

export interface MatchPlayer {
  id: string;
  name: string;
  color: number;
  x: number;
  y: number;
  aim: number;
  hp: number;
  score: number;
  kills: number;
  deaths: number;
  crystals: number;
  alive: boolean;
  connected: boolean;
  spawnIndex: number;
  protectedUntil: number;
  respawnAt: number;
  nextFireAt: number;
  dashUntil: number;
  dashReadyAt: number;
  dashDirX: number;
  dashDirY: number;
  prevDash: boolean;
  lastSeq: number;
  input: {
    seq: number;
    moveX: number;
    moveY: number;
    aim: number;
    fire: boolean;
    dash: boolean;
    activeUntil: number;
  };
}

export interface Projectile {
  id: number;
  owner: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  expiresAt: number;
}

export interface Crystal {
  id: number;
  spot: number;
  x: number;
  y: number;
  active: boolean;
  respawnAt: number;
}

export interface MatchOptions {
  settings: RoomSettings;
  roster: MatchRosterEntry[];
  rng?: () => number;
}

export interface MatchSummary {
  phase: MatchPhase;
  reason: "time" | "score" | "aborted" | null;
  elapsedMs: number;
  remainMs: number;
}

/**
 * Deterministic, authoritative simulation. It never reads the wall clock:
 * one call to step() always advances exactly one tick. That makes the whole
 * ruleset unit-testable and immune to timer drift.
 */
export class Match {
  readonly settings: RoomSettings;
  readonly durationMs: number;
  phase: MatchPhase = "countdown";
  reason: "time" | "score" | "aborted" | null = null;

  players = new Map<string, MatchPlayer>();
  projectiles: Projectile[] = [];
  crystals: Crystal[] = [];

  countdownRemainingMs: number = MATCH.countdownMs;
  elapsedMs = 0;

  private rng: () => number;
  private pendingFx: FxEvent[] = [];
  private nextFxId = 1;
  private nextProjectileId = 1;

  constructor(options: MatchOptions) {
    this.settings = options.settings;
    this.durationMs = options.settings.durationSec * 1000;
    this.rng = options.rng ?? Math.random;

    const spawns = this.pickInitialSpawns(options.roster.length);
    options.roster.forEach((entry, index) => {
      const spawn = spawns[index];
      this.players.set(entry.id, {
        id: entry.id,
        name: entry.name,
        color: entry.color,
        x: spawn.x,
        y: spawn.y,
        aim: 0,
        hp: PLAYER_STATS.maxHealth,
        score: 0,
        kills: 0,
        deaths: 0,
        crystals: 0,
        alive: true,
        connected: true,
        spawnIndex: index,
        protectedUntil: 0,
        respawnAt: 0,
        nextFireAt: 0,
        dashUntil: 0,
        dashReadyAt: 0,
        dashDirX: 1,
        dashDirY: 0,
        prevDash: false,
        lastSeq: 0,
        input: {
          seq: 0,
          moveX: 0,
          moveY: 0,
          aim: 0,
          fire: false,
          dash: false,
          activeUntil: 0,
        },
      });
    });

    CRYSTAL_SPOTS.forEach((spot, index) => {
      this.crystals.push({
        id: index + 1,
        spot: index,
        x: spot.x,
        y: spot.y,
        active: index < SCORING.maxCrystals,
        respawnAt: 0,
      });
    });
  }

  get remainMs(): number {
    if (this.phase === "countdown") return this.durationMs;
    if (this.phase === "finished") return 0;
    return Math.max(0, this.durationMs - this.elapsedMs);
  }

  get summary(): MatchSummary {
    return {
      phase: this.phase,
      reason: this.reason,
      elapsedMs: Math.min(this.elapsedMs, this.durationMs),
      remainMs: this.remainMs,
    };
  }

  applyInput(playerId: string, message: PlayerInputMsg): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;
    // A reconnecting browser starts a fresh sequence at 1, so the server
    // accepts a decreasing sequence. Ordering is guaranteed by WebSocket;
    // every message is still rate-limited and geometrically validated.
    if (message.seq === player.lastSeq) return false;

    player.lastSeq = message.seq;
    player.input = {
      seq: message.seq,
      moveX: message.moveX,
      moveY: message.moveY,
      aim: message.aim,
      fire: message.fire,
      dash: message.dash,
      activeUntil: this.elapsedMs + 250,
    };
    return true;
  }

  setConnected(playerId: string, connected: boolean): void {
    const player = this.players.get(playerId);
    if (!player) return;
    player.connected = connected;
    if (!connected) {
      player.input.fire = false;
      player.input.dash = false;
      player.prevDash = false;
      player.dashUntil = 0;
    }
  }

  removePlayer(playerId: string): void {
    this.players.delete(playerId);
    this.projectiles = this.projectiles.filter((projectile) => projectile.owner !== playerId);
  }

  /** Advances the simulation by exactly one server tick. */
  step(): void {
    if (this.phase === "finished") return;

    if (this.phase === "countdown") {
      this.countdownRemainingMs -= TICK_MS;
      if (this.countdownRemainingMs <= 0) {
        this.countdownRemainingMs = 0;
        this.phase = "playing";
        this.elapsedMs = 0;
        for (const player of this.players.values()) {
          player.protectedUntil = PLAYER_STATS.spawnProtectionMs;
          player.nextFireAt = 0;
        }
        this.emit({ kind: "match_live" });
      }
      return;
    }

    this.elapsedMs += TICK_MS;
    const now = this.elapsedMs;

    for (const player of this.players.values()) {
      if (!player.alive && this.phase === "playing" && now >= player.respawnAt) {
        this.respawnPlayer(player, now);
      }
    }

    for (const player of this.players.values()) {
      this.updatePlayer(player, now);
    }

    this.updateProjectiles(now);

    for (const player of this.players.values()) {
      if (player.alive) this.collectCrystals(player, now);
    }

    this.updateCrystals(now);

    if (this.phase === "playing") {
      if (this.settings.scoreLimit > 0) {
        for (const player of this.players.values()) {
          if (player.score >= this.settings.scoreLimit) {
            this.finish("score");
            return;
          }
        }
      }
      if (this.elapsedMs >= this.durationMs) {
        this.finish("time");
      }
    }
  }

  finish(reason: "time" | "score" | "aborted"): void {
    if (this.phase === "finished") return;
    this.phase = "finished";
    this.reason = reason;
  }

  buildSnapshot(tick: number): WorldSnapshot {
    const now = this.elapsedMs;

    const players: SnapshotPlayer[] = [];
    for (const player of this.players.values()) {
      players.push({
        id: player.id,
        x: round(player.x),
        y: round(player.y),
        aim: round(player.aim, 3),
        hp: Math.max(0, Math.round(player.hp)),
        score: player.score,
        kills: player.kills,
        deaths: player.deaths,
        crystals: player.crystals,
        alive: player.alive,
        spawnProtMs: player.alive ? Math.max(0, Math.round(player.protectedUntil - now)) : 0,
        dashCooldownMs: Math.max(0, Math.round(player.dashReadyAt - now)),
        respawnInMs: player.alive ? 0 : Math.max(0, Math.round(player.respawnAt - now)),
        connected: player.connected,
      });
    }

    const projectiles: SnapshotProjectile[] = this.projectiles.map((projectile) => ({
      id: projectile.id,
      x: round(projectile.x),
      y: round(projectile.y),
      vx: round(projectile.vx),
      vy: round(projectile.vy),
      owner: projectile.owner,
    }));

    const crystals: SnapshotCrystal[] = this.crystals.map((crystal) => ({
      id: crystal.id,
      x: crystal.x,
      y: crystal.y,
      active: crystal.active,
    }));

    const acks: Record<string, number> = {};
    for (const player of this.players.values()) {
      acks[player.id] = player.lastSeq;
    }

    const fx = this.pendingFx;
    this.pendingFx = [];

    return {
      tick,
      phase: this.phase,
      countdownMs: Math.max(0, Math.ceil(this.countdownRemainingMs)),
      remainMs: Math.max(0, Math.ceil(this.remainMs)),
      elapsedMs: Math.round(Math.min(this.elapsedMs, this.durationMs)),
      players,
      projectiles,
      crystals,
      fx,
      acks,
    };
  }

  getResults(): MatchResults {
    const rankings: RankingEntry[] = [...this.players.values()]
      .map((player) => ({
        playerId: player.id,
        name: player.name,
        color: player.color,
        score: player.score,
        kills: player.kills,
        deaths: player.deaths,
        crystals: player.crystals,
        rank: 0,
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.kills !== a.kills) return b.kills - a.kills;
        if (a.deaths !== b.deaths) return a.deaths - b.deaths;
        if (b.crystals !== a.crystals) return b.crystals - a.crystals;
        return a.name.localeCompare(b.name);
      });

    // Standard competition ranking (1, 1, 3 …).
    let lastScore: number | null = null;
    let lastRank = 0;
    rankings.forEach((entry, index) => {
      if (entry.score !== lastScore) {
        lastRank = index + 1;
        lastScore = entry.score;
      }
      entry.rank = lastRank;
    });

    const winners = rankings.filter((entry) => entry.rank === 1).map((entry) => entry.playerId);

    return {
      roomCode: "",
      durationMs: Math.round(Math.min(this.elapsedMs, this.durationMs)),
      scoreLimit: this.settings.scoreLimit,
      reason: this.reason ?? "aborted",
      winners,
      rankings,
      endedAt: Date.now(),
    };
  }

  private updatePlayer(player: MatchPlayer, now: number): void {
    if (!player.connected || !player.alive) {
      player.prevDash = false;
      return;
    }

    const input = now <= player.input.activeUntil
      ? player.input
      : { ...player.input, moveX: 0, moveY: 0, fire: false, dash: false };

    player.aim = normalizeAngle(input.aim);

    let moveX = input.moveX;
    let moveY = input.moveY;
    const moveLength = Math.hypot(moveX, moveY);
    if (moveLength > 1) {
      moveX /= moveLength;
      moveY /= moveLength;
    }

    if (input.dash && !player.prevDash && now >= player.dashReadyAt) {
      const dirX = moveLength > 0.15 ? moveX : Math.cos(player.aim);
      const dirY = moveLength > 0.15 ? moveY : Math.sin(player.aim);
      const dirLength = Math.hypot(dirX, dirY) || 1;
      player.dashDirX = dirX / dirLength;
      player.dashDirY = dirY / dirLength;
      player.dashUntil = now + PLAYER_STATS.dash.durationMs;
      player.dashReadyAt = now + PLAYER_STATS.dash.cooldownMs;
      this.emit({
        kind: "dash",
        x: round(player.x),
        y: round(player.y),
        player: player.id,
        aim: round(player.aim, 3),
      });
    }
    player.prevDash = input.dash;

    let dx: number;
    let dy: number;
    if (now < player.dashUntil) {
      const remainingDashMs = Math.max(0, player.dashUntil - now);
      const dashSeconds = Math.min(TICK_MS, remainingDashMs) / 1000;
      dx = player.dashDirX * PLAYER_STATS.dash.speed * dashSeconds;
      dy = player.dashDirY * PLAYER_STATS.dash.speed * dashSeconds;
    } else {
      dx = moveX * PLAYER_STATS.moveSpeed * (TICK_MS / 1000);
      dy = moveY * PLAYER_STATS.moveSpeed * (TICK_MS / 1000);
    }

    const moved = moveCircle(
      player.x,
      player.y,
      dx,
      dy,
      PLAYER_STATS.radius,
      OBSTACLES,
      ARENA.bounds,
    );
    player.x = moved.x;
    player.y = moved.y;

    if (input.fire && now >= player.nextFireAt) {
      this.fire(player, now);
    }
  }

  private fire(player: MatchPlayer, now: number): void {
    if (this.projectiles.length > 160) return;

    const aim = player.aim;
    const muzzleX = player.x + Math.cos(aim) * PLAYER_STATS.weapon.muzzleOffset;
    const muzzleY = player.y + Math.sin(aim) * PLAYER_STATS.weapon.muzzleOffset;

    this.projectiles.push({
      id: this.nextProjectileId++,
      owner: player.id,
      x: muzzleX,
      y: muzzleY,
      vx: Math.cos(aim) * PLAYER_STATS.weapon.projectileSpeed,
      vy: Math.sin(aim) * PLAYER_STATS.weapon.projectileSpeed,
      expiresAt: now + PLAYER_STATS.weapon.projectileLifeMs,
    });

    player.nextFireAt = now + PLAYER_STATS.weapon.cooldownMs;
    this.emit({
      kind: "shot",
      x: round(muzzleX),
      y: round(muzzleY),
      aim: round(aim, 3),
      owner: player.id,
    });
  }

  private updateProjectiles(now: number): void {
    const dtSeconds = TICK_MS / 1000;
    const survivors: Projectile[] = [];

    for (const projectile of this.projectiles) {
      if (now >= projectile.expiresAt) continue;

      const x1 = projectile.x;
      const y1 = projectile.y;
      const x2 = x1 + projectile.vx * dtSeconds;
      const y2 = y1 + projectile.vy * dtSeconds;

      const obstacleHit = firstObstacleHit(
        x1,
        y1,
        x2,
        y2,
        OBSTACLES,
        PLAYER_STATS.weapon.projectileRadius,
      );

      let playerHit: { player: MatchPlayer; t: number } | null = null;
      for (const candidate of this.players.values()) {
        if (!candidate.alive || !candidate.connected) continue;
        if (candidate.id === projectile.owner) continue;
        if (candidate.protectedUntil > now) continue;
        const t = segmentCircleIntersection(
          x1,
          y1,
          x2,
          y2,
          candidate.x,
          candidate.y,
          PLAYER_STATS.radius + PLAYER_STATS.weapon.projectileRadius,
        );
        if (t !== null && (playerHit === null || t < playerHit.t)) {
          playerHit = { player: candidate, t };
        }
      }

      if (obstacleHit && (!playerHit || obstacleHit.t <= playerHit.t)) {
        const hitX = x1 + (x2 - x1) * obstacleHit.t;
        const hitY = y1 + (y2 - y1) * obstacleHit.t;
        this.emit({ kind: "wall", x: round(hitX), y: round(hitY) });
        continue;
      }

      if (playerHit) {
        this.damagePlayer(
          playerHit.player,
          projectile.owner,
          PLAYER_STATS.weapon.damage,
          x1 + (x2 - x1) * playerHit.t,
          y1 + (y2 - y1) * playerHit.t,
          now,
        );
        continue;
      }

      projectile.x = x2;
      projectile.y = y2;
      survivors.push(projectile);
    }

    this.projectiles = survivors;
  }

  private damagePlayer(
    victim: MatchPlayer,
    attackerId: string,
    amount: number,
    hitX: number,
    hitY: number,
    now: number,
  ): void {
    const killed = victim.hp - amount <= 0;
    victim.hp = Math.max(0, victim.hp - amount);

    this.emit({
      kind: "hit",
      x: round(hitX),
      y: round(hitY),
      target: victim.id,
      attacker: attackerId,
      damage: amount,
    });

    if (!killed) return;

    victim.alive = false;
    victim.hp = 0;
    victim.deaths += 1;
    victim.respawnAt = now + PLAYER_STATS.respawnMs;
    victim.dashUntil = 0;

    const killer = this.players.get(attackerId);
    if (killer && killer.id !== victim.id) {
      killer.kills += 1;
      killer.score += SCORING.pointsPerKill;
    }

    this.emit({
      kind: "death",
      x: round(victim.x),
      y: round(victim.y),
      victim: victim.id,
      killer: attackerId,
      color: victim.color,
    });
  }

  private respawnPlayer(player: MatchPlayer, now: number): void {
    const spawn = this.chooseRespawnPoint(player);
    player.x = spawn.x;
    player.y = spawn.y;
    player.hp = PLAYER_STATS.maxHealth;
    player.alive = true;
    player.protectedUntil = now + PLAYER_STATS.spawnProtectionMs;
    player.respawnAt = 0;
    player.nextFireAt = now + 250;
    player.dashUntil = 0;
    player.dashReadyAt = now;
    player.prevDash = true;

    this.emit({
      kind: "respawn",
      x: round(spawn.x),
      y: round(spawn.y),
      player: player.id,
    });
  }

  private chooseRespawnPoint(player: MatchPlayer): Vec2 {
    const enemies = [...this.players.values()].filter(
      (candidate) => candidate.id !== player.id && candidate.alive && candidate.connected,
    );

    let best = SPAWN_POINTS[0];
    let bestDistance = -1;
    for (const spawn of SPAWN_POINTS) {
      let minDistance = Number.POSITIVE_INFINITY;
      for (const enemy of enemies) {
        minDistance = Math.min(minDistance, distanceSq(spawn.x, spawn.y, enemy.x, enemy.y));
      }
      const jitter = this.rng() * 1000;
      const score = (Number.isFinite(minDistance) ? minDistance : 0) + jitter;
      if (score > bestDistance) {
        bestDistance = score;
        best = spawn;
      }
    }

    return { x: best.x, y: best.y };
  }

  private collectCrystals(player: MatchPlayer, now: number): void {
    for (const crystal of this.crystals) {
      if (!crystal.active) continue;
      if (distanceSq(player.x, player.y, crystal.x, crystal.y) > SCORING.pickupRadius ** 2) {
        continue;
      }
      crystal.active = false;
      crystal.respawnAt = now + SCORING.crystalRespawnMs;
      player.crystals += 1;
      player.score += SCORING.pointsPerCrystal;
      this.emit({
        kind: "crystal",
        x: crystal.x,
        y: crystal.y,
        player: player.id,
        amount: SCORING.pointsPerCrystal,
        spot: crystal.spot,
      });
      break;
    }
  }

  private updateCrystals(now: number): void {
    for (const crystal of this.crystals) {
      if (!crystal.active && now >= crystal.respawnAt) {
        crystal.active = true;
        crystal.respawnAt = 0;
      }
    }
  }

  private pickInitialSpawns(count: number): Vec2[] {
    const pool = SPAWN_POINTS.map((spawn) => ({ ...spawn }));
    // Fisher–Yates with the injectable RNG.
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const result: Vec2[] = [];
    for (let i = 0; i < count; i++) {
      result.push(pool[i % pool.length]);
    }
    return result;
  }

  private emit(event: FxPayload): void {
    this.pendingFx.push({ ...event, id: this.nextFxId++ } as FxEvent);
    if (this.pendingFx.length > 200) {
      this.pendingFx.splice(0, this.pendingFx.length - 200);
    }
  }
}

function round(value: number, precision = 1): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
