export type MissionPhase = "playing" | "complete" | "failed";
export type MissionObjective = "terminal" | "extract" | "done";

export interface MissionTick {
  dt: number;
  playerAlive: boolean;
  atTerminal: boolean;
  atExtraction: boolean;
  holding: boolean;
}

export type MissionEvent =
  | { type: "hacked" }
  | { type: "extracted" }
  | { type: "failed"; reason: "killed" };

export const HACK_SECONDS = 6;
export const EXTRACT_SECONDS = 7;

/**
 * Deterministic objective state machine. Keep this free of Three.js so it can
 * move server-side unchanged and is cheap to unit test.
 */
export class MissionState {
  phase: MissionPhase = "playing";
  objective: MissionObjective = "terminal";
  elapsed = 0;
  hackProgress = 0;
  extractProgress = 0;
  hacked = false;
  extracted = false;

  update(tick: MissionTick): MissionEvent[] {
    if (this.phase !== "playing") return [];
    const events: MissionEvent[] = [];
    this.elapsed += Math.max(0, tick.dt);

    if (!tick.playerAlive) {
      this.phase = "failed";
      events.push({ type: "failed", reason: "killed" });
      return events;
    }

    if (!this.hacked) {
      if (tick.atTerminal && tick.holding) {
        this.hackProgress = Math.min(1, this.hackProgress + tick.dt / HACK_SECONDS);
        if (this.hackProgress >= 1) {
          this.hacked = true;
          this.objective = "extract";
          this.hackProgress = 1;
          this.extractProgress = 0;
          events.push({ type: "hacked" });
        }
      } else {
        this.hackProgress = Math.max(0, this.hackProgress - tick.dt * 0.03);
      }
      return events;
    }

    if (tick.atExtraction && tick.holding) {
      this.extractProgress = Math.min(1, this.extractProgress + tick.dt / EXTRACT_SECONDS);
      if (this.extractProgress >= 1) {
        this.extracted = true;
        this.phase = "complete";
        this.objective = "done";
        events.push({ type: "extracted" });
      }
    } else {
      this.extractProgress = Math.max(0, this.extractProgress - tick.dt * 0.22);
    }
    return events;
  }

  get objectiveTitle(): string {
    if (this.hacked) return "EXFILTRATE";
    return "BREACH THE DATA VAULT";
  }

  get objectiveDetail(): string {
    if (this.hacked) return "Reach the extraction pad and hold position";
    return "Reach the terminal inside the vault and hold E to slice the core";
  }
}
