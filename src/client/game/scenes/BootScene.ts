import Phaser from "phaser";
import { createArenaBackground, createCoreTextures } from "../textures";

/**
 * No external art is loaded: every texture is painted procedurally into a
 * canvas once at boot. This also guarantees the game works fully offline.
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  create(): void {
    createCoreTextures(this);
    createArenaBackground(this);
    this.game.events.emit("neon-rift-ready");
    this.scene.start("Ambient");
  }
}
