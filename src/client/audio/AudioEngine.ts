import type { ClientSettings } from "../state/SettingsStore";

type SoundName =
  | "shot"
  | "enemyShot"
  | "hit"
  | "hurt"
  | "death"
  | "crystal"
  | "dash"
  | "respawn"
  | "countdown"
  | "live"
  | "ui"
  | "error"
  | "victory"
  | "defeat";

type MusicMode = "menu" | "game" | "results";

/**
 * All audio is synthesized at runtime with the Web Audio API — no external
 * assets, no licensing ambiguity. The AudioContext is created on the first
 * user gesture, as required by browser autoplay policies.
 */
export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private droneBus: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private padTimer: ReturnType<typeof setInterval> | null = null;
  private musicMode: MusicMode = "menu";
  private settings: ClientSettings;
  private unlocked = false;

  constructor(settings: ClientSettings) {
    this.settings = settings;
  }

  get isUnlocked(): boolean {
    return this.unlocked;
  }

  apply(settings: ClientSettings): void {
    this.settings = settings;
    if (!this.context) return;
    const now = this.context.currentTime;
    this.master?.gain.setTargetAtTime(settings.muted ? 0 : 1, now, 0.03);
    this.sfxBus?.gain.setTargetAtTime(Math.pow(settings.sfxVolume, 1.3) * 0.9, now, 0.03);
    this.musicBus?.gain.setTargetAtTime(this.musicLevel(), now, 0.08);
  }

  unlock(): void {
    if (!this.context) {
      try {
        this.context = new AudioContext();
      } catch {
        return;
      }
      this.buildGraph();
    }
    if (this.context.state === "suspended") {
      void this.context.resume();
    }
    if (!this.unlocked) {
      this.unlocked = true;
      this.startScore();
    }
  }

  setMusicMode(mode: MusicMode): void {
    this.musicMode = mode;
    if (!this.context || !this.musicBus) return;
    this.musicBus.gain.setTargetAtTime(this.musicLevel(), this.context.currentTime, 0.12);
    if (this.droneBus) {
      const droneLevel = mode === "game" ? 0.55 : mode === "results" ? 0.4 : 0.3;
      this.droneBus.gain.setTargetAtTime(droneLevel, this.context.currentTime, 0.3);
    }
  }

  play(name: SoundName, volume = 1): void {
    const ctx = this.context;
    const bus = this.sfxBus;
    if (!ctx || !bus || this.settings.muted || this.settings.sfxVolume <= 0) return;
    const t = ctx.currentTime;
    const v = Math.max(0, Math.min(1, volume));

    switch (name) {
      case "shot":
        this.tone("triangle", 720, 180, 0.075, 0.16 * v, t, bus);
        this.noise(0.045, 0.05 * v, t, bus, "highpass", 900);
        break;
      case "enemyShot":
        this.tone("triangle", 520, 150, 0.06, 0.06 * v, t, bus);
        break;
      case "hit":
        this.noise(0.08, 0.13 * v, t, bus, "bandpass", 1800, 1.2);
        this.tone("square", 260, 120, 0.05, 0.05 * v, t, bus);
        break;
      case "hurt":
        this.noise(0.16, 0.16 * v, t, bus, "lowpass", 700);
        this.tone("sawtooth", 180, 70, 0.16, 0.11 * v, t, bus);
        break;
      case "death":
        this.noise(0.5, 0.2 * v, t, bus, "lowpass", 620);
        this.tone("sawtooth", 150, 32, 0.45, 0.2 * v, t, bus);
        this.tone("sine", 90, 28, 0.5, 0.18 * v, t, bus);
        break;
      case "crystal":
        this.tone("sine", 988, 988, 0.09, 0.11 * v, t, bus);
        this.tone("sine", 1480, 1480, 0.12, 0.09 * v, t + 0.07, bus);
        break;
      case "dash":
        this.noise(0.28, 0.14 * v, t, bus, "bandpass", 500, 0.8, 3400);
        this.tone("sawtooth", 180, 620, 0.2, 0.05 * v, t, bus);
        break;
      case "respawn":
        this.tone("sine", 200, 760, 0.4, 0.12 * v, t, bus);
        this.tone("sine", 400, 1200, 0.32, 0.05 * v, t + 0.05, bus);
        break;
      case "countdown":
        this.tone("square", 520, 520, 0.09, 0.08 * v, t, bus);
        break;
      case "live":
        this.tone("sawtooth", 440, 440, 0.24, 0.06 * v, t, bus);
        this.tone("sawtooth", 660, 660, 0.24, 0.05 * v, t, bus);
        this.tone("sine", 880, 880, 0.3, 0.05 * v, t, bus);
        break;
      case "ui":
        this.tone("sine", 640, 620, 0.035, 0.045 * v, t, bus);
        break;
      case "error":
        this.tone("square", 220, 160, 0.12, 0.06 * v, t, bus);
        break;
      case "victory": {
        const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
        notes.forEach((freq, index) => {
          this.tone("triangle", freq, freq, 0.36, 0.08 * v, t + index * 0.11, bus);
          this.tone("sine", freq / 2, freq / 2, 0.42, 0.04 * v, t + index * 0.11, bus);
        });
        break;
      }
      case "defeat":
        this.tone("sine", 330, 220, 0.6, 0.08 * v, t, bus);
        this.tone("sine", 247, 165, 0.7, 0.06 * v, t + 0.15, bus);
        break;
    }
  }

  dispose(): void {
    if (this.padTimer) clearInterval(this.padTimer);
    this.padTimer = null;
    if (this.context) {
      void this.context.close();
    }
    this.context = null;
  }

  private buildGraph(): void {
    const ctx = this.context;
    if (!ctx) return;
    this.master = ctx.createGain();
    this.master.gain.value = this.settings.muted ? 0 : 1;
    this.master.connect(ctx.destination);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = Math.pow(this.settings.sfxVolume, 1.3) * 0.9;
    this.sfxBus.connect(this.master);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicLevel();
    this.musicBus.connect(this.master);

    this.noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.2), ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
  }

  private musicLevel(): number {
    const base = Math.pow(this.settings.musicVolume, 1.4) * 0.24;
    const mode = this.musicMode === "game" ? 1 : this.musicMode === "results" ? 0.72 : 0.6;
    return base * mode;
  }

  private startScore(): void {
    const ctx = this.context;
    const bus = this.musicBus;
    if (!ctx || !bus) return;

    this.droneBus = ctx.createGain();
    this.droneBus.gain.value = this.musicMode === "game" ? 0.55 : 0.3;
    this.droneBus.connect(bus);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 420;
    filter.Q.value = 0.7;
    filter.connect(this.droneBus);

    const frequencies = [55, 82.41, 110, 164.81];
    for (const frequency of frequencies) {
      const osc = ctx.createOscillator();
      osc.type = frequency > 120 ? "sine" : "sawtooth";
      osc.frequency.value = frequency;
      osc.detune.value = Math.random() * 12 - 6;
      const gain = ctx.createGain();
      gain.gain.value = frequency > 120 ? 0.035 : 0.055;
      osc.connect(gain).connect(filter);
      osc.start();
    }

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.055;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 130;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();

    const notes = [220, 261.63, 329.63, 392, 329.63, 261.63];
    let noteIndex = 0;
    const schedulePad = () => {
      const context = this.context;
      const target = this.droneBus;
      if (!context || !target) return;
      const frequency = notes[noteIndex % notes.length];
      noteIndex++;
      const when = context.currentTime + 0.05;
      const osc = context.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = frequency;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.05, when + 1.4);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 4.2);
      osc.connect(gain).connect(target);
      osc.start(when);
      osc.stop(when + 4.4);
    };
    schedulePad();
    this.padTimer = setInterval(schedulePad, 3_400);
  }

  private tone(
    type: OscillatorType,
    startFreq: number,
    endFreq: number,
    duration: number,
    peak: number,
    when: number,
    destination: AudioNode,
    detune = 0,
  ): void {
    const ctx = this.context;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, startFreq), when);
    if (endFreq !== startFreq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), when + duration);
    }
    osc.detune.value = detune;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    osc.connect(gain).connect(destination);
    osc.start(when);
    osc.stop(when + duration + 0.02);
  }

  private noise(
    duration: number,
    peak: number,
    when: number,
    destination: AudioNode,
    filterType: BiquadFilterType,
    frequency: number,
    q = 1,
    sweepTo?: number,
  ): void {
    const ctx = this.context;
    if (!ctx || !this.noiseBuffer) return;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(frequency, when);
    filter.Q.value = q;
    if (sweepTo !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(30, sweepTo), when + duration);
    }
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(0.0002, peak), when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    source.connect(filter).connect(gain).connect(destination);
    source.start(when);
    source.stop(when + duration + 0.02);
  }
}
