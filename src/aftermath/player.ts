import * as THREE from "three";
import { applyDamage, fireIntervalMs, nextStamina, spreadDegrees } from "./ballistics";
import type { Box2 } from "./world";
import { resolveWorldCollision } from "./world";
import type { RoleSpec } from "./types";

export interface PlayerInput {
  forward: number;
  right: number;
  sprint: boolean;
  crouch: boolean;
  jump: boolean;
  ads: boolean;
}

export class Player {
  readonly camera: THREE.PerspectiveCamera;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly role: RoleSpec;

  yaw = 0;
  pitch = 0;
  health: number;
  armor: number;
  stamina: number;
  ammo: number;
  reserve: number;
  alive = true;
  reloading = false;
  reloadRemaining = 0;
  grounded = true;

  private verticalVelocity = 0;
  private fireCooldown = 0;
  private eyeHeight = 1.7;
  private bobPhase = 0;
  private recoilPitch = 0;
  private recoilYaw = 0;
  private recoilRecovery = 9;
  private adsBlend = 0;
  private suppressedTimer = 0;
  private sprinting = false;
  private moving = false;
  private readonly baseFov = 78;
  private readonly viewmodel: THREE.Group;
  private readonly viewmodelFlash: THREE.Mesh;
  private viewmodelBase = new THREE.Vector3(0.26, -0.22, -0.5);
  private viewmodelAds = new THREE.Vector3(0, -0.145, -0.36);
  private flashTimer = 0;

