import "./style.css";
import * as THREE from "three";
import { AudioEngine } from "./audio";
import { ClipRecorder } from "./recorder";
import { Effects } from "./effects";
import { Player, type PlayerInput } from "./player";
import { Enemy, Ally, type AiContext } from "./ai";
import { MissionState, type MissionEvent } from "./mission";
import { Planning } from "./planning";
import { HUD } from "./hud";
import { roleById } from "./roles";
import { INSERTIONS, createWorld, type World } from "./world";
import { accuracyPercent } from "./ballistics";
import { applyMissionResult, loadMeta } from "./meta";
import { coneDirection, formatClock, horizontalDistance, raySphere, worldHit } from "./combat";
import {
  ALLY_CALLSIGNS,
  type AftermathDebugState,
  type InsertionSpec,
  type MetaState,
  type MissionConfig,
  type MissionStats,
  type RewardReport,
  type RoleSpec,
} from "./types";

interface AftermathSettings {
  sensitivity: number;
  volume: number;
}

const SETTINGS_KEY = "neon-rift.aftermath.settings.v1";
const DEFAULT_SETTINGS: AftermathSettings = { sensitivity: 1, volume: 0.8 };

function loadSettings(): AftermathSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AftermathSettings>;
    return {
      sensitivity:
        typeof parsed.sensitivity === "number" && Number.isFinite(parsed.sensitivity)
          ? Math.max(0.2, Math.min(3, parsed.sensitivity))
          : DEFAULT_SETTINGS.sensitivity,
      volume:
        typeof parsed.volume === "number" && Number.isFinite(parsed.volume)
          ? Math.max(0, Math.min(1, parsed.volume))
          : DEFAULT_SETTINGS.volume,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: AftermathSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage may be unavailable; settings remain session-only.
  }
}

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function show(element: HTMLElement): void {
  element.classList.remove("is-hidden");
  element.hidden = false;
}

function conceal(element: HTMLElement): void {
  element.classList.add("is-hidden");
  element.hidden = true;
}

interface ActiveMission {
  config: MissionConfig;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  world: World;
  effects: Effects;
  player: Player;
  allies: Ally[];
  enemies: Enemy[];
  mission: MissionState;
  context: AiContext;
  stats: MissionStats;
  startedAt: number;
  beaconTime: number;
  interaction: { label: string; progress: number } | null;
  reviveProgress: number;
  reviveTarget: Ally | null;
  ending: boolean;
  endingAt: number;
  endSuccess: boolean;
  resultsShown: boolean;
  rewards: RewardReport | null;
  clipPromise: Promise<Blob | null> | null;
  terminalBeacon: THREE.Mesh;
  extractionBeacon: THREE.Mesh;
}

function emptyStats(): MissionStats {
  return {
    success: false,
    timeSec: 0,
    kills: 0,
    headshots: 0,
    shotsFired: 0,
    shotsHit: 0,
    damageDealt: 0,
    damageTaken: 0,
    revives: 0,
    alliesLost: 0,
    objectiveComplete: false,
    extracted: false,
  };
}

class AftermathApp {
  private readonly canvas = mustGet<HTMLCanvasElement>("aw-canvas");
  private readonly renderer: THREE.WebGLRenderer;
  private readonly audio = new AudioEngine();
  private readonly recorder = new ClipRecorder();
  private readonly hud = new HUD();
  private readonly planning: Planning;
  private meta: MetaState;
  private settings: AftermathSettings;

  private active: ActiveMission | null = null;
  private paused = false;
  private firing = false;
  private ads = false;
  private readonly keys = new Set<string>();
  private lastFrame = performance.now();
  private fps = 60;
  private hadPointerLock = false;
  private loadToken = 0;
  private lastClip: Blob | null = null;
  private lastStats: MissionStats | null = null;
  private lastRewards: RewardReport | null = null;

  private readonly loading = mustGet("aw-loading");
  private readonly fade = mustGet("aw-fade");
  private readonly pauseOverlay = mustGet("aw-pause");
  private readonly resultsOverlay = mustGet("aw-results");
  private readonly resultsModal = this.resultsOverlay.querySelector(".aw-modal--results") as HTMLElement;
  private readonly resultsStats = mustGet("aw-results-stats");
  private readonly resultKicker = mustGet("aw-result-kicker");
  private readonly resultTitle = mustGet("aw-result-title");
  private readonly resultSub = mustGet("aw-result-sub");
  private readonly rewardXp = mustGet("aw-reward-xp");
  private readonly rewardCredits = mustGet("aw-reward-credits");
  private readonly rewardRank = mustGet("aw-reward-rank");
  private readonly contractComplete = mustGet("aw-contract-complete");
  private readonly clipStatus = mustGet("aw-clip-status");
  private readonly downloadButton = mustGet<HTMLButtonElement>("aw-download-clip");
  private readonly sensitivityInput = mustGet<HTMLInputElement>("aw-sensitivity");
  private readonly volumeInput = mustGet<HTMLInputElement>("aw-volume");
  private readonly pauseButton = mustGet<HTMLButtonElement>("aw-pause");

  constructor() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.settings = loadSettings();
    this.meta = loadMeta();
    this.planning = new Planning((config) => this.startMission(config));
    this.planning.refresh(this.meta);
    this.planning.show();
    this.sensitivityInput.value = String(this.settings.sensitivity);
    this.volumeInput.value = String(this.settings.volume);

