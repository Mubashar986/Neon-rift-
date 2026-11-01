import * as THREE from "three";
import type { World } from "./world";
import { resolveWorldCollision } from "./world";
import { createSoldier, type ActorRig } from "./actor";
import type { Effects } from "./effects";
import type { AudioEngine } from "./audio";

export interface AiContext {
  world: World;
  effects: Effects;
  audio: AudioEngine;
  cameraPosition: THREE.Vector3;
  cameraYaw: number;
  playerPosition: THREE.Vector3;
  playerAlive: boolean;
  enemies: Enemy[];
  allies: Ally[];
  enemyFire(enemy: Enemy, targetPosition: THREE.Vector3, targetAlly: Ally | null): void;
  allyFire(ally: Ally, target: Enemy): void;
  onAllyDowned(ally: Ally): void;
}

const ENEMY_NAMES = ["CINDER", "MOTH", "RUST", "SABLE", "VEX", "HOLLOW", "DRIFT", "WRAITH", "STATIC", "ASH"];

function panFor(ctx: AiContext, position: THREE.Vector3): number {
  const dx = position.x - ctx.cameraPosition.x;
  const dz = position.z - ctx.cameraPosition.z;
  const length = Math.hypot(dx, dz) || 1;
  const rightX = Math.cos(ctx.cameraYaw);
  const rightZ = -Math.sin(ctx.cameraYaw);
  return Math.max(-1, Math.min(1, (dx * rightX + dz * rightZ) / length));
}

function faceDirection(rig: ActorRig, direction: THREE.Vector3): void {
  if (direction.lengthSq() < 0.0001) return;
  rig.group.rotation.y = Math.atan2(-direction.x, -direction.z);
}

function chest(position: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(position.x, position.y + 1.12, position.z);
}

function eye(position: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(position.x, position.y + 1.55, position.z);
}

export interface EnemyOptions {
  position: THREE.Vector3;
  index: number;
  elite?: boolean;
}

export class Enemy {
  readonly rig: ActorRig;
  readonly position: THREE.Vector3;
  readonly home: THREE.Vector3;
  readonly elite: boolean;
  readonly name: string;
  health = 100;
  readonly maxHealth: number;
  alive = true;
  state: "patrol" | "search" | "combat" = "patrol";
  lastKnown = new THREE.Vector3();
  speed = 2.8;

  private patrolTarget = new THREE.Vector3();
  private patrolWait = Math.random() * 3;
  private searchTimer = 0;
  private fireTimer = 1 + Math.random() * 2;
  private burstLeft = 0;
  private burstTimer = 0;
  private strafeDir = Math.random() < 0.5 ? -1 : 1;
  private strafeTimer = 0;
  private avoidTimer = 0;
  private avoidSign = 1;
  private alertPing = false;

  constructor(options: EnemyOptions) {
    this.position = options.position.clone();
    this.home = options.position.clone();
    this.elite = options.elite ?? false;
    this.health = this.elite ? 135 : 100;
    this.maxHealth = this.health;
    this.speed = this.elite ? 3.25 : 2.75;
    this.name = ENEMY_NAMES[options.index % ENEMY_NAMES.length];
    this.rig = createSoldier(this.name, this.elite ? "#ffb03b" : "#ff4d6d", false);
    this.rig.group.position.copy(this.position);
    this.rig.group.rotation.y = Math.random() * Math.PI * 2;
    this.pickPatrolTarget();
  }

  get muzzlePosition(): THREE.Vector3 {
    return this.rig.muzzle.getWorldPosition(new THREE.Vector3());
  }

  alertTo(position: THREE.Vector3): void {
    if (!this.alive) return;
    this.lastKnown.copy(position);
    if (this.state === "patrol") this.state = "search";
    this.searchTimer = Math.max(this.searchTimer, 7);
  }

