export type Quality = "low" | "medium" | "high";
export type TouchMode = "auto" | "on" | "off";

export interface ClientSettings {
  nickname: string;
  sfxVolume: number;
  musicVolume: number;
  muted: boolean;
  quality: Quality;
  screenShake: boolean;
  reducedMotion: boolean;
  highContrast: boolean;
  touchMode: TouchMode;
}

const STORAGE_KEY = "neon-rift.settings.v1";

const DEFAULTS: ClientSettings = {
  nickname: "",
  sfxVolume: 0.8,
  musicVolume: 0.45,
  muted: false,
  quality: "high",
  screenShake: true,
  reducedMotion: false,
  highContrast: false,
  touchMode: "auto",
};

type Subscriber = (settings: ClientSettings) => void;

function clamp01(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function applyBodyClasses(settings: ClientSettings): void {
  const classes = document.body.classList;
  classes.toggle("quality-low", settings.quality === "low");
  classes.toggle("quality-medium", settings.quality === "medium");
  classes.toggle("reduced-motion", settings.reducedMotion);
  classes.toggle("high-contrast", settings.highContrast);
}

function isCoarsePointer(): boolean {
  return window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
}

/**
 * Everything user-facing is persisted locally. Settings affect live systems:
 * the audio engine subscribes for volumes, the renderer for quality/motion.
 */
export class SettingsStore {
  private state: ClientSettings = { ...DEFAULTS };
  private subscribers = new Set<Subscriber>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load();
    applyBodyClasses(this.state);
  }

  get value(): Readonly<ClientSettings> {
    return this.state;
  }

  get nickname(): string {
    return this.state.nickname;
  }

  get touchActive(): boolean {
    if (this.state.touchMode === "on") return true;
    if (this.state.touchMode === "off") return false;
    return isCoarsePointer();
  }

  update(patch: Partial<ClientSettings>): void {
    const next: ClientSettings = { ...this.state, ...patch };
    next.sfxVolume = clamp01(next.sfxVolume, DEFAULTS.sfxVolume);
    next.musicVolume = clamp01(next.musicVolume, DEFAULTS.musicVolume);
    next.nickname = next.nickname.slice(0, 16);
    if (next.quality !== "low" && next.quality !== "medium" && next.quality !== "high") {
      next.quality = DEFAULTS.quality;
    }
    if (next.touchMode !== "auto" && next.touchMode !== "on" && next.touchMode !== "off") {
      next.touchMode = "auto";
    }
    this.state = next;
    applyBodyClasses(this.state);
    this.persistSoon();
    for (const subscriber of this.subscribers) subscriber(this.state);
  }

  reset(): void {
    this.update({ ...DEFAULTS, nickname: this.state.nickname });
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.state);
    return () => this.subscribers.delete(subscriber);
  }

  private load(): void {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      const candidate = parsed as Partial<ClientSettings>;
      this.state = {
        nickname: typeof candidate.nickname === "string" ? candidate.nickname.slice(0, 16) : DEFAULTS.nickname,
        sfxVolume: clamp01(candidate.sfxVolume, DEFAULTS.sfxVolume),
        musicVolume: clamp01(candidate.musicVolume, DEFAULTS.musicVolume),
        muted: typeof candidate.muted === "boolean" ? candidate.muted : DEFAULTS.muted,
        quality:
          candidate.quality === "low" || candidate.quality === "medium" || candidate.quality === "high"
            ? candidate.quality
            : DEFAULTS.quality,
        screenShake:
          typeof candidate.screenShake === "boolean" ? candidate.screenShake : DEFAULTS.screenShake,
        reducedMotion:
          typeof candidate.reducedMotion === "boolean"
            ? candidate.reducedMotion
            : DEFAULTS.reducedMotion,
        highContrast:
          typeof candidate.highContrast === "boolean"
            ? candidate.highContrast
            : DEFAULTS.highContrast,
        touchMode:
          candidate.touchMode === "auto" || candidate.touchMode === "on" || candidate.touchMode === "off"
            ? candidate.touchMode
            : DEFAULTS.touchMode,
      };
    } catch {
      this.state = { ...DEFAULTS };
    }
  }

  private persistSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      } catch {
        // Storage unavailable (private mode) — settings stay in memory.
      }
    }, 150);
  }
}
