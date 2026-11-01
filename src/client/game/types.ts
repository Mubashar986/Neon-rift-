import type { MatchStartInfo } from "@shared/types";

export interface GameInput {
  moveX: number;
  moveY: number;
  aim: number;
  fire: boolean;
  dash: boolean;
}

/** Implemented by TouchControls so the renderer never imports UI code. */
export interface TouchInputProvider {
  getState(): { moveX: number; moveY: number; aim: number; hasAim: boolean };
  readonly isFiring: boolean;
  consumeDash(): boolean;
}

export interface VisualSettings {
  quality: "low" | "medium" | "high";
  screenShake: boolean;
  reducedMotion: boolean;
}

export interface ArenaSceneData {
  match: MatchStartInfo;
  selfId: string;
  touch: TouchInputProvider;
  getInputSink: () => ((input: GameInput) => number) | null;
  getSettings: () => VisualSettings;
  getTouchActive: () => boolean;
}
