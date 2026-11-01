import type { RoomSettings } from "@shared/game-rules";
import type { RoomView } from "@shared/types";
import { byId, clearChildren, el, initials, playerColor } from "./dom";

export interface LobbyCallbacks {
  onReadyToggle: () => void;
  onStart: () => void;
  onLeave: () => void;
  onCopyCode: () => void;
  onCopyLink: () => void;
  onShare: () => void;
  onSettingsChange: (settings: RoomSettings) => void;
}

export class LobbyController {
  private code = byId("lobby-code");
  private count = byId("lobby-count");
  private roster = byId("lobby-players");
  private readyButton = byId<HTMLButtonElement>("btn-ready");
  private startButton = byId<HTMLButtonElement>("btn-start-match");
  private leaveButton = byId<HTMLButtonElement>("btn-leave-room");
  private visibility = byId("lobby-visibility");
  private autoStart = byId("lobby-auto-start");
  private connection = byId("lobby-connection");
  private maxPlayers = byId<HTMLSelectElement>("setting-max-players");
  private duration = byId<HTMLSelectElement>("setting-duration");
  private scoreLimit = byId<HTMLSelectElement>("setting-score-limit");
  private settingsLock = byId("settings-lock-hint");
  private note = document.querySelector<HTMLElement>(".lobby-note");
  private autoStartTimer: ReturnType<typeof setInterval> | null = null;
  private autoStartDeadline: number | null = null;
  private selfId: string | null = null;

  constructor(private readonly callbacks: LobbyCallbacks) {
    this.readyButton.addEventListener("click", () => this.callbacks.onReadyToggle());
    this.startButton.addEventListener("click", () => this.callbacks.onStart());
    this.leaveButton.addEventListener("click", () => this.callbacks.onLeave());
    byId("btn-copy-code").addEventListener("click", () => this.callbacks.onCopyCode());
    byId("btn-copy-link").addEventListener("click", () => this.callbacks.onCopyLink());
    byId("btn-share").addEventListener("click", () => this.callbacks.onShare());

    for (const select of [this.maxPlayers, this.duration, this.scoreLimit]) {
      select.addEventListener("change", () => this.emitSettings());
    }
  }

  render(room: RoomView, selfId: string): void {
    this.selfId = selfId;
    this.code.textContent = room.code;
    this.count.textContent = `${room.players.length} / ${room.settings.maxPlayers}`;
    this.visibility.textContent = room.isPrivate ? "PRIVATE ARENA" : "PUBLIC ARENA";
    this.visibility.classList.toggle("tag--violet", room.isPrivate);

    this.renderRoster(room);

    const self = room.players.find((player) => player.id === selfId);
    const isHost = room.hostId === selfId;
    const connected = room.players.filter((player) => player.connected).length;

    this.readyButton.classList.toggle("is-ready", Boolean(self?.ready));
    this.readyButton.textContent = self?.ready ? "READY ✓" : "READY UP";
    this.readyButton.disabled = !self?.connected;

    this.startButton.disabled = !isHost || connected === 0;
    this.startButton.textContent = isHost ? "START MATCH" : "HOST STARTS";

    for (const select of [this.maxPlayers, this.duration, this.scoreLimit]) {
      select.disabled = !isHost;
    }
    this.settingsLock.textContent = isHost
      ? "Changes apply instantly for every pilot."
      : "Only the host can edit arena config.";

    for (const option of [...this.maxPlayers.options]) {
      const value = Number(option.value);
      option.disabled = value < room.players.length;
    }
    this.maxPlayers.value = String(room.settings.maxPlayers);
    this.duration.value = String(room.settings.durationSec);
    this.scoreLimit.value = String(room.settings.scoreLimit);

    if (this.note) {
      this.note.textContent = isHost
        ? "You control the launch. Readiness is visible to everyone."
        : "The host controls the launch. Ready up to show you're set.";
    }

    this.updateAutoStart(room);
  }

  setConnection(state: "online" | "connecting" | "offline"): void {
    this.connection.dataset.state = state;
    const label = this.connection.querySelector("span:last-child");
    if (label) {
      label.textContent =
        state === "online"
          ? "RIFT LINK ACTIVE"
          : state === "connecting"
            ? "RELINKING"
            : "RIFT LINK LOST";
    }
  }

  dispose(): void {
    this.stopAutoStartTimer();
  }

  private renderRoster(room: RoomView): void {
    clearChildren(this.roster);
    for (const player of room.players) {
      const item = el("li", "lobby-player");
      item.dataset.playerId = player.id;
      if (player.id === this.selfId) item.classList.add("is-self");
      if (!player.connected) item.classList.add("is-disconnected");

      const avatar = el("div", "avatar");
      avatar.style.setProperty("--avatar-color", playerColor(player.color));
      avatar.appendChild(el("span", "avatar__initial", initials(player.name)));
      if (player.isHost) {
        avatar.appendChild(el("span", "avatar__crown", "★"));
      }
      item.appendChild(avatar);

      const copy = el("div", "lobby-player__copy");
      copy.appendChild(el("span", "lobby-player__name", player.name));

      const meta = el("div", "lobby-player__meta");
      if (player.isHost) meta.appendChild(el("span", "host-badge", "HOST"));
      meta.appendChild(el("span", undefined, player.connected ? "PILOT" : "SIGNAL LOST"));
      copy.appendChild(meta);
      item.appendChild(copy);

      const badge = el(
        "span",
        player.ready ? "ready-badge" : "ready-badge is-waiting",
        player.ready ? "READY" : "STANDBY",
      );
      if (!player.connected) {
        badge.textContent = "AWAY";
        badge.classList.add("is-waiting");
      }
      item.appendChild(badge);
      this.roster.appendChild(item);
    }

    for (let slot = room.players.length; slot < room.settings.maxPlayers; slot++) {
      const item = el("li", "lobby-player is-empty");
      item.dataset.empty = "true";
      const avatar = el("div", "avatar avatar--empty", "+");
      item.appendChild(avatar);
      const copy = el("div", "lobby-player__copy");
      copy.appendChild(el("span", "lobby-player__name", "OPEN SLOT"));
      copy.appendChild(el("span", "lobby-player__meta", "AWAITING PILOT"));
      item.appendChild(copy);
      item.appendChild(el("span", "ready-badge is-waiting", "EMPTY"));
      this.roster.appendChild(item);
    }
  }

  private updateAutoStart(room: RoomView): void {
    this.stopAutoStartTimer();
    if (room.autoStartInMs === null) {
      this.autoStart.hidden = true;
      this.autoStartDeadline = null;
      return;
    }
    this.autoStartDeadline = Date.now() + room.autoStartInMs;
    this.autoStart.hidden = false;
    const tick = () => {
      if (this.autoStartDeadline === null) return;
      const remaining = Math.max(0, this.autoStartDeadline - Date.now());
      this.autoStart.textContent = `PUBLIC ARENA AUTO-STARTS IN ${(remaining / 1000).toFixed(1)}s`;
      if (remaining <= 0) this.stopAutoStartTimer();
    };
    tick();
    this.autoStartTimer = setInterval(tick, 200);
  }

  private stopAutoStartTimer(): void {
    if (this.autoStartTimer) clearInterval(this.autoStartTimer);
    this.autoStartTimer = null;
  }

  private emitSettings(): void {
    const settings: RoomSettings = {
      maxPlayers: Number(this.maxPlayers.value),
      durationSec: Number(this.duration.value),
      scoreLimit: Number(this.scoreLimit.value),
    };
    this.callbacks.onSettingsChange(settings);
  }
}