  update(dt: number, ctx: AiContext): void {
    if (!this.alive) {
      this.rig.animate(dt, 0, false);
      return;
    }

    {
      const selfEye = eye(this.position);
      const target = this.pickTarget(ctx, selfEye);
      let desired: THREE.Vector3 | null = null;
      let moveSpeed = 0;
      let aiming = false;

      if (target) {
        if (!this.alertPing) {
          this.alertPing = true;
          for (const other of ctx.enemies) {
            if (other !== this && other.alive && other.position.distanceTo(this.position) < 22) {
              other.alertTo(target.position);
            }
          }
        }
        this.state = "combat";
        this.lastKnown.copy(target.position);
        const distance = this.position.distanceTo(target.position);
        const toward = new THREE.Vector3().subVectors(target.position, this.position).setY(0);
        faceDirection(this.rig, toward);
        aiming = true;

        if (distance > 15) {
          desired = target.position;
          moveSpeed = this.speed;
        } else if (distance < 6.5) {
          desired = this.position.clone().addScaledVector(toward.normalize(), -3);
          moveSpeed = this.speed * 0.8;
        } else {
          this.strafeTimer -= dt;
          if (this.strafeTimer <= 0) {
            this.strafeTimer = 1.4 + Math.random() * 2;
            this.strafeDir *= Math.random() < 0.55 ? -1 : 1;
          }
          desired = this.position
            .clone()
            .add(new THREE.Vector3(-toward.z, 0, toward.x).multiplyScalar(this.strafeDir * 2.6));
          moveSpeed = this.speed * 0.6;
        }

        this.fireTimer -= dt;
        if (this.burstLeft > 0) {
          this.burstTimer -= dt;
          if (this.burstTimer <= 0) {
            ctx.enemyFire(this, target.position, target.ally);
            this.burstLeft -= 1;
            this.burstTimer = this.elite ? 0.1 : 0.15;
            if (this.burstLeft <= 0) this.fireTimer = 1.5 + Math.random() * 1.6;
          }
        } else if (this.fireTimer <= 0) {
          this.burstLeft = 3 + Math.floor(Math.random() * 2);
          this.burstTimer = 0;
        }
      } else if (this.state === "combat") {
        this.state = "search";
        this.searchTimer = 9;
        desired = this.lastKnown.clone();
        moveSpeed = this.speed * 0.95;
      } else if (this.state === "search") {
        this.searchTimer -= dt;
        desired = this.lastKnown.clone();
        moveSpeed = this.speed * 0.8;
        if (this.position.distanceTo(this.lastKnown) < 2.4 || this.searchTimer <= 0) {
          this.state = "patrol";
          this.pickPatrolTarget();
        }
      } else {
        this.patrolWait -= dt;
        if (this.patrolWait <= 0) {
          if (this.position.distanceTo(this.patrolTarget) < 1.5) this.pickPatrolTarget();
          desired = this.patrolTarget;
          moveSpeed = 1.35;
        }
      }

      if (desired) {
        this.stepToward(desired, moveSpeed, dt, ctx.world);
        if (!aiming) {
          const look = new THREE.Vector3().subVectors(desired, this.position).setY(0);
          faceDirection(this.rig, look);
        }
      }
      this.rig.animate(dt, moveSpeed, aiming);
    }
  }

  applyDamage(amount: number, headshot: boolean, ctx: AiContext): boolean {
    if (!this.alive) return false;
    this.health -= amount * (headshot ? 1.8 : 1);
    this.rig.setHealth(this.health / this.maxHealth);
    this.state = "combat";
    this.alertPing = true;
    this.lastKnown.copy(ctx.playerPosition);
    if (this.health <= 0) {
      this.alive = false;
      this.rig.setDead();
      this.rig.group.rotation.z = (Math.random() - 0.5) * 0.4;
      ctx.effects.spark(chest(this.position), 0xff6b81, 16);
      return true;
    }
    return false;
  }

  private pickTarget(ctx: AiContext, selfEye: THREE.Vector3): { position: THREE.Vector3; ally: Ally | null } | null {
    let best: { position: THREE.Vector3; ally: Ally | null } | null = null;
    let bestDistance = this.state === "patrol" ? 27 : 46;
    if (ctx.playerAlive) {
      const distance = this.position.distanceTo(ctx.playerPosition);
      if (distance < bestDistance && ctx.world.hasLineOfSight(selfEye, eye(ctx.playerPosition))) {
        best = { position: ctx.playerPosition, ally: null };
        bestDistance = distance;
      }
    }
    for (const ally of ctx.allies) {
      if (ally.state !== "alive") continue;
      const distance = this.position.distanceTo(ally.position);
      if (distance < bestDistance && ctx.world.hasLineOfSight(selfEye, eye(ally.position))) {
        best = { position: ally.position, ally };
        bestDistance = distance;
      }
    }
    return best;
  }

