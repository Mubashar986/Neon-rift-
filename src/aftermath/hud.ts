import type * as THREE from "three";
import type { Box2 } from "./world";

export interface HudSquadEntry {
  name: string;
  health: number;
  state: "alive" | "downed" | "dead";
  position: THREE.Vector3;
}

export interface HudFrame {
  camera: THREE.PerspectiveCamera;
  position: THREE.Vector3;
  yaw: number;
  health: number;
  armor: number;
  maxArmor: number;
  stamina: number;
  maxStamina: number;
  ammo: number;
  reserve: number;
  reloading: boolean;
  reloadFraction: number;
  crouched: boolean;
  missionTitle: string;
  missionDetail: string;
  elapsed: number;
  objectiveProgress: number;
  waypoint: THREE.Vector3 | null;
  waypointLabel: string;
  extraction: THREE.Vector3;
  terminal: THREE.Vector3;
  hacked: boolean;
  squad: HudSquadEntry[];
  interaction: { label: string; progress: number } | null;
  contacts: THREE.Vector3[];
  fps: number;
  recording: boolean;
  boxes: Box2[];
}

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function formatTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function angleDelta(target: number, current: number): number {
  let delta = (target - current) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function bearingTo(from: THREE.Vector3, to: THREE.Vector3): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const radians = Math.atan2(dx, -dz);
  return ((radians * 180) / Math.PI + 360) % 360;
}

export class HUD {
  private readonly root = mustGet<HTMLDivElement>("aw-hud");
  private readonly compass = mustGet<HTMLCanvasElement>("aw-compass");
  private readonly minimap = mustGet<HTMLCanvasElement>("aw-minimap");
  private readonly healthValue = mustGet("aw-health-value");
  private readonly healthFill = mustGet<HTMLElement>("aw-health-fill");
  private readonly armorValue = mustGet("aw-armor-value");
  private readonly armorFill = mustGet<HTMLElement>("aw-armor-fill");
  private readonly staminaFill = mustGet<HTMLElement>("aw-stamina-fill");
  private readonly ammoValue = mustGet("aw-ammo-value");
  private readonly reserveValue = mustGet("aw-reserve-value");
  private readonly reloadBar = mustGet("aw-reload-bar");
  private readonly reloadFill = mustGet<HTMLElement>("aw-reload-fill");
  private readonly timer = mustGet("aw-timer");
  private readonly objectiveTitle = mustGet("aw-objective-title");
  private readonly objectiveDetail = mustGet("aw-objective-detail");
  private readonly objectiveProgress = mustGet("aw-objective-progress");
  private readonly objectiveProgressFill = this.objectiveProgress.querySelector("i") as HTMLElement | null;
  private readonly squadList = mustGet<HTMLUListElement>("aw-squad-list");
  private readonly squadCount = mustGet("aw-squad-count");
  private readonly killfeed = mustGet<HTMLUListElement>("aw-killfeed");
  private readonly interaction = mustGet("aw-interaction");
  private readonly interactionLabel = mustGet("aw-interaction-label");
  private readonly interactionFill = mustGet<HTMLElement>("aw-interaction-fill");
  private readonly waypoint = mustGet("aw-waypoint");
  private readonly waypointLabel = mustGet("aw-waypoint-label");
  private readonly waypointDistance = mustGet("aw-waypoint-distance");
  private readonly crosshair = mustGet("aw-crosshair");
  private readonly hitmarker = mustGet("aw-hitmarker");
  private readonly alert = mustGet("aw-alert");
  private readonly subtitles = mustGet("aw-subtitles");
  private readonly damage = mustGet("aw-damage");
  private readonly roleName = mustGet("aw-role-name");
  private readonly weaponName = mustGet("aw-weapon-name");
  private readonly fps = mustGet("aw-fps");
  private readonly record = mustGet("aw-record-indicator");
  private readonly stance = mustGet("aw-stance");
  private readonly recordLabel = this.record.querySelector("span");