    this.bindEvents();
    this.installDebugApi();
    requestAnimationFrame(this.loop);
  }

  private bindEvents(): void {
    window.addEventListener("resize", () => this.resize());
    document.addEventListener("keydown", (event) => this.onKeyDown(event));
    document.addEventListener("keyup", (event) => this.keys.delete(event.code));
    document.addEventListener("mousemove", (event) => this.onMouseMove(event));
    document.addEventListener("mouseup", (event) => {
      if (event.button === 0) this.firing = false;
      if (event.button === 2) this.ads = false;
    });
    window.addEventListener("blur", () => {
      this.firing = false;
      this.ads = false;
      this.keys.clear();
      if (this.active && !this.paused && !this.active.ending) this.pause();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && this.active && !this.paused && !this.active.ending) {
        this.pause();
      }
    });
    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === this.canvas;
      if (locked) {
        this.hadPointerLock = true;
        return;
      }
      if (this.hadPointerLock && this.active && !this.paused && !this.active.ending) {
        this.pause();
      }
    });

    this.canvas.addEventListener("mousedown", (event) => {
      if (!this.active || this.paused || this.active.ending) return;
      if (document.pointerLockElement !== this.canvas) {
        this.requestPointerLock();
        return;
      }
      if (event.button === 0) this.firing = true;
      if (event.button === 2) this.ads = true;
    });
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    this.canvas.addEventListener("click", () => {
      if (this.active && !this.paused && !this.active.ending && document.pointerLockElement !== this.canvas) {
        this.requestPointerLock();
      }
    });

    this.pauseButton.addEventListener("click", () => this.pause());
    mustGet("aw-resume").addEventListener("click", () => this.resume());
    mustGet("aw-pause-abort").addEventListener("click", () => this.abortToPlanning());
    mustGet("aw-redeploy").addEventListener("click", () => this.abortToPlanning());
    mustGet("aw-retry").addEventListener("click", () => {
      const config = this.active?.config;
      if (!config) {
        this.abortToPlanning();
        return;
      }
      this.teardown();
      this.startMission(config);
    });
    this.downloadButton.addEventListener("click", () => {
      if (!this.lastClip) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      ClipRecorder.download(this.lastClip, `aftermath-${stamp}.${this.recorder.extension}`);
    });
    mustGet("aw-save-frame").addEventListener("click", () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      ClipRecorder.captureFrame(this.canvas, `aftermath-frame-${stamp}.png`);
    });
    mustGet("aw-share").addEventListener("click", () => {
      void this.copyShareText();
    });
    this.sensitivityInput.addEventListener("input", () => {
      this.settings.sensitivity = Math.max(0.2, Math.min(3, Number(this.sensitivityInput.value) || 1));
      saveSettings(this.settings);
    });
    this.volumeInput.addEventListener("input", () => {
      this.settings.volume = Math.max(0, Math.min(1, Number(this.volumeInput.value) || 0));
      this.audio.setMasterVolume(this.settings.volume);
      saveSettings(this.settings);
    });
  }

  private onKeyDown(event: KeyboardEvent): void {
    const active = this.active;
    if (!active) return;
    if (event.code === "Escape") {
      if (active.ending) return;
      event.preventDefault();
      if (this.paused) this.resume();
      else this.pause();
      return;
    }
    if (event.code === "KeyR" && !this.paused && !active.ending) {
      active.player.startReload();
      this.audio.reload();
    }
    if (["Space", "Tab", "KeyE", "ShiftLeft", "ControlLeft"].includes(event.code)) event.preventDefault();
    this.keys.add(event.code);
  }

  private onMouseMove(event: MouseEvent): void {
    if (!this.active || this.paused || this.active.ending) return;
    if (document.pointerLockElement !== this.canvas) return;
    this.active.player.addLook(event.movementX, event.movementY, this.settings.sensitivity);
  }

  private loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    const raw = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    const dt = Math.max(0, Math.min(0.05, raw));
    const wallDt = Math.max(0, Math.min(1, raw));
    if (raw > 0) this.fps = this.fps * 0.92 + (1 / raw) * 0.08;

    const active = this.active;
    if (!active) return;

    if (active.ending) {
      this.updateEnding(active, now);
      active.world.update(dt, active.camera.position);
      active.effects.update(dt);
    } else if (!this.paused) {
      this.updatePlaying(active, dt, wallDt);
    } else {
      active.world.update(dt * 0.15, active.camera.position);
      active.effects.update(dt * 0.15);
    }

    this.renderer.render(active.scene, active.camera);
  };

  private startMission(config: MissionConfig): void {
    this.teardown();
    this.lastClip = null;
    this.lastStats = null;
    this.lastRewards = null;
    this.paused = false;
    this.firing = false;
    this.ads = false;
    this.keys.clear();
    this.hideResults();
    conceal(this.pauseOverlay);
    this.planning.hide();
    this.hud.setVisible(false);
    this.showLoading(true);
    this.fade.classList.add("is-active");
    this.requestPointerLock();

    const token = ++this.loadToken;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(78, this.aspect(), 0.05, 300);
    camera.rotation.order = "YXZ";
    scene.add(camera);

    const world = createWorld(scene);
    const effects = new Effects(scene);
    const player = new Player(camera, config.role);
    const spawn = new THREE.Vector3(config.insertion.x, 0, config.insertion.z);
    player.reset(spawn, config.insertion.angle, 0);

    const right = new THREE.Vector3(Math.cos(config.insertion.angle), 0, -Math.sin(config.insertion.angle));
    const forward = new THREE.Vector3(-Math.sin(config.insertion.angle), 0, -Math.cos(config.insertion.angle));
    const formation: Array<[number, number]> = [
      [-2.7, -1.8],
      [2.7, -1.8],
      [0.2, -3.2],
    ];
    const allies = ALLY_CALLSIGNS.map((name, index) => {
      const [side, ahead] = formation[index % formation.length];
      const position = spawn
        .clone()
        .addScaledVector(right, side)
        .addScaledVector(forward, ahead);
      const ally = new Ally({ name, index, position });
      scene.add(ally.rig.group);
      return ally;
    });

    const enemies = this.spawnEnemies(scene, world, 0);

    const mission = new MissionState();
    const terminalBeacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 4.2, 6),
      new THREE.MeshBasicMaterial({
        color: 0x33f6ff,
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    terminalBeacon.position.copy(world.terminalPosition);
    terminalBeacon.position.y = 2.1;
    scene.add(terminalBeacon);
    const extractionBeacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.16, 13, 8),
      new THREE.MeshBasicMaterial({
        color: 0x51ff9d,
        transparent: true,
        opacity: 0.12,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    extractionBeacon.position.copy(world.extractionPosition);
    extractionBeacon.position.y = 6.5;
    scene.add(extractionBeacon);

    const active: ActiveMission = {
      config,
      scene,
      camera,
      world,
      effects,
      player,
      allies,
      enemies,
      mission,
      stats: emptyStats(),
      startedAt: performance.now(),
      beaconTime: 0,
      interaction: null,
      reviveProgress: 0,
      reviveTarget: null,
      ending: false,
      endingAt: 0,
      endSuccess: false,
      resultsShown: false,
      rewards: null,
      clipPromise: null,
      terminalBeacon,
      extractionBeacon,
      context: null as unknown as AiContext,
    };
    active.context = this.createContext(active);
    this.active = active;

    this.hud.setLoadout(`${config.role.name} // ${config.role.codename}`, config.role.weapon);
    this.hud.setVisible(true);
    this.hud.resetFeed();
    this.hud.feed("COMMAND", "OPERATION BLACKOUT CORE", "neutral", "committed to");
    this.hud.subtitle("COMMAND", "Boots on wet concrete. Slice the vault core, then reach the exfil pad.");
    this.hud.showAlert("MISSION LIVE — STAY LOW", 2600);

    void this.audio.start().then(() => this.audio.setMasterVolume(this.settings.volume)).catch(() => undefined);
    this.downloadButton.disabled = true;
    this.clipStatus.textContent = config.record
      ? "Encoding mission clip locally. No upload."
      : "Clip recording was disabled for this run.";
    if (config.record && ClipRecorder.supported) {
      this.recorder.start(this.canvas, this.audio.captureStream, 30);
    }

    this.renderer.render(scene, camera);
    window.setTimeout(() => {
      if (this.loadToken !== token || this.active !== active) return;
      this.showLoading(false);
      this.fade.classList.remove("is-active");
    }, 360);
  }

  private spawnEnemies(scene: THREE.Scene, world: World, offset: number): Enemy[] {
    const positions = [
      ...world.enemySpawns,
      new THREE.Vector3(20, 0, 8),
      new THREE.Vector3(42, 0, 33),
    ];
    const enemies: Enemy[] = [];
    for (let i = 0; i < positions.length; i += 1) {
      const enemy = new Enemy({
        position: positions[i],
        index: offset + i,
        elite: (offset + i) % 4 === 2,
      });
      scene.add(enemy.rig.group);
      enemies.push(enemy);
    }
    return enemies;
  }

  private spawnReinforcements(active: ActiveMission): void {
    const positions = [
      new THREE.Vector3(30, 0, -4),
      new THREE.Vector3(38, 0, 6),
      new THREE.Vector3(52, 0, 32),
      new THREE.Vector3(8, 0, 32),
    ];
    for (let i = 0; i < positions.length; i += 1) {
      const enemy = new Enemy({
        position: positions[i],
        index: active.enemies.length + i,
        elite: i % 2 === 0,
      });
      active.scene.add(enemy.rig.group);
      active.enemies.push(enemy);
      enemy.alertTo(active.player.position);
    }
    for (const enemy of active.enemies) {
      if (enemy.alive) enemy.alertTo(active.player.position);
    }
  }

  private createContext(active: ActiveMission): AiContext {
    return {
      world: active.world,
      effects: active.effects,
      audio: this.audio,
      cameraPosition: active.player.eyePosition,
      cameraYaw: active.player.yaw,
      playerPosition: active.player.position,
      playerAlive: active.player.alive,
      enemies: active.enemies,
      allies: active.allies,
      enemyFire: (enemy, targetPosition, targetAlly) =>
        this.resolveEnemyFire(active, enemy, targetPosition, targetAlly),
      allyFire: (ally, target) => this.resolveAllyFire(active, ally, target),
      onAllyDowned: (ally) => {
        if (ally.state === "dead") {
          this.hud.feed(ally.name, "KIA", "warn", "declared");
          this.hud.subtitle("COMMAND", `${ally.name} is gone. The squad is smaller now.`);
        } else {
          this.hud.feed(ally.name, "DOWN", "warn", "is");
          this.hud.subtitle("COMMAND", `${ally.name} is down. Reach them and hold E — they have 30 seconds.`);
        }
        this.audio.alarm();
      },
    };
  }

  private updatePlaying(active: ActiveMission, dt: number, wallDt: number): void {
    const input: PlayerInput = {
      forward: (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0),
      right: (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0),
      sprint: this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"),
      crouch: this.keys.has("KeyC") || this.keys.has("ControlLeft"),
      jump: this.keys.has("Space"),
      ads: this.ads,
    };
    active.player.update(dt, input, active.world.boxes);

    if (this.firing && active.player.canFire()) this.firePlayerWeapon(active);
    if (this.firing && active.player.ammo === 0 && !active.player.reloading && active.player.reserve > 0) {
      active.player.startReload();
      this.audio.reload();
    }

    const context = active.context;
    context.cameraPosition = active.player.eyePosition;
    context.cameraYaw = active.player.yaw;
    context.playerAlive = active.player.alive;

    for (const enemy of active.enemies) enemy.update(dt, context);
    for (const ally of active.allies) ally.update(dt, context);
    for (const enemy of active.enemies) {
      enemy.rig.setTagDistance(active.player.eyePosition.distanceTo(enemy.position));
    }
    for (const ally of active.allies) {
      ally.rig.setTagDistance(active.player.eyePosition.distanceTo(ally.position));
    }

    this.updateObjective(active, dt, wallDt);
    this.updateBeacons(active, dt);
    active.world.update(dt, active.player.position);
    active.effects.update(dt);
    this.pushHud(active);
  }

  private updateObjective(active: ActiveMission, dt: number, wallDt: number): void {
    const player = active.player;
    const mission = active.mission;
    const atTerminal = horizontalDistance(player.position, active.world.terminalPosition) <= 3.1;
    const atExtraction =
      horizontalDistance(player.position, active.world.extractionPosition) <= active.world.extractionRadius - 0.25;
    const holding = this.keys.has("KeyE");

    let interaction: { label: string; progress: number } | null = null;
    let missionHolding = holding;

    const downed = active.allies.find(
      (ally) => ally.state === "downed" && horizontalDistance(player.position, ally.position) < 2.5,
    );
    if (downed) {
      if (active.reviveTarget !== downed) {
        active.reviveTarget = downed;
        active.reviveProgress = 0;
      }
      if (holding) {
        active.reviveProgress = Math.min(1, active.reviveProgress + dt / 2.8);
        missionHolding = false;
        if (active.reviveProgress >= 1) {
          downed.revive(active.context);
          active.stats.revives += 1;
          active.reviveProgress = 0;
          active.reviveTarget = null;
          this.hud.feed("YOU", downed.name, "good", "revived");
          this.hud.subtitle("COMMAND", `${downed.name} is back up. Keep moving.`);
          this.audio.radio();
        }
      }
      interaction = {
        label: `HOLD E — REVIVE ${downed.name}${holding ? "" : " (30s BLEED-OUT)"}`,
        progress: active.reviveProgress,
      };
      missionHolding = false;
    } else {
      active.reviveTarget = null;
      active.reviveProgress = 0;
      if (!mission.hacked && atTerminal) {
        interaction = { label: "HOLD E — SLICE DATA CORE", progress: mission.hackProgress };
      } else if (mission.hacked && atExtraction) {
        interaction = { label: "HOLD E — SECURE EXFIL", progress: mission.extractProgress };
      } else if (!mission.hacked && atExtraction) {
        interaction = { label: "DATA CORE REQUIRED — RETURN TO THE VAULT", progress: 0 };
      } else if (mission.hacked && atTerminal) {
        interaction = { label: "CORE SLICED — MOVE TO EXTRACTION", progress: 0 };
      }
    }
    active.interaction = interaction;

    const events = mission.update({
      dt: wallDt,
      playerAlive: player.alive,
      atTerminal,
      atExtraction,
      holding: missionHolding,
    });
    for (const event of events) this.handleMissionEvent(active, event);
  }

  private handleMissionEvent(active: ActiveMission, event: MissionEvent): void {
    if (event.type === "hacked") {
      active.stats.objectiveComplete = true;
      this.spawnReinforcements(active);
      this.hud.showAlert("CORE SLICED // EXFIL NOW", 3400);
      this.hud.feed("YOU", "DATA CORE", "good", "sliced");
      this.hud.subtitle("ECHO", "They felt that. Every patrol is converging on the pad.");
      this.audio.alarm();
      this.audio.radio();
      return;
    }
    if (event.type === "extracted") {
      this.endMission(active, true);
      return;
    }
    this.endMission(active, false);
  }

  private firePlayerWeapon(active: ActiveMission): void {
    const player = active.player;
    player.consumeShot();
    active.stats.shotsFired += 1;
    this.audio.shot(0, 0, false);
    active.effects.muzzle(player.muzzleWorldPosition, 0xffd9a0);

    const origin = player.eyePosition.clone();
    const direction = coneDirection(player.getAimDirection(), player.spread);
    const wall = worldHit(origin, direction, active.world.raycastMeshes, 150);
    const wallDistance = wall?.distance ?? 150;

    let bestDistance = wallDistance;
    let bestEnemy: Enemy | null = null;
    let headshot = false;
    for (const enemy of active.enemies) {
      if (!enemy.alive) continue;
      const bodyCenter = new THREE.Vector3(enemy.position.x, enemy.position.y + 1.02, enemy.position.z);
      const headCenter = new THREE.Vector3(enemy.position.x, enemy.position.y + 1.62, enemy.position.z);
      const bodyHit = raySphere(origin, direction, bodyCenter, 0.44);
      const headHit = raySphere(origin, direction, headCenter, 0.21);
      const candidate = headHit !== null && (bodyHit === null || headHit <= bodyHit) ? headHit : bodyHit;
      const candidateHead = headHit !== null && (bodyHit === null || headHit <= bodyHit);
      if (candidate !== null && candidate < bestDistance) {
        bestDistance = candidate;
        bestEnemy = enemy;
        headshot = candidateHead;
      }
    }

    let endpoint: THREE.Vector3;
    if (bestEnemy) {
      endpoint = origin.clone().addScaledVector(direction, bestDistance);
      const killed = bestEnemy.applyDamage(player.role.damage, headshot, active.context);
      active.stats.shotsHit += 1;
      active.stats.damageDealt += player.role.damage * (headshot ? 2.6 : 1);
      if (headshot) active.stats.headshots += 1;
      this.hud.showHitmarker(headshot);
      active.effects.spark(endpoint, headshot ? 0x9ffcff : 0xff8a9e, headshot ? 8 : 4);
      this.audio.hit(headshot);
      if (killed) {
        active.stats.kills += 1;
        this.hud.feed("YOU", bestEnemy.name, "good");
        this.hud.subtitle("COMMAND", `Hostile ${bestEnemy.name} down.`);
      }
    } else if (wall) {
      endpoint = wall.point;
      active.effects.spark(endpoint, 0xffc46b, 4);
      this.audio.impact(0, wall.distance);
    } else {
      endpoint = origin.clone().addScaledVector(direction, 150);
    }

    active.effects.tracer(player.muzzleWorldPosition, endpoint, 0xffd9a0, 0.08);
  }

  private resolveEnemyFire(
    active: ActiveMission,
    enemy: Enemy,
    targetPosition: THREE.Vector3,
    targetAlly: Ally | null,
  ): void {
    const origin = enemy.muzzlePosition.clone();
    const aim = new THREE.Vector3(
      targetPosition.x,
      targetPosition.y + (targetAlly ? 1.02 : 1.08),
      targetPosition.z,
    );
    const direction = coneDirection(aim.sub(origin).normalize(), enemy.elite ? 1.5 : 2.8);
    const wall = worldHit(origin, direction, active.world.raycastMeshes, 90);
    const limit = wall?.distance ?? 90;

    let bestDistance = limit;
    let victim: { kind: "player" } | { kind: "ally"; ally: Ally } | null = null;
    if (active.player.alive) {
      const hit = raySphere(origin, direction, active.player.position.clone().setY(active.player.position.y + 1.1), 0.5);
      if (hit !== null && hit < bestDistance) {
        bestDistance = hit;
        victim = { kind: "player" };
      }
    }
    for (const ally of active.allies) {
      if (ally.state !== "alive") continue;
      const hit = raySphere(origin, direction, ally.position.clone().setY(ally.position.y + 1.02), 0.44);
      if (hit !== null && hit < bestDistance) {
        bestDistance = hit;
        victim = { kind: "ally", ally };
      }
    }

    active.effects.muzzle(origin, 0xffb07a);
    const endpoint = victim
      ? origin.clone().addScaledVector(direction, bestDistance)
      : wall
        ? wall.point
        : origin.clone().addScaledVector(direction, 90);
    active.effects.tracer(origin, endpoint, 0xffb07a, 0.09);
    this.audio.enemyShot(this.panFor(origin), origin.distanceTo(active.camera.position));

    if (victim?.kind === "player") {
      const result = active.player.applyIncomingDamage(enemy.elite ? 23 : 18, bestDistance);
      active.stats.damageTaken += result.healthLost;
      this.hud.flashDamage();
      active.effects.spark(endpoint, 0xff6b81, 6);
      if (result.dead) {
        this.hud.subtitle("COMMAND", "Operator down. Signal lost.");
      }
    } else if (victim?.kind === "ally") {
      victim.ally.applyDamage(enemy.elite ? 20 : 15, active.context);
      active.effects.spark(endpoint, 0x7fe9ff, 5);
    } else if (wall) {
      active.effects.spark(wall.point, 0xffc46b, 3);
    }
  }

  private resolveAllyFire(active: ActiveMission, ally: Ally, target: Enemy): void {
    const origin = ally.muzzlePosition.clone();
    const aim = new THREE.Vector3(target.position.x, target.position.y + 1.05, target.position.z);
    const direction = coneDirection(aim.sub(origin).normalize(), 1.9);
    const wall = worldHit(origin, direction, active.world.raycastMeshes, 70);
    const wallDistance = wall?.distance ?? 70;
    const bodyCenter = new THREE.Vector3(target.position.x, target.position.y + 1.02, target.position.z);
    const headCenter = new THREE.Vector3(target.position.x, target.position.y + 1.62, target.position.z);
    const bodyHit = raySphere(origin, direction, bodyCenter, 0.44);
    const headHit = raySphere(origin, direction, headCenter, 0.21);
    const headshot = headHit !== null && (bodyHit === null || headHit <= bodyHit);
    const hit = headshot ? headHit : bodyHit;

    this.audio.shot(this.panFor(origin), origin.distanceTo(active.camera.position), false);
    ally.rig.flashMuzzle();
    active.effects.muzzle(origin, 0x9ffcff);

    if (hit !== null && hit < wallDistance) {
      const endpoint = origin.clone().addScaledVector(direction, hit);
      active.effects.spark(endpoint, 0x9ffcff, 4);
      const killed = target.applyDamage(16, headshot, active.context);
      if (killed) this.hud.feed(ally.name, target.name, "good");
      active.effects.tracer(origin, endpoint, 0x9ffcff, 0.07);
    } else {
      const endpoint = wall ? wall.point : origin.clone().addScaledVector(direction, 70);
      if (wall) active.effects.spark(wall.point, 0xffc46b, 2);
      active.effects.tracer(origin, endpoint, 0x9ffcff, 0.07);
    }
  }

  private updateBeacons(active: ActiveMission, dt: number): void {
    active.beaconTime += dt;
    const pulse = 0.55 + Math.sin(active.beaconTime * 2.6) * 0.2;
    const terminalMaterial = active.terminalBeacon.material as THREE.MeshBasicMaterial;
    const extractionMaterial = active.extractionBeacon.material as THREE.MeshBasicMaterial;
    terminalMaterial.opacity = active.mission.hacked ? 0.06 : 0.25 + pulse * 0.18;
    extractionMaterial.opacity = active.mission.hacked ? 0.3 + pulse * 0.2 : 0.1;
    active.terminalBeacon.rotation.y += dt * 0.6;
    active.extractionBeacon.rotation.y += dt * 0.3;
  }

  private pushHud(active: ActiveMission): void {
    const mission = active.mission;
    const target = mission.hacked ? active.world.extractionPosition : active.world.terminalPosition;
    const contacts = active.enemies
      .filter((enemy) => enemy.alive && enemy.state !== "patrol")
      .slice(0, 14)
      .map((enemy) => enemy.position);
    this.hud.update({
      camera: active.camera,
      position: active.player.position,
      yaw: active.player.yaw,
      health: active.player.health,
      armor: active.player.armor,
      maxArmor: active.config.role.armor,
      stamina: active.player.stamina,
      maxStamina: active.config.role.stamina,
      ammo: active.player.ammo,
      reserve: active.player.reserve,
      reloading: active.player.reloading,
      reloadFraction: active.player.reloadFraction,
      crouched: active.player.crouchedNow,
      missionTitle: mission.objectiveTitle,
      missionDetail: mission.objectiveDetail,
      elapsed: mission.elapsed,
      objectiveProgress: mission.hacked ? mission.extractProgress : mission.hackProgress,
      waypoint: target,
      waypointLabel: mission.hacked ? "EXTRACTION" : "DATA CORE",
      extraction: active.world.extractionPosition,
      terminal: active.world.terminalPosition,
      hacked: mission.hacked,
      squad: active.allies.map((ally) => ({
        name: ally.name,
        health: ally.state === "dead" ? 0 : ally.health,
        state: ally.state,
        position: ally.position,
      })),
      interaction: active.interaction,
      contacts,
      fps: this.fps,
      recording: this.recorder.active,
      boxes: active.world.boxes,
    });
  }

  private endMission(active: ActiveMission, success: boolean): void {
    if (active.ending) return;
    active.ending = true;
    active.endingAt = performance.now();
    active.endSuccess = success;
    this.firing = false;
    this.ads = false;
    this.keys.clear();
    active.player.setViewmodelVisible(false);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();

    active.stats.success = success;
    active.stats.timeSec = active.mission.elapsed;
    active.stats.objectiveComplete = active.mission.hacked;
    active.stats.extracted = success && active.mission.hacked;
    active.stats.alliesLost = active.allies.filter((ally) => ally.state === "dead").length;

    const result = applyMissionResult(this.meta, active.stats);
    this.meta = result.meta;
    active.rewards = result.rewards;
    this.lastStats = active.stats;
    this.lastRewards = result.rewards;
    this.planning.refresh(this.meta);

    active.clipPromise = this.recorder.active ? this.recorder.stop() : Promise.resolve(null);
    this.downloadButton.disabled = true;

    this.hud.setVisible(false);
    this.hud.showAlert(success ? "EXFIL SECURED" : "SIGNAL LOST", 2200);
    if (success) {
      this.audio.success();
      this.hud.subtitle("COMMAND", "Extraction confirmed. The core is ours.");
    } else {
      this.audio.fail();
      this.hud.subtitle("COMMAND", "Operator down. Extraction denied.");
    }
  }

  private updateEnding(active: ActiveMission, now: number): void {
    const time = (now - active.endingAt) / 1000;
    active.beaconTime += 1 / 60;
    active.world.update(1 / 60, active.camera.position);
    active.effects.update(1 / 60);
    this.updateBeacons(active, 1 / 60);

    if (active.endSuccess) {
      const center = active.world.extractionPosition;
      const angle = time * 0.28;
      active.camera.position.set(center.x + Math.cos(angle) * 13, 7.4, center.z + Math.sin(angle) * 13);
      active.camera.lookAt(center.x, 1.4, center.z);
    } else {
      const point = active.player.position;
      const angle = time * 0.4;
      active.camera.position.set(point.x + Math.cos(angle) * 4.2, 2.1, point.z + Math.sin(angle) * 4.2);
      active.camera.lookAt(point.x, 1.0, point.z);
    }
    active.camera.fov = Math.max(60, active.camera.fov - 0.3);
    active.camera.updateProjectionMatrix();

    if (!active.resultsShown && now - active.endingAt > 1650) {
      active.resultsShown = true;
      this.showResults(active);
    }
  }

  private showResults(active: ActiveMission): void {
    const stats = active.stats;
    const rewards = active.rewards;
    const accuracy = accuracyPercent(stats.shotsHit, stats.shotsFired);
    this.resultsModal.classList.toggle("is-failed", !stats.success);
    this.resultKicker.textContent = stats.success ? "OPERATION COMPLETE // CORE SECURED" : "OPERATION FAILED // SIGNAL LOST";
    this.resultTitle.textContent = stats.success ? "EXTRACTED" : "KIA";
    this.resultSub.textContent = stats.success
      ? "The data core is secure. District 07 will remember this run."
      : "The district keeps what it kills. Redeploy and take the core back.";

    const rows: Array<[string, string]> = [
      ["TIME", formatClock(stats.timeSec)],
      ["KILLS", String(stats.kills)],
      ["ACCURACY", `${accuracy}%`],
      ["HEADSHOTS", String(stats.headshots)],
      ["REVIVES", String(stats.revives)],
      ["DAMAGE", String(Math.round(stats.damageDealt))],
      ["SQUAD LOST", String(stats.alliesLost)],
      ["SHOTS", String(stats.shotsFired)],
    ];
    this.resultsStats.replaceChildren();
    for (const [label, value] of rows) {
      const item = document.createElement("div");
      item.className = "aw-stat";
      const name = document.createElement("span");
      name.textContent = label;
      const strong = document.createElement("strong");
      strong.textContent = value;
      item.append(name, strong);
      this.resultsStats.append(item);
    }

    if (rewards) {
      this.rewardXp.textContent = `+${rewards.xp}`;
      this.rewardCredits.textContent = `+${rewards.credits}`;
      this.rewardRank.textContent = rewards.rankName;
      this.contractComplete.classList.toggle("is-hidden", !rewards.contractComplete);
      if (rewards.contractComplete) {
        this.contractComplete.textContent = `DAILY CONTRACT COMPLETE // ${rewards.contractLabel.toUpperCase()}`;
      }
    }

    this.downloadButton.disabled = true;
    if (!active.config.record) {
      this.clipStatus.textContent = "Clip recording was disabled before deployment.";
    } else if (!ClipRecorder.supported) {
      this.clipStatus.textContent = "This browser does not support local canvas clip recording.";
    } else if (active.clipPromise) {
      this.clipStatus.textContent = "Encoding mission clip locally…";
      void active.clipPromise.then((blob) => {
        if (this.active !== active) return;
        this.lastClip = blob;
        this.downloadButton.disabled = !blob;
        this.clipStatus.textContent = blob
          ? `Clip ready · ${(blob.size / 1_000_000).toFixed(1)} MB · generated locally, never uploaded.`
          : "Clip capture produced no data (the browser may restrict canvas recording).";
      });
    }

    show(this.resultsOverlay);
    this.resultsOverlay.scrollTop = 0;
  }

  private async copyShareText(): Promise<void> {
    const stats = this.lastStats;
    if (!stats) return;
    const accuracy = accuracyPercent(stats.shotsHit, stats.shotsFired);
    const rank = this.lastRewards?.rankName ?? "RECRUIT";
    const text = [
      `AFTERMATH // ${stats.success ? "EXTRACTED" : "KIA"}`,
      `${formatClock(stats.timeSec)} · ${stats.kills} kills · ${stats.headshots} headshots · ${accuracy}% accuracy`,
      `${this.meta.callsign} [${rank}] · District 07`,
      "Play the Neon Rift tactical prototype.",
    ].join("\n");
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }
      area.remove();
    }
    this.clipStatus.textContent = copied ? "Share text copied to clipboard." : "Clipboard unavailable in this browser.";
  }

  private pause(): void {
    if (!this.active || this.paused || this.active.ending) return;
    this.paused = true;
    this.firing = false;
    this.ads = false;
    show(this.pauseOverlay);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private resume(): void {
    if (!this.active || this.active.ending) return;
    this.paused = false;
    conceal(this.pauseOverlay);
    this.lastFrame = performance.now();
    this.requestPointerLock();
  }

  private abortToPlanning(): void {
    this.teardown();
    this.hud.setVisible(false);
    this.hideResults();
    conceal(this.pauseOverlay);
    this.paused = false;
    this.planning.setBusy(false);
    this.planning.show();
    this.planning.refresh(this.meta);
    this.renderer.clear(true, false, false);
  }

  private teardown(): void {
    this.loadToken += 1;
    const active = this.active;
    if (!active) return;
    if (this.recorder.active) void this.recorder.stop();
    active.world.dispose();
    active.effects.dispose();
    active.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = (mesh as THREE.Mesh).material;
      if (Array.isArray(material)) {
        for (const entry of material) entry.dispose();
      } else if (material) {
        material.dispose();
      }
    });
    active.scene.clear();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.active = null;
    this.paused = false;
  }

  private hideResults(): void {
    conceal(this.resultsOverlay);
  }

  private showLoading(visible: boolean): void {
    if (visible) {
      show(this.loading);
    } else {
      conceal(this.loading);
    }
  }

  private requestPointerLock(): void {
    if (document.pointerLockElement === this.canvas) return;
    try {
      const result = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (result && typeof result.catch === "function") result.catch(() => undefined);
    } catch {
      // Pointer lock is optional; movement still works without it.
    }
  }

  private resize(): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    const active = this.active;
    if (!active) return;
    active.camera.aspect = this.aspect();
    active.camera.updateProjectionMatrix();
  }

  private aspect(): number {
    return Math.max(0.2, window.innerWidth / Math.max(1, window.innerHeight));
  }

  private panFor(position: THREE.Vector3): number {
    const active = this.active;
    if (!active) return 0;
    const dx = position.x - active.player.eyePosition.x;
    const dz = position.z - active.player.eyePosition.z;
    const length = Math.hypot(dx, dz) || 1;
    const rightX = Math.cos(active.player.yaw);
    const rightZ = -Math.sin(active.player.yaw);
    return Math.max(-1, Math.min(1, (dx * rightX + dz * rightZ) / length));
  }

  private installDebugApi(): void {
    const api = {
      getState: (): AftermathDebugState => {
        const active = this.active;
        if (!active) {
          return {
            phase: "planning",
            health: 0,
            armor: 0,
            stamina: 0,
            ammo: 0,
            reserve: 0,
            objective: "planning",
            timerSec: 0,
            enemiesAlive: 0,
            alliesAlive: 0,
            kills: 0,
            shotsFired: 0,
            shotsHit: 0,
            position: { x: 0, y: 0, z: 0 },
            role: null,
            insertion: null,
            paused: false,
            pointerLocked: document.pointerLockElement === this.canvas,
            drawCalls: this.renderer.info.render.calls,
            fps: Math.round(this.fps),
          };
        }
        return {
          phase: active.ending ? (active.endSuccess ? "complete" : "failed") : active.mission.phase,
          health: active.player.health,
          armor: active.player.armor,
          stamina: active.player.stamina,
          ammo: active.player.ammo,
          reserve: active.player.reserve,
          objective: active.mission.objectiveTitle,
          timerSec: active.mission.elapsed,
          enemiesAlive: active.enemies.filter((enemy) => enemy.alive).length,
          alliesAlive: active.allies.filter((ally) => ally.state === "alive").length,
          kills: active.stats.kills,
          shotsFired: active.stats.shotsFired,
          shotsHit: active.stats.shotsHit,
          position: {
            x: active.player.position.x,
            y: active.player.position.y,
            z: active.player.position.z,
          },
          role: active.config.role.id,
          insertion: active.config.insertion.id,
          paused: this.paused,
          pointerLocked: document.pointerLockElement === this.canvas,
          drawCalls: this.renderer.info.render.calls,
          fps: Math.round(this.fps),
        };
      },
      deploy: (roleId?: string, insertionId?: string, record = false): void => {
        const role: RoleSpec = roleById(roleId ?? "assault");
        const insertion: InsertionSpec =
          INSERTIONS.find((entry) => entry.id === (insertionId ?? "north")) ?? INSERTIONS[0];
        this.startMission({ role, insertion, record });
      },
      teleportTerminal: (): void => {
        const active = this.active;
        if (!active) return;
        active.player.position.set(-33, 0, -31.6);
        active.player.velocity.set(0, 0, 0);
        active.player.yaw = 0;
        active.player.pitch = -0.05;
      },
      teleportExtraction: (): void => {
        const active = this.active;
        if (!active) return;
        const pad = active.world.extractionPosition;
        active.player.position.set(pad.x, 0, pad.z + 4);
        active.player.velocity.set(0, 0, 0);
        active.player.yaw = 0;
        active.player.pitch = -0.05;
      },
      forceHack: (): void => {
        const active = this.active;
        if (!active || active.mission.hacked) return;
        active.mission.hacked = true;
        active.mission.hackProgress = 1;
        active.mission.extractProgress = 0;
        active.mission.objective = "extract";
        this.handleMissionEvent(active, { type: "hacked" });
        this.pushHud(active);
      },
      forceExtract: (): void => {
        const active = this.active;
        if (!active) return;
        if (!active.mission.hacked) {
          active.mission.hacked = true;
          active.mission.objective = "extract";
          active.mission.hackProgress = 1;
          active.stats.objectiveComplete = true;
        }
        active.mission.extractProgress = 1;
        this.endMission(active, true);
      },
      /**
       * Skips the 1.65s cinematic hold so automated tests never race the
       * results panel on slow software renderers. No effect mid-mission.
       */
      revealResults: (): void => {
        const active = this.active;
        if (!active || !active.ending || active.resultsShown) return;
        active.resultsShown = true;
        this.showResults(active);
      },
      damagePlayer: (amount: number): void => {
        const active = this.active;
        if (!active) return;
        active.player.applyIncomingDamage(Math.max(0, amount), 0);
        this.hud.flashDamage();
      },
      killPlayer: (): void => {
        const active = this.active;
        if (!active) return;
        active.player.health = 0;
        active.player.alive = false;
        this.endMission(active, false);
      },
      setPaused: (paused: boolean): void => {
        if (paused) this.pause();
        else this.resume();
      },
      getMeta: (): MetaState => ({ ...this.meta }),
    };
    (window as unknown as { __aftermath?: typeof api }).__aftermath = api;
  }
}

function showFatal(message: string): void {
  const error = document.getElementById("aw-error");
  const text = document.getElementById("aw-error-text");
  if (text) text.textContent = message;
  if (error) error.classList.remove("is-hidden");
}

function boot(): void {
  try {
    const app = new AftermathApp();
    void app;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showFatal(`AFTERMATH could not start: ${message}. Try a current desktop browser with WebGL enabled.`);
  }
}

void boot();