  private pickPatrolTarget(): void {
    const angle = Math.random() * Math.PI * 2;
    const radius = 3 + Math.random() * 9;
    this.patrolTarget.set(
      this.home.x + Math.cos(angle) * radius,
      0,
      this.home.z + Math.sin(angle) * radius,
    );
    this.patrolWait = 1.5 + Math.random() * 4;
  }

  private stepToward(target: THREE.Vector3, speed: number, dt: number, world: World): void {
    if (speed <= 0) return;
    const direction = new THREE.Vector3().subVectors(target, this.position).setY(0);
    const distance = direction.length();
    if (distance < 0.2) return;
    direction.normalize();
    if (this.avoidTimer > 0) {
      this.avoidTimer -= dt;
      const sign = this.avoidSign;
      const x = direction.x * 0.45 - direction.z * sign * 0.9;
      const z = direction.z * 0.45 + direction.x * sign * 0.9;
      direction.set(x, 0, z).normalize();
    }
    const beforeX = this.position.x;
    const beforeZ = this.position.z;
    this.position.addScaledVector(direction, speed * dt);
    resolveWorldCollision(this.position, 0.4, world.boxes);
    const moved = Math.hypot(this.position.x - beforeX, this.position.z - beforeZ);
    if (moved < Math.min(speed * dt * 0.35, 0.02) && distance > 1.2) {
      this.avoidTimer = 0.7 + Math.random() * 0.5;
      this.avoidSign = Math.random() < 0.5 ? -1 : 1;
    }
    this.rig.group.position.copy(this.position);
  }

  playShotSound(ctx: AiContext): void {
    const position = this.muzzlePosition;
    ctx.audio.enemyShot(panFor(ctx, position), position.distanceTo(ctx.cameraPosition));
  }
}

export interface AllyOptions {
  name: string;
  index: number;
  position: THREE.Vector3;
}

export class Ally {
  readonly rig: ActorRig;
  readonly position: THREE.Vector3;
  readonly name: string;
  readonly index: number;
  state: "alive" | "downed" | "dead" = "alive";
  health = 100;
  bleedTimer = 0;

  private fireTimer = 1 + Math.random() * 2;
  private burstLeft = 0;
  private burstTimer = 0;
  private avoidTimer = 0;
  private avoidSign = 1;

  constructor(options: AllyOptions) {
    this.name = options.name;
    this.index = options.index;
    this.position = options.position.clone();
    this.rig = createSoldier(this.name, "#49f7ff", true);
    this.rig.group.position.copy(this.position);
  }

  get muzzlePosition(): THREE.Vector3 {
    return this.rig.muzzle.getWorldPosition(new THREE.Vector3());
  }

