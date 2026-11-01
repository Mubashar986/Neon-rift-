import Phaser from "phaser";
import { TEX } from "../textures";

/**
 * Low-cost living backdrop shown behind the menu and lobby. It is the same
 * arena artwork, scaled to cover the viewport and drifting very slowly, with
 * screen-space dust and a breathing core. It never reads network state.
 */
export class AmbientScene extends Phaser.Scene {
  private world!: Phaser.GameObjects.Container;
  private background!: Phaser.GameObjects.Image;
  private coreGlow!: Phaser.GameObjects.Image;
  private ringA!: Phaser.GameObjects.Image;
  private ringB!: Phaser.GameObjects.Image;
  private dust: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private elapsed = 0;
  private cover = 1;

  constructor() {
    super("Ambient");
  }

  create(): void {
    this.cameras.main.setBackgroundColor("#03040a");
    this.world = this.add.container(0, 0).setDepth(0);

    this.background = this.add
      .image(0, 0, TEX.arena)
      .setOrigin(0.5)
      .setAlpha(0.92);
    this.world.add(this.background);

    this.coreGlow = this.add
      .image(0, 0, TEX.glow)
      .setTint(0x8a46ff)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(3.2)
      .setAlpha(0.2);
    this.world.add(this.coreGlow);

    this.ringA = this.add
      .image(0, 0, TEX.ring)
      .setTint(0x33f6ff)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(1.1)
      .setAlpha(0.07);
    this.world.add(this.ringA);

    this.ringB = this.add
      .image(0, 0, TEX.ring)
      .setTint(0xff3bd4)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(1.7)
      .setAlpha(0.05);
    this.world.add(this.ringB);

    this.layout();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.layout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.layout, this);
      this.dust?.destroy();
      this.dust = null;
    });
  }

  update(_time: number, delta: number): void {
    this.elapsed += delta;
    const t = this.elapsed / 1000;
    const width = this.scale.width;
    const height = this.scale.height;

    this.world.x = width / 2 + Math.sin(t * 0.07) * 18;
    this.world.y = height / 2 + Math.cos(t * 0.055) * 12;
    this.world.setScale(this.cover * (1 + Math.sin(t * 0.11) * 0.006));
    this.coreGlow.setAlpha(0.16 + Math.sin(t * 0.9) * 0.045);
    this.ringA.setScale(1.1 + ((t * 0.12) % 1) * 0.7);
    this.ringA.setAlpha(0.09 - ((t * 0.12) % 1) * 0.07);
    this.ringB.rotation = t * 0.05;
  }

  private layout(): void {
    const width = this.scale.width;
    const height = this.scale.height;
    this.cover = Math.max(width / 2400, height / 1600) * 1.04;
    this.world.setPosition(width / 2, height / 2);
    this.world.setScale(this.cover);
    this.buildDust(width, height);
  }

  private buildDust(width: number, height: number): void {
    this.dust?.destroy();
    const particles = this.add.particles(0, 0, TEX.star, {
      x: { min: 0, max: width },
      y: { min: 0, max: height },
      lifespan: { min: 3_500, max: 7_500 },
      speedY: { min: -16, max: -5 },
      speedX: { min: -8, max: 8 },
      scale: { start: 0.42, end: 0 },
      alpha: { start: 0.34, end: 0 },
      tint: [0x33f6ff, 0xb06bff, 0xff3bd4],
      blendMode: Phaser.BlendModes.ADD,
      frequency: 110,
      quantity: 1,
    });
    particles.setDepth(1);
    this.dust = particles;
  }
}