  private readonly compassContext: CanvasRenderingContext2D;
  private readonly minimapContext: CanvasRenderingContext2D;
  private hitmarkerTimer = 0;
  private damageTimer = 0;
  private alertTimer = 0;
  private lastSlow = 0;
  private lastWaypoint = 0;
  private squadSignature = "";

  constructor() {
    const compassContext = this.compass.getContext("2d");
    const minimapContext = this.minimap.getContext("2d");
    if (!compassContext || !minimapContext) throw new Error("HUD canvases unavailable");
    this.compassContext = compassContext;
    this.minimapContext = minimapContext;
    if (!this.recordLabel) throw new Error("Record label missing");
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle("is-hidden", !visible);
  }

  setLoadout(roleName: string, weaponName: string): void {
    this.roleName.textContent = roleName;
    this.weaponName.textContent = weaponName;
  }

  update(frame: HudFrame): void {
    const now = performance.now();
    this.crosshair.classList.toggle("is-reloading", frame.reloading);
    this.stance.classList.toggle("is-hidden", !frame.crouched);
    if (this.recordLabel) {
      this.recordLabel.textContent = frame.recording ? "REC" : "NO CLIP";
      this.record.style.opacity = frame.recording ? "1" : "0.45";
    }

    if (now - this.lastWaypoint > 33) {
      this.lastWaypoint = now;
      this.renderWaypoint(frame);
    }

    if (now - this.lastSlow < 80) return;
    this.lastSlow = now;

    this.healthValue.textContent = String(Math.max(0, Math.ceil(frame.health)));
    this.healthFill.style.width = `${Math.max(0, Math.min(100, frame.health))}%`;
    this.armorValue.textContent = String(Math.max(0, Math.ceil(frame.armor)));
    this.armorFill.style.width = `${Math.max(0, Math.min(100, (frame.armor / Math.max(1, frame.maxArmor)) * 100))}%`;
    this.staminaFill.style.width = `${Math.max(0, Math.min(100, (frame.stamina / Math.max(1, frame.maxStamina)) * 100))}%`;
    this.ammoValue.textContent = String(frame.ammo);
    this.reserveValue.textContent = String(frame.reserve);
    this.reloadBar.classList.toggle("is-hidden", !frame.reloading);
    this.reloadFill.style.width = `${Math.max(0, Math.min(100, frame.reloadFraction * 100))}%`;
    this.timer.textContent = formatTime(frame.elapsed);
    this.objectiveTitle.textContent = frame.missionTitle;
    this.objectiveDetail.textContent = frame.missionDetail;
    const showProgress = frame.objectiveProgress > 0.001 && frame.objectiveProgress < 1;
    this.objectiveProgress.classList.toggle("is-hidden", !showProgress);
    if (this.objectiveProgressFill) {
      this.objectiveProgressFill.style.width = `${Math.max(0, Math.min(100, frame.objectiveProgress * 100))}%`;
    }
    this.fps.textContent = `${Math.round(frame.fps)} FPS`;

    this.updateSquad(frame.squad);
    if (frame.interaction) {
      this.interaction.classList.remove("is-hidden");
      this.interactionLabel.textContent = frame.interaction.label;
      this.interactionFill.style.width = `${Math.max(0, Math.min(100, frame.interaction.progress * 100))}%`;
    } else {
      this.interaction.classList.add("is-hidden");
    }

    this.renderCompass(frame);
    this.renderMinimap(frame);

    if (this.hitmarkerTimer > 0) {
      this.hitmarkerTimer -= 80;
      if (this.hitmarkerTimer <= 0) this.hitmarker.classList.remove("is-active", "is-headshot");
    }
    if (this.damageTimer > 0) {
      this.damageTimer -= 80;
      if (this.damageTimer <= 0) this.damage.style.opacity = "0";
    }
    if (this.alertTimer > 0) {
      this.alertTimer -= 80;
      if (this.alertTimer <= 0) this.alert.classList.remove("is-active");
    }
  }

  showHitmarker(headshot: boolean): void {
    this.hitmarker.classList.remove("is-active", "is-headshot");
    // Force a reflow so repeated hits restart the animation.
    void this.hitmarker.offsetWidth;
    this.hitmarker.classList.add("is-active");
    if (headshot) this.hitmarker.classList.add("is-headshot");
    this.hitmarkerTimer = 220;
  }