  update(dt: number, ctx: AiContext): void {
    if (this.state === "dead") {
      this.rig.animate(dt, 0, false);
      return;
    }
    if (this.state === "downed") {
      this.rig.animate(dt, 0, false);
      this.bleedTimer -= dt;
      if (this.bleedTimer <= 0) {
        this.state = "dead";
        this.rig.setDead();
        ctx.onAllyDowned(this);
      }
      return;
    }

    const selfEye = eye(this.position);
    let target: Enemy | null = null;
    let targetDistance = 38;
    for (const enemy of ctx.enemies) {
      if (!enemy.alive) continue;
      const distance = this.position.distanceTo(enemy.position);
      if (distance < targetDistance && ctx.world.hasLineOfSight(selfEye, eye(enemy.position))) {
        target = enemy;
        targetDistance = distance;
      }
    }

    const slot = this.formationSlot(ctx);
    const toSlot = new THREE.Vector3().subVectors(slot, this.position).setY(0);
    const slotDistance = toSlot.length();
    let moving = false;
    if (slotDistance > 2.2) {
      const speed = slotDistance > 11 ? 6.1 : slotDistance > 4.5 ? 4.7 : 3.1;
      this.stepToward(slot, speed, dt, ctx.world);
      moving = true;
    }

    if (target) {
      const toward = new THREE.Vector3().subVectors(target.position, this.position).setY(0);
      faceDirection(this.rig, toward);
      this.fireTimer -= dt;
      if (this.burstLeft > 0) {
        this.burstTimer -= dt;
        if (this.burstTimer <= 0) {
          ctx.allyFire(this, target);
          this.burstLeft -= 1;
          this.burstTimer = 0.16;
          if (this.burstLeft <= 0) this.fireTimer = 1.6 + Math.random() * 1.8;
        }
      } else if (this.fireTimer <= 0) {
        this.burstLeft = 2 + Math.floor(Math.random() * 3);
        this.burstTimer = 0;
      }
    } else if (moving) {
      faceDirection(this.rig, toSlot);
    }

    // Keep squadmates from standing inside the player's camera.
    const away = new THREE.Vector3().subVectors(this.position, ctx.playerPosition).setY(0);
    const separation = away.length();
    if (separation > 0.001 && separation < 1.65) {
      this.position.addScaledVector(away.normalize(), 1.65 - separation);
      resolveWorldCollision(this.position, 0.4, ctx.world.boxes);
      this.rig.group.position.copy(this.position);
    }

    this.rig.animate(dt, moving ? 4 : 0, target !== null);
  }

  applyDamage(amount: number, ctx: AiContext): boolean {
    if (this.state !== "alive") return false;
    this.health -= amount;
    this.rig.setHealth(this.health / 100);
    if (this.health <= 0) {
      this.health = 0;
      this.state = "downed";
      this.bleedTimer = 30;
      this.rig.setDowned();
      ctx.effects.spark(chest(this.position), 0x7fe9ff, 10);
      ctx.onAllyDowned(this);
      return true;
    }
    return false;
  }

  revive(ctx: AiContext): void {
    if (this.state !== "downed") return;
    this.state = "alive";
    this.health = 60;
    this.bleedTimer = 0;
    this.rig.setAlive();
    this.rig.setHealth(0.6);
    this.rig.group.position.copy(this.position);
    ctx.effects.spark(chest(this.position), 0x7dffcf, 10);
  }

  playShotSound(ctx: AiContext): void {
    const position = this.muzzlePosition;
    ctx.audio.shot(panFor(ctx, position), position.distanceTo(ctx.cameraPosition), false);
  }

  private formationSlot(ctx: AiContext): THREE.Vector3 {
    const right = new THREE.Vector3(Math.cos(ctx.cameraYaw), 0, -Math.sin(ctx.cameraYaw));
    const forward = new THREE.Vector3(-Math.sin(ctx.cameraYaw), 0, -Math.cos(ctx.cameraYaw));
    const offsets: Array<[number, number]> = [
      [-2.8, 1.8],
      [2.8, 1.8],
      [0, 3.6],
    ];
    const [side, back] = offsets[this.index % offsets.length];
    return new THREE.Vector3()
      .copy(ctx.playerPosition)
      .addScaledVector(right, side)
      .addScaledVector(forward, -back);
  }

  private stepToward(target: THREE.Vector3, speed: number, dt: number, world: World): void {
    const direction = new THREE.Vector3().subVectors(target, this.position).setY(0);
    if (direction.lengthSq() < 0.04) return;
    direction.normalize();
    if (this.avoidTimer > 0) {
      this.avoidTimer -= dt;
      const sign = this.avoidSign;
      const x = direction.x * 0.45 - direction.z * sign * 0.9;
      const z = direction.z * 0.45 + direction.x * sign * 0.9;
      direction.set(x, 0, z).normalize();
    }
    const beforeX = this.position.x;
    const beforeZ = this.position.z;
    this.position.addScaledVector(direction, speed * dt);
    resolveWorldCollision(this.position, 0.4, world.boxes);
    const moved = Math.hypot(this.position.x - beforeX, this.position.z - beforeZ);
    if (moved < Math.min(speed * dt * 0.35, 0.02)) {
      this.avoidTimer = 0.6 + Math.random() * 0.5;
      this.avoidSign = Math.random() < 0.5 ? -1 : 1;
    }
    this.rig.group.position.copy(this.position);
  }
}
