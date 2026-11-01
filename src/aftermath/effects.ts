import * as THREE from "three";

interface Tracer {
  line: THREE.Line;
  life: number;
  maxLife: number;
}

interface Spark {
  sprite: THREE.Sprite;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
}

/**
 * Lightweight pooled effects: tracers, impact sparks, muzzle flashes and a
 * single roaming muzzle light. No external textures are used.
 */
export class Effects {
  private readonly scene: THREE.Scene;
  private readonly glow: THREE.Texture;
  private readonly tracers: Tracer[] = [];
  private readonly sparks: Spark[] = [];
  private readonly muzzleLight: THREE.PointLight;
  private readonly muzzleLightLife = { value: 0 };
  private disposed = false;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.glow = Effects.makeGlowTexture();
    this.muzzleLight = new THREE.PointLight(0xffcf8a, 0, 14, 2);
    this.muzzleLight.position.set(0, -100, 0);
    scene.add(this.muzzleLight);
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, color = 0xffd9a0, life = 0.09): void {
    if (this.disposed) return;
    const geometry = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    this.scene.add(line);
    this.tracers.push({ line, life, maxLife: life });
    if (this.tracers.length > 64) {
      const oldest = this.tracers.shift();
      if (oldest) this.destroyTracer(oldest);
    }
  }

  spark(point: THREE.Vector3, color = 0xffc46b, count = 5): void {
    if (this.disposed) return;
    for (let i = 0; i < count; i += 1) {
      const material = new THREE.SpriteMaterial({
        map: this.glow,
        color,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.position.copy(point);
      sprite.scale.setScalar(0.14 + Math.random() * 0.16);
      this.scene.add(sprite);
      const maxLife = 0.28 + Math.random() * 0.4;
      this.sparks.push({
        sprite,
        velocity: new THREE.Vector3(
          (Math.random() - 0.5) * 4.2,
          Math.random() * 2.6 + 0.4,
          (Math.random() - 0.5) * 4.2,
        ),
        life: maxLife,
        maxLife,
      });
      if (this.sparks.length > 160) {
        const oldest = this.sparks.shift();
        if (oldest) this.destroySpark(oldest);
      }
    }
  }

  muzzle(point: THREE.Vector3, color = 0xffcf8a): void {
    if (this.disposed) return;
    this.muzzleLight.position.copy(point);
    this.muzzleLight.color.setHex(color);
    this.muzzleLight.intensity = 22;
    this.muzzleLightLife.value = 0.07;
    this.spark(point, color, 2);
  }

  update(dt: number): void {
    if (this.disposed) return;
    for (let i = this.tracers.length - 1; i >= 0; i -= 1) {
      const tracer = this.tracers[i];
      tracer.life -= dt;
      if (tracer.life <= 0) {
        this.tracers.splice(i, 1);
        this.destroyTracer(tracer);
      } else {
        const material = tracer.line.material as THREE.LineBasicMaterial;
        material.opacity = (tracer.life / tracer.maxLife) * 0.85;
      }
    }
    for (let i = this.sparks.length - 1; i >= 0; i -= 1) {
      const spark = this.sparks[i];
      spark.life -= dt;
      if (spark.life <= 0) {
        this.sparks.splice(i, 1);
        this.destroySpark(spark);
        continue;
      }
      spark.velocity.y -= dt * 9;
      spark.sprite.position.addScaledVector(spark.velocity, dt);
      const material = spark.sprite.material as THREE.SpriteMaterial;
      const t = spark.life / spark.maxLife;
      material.opacity = t * 0.95;
      spark.sprite.scale.setScalar(0.1 + t * 0.16);
    }
    if (this.muzzleLightLife.value > 0) {
      this.muzzleLightLife.value -= dt;
      this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 340);
    } else if (this.muzzleLight.intensity !== 0) {
      this.muzzleLight.intensity = 0;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const tracer of this.tracers) this.destroyTracer(tracer);
    for (const spark of this.sparks) this.destroySpark(spark);
    this.tracers.length = 0;
    this.sparks.length = 0;
    this.scene.remove(this.muzzleLight);
    this.glow.dispose();
  }

  private destroyTracer(tracer: Tracer): void {
    this.scene.remove(tracer.line);
    tracer.line.geometry.dispose();
    (tracer.line.material as THREE.Material).dispose();
  }

  private destroySpark(spark: Spark): void {
    this.scene.remove(spark.sprite);
    (spark.sprite.material as THREE.SpriteMaterial).dispose();
  }

  private static makeGlowTexture(): THREE.Texture {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.35, "rgba(255,220,160,0.7)");
    gradient.addColorStop(1, "rgba(255,180,80,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }
}
