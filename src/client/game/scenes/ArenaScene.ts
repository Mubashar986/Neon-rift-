import Phaser from "phaser";
import { INPUT_INTERVAL_MS, TICK_MS } from "@shared/constants";
import {
  ARENA,
  OBSTACLES,
  PLAYER_COLORS,
  PLAYER_STATS,
} from "@shared/game-rules";
import { moveCircle, normalizeAngle } from "@shared/physics";
import type {
  SnapshotCrystal,
  SnapshotPlayer,
  SnapshotProjectile,
  SnapshotMsg,
  FxEvent,
} from "@shared/types";
import { TEX } from "../textures";
import type { ArenaSceneData, GameInput, VisualSettings } from "../types";

const INTERP_DELAY_MS = 95;

interface InterpSample {
  t: number;
  x: number;
  y: number;
  aim: number;
}

interface PlayerView {
  id: string;
  name: string;
  color: number;
  container: Phaser.GameObjects.Container;
  glow: Phaser.GameObjects.Image;
  ring: Phaser.GameObjects.Image;
  shield: Phaser.GameObjects.Arc;
  hull: Phaser.GameObjects.Polygon;
  cockpit: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
  hpBack: Phaser.GameObjects.Rectangle;
  hpFill: Phaser.GameObjects.Rectangle;
  samples: InterpSample[];
  alive: boolean;
  connected: boolean;
  hp: number;
  spawnProtMs: number;
  lastAim: number;
  wasAlive: boolean;
}

interface ProjectileView {
  container: Phaser.GameObjects.Container;
  bolt: Phaser.GameObjects.Image;
  glow: Phaser.GameObjects.Image;
  snapX: number;
  snapY: number;
  vx: number;
  vy: number;
  receivedAt: number;
  seenAt: number;
}

interface CrystalView {
  container: Phaser.GameObjects.Container;
  image: Phaser.GameObjects.Image;
  glow: Phaser.GameObjects.Image;
  active: boolean;
}

interface PredictionState {
  x: number;
  y: number;
  elapsed: number;
  dashUntil: number;
  dashReadyAt: number;
  prevDash: boolean;
  alive: boolean;
}

interface HistoryEntry {
  seq: number;
  input: GameInput;
}

const TONE: Record<"cyan" | "violet" | "amber", number> = {
  cyan: 0x33f6ff,
  violet: 0xb06bff,
  amber: 0xffb03b,
};

function colorNumber(hex: string): number {
  return Phaser.Display.Color.HexStringToColor(hex).color;
}

function shortestAngle(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta;
}

/**
 * The authoritative match renderer. The server owns every rule; this scene
 * owns input sampling, local movement prediction, snapshot interpolation and
 * visual effects. Health, score and timer are rendered by the DOM HUD from
 * server snapshots, never from local state.
 */
export class ArenaScene extends Phaser.Scene {
  private sceneData!: ArenaSceneData;
  private selfId = "";
  private roster = new Map<string, { name: string; color: number }>();

  private players = new Map<string, PlayerView>();
  private projectiles = new Map<number, ProjectileView>();
  private crystals = new Map<number, CrystalView>();

  private prediction: PredictionState | null = null;
  private history: HistoryEntry[] = [];
  private lastAckDash = false;
  private selfError = { x: 0, y: 0 };
  private lastAim = 0;
  private lastInputAt = 0;
  private phase: SnapshotMsg["phase"] = "countdown";
  private finished = false;
  private inputPaused = false;
  private pointerFire = false;
  private dashQueued = false;
  private lastFxId = 0;

