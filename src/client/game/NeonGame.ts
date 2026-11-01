import Phaser from "phaser";
import type { MatchStartInfo, SnapshotMsg } from "@shared/types";
import type { ClientSettings } from "../state/SettingsStore";
import { AmbientScene } from "./scenes/AmbientScene";
import { ArenaScene } from "./scenes/ArenaScene";
import { BootScene } from "./scenes/BootScene";
import type { ArenaSceneData, GameInput, TouchInputProvider, VisualSettings } from "./types";

/**
 * Owns the single Phaser instance. The app never talks to scenes directly;
 * it starts an arena, forwards snapshots, and lets the wrapper handle scene
 * switching. Phaser's own scale manager handles arbitrary viewport sizes.
 */
export class NeonGame {
  readonly ready: Promise<void>;
  private readonly game: Phaser.Game;
  private inputSink: ((input: GameInput) => number) | null = null;
  private touchActive = false;
  private visuals: VisualSettings;
  private currentArenaKey: string | null = null;

  constructor(
    parentId: string,
    settings: ClientSettings,
    private readonly touch: TouchInputProvider,
  ) {
    this.visuals = {
      quality: settings.quality,
      screenShake: settings.screenShake,
      reducedMotion: settings.reducedMotion,
    };

    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: parentId,
      transparent: true,
      backgroundColor: "#03040a",
      scale: {
        mode: Phaser.Scale.RESIZE,
        width: window.innerWidth,
        height: window.innerHeight,
      },
      render: {
        antialias: true,
        powerPreference: "high-performance",
        roundPixels: false,
      },
      input: {
        keyboard: true,
        mouse: true,
        touch: true,
        activePointers: 3,
      },
      scene: [BootScene, AmbientScene, ArenaScene],
    });

    this.ready = new Promise((resolve) => {
      this.game.events.once("neon-rift-ready", () => resolve());
    });
  }

  get arenaKey(): string | null {
    return this.currentArenaKey;
  }

  get isArenaActive(): boolean {
    return this.game.scene.isActive("Arena");
  }

  setInputSink(sink: ((input: GameInput) => number) | null): void {
    this.inputSink = sink;
  }

  setTouchActive(active: boolean): void {
    this.touchActive = active;
  }

  setSettings(settings: ClientSettings): void {
    this.visuals = {
      quality: settings.quality,
      screenShake: settings.screenShake,
      reducedMotion: settings.reducedMotion,
    };
  }

  async showAmbient(): Promise<void> {
    await this.ready;
    if (this.game.scene.isActive("Arena")) this.game.scene.stop("Arena");
    if (!this.game.scene.isActive("Ambient")) this.game.scene.start("Ambient");
    this.currentArenaKey = null;
  }

  async startMatch(match: MatchStartInfo, selfId: string): Promise<void> {
    await this.ready;
    this.currentArenaKey = `${match.roomCode}:${match.startedAt}`;
    this.game.scene.stop("Ambient");

    const data: ArenaSceneData = {
      match,
      selfId,
      touch: this.touch,
      getInputSink: () => this.inputSink,
      getSettings: () => this.visuals,
      getTouchActive: () => this.touchActive,
    };

    if (this.game.scene.isActive("Arena")) {
      this.game.scene.getScene("Arena").scene.restart(data);
    } else {
      this.game.scene.start("Arena", data);
    }
  }

  applySnapshot(snapshot: SnapshotMsg): void {
    if (!this.game.scene.isActive("Arena")) return;
    const scene = this.game.scene.getScene("Arena") as ArenaScene;
    scene.applySnapshot(snapshot);
  }

  setArenaPaused(paused: boolean): void {
    if (!this.game.scene.isActive("Arena")) return;
    const scene = this.game.scene.getScene("Arena") as ArenaScene;
    scene.setInputPaused(paused);
  }

  endMatch(): void {
    if (!this.game.scene.isActive("Arena")) return;
    const scene = this.game.scene.getScene("Arena") as ArenaScene;
    scene.endMatch();
  }

  /** Diagnostics used by the debug API, E2E checks and docs screenshots. */
  getCameraState(): { scrollX: number; scrollY: number; zoom: number; viewX: number; viewY: number; viewWidth: number; viewHeight: number } | null {
    if (!this.game.scene.isActive("Arena")) return null;
    return (this.game.scene.getScene("Arena") as ArenaScene).getCameraState();
  }

  destroy(): void {
    this.game.destroy(true);
  }
}
