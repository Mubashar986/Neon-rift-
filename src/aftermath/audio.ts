/**
 * Synthesized audio for AFTERMATH. No binary assets: rain, gunfire, impacts,
 * reloads and radio chatter are generated with WebAudio.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private ambient: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private rainSource: AudioBufferSourceNode | null = null;
  private hum: OscillatorNode | null = null;
  private captureNode: MediaStreamAudioDestinationNode | null = null;
  private started = false;

  get isStarted(): boolean {
    return this.started;
  }

  get captureStream(): MediaStream | null {
    return this.captureNode?.stream ?? null;
  }

  async start(): Promise<void> {
    if (this.started && this.ctx && this.ctx.state === "running") return;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.7;
      this.master.connect(this.ctx.destination);
      this.sfx = this.ctx.createGain();
      this.sfx.gain.value = 0.85;
      this.sfx.connect(this.master);
      this.ambient = this.ctx.createGain();
      this.ambient.gain.value = 0.5;
      this.ambient.connect(this.master);
      this.noise = this.makeNoise(1.2);
      this.captureNode = this.ctx.createMediaStreamDestination();
      this.master.connect(this.captureNode);
    }
    await this.ctx.resume();
    if (!this.started) {
      this.started = true;
      this.startAmbience();
    }
  }

  setMasterVolume(value: number): void {
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(Math.max(0, Math.min(1, value)) * 0.8, this.ctx.currentTime, 0.05);
    }
  }

  shot(pan: number, distance: number, heavy = false): void {
    if (!this.ctx || !this.sfx || !this.noise) return;
    const gain = this.distanceGain(distance) * (heavy ? 0.9 : 0.62);
    const t = this.ctx.currentTime;
    const output = this.panner(pan);

    const crack = this.ctx.createBufferSource();
    crack.buffer = this.noise;
    const band = this.ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = heavy ? 680 : 1_250;
    band.Q.value = 0.7;
    const crackGain = this.ctx.createGain();
    crackGain.gain.setValueAtTime(gain, t);
    crackGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    crack.connect(band).connect(crackGain).connect(output);
    crack.start(t);
    crack.stop(t + 0.16);

    const thump = this.ctx.createOscillator();
    thump.type = "triangle";
    thump.frequency.setValueAtTime(heavy ? 72 : 108, t);
    thump.frequency.exponentialRampToValueAtTime(38, t + 0.16);
    const thumpGain = this.ctx.createGain();
    thumpGain.gain.setValueAtTime(gain * 0.8, t);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    thump.connect(thumpGain).connect(output);
    thump.start(t);
    thump.stop(t + 0.22);
  }

  enemyShot(pan: number, distance: number): void {
    if (!this.ctx || !this.sfx || !this.noise) return;
    const gain = this.distanceGain(distance) * 0.38;
    const t = this.ctx.currentTime;
    const output = this.panner(pan);
    const crack = this.ctx.createBufferSource();
    crack.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 900;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    crack.connect(filter).connect(env).connect(output);
    crack.start(t);
    crack.stop(t + 0.12);
  }

  impact(pan: number, distance: number): void {
    if (!this.ctx || !this.sfx || !this.noise) return;
    const gain = this.distanceGain(distance) * 0.28;
    const t = this.ctx.currentTime;
    const output = this.panner(pan);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 2_600;
    filter.Q.value = 1.2;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    src.connect(filter).connect(env).connect(output);
    src.start(t);
    src.stop(t + 0.08);
  }

  hit(headshot = false): void {
    if (!this.ctx || !this.sfx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(headshot ? 1_450 : 880, t);
    osc.frequency.exponentialRampToValueAtTime(headshot ? 2_100 : 1_180, t + 0.045);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.12, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    osc.connect(env).connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.08);
  }

  reload(): void {
    if (!this.ctx || !this.sfx) return;
    for (let i = 0; i < 2; i += 1) {
      const t = this.ctx.currentTime + i * 0.28 + 0.05;
      const osc = this.ctx.createOscillator();
      osc.type = "square";
      osc.frequency.setValueAtTime(210 - i * 40, t);
      const env = this.ctx.createGain();
      env.gain.setValueAtTime(0.055, t);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      osc.connect(env).connect(this.sfx);
      osc.start(t);
      osc.stop(t + 0.06);
    }
  }

  footstep(pan: number, sprinting: boolean): void {
    if (!this.ctx || !this.sfx || !this.noise) return;
    const t = this.ctx.currentTime;
    const output = this.panner(pan);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = sprinting ? 520 : 380;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(sprinting ? 0.075 : 0.045, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    src.connect(filter).connect(env).connect(output);
    src.start(t);
    src.stop(t + 0.12);
  }

  radio(): void {
    this.beep(1_220, 0.04, 0.05);
    this.beep(760, 0.05, 0.12);
  }

  alarm(): void {
    this.beep(520, 0.12, 0.04);
    this.beep(390, 0.14, 0.18);
  }

  success(): void {
    [440, 554, 659, 880].forEach((freq, i) => this.beep(freq, 0.12, i * 0.11, "triangle", 0.07));
  }

  fail(): void {
    [330, 247, 165].forEach((freq, i) => this.beep(freq, 0.2, i * 0.16, "sawtooth", 0.06));
  }

  thunder(distance = 0.4): void {
    if (!this.ctx || !this.ambient || !this.noise) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(320, t);
    filter.frequency.exponentialRampToValueAtTime(90, t + 1.4);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.22 * (1 - distance * 0.5), t + 0.08);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
    src.connect(filter).connect(env).connect(this.ambient);
    src.start(t);
    src.stop(t + 1.9);
  }

  dispose(): void {
    this.rainSource?.stop();
    this.hum?.stop();
    void this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }

  private startAmbience(): void {
    if (!this.ctx || !this.ambient || !this.noise) return;
    const rain = this.ctx.createBufferSource();
    rain.buffer = this.noise;
    rain.loop = true;
    const low = this.ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 4_200;
    const high = this.ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 420;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.055;
    rain.connect(low).connect(high).connect(gain).connect(this.ambient);
    rain.start();
    this.rainSource = rain;

    const hum = this.ctx.createOscillator();
    hum.type = "sine";
    hum.frequency.value = 47;
    const humGain = this.ctx.createGain();
    humGain.gain.value = 0.012;
    hum.connect(humGain).connect(this.ambient);
    hum.start();
    this.hum = hum;
  }

  private beep(
    frequency: number,
    duration: number,
    delay = 0,
    type: OscillatorType = "sine",
    gain = 0.06,
  ): void {
    if (!this.ctx || !this.sfx) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, t);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(env).connect(this.sfx);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  private panner(pan: number): GainNode {
    const ctx = this.ctx!;
    const node = ctx.createStereoPanner();
    node.pan.value = Math.max(-1, Math.min(1, pan));
    const gain = ctx.createGain();
    gain.gain.value = 1;
    node.connect(gain).connect(this.sfx!);
    return gain;
  }

  private distanceGain(distance: number): number {
    return Math.max(0.025, 1 / (1 + Math.max(0, distance) * 0.09));
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      last = last * 0.72 + white * 0.28;
      data[i] = last;
    }
    return buffer;
  }
}
