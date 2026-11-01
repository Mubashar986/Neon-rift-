/**
 * Captures the WebGL canvas (and, when available, the synthesized audio) so a
 * completed contract can be downloaded as a clip without external services.
 */
export class ClipRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private mimeType = "";

  static get supported(): boolean {
    return typeof window !== "undefined" && typeof window.MediaRecorder !== "undefined";
  }

  get active(): boolean {
    return this.recorder?.state === "recording";
  }

  get extension(): string {
    return this.mimeType.includes("mp4") ? "mp4" : "webm";
  }

  start(canvas: HTMLCanvasElement, audio: MediaStream | null, fps = 30): boolean {
    if (!ClipRecorder.supported || this.recorder) return false;
    if (typeof canvas.captureStream !== "function") return false;

    const video = canvas.captureStream(fps);
    const tracks: MediaStreamTrack[] = [...video.getVideoTracks()];
    if (audio) tracks.push(...audio.getAudioTracks());
    const stream = new MediaStream(tracks);

    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    ];
    const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
    try {
      this.recorder = new MediaRecorder(stream, {
        mimeType: mimeType || undefined,
        videoBitsPerSecond: 4_500_000,
      });
    } catch {
      this.recorder = null;
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }

    this.mimeType = mimeType;
    this.chunks = [];
    this.stream = stream;
    this.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
    this.recorder.start(1_000);
    return true;
  }

  async stop(): Promise<Blob | null> {
    const recorder = this.recorder;
    if (!recorder) return null;
    const done = new Promise<Blob | null>((resolve) => {
      recorder.addEventListener(
        "stop",
        () => {
          const blob = new Blob(this.chunks, { type: this.mimeType || "video/webm" });
          resolve(blob.size > 0 ? blob : null);
        },
        { once: true },
      );
    });
    if (recorder.state !== "inactive") recorder.stop();
    const blob = await done;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.recorder = null;
    this.stream = null;
    return blob;
  }

  static download(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  static captureFrame(canvas: HTMLCanvasElement, filename: string): void {
    const url = canvas.toDataURL("image/png");
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  }
}