  flashDamage(): void {
    this.damage.style.opacity = "0.7";
    this.damageTimer = 260;
  }

  showAlert(text: string, durationMs = 2400): void {
    this.alert.textContent = text;
    this.alert.classList.add("is-active");
    this.alertTimer = durationMs;
  }

  feed(actor: string, victim: string, tone: "good" | "warn" | "neutral" = "neutral", verb = "eliminated"): void {
    const item = document.createElement("li");
    item.className = tone === "good" ? "is-good" : tone === "warn" ? "is-warn" : "";
    const name = document.createElement("b");
    name.textContent = actor;
    item.append(name, document.createTextNode(` ${verb} ${victim}`));
    this.killfeed.prepend(item);
    while (this.killfeed.children.length > 6) this.killfeed.lastElementChild?.remove();
    window.setTimeout(() => item.remove(), 7000);
  }

  subtitle(speaker: string, text: string, durationMs = 4200): void {
    const item = document.createElement("div");
    item.className = "aw-sub";
    const name = document.createElement("b");
    name.textContent = speaker;
    item.append(name, document.createTextNode(text));
    this.subtitles.append(item);
    while (this.subtitles.children.length > 3) this.subtitles.firstElementChild?.remove();
    window.setTimeout(() => item.remove(), durationMs);
  }

  resetFeed(): void {
    this.killfeed.replaceChildren();
    this.subtitles.replaceChildren();
  }

  private updateSquad(squad: HudSquadEntry[]): void {
    const signature = squad.map((entry) => `${entry.name}:${entry.state}:${Math.round(entry.health)}`).join("|");
    if (signature === this.squadSignature) return;
    this.squadSignature = signature;
    this.squadCount.textContent = String(squad.filter((entry) => entry.state !== "dead").length);
    this.squadList.replaceChildren();
    for (const entry of squad) {
      const item = document.createElement("li");
      item.className =
        entry.state === "downed" ? "aw-squad__unit is-down" : entry.state === "dead" ? "aw-squad__unit is-dead" : "aw-squad__unit";
      const dot = document.createElement("i");
      dot.className = "aw-squad__dot";
      const name = document.createElement("strong");
      name.textContent = entry.name;
      const status = document.createElement("span");
      status.className = "aw-squad__status";
      status.textContent = entry.state === "alive" ? "ALIVE" : entry.state === "downed" ? "DOWN" : "KIA";
      const bar = document.createElement("div");
      bar.className = "aw-squad__bar";
      const fill = document.createElement("i");
      fill.style.width = `${Math.max(0, Math.min(100, entry.health))}%`;
      bar.append(fill);
      item.append(dot, name, status, bar);
      this.squadList.append(item);
    }
  }

  private renderCompass(frame: HudFrame): void {
    const ctx = this.compassContext;
    const width = this.compass.width;
    const height = this.compass.height;
    const center = width / 2;
    const heading = ((-frame.yaw * 180) / Math.PI + 360) % 360;
    ctx.clearRect(0, 0, width, height);
    ctx.font = '700 17px "Rajdhani", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const pixelsPerDegree = 5.2;
    for (let offset = -70; offset <= 70; offset += 5) {
      const degrees = (heading + offset + 360) % 360;
      const x = center + offset * pixelsPerDegree;
      const major = degrees % 15 === 0;
      const cardinal = degrees % 90 === 0;
      ctx.strokeStyle = cardinal ? "rgba(150, 245, 255, 0.9)" : major ? "rgba(170, 215, 235, 0.5)" : "rgba(150, 190, 210, 0.24)";
      ctx.lineWidth = cardinal ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, height - 16);
      ctx.lineTo(x, height - (cardinal ? 2 : major ? 7 : 11));
      ctx.stroke();
      if (cardinal) {
        const labels: Record<number, string> = { 0: "N", 90: "E", 180: "S", 270: "W" };
        ctx.fillStyle = "rgba(220, 250, 255, 0.9)";
        ctx.fillText(labels[degrees], x, 14);
      }
    }