  private keys!: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
    w: Phaser.Input.Keyboard.Key;
    a: Phaser.Input.Keyboard.Key;
    s: Phaser.Input.Keyboard.Key;
    d: Phaser.Input.Keyboard.Key;
  };
  private cameraTarget!: Phaser.GameObjects.Zone;
  private coreGlow!: Phaser.GameObjects.Image;
  private coreRing!: Phaser.GameObjects.Image;
  private coreRing2!: Phaser.GameObjects.Image;
  private ambientTime = 0;

  constructor() {
    super("Arena");
  }

  init(data: ArenaSceneData): void {
    this.sceneData = data;
    this.selfId = data.selfId;
    this.roster = new Map(
      data.match.roster.map((entry) => [entry.id, { name: entry.name, color: entry.color }]),
    );
  }

  create(): void {
    this.cameras.main.setBackgroundColor("#03040a");
    this.cameras.main.setBounds(0, 0, ARENA.width, ARENA.height);

    this.add.image(0, 0, TEX.arena).setOrigin(0).setDepth(0);
    this.drawArenaFrame();
    this.drawObstacles();
    this.createCrystals();

    this.cameraTarget = this.add.zone(ARENA.width / 2, ARENA.height / 2, 4, 4).setVisible(false);
    this.cameras.main.startFollow(this.cameraTarget, true, 0.16, 0.16);
    this.cameras.main.setDeadzone(90, 60);
    this.applyZoom();

    const keyboard = this.input.keyboard;
    if (keyboard) {
      this.keys = {
        up: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
        down: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
        left: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT),
        right: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT),
        w: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
        a: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
        s: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
        d: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      };
      keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
      keyboard.on("keydown-SPACE", this.queueDash, this);
    }

    this.input.on("pointerdown", this.onPointerDown, this);
    this.input.on("pointerup", this.onPointerUp, this);
    this.input.on(Phaser.Input.Events.GAME_OUT, this.onPointerUp, this);
    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);

    this.cameras.main.fadeIn(280, 3, 4, 10);
  }

  /* ------------------------------------------------------------------ */
  /* Public bridge used by the app controller                           */
  /* ------------------------------------------------------------------ */

  applySnapshot(snapshot: SnapshotMsg): void {
    if (!this.scene.isActive()) return;
    const now = performance.now();
    const wasPlaying = this.phase === "playing";
    this.phase = snapshot.phase;
    if (!wasPlaying && snapshot.phase === "playing") this.lastInputAt = 0;

    const seen = new Set<string>();
    for (const player of snapshot.players) {
      seen.add(player.id);
      const view = this.ensurePlayerView(player);
      if (!view) continue;
      if (!player.connected && view.connected) {
        view.label.setText(`${view.name} · LINK LOST`);
        view.label.setColor("#ff8a9c");
      } else if (player.connected && !view.connected) {
        view.label.setText(view.name);
        view.label.setColor("#dff6ff");
      }
      view.connected = player.connected;
      view.hp = player.hp;
      view.spawnProtMs = player.spawnProtMs;
      view.alive = player.alive;
      view.lastAim = player.aim;

      if (player.id === this.selfId) {
        this.reconcileSelf(player, snapshot);
      } else {
        this.pushRemoteSample(view, player, now);
      }
    }

    for (const [id, view] of this.players) {
      if (!seen.has(id)) {
        view.container.destroy(true);
        this.players.delete(id);
      }
    }

    this.applyProjectiles(snapshot.projectiles, now);
    this.applyCrystals(snapshot.crystals);
    for (const fx of snapshot.fx) this.processFx(fx);
  }

  getCameraState(): { scrollX: number; scrollY: number; zoom: number; viewX: number; viewY: number; viewWidth: number; viewHeight: number } {
    const camera = this.cameras.main;
    const view = camera.worldView;
    return {
      scrollX: Math.round(camera.scrollX),
      scrollY: Math.round(camera.scrollY),
      zoom: Math.round(camera.zoom * 1000) / 1000,
      viewX: Math.round(view.x),
      viewY: Math.round(view.y),
      viewWidth: Math.round(view.width),
      viewHeight: Math.round(view.height),
    };
  }

  setInputPaused(paused: boolean): void {
    this.inputPaused = paused;
    this.pointerFire = false;
    this.dashQueued = false;
    if (paused) this.history = [];
  }

  endMatch(): void {
    this.finished = true;
    this.inputPaused = true;
    this.pointerFire = false;
    this.dashQueued = false;
    this.history = [];
  }

  /* ------------------------------------------------------------------ */
  /* Update loop                                                        */
  /* ------------------------------------------------------------------ */

  update(_time: number, delta: number): void {
    const now = performance.now();
    this.ambientTime += delta;
    this.pulseCore();

    for (const [id, view] of this.players) {
      if (id === this.selfId) continue;
      this.updateRemoteView(view, now);
    }

    if (this.prediction && this.selfId) {
      const view = this.players.get(this.selfId);
      if (view && this.prediction.alive) {
        view.container.setPosition(
          this.prediction.x + this.selfError.x,
          this.prediction.y + this.selfError.y,
        );
        view.hull.setRotation(this.lastAim);
        view.cockpit.setPosition(Math.cos(this.lastAim) * 5, Math.sin(this.lastAim) * 5);
        this.cameraTarget.setPosition(
          this.prediction.x + this.selfError.x,
          this.prediction.y + this.selfError.y,
        );
      }
    }

    const decay = Math.exp(-delta / 90);
    this.selfError.x *= decay;
    this.selfError.y *= decay;
    if (Math.abs(this.selfError.x) < 0.05) this.selfError.x = 0;
    if (Math.abs(this.selfError.y) < 0.05) this.selfError.y = 0;

    this.updateProjectileViews(now);
    this.updateSelfVisual(now);

    if (
      !this.finished &&
      !this.inputPaused &&
      this.phase === "playing" &&
      this.prediction?.alive &&
      now - this.lastInputAt >= INPUT_INTERVAL_MS
    ) {
      this.lastInputAt = now;
      this.sampleAndSend();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Arena art                                                          */
  /* ------------------------------------------------------------------ */

  private drawArenaFrame(): void {
    const g = this.add.graphics().setDepth(1);
    g.lineStyle(3, 0x33f6ff, 0.22);
    g.strokeRect(ARENA.bounds.left, ARENA.bounds.top, ARENA.bounds.right - ARENA.bounds.left, ARENA.bounds.bottom - ARENA.bounds.top);
    g.lineStyle(1, 0x8ffaff, 0.12);
    g.strokeRect(ARENA.bounds.left + 10, ARENA.bounds.top + 10, ARENA.bounds.right - ARENA.bounds.left - 20, ARENA.bounds.bottom - ARENA.bounds.top - 20);

    for (const corner of [
      [ARENA.bounds.left, ARENA.bounds.top, 1, 1],
      [ARENA.bounds.right, ARENA.bounds.top, -1, 1],
      [ARENA.bounds.left, ARENA.bounds.bottom, 1, -1],
      [ARENA.bounds.right, ARENA.bounds.bottom, -1, -1],
    ]) {
      const [x, y, sx, sy] = corner;
      g.lineStyle(3, 0x33f6ff, 0.55);
      g.beginPath();
      g.moveTo(x + sx * 66, y);
      g.lineTo(x, y);
      g.lineTo(x, y + sy * 66);
      g.strokePath();
    }
  }

  private drawObstacles(): void {
    const g = this.add.graphics().setDepth(2);
    for (const obstacle of OBSTACLES) {
      const tone = obstacle.tone ?? "cyan";
      const color = TONE[tone];
      if (obstacle.kind === "rect") {
        g.fillStyle(0x06101e, 0.94);
        g.fillRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h);
        g.lineStyle(2, color, 0.5);
        g.strokeRect(obstacle.x + 0.5, obstacle.y + 0.5, obstacle.w - 1, obstacle.h - 1);
        g.lineStyle(1, 0xffffff, 0.08);
        g.strokeRect(obstacle.x + 7, obstacle.y + 7, obstacle.w - 14, obstacle.h - 14);
        g.fillStyle(color, 0.28);
        g.fillRect(obstacle.x + 8, obstacle.y + 8, Math.max(8, obstacle.w * 0.22), 2);
        g.fillRect(obstacle.x + obstacle.w - 8 - Math.max(8, obstacle.w * 0.14), obstacle.y + obstacle.h - 10, Math.max(8, obstacle.w * 0.14), 2);
      } else {
        this.coreGlow = this.add
          .image(obstacle.x, obstacle.y, TEX.glow)
          .setTint(0x9c4dff)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setScale(2.1)
          .setAlpha(0.35)
          .setDepth(3);
        this.coreRing = this.add
          .image(obstacle.x, obstacle.y, TEX.ring)
          .setTint(0xb06bff)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setScale(0.9)
          .setAlpha(0.22)
          .setDepth(3);
        this.coreRing2 = this.add
          .image(obstacle.x, obstacle.y, TEX.ring)
          .setTint(0x33f6ff)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setScale(1.3)
          .setAlpha(0.1)
          .setDepth(3);

        g.fillStyle(0x120a24, 0.96);
        g.fillCircle(obstacle.x, obstacle.y, obstacle.r);
        g.lineStyle(3, 0xb06bff, 0.55);
        g.strokeCircle(obstacle.x, obstacle.y, obstacle.r);
        g.lineStyle(1, 0xffffff, 0.16);
        g.strokeCircle(obstacle.x, obstacle.y, obstacle.r - 10);
        g.lineStyle(2, 0xff3bd4, 0.24);
        g.strokeCircle(obstacle.x, obstacle.y, obstacle.r * 0.55);
      }
    }
  }

  private createCrystals(): void {
    for (let index = 0; index < 10; index += 1) {
      // Positions are replaced by the first authoritative snapshot.
      const view: CrystalView = {
        container: this.add.container(0, 0).setDepth(9).setVisible(false),
        image: this.add.image(0, 0, TEX.crystal).setScale(0.72),
        glow: this.add
          .image(0, 0, TEX.glow)
          .setTint(0x8ffaff)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setScale(0.32)
          .setAlpha(0.5),
        active: false,
      };
      view.container.add([view.glow, view.image]);
      this.crystals.set(index + 1, view);
      this.tweens.add({
        targets: view.image,
        y: -6,
        duration: 1_300 + index * 80,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
      this.tweens.add({
        targets: view.glow,
        alpha: 0.78,
        scale: 0.42,
        duration: 900 + index * 50,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
      this.tweens.add({
        targets: view.image,
        angle: 12,
        duration: 2_000 + index * 90,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }
  }

  private pulseCore(): void {
    if (!this.coreGlow) return;
    const t = this.ambientTime / 1000;
    this.coreGlow.setAlpha(0.3 + Math.sin(t * 1.4) * 0.08);
    this.coreRing.rotation += 0.002;
    this.coreRing2.rotation -= 0.0013;
    this.coreRing2.setAlpha(0.08 + (Math.sin(t * 0.8) + 1) * 0.035);
  }

  /* ------------------------------------------------------------------ */
  /* Players                                                            */
  /* ------------------------------------------------------------------ */

  private ensurePlayerView(player: SnapshotPlayer): PlayerView | null {
    const existing = this.players.get(player.id);
    if (existing) return existing;
    const entry = this.roster.get(player.id);
    if (!entry) return null;

    const color = colorNumber(PLAYER_COLORS[entry.color % PLAYER_COLORS.length]);
    const isSelf = player.id === this.selfId;
    const container = this.add.container(player.x, player.y).setDepth(isSelf ? 32 : 30);
    const glow = this.add
      .image(0, 0, TEX.glow)
      .setTint(color)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(0.52)
      .setAlpha(0.55);
    const ring = this.add
      .image(0, 0, TEX.ring)
      .setTint(color)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(isSelf ? 0.27 : 0.22)
      .setAlpha(isSelf ? 0.46 : 0.24);
    const shield = this.add
      .circle(0, 0, 27)
      .setStrokeStyle(2, color, 0.85)
      .setFillStyle(color, 0.04)
      .setVisible(false);
    const hull = this.add
      .polygon(0, 0, [20, 0, -12, -13, -4, 0, -12, 13], color, 1)
      .setStrokeStyle(2, 0xffffff, 0.5);
    const cockpit = this.add.circle(5, 0, 4, 0xffffff, 0.92);
    const label = this.add
      .text(0, -40, entry.name, {
        fontFamily: '"Rajdhani", "Segoe UI", sans-serif',
        fontSize: isSelf ? "14px" : "12px",
        fontStyle: "600",
        color: isSelf ? "#ffffff" : "#cfe9ff",
        stroke: "#02050d",
        strokeThickness: 4,
      })
      .setOrigin(0.5);
    const hpBack = this.add.rectangle(0, 28, 38, 4, 0x02050d, 0.8).setOrigin(0.5);
    const hpFill = this.add.rectangle(-19, 28, 38, 4, color, 0.95).setOrigin(0, 0.5);

    container.add([glow, ring, shield, hull, cockpit, label, hpBack, hpFill]);
    this.tweens.add({
      targets: ring,
      angle: 360,
      duration: isSelf ? 6_000 : 9_000,
      repeat: -1,
      ease: "Linear",
    });

    const view: PlayerView = {
      id: player.id,
      name: entry.name,
      color,
      container,
      glow,
      ring,
      shield,
      hull,
      cockpit,
      label,
      hpBack,
      hpFill,
      samples: [],
      alive: player.alive,
      connected: player.connected,
      hp: player.hp,
      spawnProtMs: player.spawnProtMs,
      lastAim: player.aim,
      wasAlive: player.alive,
    };
    this.players.set(player.id, view);
    return view;
  }

  private pushRemoteSample(view: PlayerView, player: SnapshotPlayer, now: number): void {
    const last = view.samples[view.samples.length - 1];
    const respawned = !view.wasAlive && player.alive;
    const teleported = last !== undefined && Math.hypot(last.x - player.x, last.y - player.y) > 420;
    if (respawned || teleported) view.samples = [];
    view.samples.push({ t: now, x: player.x, y: player.y, aim: player.aim });
    if (view.samples.length > 24) view.samples.shift();
    view.wasAlive = player.alive;
    view.lastAim = player.aim;

    if (!player.alive) {
      view.hull.setVisible(false);
      view.cockpit.setVisible(false);
      view.glow.setAlpha(0.25);
      view.hpFill.setVisible(false);
    } else {
      view.hull.setVisible(true);
      view.cockpit.setVisible(true);
      view.glow.setAlpha(0.55);
      view.hpFill.setVisible(true);
      view.container.setAlpha(player.connected ? 1 : 0.5);
    }

    view.shield.setVisible(player.spawnProtMs > 0 && player.alive);
    view.hpFill.width = Math.max(0, (player.hp / PLAYER_STATS.maxHealth) * 38);
    view.hpFill.fillColor = player.hp <= 30 ? 0xff4d6d : view.color;
    if (view.samples.length === 1) {
      view.container.setPosition(player.x, player.y);
      view.hull.setRotation(player.aim);
    }
  }

  private updateRemoteView(view: PlayerView, now: number): void {
    if (view.id === this.selfId || view.samples.length === 0) return;
    const targetTime = now - INTERP_DELAY_MS;
    const samples = view.samples;
    let x = samples[samples.length - 1].x;
    let y = samples[samples.length - 1].y;
    let aim = samples[samples.length - 1].aim;

    if (samples.length === 1 || targetTime <= samples[0].t) {
      x = samples[0].x;
      y = samples[0].y;
      aim = samples[0].aim;
    } else {
      for (let index = 0; index < samples.length - 1; index += 1) {
        const a = samples[index];
        const b = samples[index + 1];
        if (targetTime >= a.t && targetTime <= b.t) {
          const span = Math.max(1, b.t - a.t);
          const t = (targetTime - a.t) / span;
          x = a.x + (b.x - a.x) * t;
          y = a.y + (b.y - a.y) * t;
          aim = a.aim + (shortestAngle(a.aim, b.aim) - a.aim) * t;
          view.lastAim = aim;
          break;
        }
      }
      if (targetTime > samples[samples.length - 1].t) {
        const last = samples[samples.length - 1];
        x = last.x;
        y = last.y;
        aim = last.aim;
      }
    }

    view.container.setPosition(x, y);
    view.hull.setRotation(aim);
    view.cockpit.setPosition(Math.cos(aim) * 5, Math.sin(aim) * 5);

    if (view.spawnProtMs > 0) {
      view.shield.setAlpha(0.55 + Math.sin(now / 120) * 0.3);
    }
  }

  private reconcileSelf(player: SnapshotPlayer, snapshot: SnapshotMsg): void {
    const ack = snapshot.acks[this.selfId] ?? 0;
    while (this.history.length > 0 && this.history[0].seq <= ack) {
      this.lastAckDash = this.history[0].input.dash;
      this.history.shift();
    }

    if (!this.prediction) {
      this.prediction = {
        x: player.x,
        y: player.y,
        elapsed: 0,
        dashUntil: 0,
        dashReadyAt: player.dashCooldownMs,
        prevDash: false,
        alive: player.alive,
      };
      this.selfError.x = 0;
      this.selfError.y = 0;
      this.cameraTarget.setPosition(player.x, player.y);
      this.applySelfState(player);
      return;
    }

    const renderedX = this.prediction.x + this.selfError.x;
    const renderedY = this.prediction.y + this.selfError.y;
    const wasAlive = this.prediction.alive;

    const state: PredictionState = {
      x: player.x,
      y: player.y,
      elapsed: 0,
      dashUntil: 0,
      dashReadyAt: player.dashCooldownMs,
      prevDash: this.lastAckDash,
      alive: player.alive,
    };

    if (player.alive) {
      for (const entry of this.history) {
        this.simulateStep(state, entry.input, TICK_MS);
      }
    }

    this.prediction = state;
    if (!wasAlive && player.alive) {
      this.selfError.x = 0;
      this.selfError.y = 0;
    } else {
      this.selfError.x = renderedX - state.x;
      this.selfError.y = renderedY - state.y;
      if (Math.hypot(this.selfError.x, this.selfError.y) > 180) {
        this.selfError.x = 0;
        this.selfError.y = 0;
      }
    }
    this.applySelfState(player);
  }

  private applySelfState(player: SnapshotPlayer): void {
    const view = this.players.get(this.selfId);
    if (!view) return;
    view.connected = player.connected;
    view.hp = player.hp;
    view.alive = player.alive;
    view.spawnProtMs = player.spawnProtMs;
    view.shield.setVisible(player.alive && player.spawnProtMs > 0);
    view.hull.setVisible(player.alive);
    view.cockpit.setVisible(player.alive);
    view.hpFill.setVisible(player.alive);
    view.glow.setAlpha(player.alive ? 0.6 : 0.18);
    view.hpFill.width = Math.max(0, (player.hp / PLAYER_STATS.maxHealth) * 38);
    view.hpFill.fillColor = player.hp <= 30 ? 0xff4d6d : view.color;
    view.container.setAlpha(player.connected ? 1 : 0.55);
    if (!player.alive) {
      view.container.setPosition(player.x, player.y);
      view.hull.setRotation(view.lastAim);
    }
  }

  private updateSelfVisual(now: number): void {
    const view = this.players.get(this.selfId);
    if (!view || !this.prediction) return;
    if (!this.prediction.alive) {
      view.container.setPosition(this.prediction.x, this.prediction.y);
      view.hull.setRotation(this.lastAim);
      view.cockpit.setPosition(Math.cos(this.lastAim) * 5, Math.sin(this.lastAim) * 5);
    }
    if (view.spawnProtMs > 0) {
      view.shield.setAlpha(0.55 + Math.sin(now / 110) * 0.3);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Local prediction                                                   */
  /* ------------------------------------------------------------------ */

  private sampleAndSend(): void {
    if (!this.prediction) return;
    const input = this.readInput();
    if (!input) return;
    this.lastAim = input.aim;
    const sink = this.sceneData.getInputSink();
    if (!sink) return;
    const seq = sink(input);
    if (seq <= 0) return;
    this.history.push({ seq, input });
    if (this.history.length > 60) this.history.shift();
    this.simulateStep(this.prediction, input, TICK_MS);
  }

  private readInput(): GameInput | null {
    if (!this.prediction) return null;
    const touchActive = this.sceneData.getTouchActive();
    const touch = this.sceneData.touch.getState();
    let moveX = 0;
    let moveY = 0;
    let aim = this.lastAim;

    if (touchActive) {
      moveX = touch.moveX;
      moveY = touch.moveY;
      if (touch.hasAim) {
        aim = touch.aim;
      } else if (Math.hypot(moveX, moveY) > 0.12) {
        aim = Math.atan2(moveY, moveX);
      }
    } else {
      if (this.keys.d.isDown || this.keys.right.isDown) moveX += 1;
      if (this.keys.a.isDown || this.keys.left.isDown) moveX -= 1;
      if (this.keys.s.isDown || this.keys.down.isDown) moveY += 1;
      if (this.keys.w.isDown || this.keys.up.isDown) moveY -= 1;

      const pointer = this.input.activePointer;
      if (pointer && (pointer.x !== 0 || pointer.y !== 0)) {
        const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
        const renderX = this.prediction.x + this.selfError.x;
        const renderY = this.prediction.y + this.selfError.y;
        aim = Math.atan2(world.y - renderY, world.x - renderX);
      }
    }

    const touchDash = touchActive ? this.sceneData.touch.consumeDash() : false;
    const dash = this.dashQueued || touchDash;
    this.dashQueued = false;
    const fire = this.pointerFire || (touchActive && this.sceneData.touch.isFiring);

    const length = Math.hypot(moveX, moveY);
    if (length > 1) {
      moveX /= length;
      moveY /= length;
    }

    return {
      moveX: Math.round(moveX * 100) / 100,
      moveY: Math.round(moveY * 100) / 100,
      aim: normalizeAngle(aim),
      fire,
      dash,
    };
  }

  private simulateStep(state: PredictionState, input: GameInput, deltaMs: number): void {
    if (!state.alive) return;
    let moveX = input.moveX;
    let moveY = input.moveY;
    const length = Math.hypot(moveX, moveY);
    if (length > 1) {
      moveX /= length;
      moveY /= length;
    }

    if (input.dash && !state.prevDash && state.dashReadyAt <= state.elapsed) {
      const dirX = length > 0.15 ? moveX : Math.cos(input.aim);
      const dirY = length > 0.15 ? moveY : Math.sin(input.aim);
      const dirLength = Math.hypot(dirX, dirY) || 1;
      state.dashUntil = state.elapsed + PLAYER_STATS.dash.durationMs;
      state.dashReadyAt = state.elapsed + PLAYER_STATS.dash.cooldownMs;
      const moved = moveCircle(
        state.x,
        state.y,
        (dirX / dirLength) * PLAYER_STATS.dash.speed * (deltaMs / 1000),
        (dirY / dirLength) * PLAYER_STATS.dash.speed * (deltaMs / 1000),
        PLAYER_STATS.radius,
        OBSTACLES,
        ARENA.bounds,
      );
      state.x = moved.x;
      state.y = moved.y;
      state.elapsed += deltaMs;
      state.prevDash = true;
      return;
    }

    state.prevDash = input.dash;
    let dx: number;
    let dy: number;
    if (state.elapsed < state.dashUntil) {
      const remaining = Math.max(0, state.dashUntil - state.elapsed);
      const dashSeconds = Math.min(deltaMs, remaining) / 1000;
      const dashLength = Math.hypot(moveX, moveY);
      const dirX = dashLength > 0.15 ? moveX / dashLength : Math.cos(input.aim);
      const dirY = dashLength > 0.15 ? moveY / dashLength : Math.sin(input.aim);
      dx = dirX * PLAYER_STATS.dash.speed * dashSeconds;
      dy = dirY * PLAYER_STATS.dash.speed * dashSeconds;
    } else {
      dx = moveX * PLAYER_STATS.moveSpeed * (deltaMs / 1000);
      dy = moveY * PLAYER_STATS.moveSpeed * (deltaMs / 1000);
    }

    const moved = moveCircle(
      state.x,
      state.y,
      dx,
      dy,
      PLAYER_STATS.radius,
      OBSTACLES,
      ARENA.bounds,
    );
    state.x = moved.x;
    state.y = moved.y;
    state.elapsed += deltaMs;
  }

  /* ------------------------------------------------------------------ */
  /* Projectiles + crystals                                             */
  /* ------------------------------------------------------------------ */

  private applyProjectiles(projectiles: SnapshotProjectile[], now: number): void {
    const seen = new Set<number>();
    for (const projectile of projectiles) {
      seen.add(projectile.id);
      let view = this.projectiles.get(projectile.id);
      if (!view) {
        const entry = this.roster.get(projectile.owner);
        const color = entry ? colorNumber(PLAYER_COLORS[entry.color % PLAYER_COLORS.length]) : 0xffffff;
        const container = this.add.container(projectile.x, projectile.y).setDepth(21);
        const glow = this.add
          .image(0, 0, TEX.glow)
          .setTint(color)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setScale(0.2)
          .setAlpha(0.5);
        const bolt = this.add
          .image(0, 0, TEX.bolt)
          .setTint(color)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setScale(0.85, 0.9);
        container.add([glow, bolt]);
        container.setRotation(Math.atan2(projectile.vy, projectile.vx));
        view = {
          container,
          bolt,
          glow,
          snapX: projectile.x,
          snapY: projectile.y,
          vx: projectile.vx,
          vy: projectile.vy,
          receivedAt: now,
          seenAt: now,
        };
        this.projectiles.set(projectile.id, view);
      }
      view.snapX = projectile.x;
      view.snapY = projectile.y;
      view.vx = projectile.vx;
      view.vy = projectile.vy;
      view.receivedAt = now;
      view.seenAt = now;
      view.container.setRotation(Math.atan2(projectile.vy, projectile.vx));
    }

    for (const [id, view] of this.projectiles) {
      if (seen.has(id)) continue;
      if (now - view.seenAt > 160) {
        view.container.destroy(true);
        this.projectiles.delete(id);
      }
    }
  }

  private updateProjectileViews(now: number): void {
    for (const view of this.projectiles.values()) {
      const age = Math.min((now - view.receivedAt) / 1000, 0.07);
      const x = view.snapX + view.vx * age;
      const y = view.snapY + view.vy * age;
      view.container.x += (x - view.container.x) * 0.65;
      view.container.y += (y - view.container.y) * 0.65;
      view.glow.setAlpha(0.4 + Math.sin(now / 60 + view.snapX) * 0.16);
    }
  }

  private applyCrystals(crystals: SnapshotCrystal[]): void {
    for (const crystal of crystals) {
      const view = this.crystals.get(crystal.id);
      if (!view) continue;
      view.container.setPosition(crystal.x, crystal.y);
      if (crystal.active === view.active) {
        if (!crystal.active) view.container.setVisible(false);
        continue;
      }
      view.active = crystal.active;
      view.container.setVisible(crystal.active);
      view.container.setScale(crystal.active ? 1 : 0.2);
      if (crystal.active) {
        view.container.setScale(0.25);
        this.tweens.add({
          targets: view.container,
          scale: 1,
          duration: 420,
          ease: "Back.easeOut",
        });
        this.ring(crystal.x, crystal.y, 0x8ffaff, 0.4, 360);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Effects                                                            */
  /* ------------------------------------------------------------------ */

  private processFx(fx: FxEvent): void {
    if (fx.id <= this.lastFxId) return;
    this.lastFxId = fx.id;

    switch (fx.kind) {
      case "shot": {
        const entry = this.roster.get(fx.owner);
        const color = entry ? colorNumber(PLAYER_COLORS[entry.color % PLAYER_COLORS.length]) : 0xffffff;
        this.muzzle(fx.x, fx.y, fx.aim, color);
        break;
      }
      case "hit": {
        const entry = this.roster.get(fx.target);
        const color = entry ? colorNumber(PLAYER_COLORS[entry.color % PLAYER_COLORS.length]) : 0xffb03b;
        this.burst(fx.x, fx.y, color, 5, 130, 280);
        this.floatText(fx.x, fx.y - 14, `-${fx.damage}`, "#ffd0a3");
        this.nearShake(fx.x, fx.y, 0.0035);
        break;
      }
      case "death": {
        this.burst(fx.x, fx.y, fx.color, 20, 290, 620);
        this.burst(fx.x, fx.y, 0xffffff, 6, 180, 380);
        this.flash(fx.x, fx.y, fx.color, 1.1, 220);
        this.ring(fx.x, fx.y, fx.color, 0.55, 520);
        this.nearShake(fx.x, fx.y, 0.009);
        break;
      }
      case "respawn": {
        this.ring(fx.x, fx.y, 0x8ffaff, 0.45, 600);
        this.flash(fx.x, fx.y, 0x33f6ff, 0.7, 240);
        break;
      }
      case "dash": {
        const entry = this.roster.get(fx.player);
        const color = entry ? colorNumber(PLAYER_COLORS[entry.color % PLAYER_COLORS.length]) : 0xffffff;
        this.dashTrail(fx.x, fx.y, fx.aim, color);
        break;
      }
      case "crystal": {
        this.burst(fx.x, fx.y, 0x8ffaff, 9, 170, 420);
        this.floatText(fx.x, fx.y - 20, `+${fx.amount}`, "#8ffaff");
        break;
      }
      case "wall": {
        this.burst(fx.x, fx.y, 0x9fd8ff, 3, 90, 220);
        break;
      }
      case "match_live": {
        this.ring(ARENA.width / 2, ARENA.height / 2, 0x33f6ff, 2.2, 650);
        break;
      }
      case "countdown":
        break;
    }
  }

  private muzzle(x: number, y: number, aim: number, color: number): void {
    const bolt = this.add
      .image(x, y, TEX.bolt)
      .setTint(color)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setRotation(aim)
      .setScale(0.55)
      .setAlpha(0.95)
      .setDepth(45);
    this.tweens.add({
      targets: bolt,
      alpha: 0,
      scaleX: 1.1,
      scaleY: 0.2,
      duration: 130,
      ease: "Quad.easeOut",
      onComplete: () => bolt.destroy(),
    });
    const glow = this.add
      .image(x, y, TEX.glow)
      .setTint(color)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(0.24)
      .setAlpha(0.7)
      .setDepth(44);
    this.tweens.add({
      targets: glow,
      alpha: 0,
      scale: 0.45,
      duration: 100,
      onComplete: () => glow.destroy(),
    });
  }

  private burst(
    x: number,
    y: number,
    color: number,
    count: number,
    speed: number,
    lifespan: number,
  ): void {
    const settings = this.visualSettings();
    const amount = settings.quality === "low" ? Math.ceil(count / 2) : settings.reducedMotion ? Math.ceil(count * 0.6) : count;
    const emitter = this.add.particles(x, y, TEX.spark, {
      speed: { min: speed * 0.35, max: speed },
      angle: { min: 0, max: 360 },
      scale: { start: 0.55, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: { min: lifespan * 0.6, max: lifespan },
      tint: color,
      blendMode: Phaser.BlendModes.ADD,
      emitting: false,
    });
    emitter.setDepth(52);
    emitter.explode(amount);
    this.time.delayedCall(lifespan + 160, () => emitter.destroy());
  }

  private ring(x: number, y: number, color: number, scale: number, duration: number): void {
    const ring = this.add
      .image(x, y, TEX.ring)
      .setTint(color)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(0.08)
      .setAlpha(0.9)
      .setDepth(50);
    this.tweens.add({
      targets: ring,
      scale,
      alpha: 0,
      duration,
      ease: "Cubic.easeOut",
      onComplete: () => ring.destroy(),
    });
  }

  private flash(x: number, y: number, color: number, scale: number, duration: number): void {
    const glow = this.add
      .image(x, y, TEX.glow)
      .setTint(color)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(scale * 0.5)
      .setAlpha(0.9)
      .setDepth(49);
    this.tweens.add({
      targets: glow,
      scale,
      alpha: 0,
      duration,
      ease: "Quad.easeOut",
      onComplete: () => glow.destroy(),
    });
  }

  private dashTrail(x: number, y: number, aim: number, color: number): void {
    const trail = this.add
      .image(x, y, TEX.bolt)
      .setTint(color)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setRotation(aim)
      .setScale(1.2, 1.4)
      .setAlpha(0.4)
      .setDepth(28);
    this.tweens.add({
      targets: trail,
      alpha: 0,
      scaleX: 0.2,
      duration: 220,
      onComplete: () => trail.destroy(),
    });
  }

  private floatText(x: number, y: number, text: string, color: string): void {
    const label = this.add
      .text(x, y, text, {
        fontFamily: '"Orbitron", "Arial Black", sans-serif',
        fontSize: "14px",
        fontStyle: "700",
        color,
        stroke: "#02050d",
        strokeThickness: 4,
      })
      .setOrigin(0.5)
      .setDepth(56);
    this.tweens.add({
      targets: label,
      y: y - 36,
      alpha: 0,
      duration: 760,
      ease: "Quad.easeOut",
      onComplete: () => label.destroy(),
    });
  }

  private nearShake(x: number, y: number, intensity: number): void {
    const settings = this.visualSettings();
    if (!settings.screenShake || settings.reducedMotion) return;
    const self = this.prediction;
    if (!self) return;
    const distance = Math.hypot(self.x - x, self.y - y);
    if (distance > 520) return;
    const falloff = 1 - distance / 520;
    this.cameras.main.shake(140, intensity * falloff);
  }

  /* ------------------------------------------------------------------ */
  /* Input plumbing                                                     */
  /* ------------------------------------------------------------------ */

  private queueDash(): void {
    this.dashQueued = true;
  }

  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    if (pointer.leftButtonDown()) {
      this.pointerFire = true;
    }
  }

  private onPointerUp(): void {
    this.pointerFire = false;
  }

  private handleResize(): void {
    this.applyZoom();
  }

  private applyZoom(): void {
    const zoom = Math.min(
      1.15,
      Math.max(0.62, Math.min(this.scale.width / 1_450, this.scale.height / 900)),
    );
    this.cameras.main.setZoom(zoom);
  }

  private visualSettings(): VisualSettings {
    return this.sceneData.getSettings();
  }

  private onShutdown(): void {
    this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.input.keyboard?.off("keydown-SPACE", this.queueDash, this);
    this.input.off("pointerdown", this.onPointerDown, this);
    this.input.off("pointerup", this.onPointerUp, this);
    this.input.off(Phaser.Input.Events.GAME_OUT, this.onPointerUp, this);
    for (const view of this.players.values()) view.container.destroy(true);
    for (const view of this.projectiles.values()) view.container.destroy(true);
    for (const view of this.crystals.values()) view.container.destroy(true);
    this.players.clear();
    this.projectiles.clear();
    this.crystals.clear();
  }
}