  constructor(camera: THREE.PerspectiveCamera, role: RoleSpec) {
    this.camera = camera;
    this.role = role;
    this.health = 100;
    this.armor = role.armor;
    this.stamina = role.stamina;
    this.ammo = role.magazine;
    this.reserve = role.reserve;
    this.camera.rotation.order = "YXZ";
    this.camera.fov = this.baseFov;

    const gunMetal = new THREE.MeshStandardMaterial({ color: 0x0c1017, roughness: 0.3, metalness: 0.9 });
    const accent = new THREE.MeshStandardMaterial({
      color: 0x111820,
      emissive: new THREE.Color(role.color),
      emissiveIntensity: 1.6,
      roughness: 0.35,
      metalness: 0.6,
    });
    this.viewmodel = new THREE.Group();
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.15, 0.72), gunMetal);
    receiver.position.z = -0.2;
    this.viewmodel.add(receiver);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.5), gunMetal);
    barrel.position.set(0, 0.02, -0.78);
    this.viewmodel.add(barrel);
    const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 0.36), accent);
    handguard.position.set(0, -0.005, -0.55);
    this.viewmodel.add(handguard);
    const magazine = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.28, 0.16), gunMetal);
    magazine.position.set(0, -0.2, -0.16);
    magazine.rotation.x = 0.16;
    this.viewmodel.add(magazine);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.17, 0.28), gunMetal);
    stock.position.set(0, -0.01, 0.26);
    this.viewmodel.add(stock);
    const sightRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.055, 0.009, 6, 18),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(role.color), toneMapped: false }),
    );
    sightRing.position.set(0, 0.11, -0.32);
    this.viewmodel.add(sightRing);

    const flashMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.viewmodelFlash = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), flashMaterial);
    this.viewmodelFlash.position.set(0, 0.02, -1.04);
    this.viewmodelFlash.visible = false;
    this.viewmodel.add(this.viewmodelFlash);

    this.viewmodel.position.copy(this.viewmodelBase);
    this.viewmodel.rotation.y = 0.03;
    camera.add(this.viewmodel);

    const flashlight = new THREE.SpotLight(0xbfe4ff, 26, 46, 0.46, 0.6, 1.4);
    flashlight.position.set(0.05, -0.05, 0.1);
    const target = new THREE.Object3D();
    target.position.set(0, 0, -10);
    camera.add(target);
    flashlight.target = target;
    camera.add(flashlight);
  }

  reset(position: THREE.Vector3, yaw: number, pitch = 0): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = pitch;
    this.health = 100;
    this.armor = this.role.armor;
    this.stamina = this.role.stamina;
    this.ammo = this.role.magazine;
    this.reserve = this.role.reserve;
    this.alive = true;
    this.reloading = false;
    this.reloadRemaining = 0;
    this.fireCooldown = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.adsBlend = 0;
    this.suppressedTimer = 0;
    this.verticalVelocity = 0;
    this.grounded = true;
    this.viewmodel.position.copy(this.viewmodelBase);
    this.camera.position.copy(this.position).y += 1.7;
    this.applyCamera(0);
  }

  update(dt: number, input: PlayerInput, boxes: Box2[]): void {
    if (!this.alive) {
      this.verticalVelocity -= dt * 16;
      this.position.y = Math.max(0, this.position.y + this.verticalVelocity * dt);
      return;
    }

    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.suppressedTimer = Math.max(0, this.suppressedTimer - dt);
    if (this.reloading) {
      this.reloadRemaining -= dt;
      if (this.reloadRemaining <= 0) this.finishReload();
    }

    const crouching = input.crouch;
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new THREE.Vector3()
      .addScaledVector(forward, input.forward)
      .addScaledVector(right, input.right);
    if (wish.lengthSq() > 1) wish.normalize();

    const wantsSprint =
      input.sprint && wish.lengthSq() > 0.01 && !crouching && !input.ads && this.stamina > 1;
    this.sprinting = wantsSprint;
    let speed = this.role.speed;
    if (wantsSprint) speed *= 1.62;
    if (crouching) speed *= 0.52;
    if (input.ads) speed *= 0.62;

    this.moving = wish.lengthSq() > 0.01;
    const targetVelocity = wish.multiplyScalar(speed);
    const blend = 1 - Math.exp(-dt * (this.grounded ? 13 : 3.2));
    this.velocity.x += (targetVelocity.x - this.velocity.x) * blend;
    this.velocity.z += (targetVelocity.z - this.velocity.z) * blend;

    if (input.jump && this.grounded && !crouching) {
      this.verticalVelocity = 5.3;
      this.grounded = false;
    }
    this.verticalVelocity -= 16.5 * dt;
    this.position.y += this.verticalVelocity * dt;
    if (this.position.y <= 0) {
      this.position.y = 0;
      this.verticalVelocity = 0;
      this.grounded = true;
    }

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    resolveWorldCollision(this.position, 0.42, boxes);

    this.stamina = nextStamina(dt, {
      current: this.stamina,
      max: this.role.stamina,
      sprinting: this.sprinting,
      moving: this.moving,
      crouching,
      restingForSec: this.moving ? 0 : 1,
    });

    const targetEye = crouching ? 1.06 : 1.7;
    this.eyeHeight += (targetEye - this.eyeHeight) * (1 - Math.exp(-dt * 12));

    if (this.moving && this.grounded) {
      this.bobPhase += dt * (this.sprinting ? 12.5 : 8.2);
    }
    const bobAmount = this.moving && this.grounded ? (this.sprinting ? 0.045 : 0.022) : 0;
    const bob = Math.sin(this.bobPhase * 2) * bobAmount;
    const sway = Math.sin(this.bobPhase) * bobAmount * 0.35;

    this.recoilPitch += (0 - this.recoilPitch) * (1 - Math.exp(-dt * this.recoilRecovery));
    this.recoilYaw += (0 - this.recoilYaw) * (1 - Math.exp(-dt * this.recoilRecovery));

    const targetAds = input.ads && !this.sprinting && !this.reloading ? 1 : 0;
    this.adsBlend += (targetAds - this.adsBlend) * (1 - Math.exp(-dt * 12));
    const targetFov = this.baseFov + (this.role.adsZoom - this.baseFov) * this.adsBlend;
    this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-dt * 14));
    this.camera.updateProjectionMatrix();

    this.camera.position.set(this.position.x, this.position.y + this.eyeHeight + bob, this.position.z);
    this.camera.rotation.set(this.pitch + this.recoilPitch, this.yaw + this.recoilYaw, sway);

    const vmTarget = this.viewmodelBase.clone().lerp(this.viewmodelAds, this.adsBlend);
    const vmBobX = Math.sin(this.bobPhase) * 0.012 * (this.moving ? 1 : 0.25);
    const vmBobY = Math.abs(Math.cos(this.bobPhase)) * 0.009 * (this.moving ? 1 : 0.2);
    this.viewmodel.position.x += (vmTarget.x + vmBobX - this.viewmodel.position.x) * (1 - Math.exp(-dt * 14));
    this.viewmodel.position.y += (vmTarget.y + vmBobY - this.viewmodel.position.y) * (1 - Math.exp(-dt * 14));
    this.viewmodel.position.z += (vmTarget.z - this.viewmodel.position.z) * (1 - Math.exp(-dt * 14));
    this.viewmodel.rotation.z = this.reloading ? -0.5 : 0;
    this.viewmodel.rotation.x = this.reloading ? 0.35 : 0;

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.viewmodelFlash.visible = false;
    }
  }

  addLook(dx: number, dy: number, sensitivity: number): void {
    if (!this.alive) return;
    const scale = 0.0022 * sensitivity;
    this.yaw -= dx * scale;
    this.pitch -= dy * scale;
    this.pitch = Math.max(-1.48, Math.min(1.48, this.pitch));
  }

  get movingNow(): boolean {
    return this.moving;
  }

  get crouchedNow(): boolean {
    return this.eyeHeight < 1.3;
  }

  get sprintingNow(): boolean {
    return this.sprinting;
  }

  get suppressed(): boolean {
    return this.suppressedTimer > 0;
  }

  get ads(): number {
    return this.adsBlend;
  }

  get reloadFraction(): number {
    if (!this.reloading) return 0;
    return 1 - Math.max(0, this.reloadRemaining) / 1.65;
  }

  get eyePosition(): THREE.Vector3 {
    return this.camera.position;
  }

  get spread(): number {
    return spreadDegrees({
      stance: this.eyeHeight < 1.3 ? "crouch" : "stand",
      ads: this.adsBlend > 0.6,
      moving: this.moving,
      sprinting: this.sprinting,
      stamina01: this.stamina / Math.max(1, this.role.stamina),
      suppressed: this.suppressedTimer > 0,
    });
  }

  canFire(): boolean {
    return this.alive && !this.reloading && this.fireCooldown <= 0 && this.ammo > 0;
  }

  consumeShot(): void {
    this.ammo = Math.max(0, this.ammo - 1);
    this.fireCooldown = fireIntervalMs(this.role.rpm) / 1000;
    const adsFactor = 1 - this.adsBlend * 0.35;
    const kick = (this.role.id === "recon" ? 1.35 : this.role.id === "support" ? 0.72 : 1) * adsFactor;
    this.recoilPitch += 0.0125 * kick;
    this.recoilYaw += (Math.random() - 0.5) * 0.006 * kick;
    this.flashTimer = 0.05;
    this.viewmodelFlash.visible = true;
    this.viewmodelFlash.rotation.z = Math.random() * Math.PI;
  }

  startReload(): void {
    if (!this.alive || this.reloading) return;
    if (this.ammo >= this.role.magazine || this.reserve <= 0) return;
    this.reloading = true;
    this.reloadRemaining = 1.65;
  }

  get muzzleWorldPosition(): THREE.Vector3 {
    return this.viewmodelFlash.getWorldPosition(new THREE.Vector3());
  }

  setViewmodelVisible(visible: boolean): void {
    this.viewmodel.visible = visible;
  }

  getAimDirection(): THREE.Vector3 {
    return this.camera.getWorldDirection(new THREE.Vector3());
  }

  applyIncomingDamage(baseDamage: number, distanceMeters: number): { dead: boolean; healthLost: number } {
    if (!this.alive) return { dead: true, healthLost: 0 };
    const result = applyDamage(this.health, this.armor, baseDamage, false, distanceMeters);
    this.health = result.health;
    this.armor = result.armor;
    this.suppressedTimer = 1.1;
    if (this.health <= 0) {
      this.alive = false;
      return { dead: true, healthLost: result.healthLost };
    }
    return { dead: false, healthLost: result.healthLost };
  }

  private finishReload(): void {
    const needed = this.role.magazine - this.ammo;
    const loaded = Math.min(needed, this.reserve);
    this.ammo += loaded;
    this.reserve -= loaded;
    this.reloading = false;
    this.reloadRemaining = 0;
  }

  private applyCamera(_dt: number): void {
    this.camera.position.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
  }
}