    const target = frame.hacked ? frame.extraction : frame.terminal;
    const bearing = bearingTo(frame.position, target);
    const delta = angleDelta(bearing, heading);
    if (Math.abs(delta) <= 70) {
      const x = center + delta * pixelsPerDegree;
      ctx.fillStyle = frame.hacked ? "#51ff9d" : "#33f6ff";
      ctx.beginPath();
      ctx.moveTo(x, height - 1);
      ctx.lineTo(x - 5, height - 10);
      ctx.lineTo(x + 5, height - 10);
      ctx.closePath();
      ctx.fill();
    }
  }

  private renderMinimap(frame: HudFrame): void {
    const ctx = this.minimapContext;
    const size = this.minimap.width;
    const center = size / 2;
    const scale = size / 150;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, size, size);
    ctx.clip();

    ctx.fillStyle = "rgba(3, 10, 17, 0.72)";
    ctx.fillRect(0, 0, size, size);

    ctx.strokeStyle = "rgba(90, 160, 190, 0.12)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= size; i += size / 8) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(size, i);
      ctx.stroke();
    }

    ctx.translate(center, center);
    const toScreen = (x: number, z: number): [number, number] => [
      (x - frame.position.x) * scale,
      (z - frame.position.z) * scale,
    ];

    ctx.fillStyle = "rgba(90, 150, 190, 0.14)";
    ctx.strokeStyle = "rgba(120, 200, 240, 0.28)";
    for (const box of frame.boxes) {
      const [x1, y1] = toScreen(box.minX, box.minZ);
      const [x2, y2] = toScreen(box.maxX, box.maxZ);
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }

    const marker = (position: THREE.Vector3, color: string, radius: number): void => {
      const [x, y] = toScreen(position.x, position.z);
      const clampedX = Math.max(-center + 12, Math.min(center - 12, x));
      const clampedY = Math.max(-center + 12, Math.min(center - 12, y));
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2;
      if (clampedX !== x || clampedY !== y) {
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.arc(clampedX, clampedY, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    };

    marker(frame.terminal, "rgba(51, 246, 255, 0.9)", 6);
    marker(frame.extraction, "rgba(81, 255, 157, 0.9)", 7);

    for (const entry of frame.squad) {
      if (entry.state === "dead") continue;
      const [x, y] = toScreen(entry.position.x, entry.position.z);
      ctx.fillStyle = entry.state === "downed" ? "#ffb03b" : "rgba(120, 240, 255, 0.85)";
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const contact of frame.contacts) {
      const [x, y] = toScreen(contact.x, contact.z);
      ctx.fillStyle = "rgba(255, 77, 109, 0.9)";
      ctx.beginPath();
      ctx.arc(x, y, 2.8, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    // Player arrow is screen-centered and rotates with facing.
    const px = center;
    const py = center;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-frame.yaw);
    ctx.fillStyle = "#f4feff";
    ctx.shadowColor = "#33f6ff";
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6, 7);
    ctx.lineTo(0, 4);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = "rgba(120, 220, 255, 0.25)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, size - 2, size - 2);
  }

  private renderWaypoint(frame: HudFrame): void {
    if (!frame.waypoint) {
      this.waypoint.classList.add("is-hidden");
      return;
    }
    const projected = frame.waypoint.clone().project(frame.camera);
    const distance = frame.position.distanceTo(frame.waypoint);
    if (projected.z > 1 || projected.z < -1 || Math.abs(projected.x) > 1.1 || Math.abs(projected.y) > 1.1) {
      this.waypoint.classList.add("is-hidden");
      return;
    }
    const width = window.innerWidth;
    const height = window.innerHeight;
    const x = (projected.x * 0.5 + 0.5) * width;
    const y = (-projected.y * 0.5 + 0.5) * height;
    this.waypoint.classList.remove("is-hidden");
    this.waypoint.style.left = `${x}px`;
    this.waypoint.style.top = `${y - 26}px`;
    this.waypointLabel.textContent = frame.waypointLabel;
    this.waypointDistance.textContent = `${Math.round(distance)}M`;
  }
}
