import { PROTOCOL_VERSION } from "@shared/constants";
import { DEFAULT_ROOM_SETTINGS } from "@shared/game-rules";
import type { RoomSettings } from "@shared/game-rules";
import { normalizeRoomCode } from "@shared/protocol";
import type {
  MatchResults,
  MatchStartInfo,
  RoomView,
  SnapshotMsg,
} from "@shared/types";
import { AudioEngine } from "./audio/AudioEngine";
import { NeonGame } from "./game/NeonGame";
import type { GameInput } from "./game/types";
import { NetClient } from "./net/NetClient";
import { SettingsStore } from "./state/SettingsStore";
import type { ClientSettings } from "./state/SettingsStore";
import { HudController } from "./ui/HudController";
import { LobbyController } from "./ui/LobbyController";
import { ModalManager } from "./ui/ModalManager";
import { ResultsController } from "./ui/ResultsController";
import { TouchControls } from "./ui/TouchControls";
import {
  byId,
  copyText,
  invitationUrl,
  inviteCodeFromLocation,
  isValidNickname,
} from "./ui/dom";

export type ScreenName = "menu" | "lobby" | "game" | "results";

export interface NeonRiftCameraState {
  scrollX: number;
  scrollY: number;
  zoom: number;
  viewX: number;
  viewY: number;
  viewWidth: number;
  viewHeight: number;
}

export interface NeonRiftDebugState {
  screen: ScreenName;
  online: boolean;
  selfId: string | null;
  nickname: string;
  roomCode: string | null;
  room: RoomView | null;
  match: MatchStartInfo | null;
  results: MatchResults | null;
  snapshot: SnapshotMsg | null;
  latency: number | null;
  touchMode: boolean;
  arenaActive: boolean;
  camera: NeonRiftCameraState | null;
}

export interface NeonRiftDebug {
  version: string;
  getState(): NeonRiftDebugState;
}

declare global {
  interface Window {
    __NEON_RIFT__?: NeonRiftDebug;
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  room_not_found: "No arena answers to that key.",
  room_full: "That arena is already full.",
  room_started: "That match has already started.",
  not_host: "Only the host can do that.",
  in_room: "You are already in an arena.",
  not_in_room: "Join an arena first.",
  invalid_settings: "Those arena settings cannot be applied.",
  rate_limited: "The rift is throttling you — slow down.",
  invalid_name: "That callsign is not valid.",
  server_full: "The rift network is at capacity. Try again shortly.",
};

const MAX_NICKNAME = 16;

export class NeonRiftApp {
  private readonly settings = new SettingsStore();
  private readonly audio: AudioEngine;
  private readonly modal: ModalManager;
  private readonly touch: TouchControls;
  private readonly game: NeonGame;
  private readonly net: NetClient;
  private readonly hud: HudController;
  private readonly lobby: LobbyController;
  private readonly results: ResultsController;

  private readonly screens: Record<ScreenName, HTMLElement>;
  private readonly nicknameInput = byId<HTMLInputElement>("nickname");
  private readonly nicknameCount = byId("nickname-count");
  private readonly nicknameHint = byId("nickname-hint");
  private readonly connectionPill = byId("connection-pill");
  private readonly connectionText = byId("connection-text");
  private readonly menuPing = byId("menu-ping");
  private readonly menuServerMode = byId("menu-server-mode");
  private readonly quickButton = byId<HTMLButtonElement>("btn-quick-match");
  private readonly createButton = byId<HTMLButtonElement>("btn-create-room");
  private readonly joinButton = byId<HTMLButtonElement>("btn-join-room");
  private readonly joinForm = byId<HTMLFormElement>("join-form");
  private readonly joinNameInput = byId<HTMLInputElement>("join-name");
  private readonly joinCodeInput = byId<HTMLInputElement>("join-code");
  private readonly joinError = byId("join-error");
  private readonly joinInviteNote = byId("join-invite-note");
  private readonly reconnectBanner = byId("reconnect-banner");
  private readonly reconnectText = byId("reconnect-text");
  private readonly toastRoot = byId("toast-root");
  private readonly bootScreen = byId("boot-screen");
  private readonly bootBar = byId("boot-bar-fill");
  private readonly bootStatus = byId("boot-status");
  private readonly pauseButton = byId<HTMLButtonElement>("btn-pause");
  private readonly resumeButton = byId<HTMLButtonElement>("btn-resume");
  private readonly pauseSettings = byId<HTMLButtonElement>("btn-pause-settings");
  private readonly pauseHelp = byId<HTMLButtonElement>("btn-pause-help");
  private readonly leaveMatchButton = byId<HTMLButtonElement>("btn-leave-match");
  private readonly qualityButtons = [
    ...document.querySelectorAll<HTMLButtonElement>("[data-quality]"),
  ];
  private readonly sfxSlider = byId<HTMLInputElement>("setting-sfx");
  private readonly sfxValue = byId<HTMLOutputElement>("setting-sfx-value");
  private readonly musicSlider = byId<HTMLInputElement>("setting-music");
  private readonly musicValue = byId<HTMLOutputElement>("setting-music-value");
  private readonly muteToggle = byId<HTMLInputElement>("setting-mute");
  private readonly shakeToggle = byId<HTMLInputElement>("setting-shake");
  private readonly motionToggle = byId<HTMLInputElement>("setting-reduce-motion");
  private readonly contrastToggle = byId<HTMLInputElement>("setting-contrast");
  private readonly touchSelect = byId<HTMLSelectElement>("setting-touch");
  private readonly resetSettingsButton = byId<HTMLButtonElement>("btn-reset-settings");

  private screen: ScreenName = "menu";
  private selfId: string | null = null;
  private currentRoom: RoomView | null = null;
  private currentMatch: MatchStartInfo | null = null;
  private currentResults: MatchResults | null = null;
  private lastSnapshot: SnapshotMsg | null = null;
  private lastCountdownSecond: number | null = null;
  private lastStatus: "connecting" | "online" | "offline" = "offline";
  private tabHidden = false;
  private pendingInviteCode: string | null = null;
  private pendingJoinCode: string | null = null;
  private pendingQuickMatch = false;
  private nameTimer: ReturnType<typeof setTimeout> | null = null;
  private resultsBusyTimer: ReturnType<typeof setTimeout> | null = null;
  private bootedAt = performance.now();
  private bootMinimumMs = 650;

  constructor() {
    this.audio = new AudioEngine(this.settings.value);
    this.screens = {
      menu: byId("screen-menu"),
      lobby: byId("screen-lobby"),
      game: byId("screen-game"),
      results: byId("screen-results"),
    };
    this.touch = new TouchControls();
    this.game = new NeonGame("game-root", this.settings.value, this.touch);
    this.net = new NetClient(this.settings.nickname);
    this.hud = new HudController();
    this.lobby = new LobbyController({
      onReadyToggle: () => this.toggleReady(),
      onStart: () => this.startMatch(),
      onLeave: () => this.leaveRoom(),
      onCopyCode: () => void this.copyRoomCode(),
      onCopyLink: () => void this.copyInviteLink(),
      onShare: () => void this.shareInvite(),
      onSettingsChange: (settings) => this.updateRoomSettings(settings),
    });
    this.results = new ResultsController({
      onRematch: () => this.requestRematch(),
      onPlayAgain: () => this.playAgain(),
      onReturnLobby: () => this.returnToLobby(),
    });
    this.modal = new ModalManager({
      onTopChange: () => this.refreshPauseState(),
      onOpen: () => this.audio.play("ui", 0.6),
    });

    this.bindUi();
    this.bindSettings();
    this.bindNetwork();
    this.installDebugApi();
    this.setScreen("menu");
    this.audio.setMusicMode("menu");
    this.bootedAt = performance.now();
    this.startBootSequence();
    this.net.connect();
  }

  /* ------------------------------------------------------------------ */
  /* Boot + settings                                                    */
  /* ------------------------------------------------------------------ */

  private startBootSequence(): void {
    this.bootStatus.textContent = "PAINTING THE RIFT";
    this.bootBar.style.width = "32%";
    this.pendingInviteCode = inviteCodeFromLocation();

    this.game.ready
      .then(() => {
        this.bootStatus.textContent = "RIFT DRIVE ONLINE";
        this.bootBar.style.width = "100%";
        const wait = Math.max(0, this.bootMinimumMs - (performance.now() - this.bootedAt));
        window.setTimeout(() => {
          this.bootScreen.classList.add("is-hidden");
          if (this.pendingInviteCode && !this.currentRoom && this.lastStatus === "online") {
            this.openJoinModal(this.pendingInviteCode);
            this.pendingInviteCode = null;
          }
        }, wait);
      })
      .catch(() => {
        this.bootStatus.textContent = "RIFT DRIVE FAULT";
        this.toast("The renderer failed to start. Reload the page.", "error");
      });

    window.setTimeout(() => {
      if (this.bootBar.style.width === "32%") this.bootBar.style.width = "68%";
    }, 700);
  }

  private bindSettings(): void {
    this.settings.subscribe((settings) => {
      this.syncSettingsUi(settings);
      this.audio.apply(settings);
      this.game.setSettings(settings);
      this.game.setTouchActive(this.settings.touchActive);
      document.body.classList.toggle("touch-mode", this.settings.touchActive);
      if (this.screen === "game") this.touch.setActive(this.settings.touchActive);
      if (settings.nickname !== this.net.playerName && isValidNickname(settings.nickname)) {
        this.net.setPreferredName(settings.nickname);
      }
    });

    this.sfxSlider.addEventListener("input", () => {
      this.settings.update({ sfxVolume: Number(this.sfxSlider.value) / 100 });
    });
    this.musicSlider.addEventListener("input", () => {
      this.settings.update({ musicVolume: Number(this.musicSlider.value) / 100 });
    });
    this.muteToggle.addEventListener("change", () => {
      this.settings.update({ muted: this.muteToggle.checked });
    });
    this.shakeToggle.addEventListener("change", () => {
      this.settings.update({ screenShake: this.shakeToggle.checked });
    });
    this.motionToggle.addEventListener("change", () => {
      this.settings.update({ reducedMotion: this.motionToggle.checked });
    });
    this.contrastToggle.addEventListener("change", () => {
      this.settings.update({ highContrast: this.contrastToggle.checked });
    });
    this.touchSelect.addEventListener("change", () => {
      const value = this.touchSelect.value;
      this.settings.update({
        touchMode: value === "on" || value === "off" ? value : "auto",
      });
    });
    for (const button of this.qualityButtons) {
      button.addEventListener("click", () => {
        const quality = button.dataset.quality;
        if (quality === "low" || quality === "medium" || quality === "high") {
          this.settings.update({ quality });
        }
      });
    }
    this.resetSettingsButton.addEventListener("click", () => {
      this.settings.reset();
      this.toast("Pilot defaults restored.", "success");
    });
  }

  private syncSettingsUi(settings: ClientSettings): void {
    this.sfxSlider.value = String(Math.round(settings.sfxVolume * 100));
    this.sfxValue.textContent = `${Math.round(settings.sfxVolume * 100)}%`;
    this.musicSlider.value = String(Math.round(settings.musicVolume * 100));
    this.musicValue.textContent = `${Math.round(settings.musicVolume * 100)}%`;
    this.muteToggle.checked = settings.muted;
    this.shakeToggle.checked = settings.screenShake;
    this.motionToggle.checked = settings.reducedMotion;
    this.contrastToggle.checked = settings.highContrast;
    this.touchSelect.value = settings.touchMode;
    for (const button of this.qualityButtons) {
      button.classList.toggle("is-active", button.dataset.quality === settings.quality);
    }
    if (this.nicknameInput.value !== settings.nickname && document.activeElement !== this.nicknameInput) {
      this.nicknameInput.value = settings.nickname;
      this.updateNicknameCount();
    }
    if (
      this.joinNameInput.value === "" &&
      settings.nickname !== "" &&
      document.activeElement !== this.joinNameInput
    ) {
      this.joinNameInput.value = settings.nickname;
    }
  }

  /* ------------------------------------------------------------------ */
  /* UI wiring                                                          */
  /* ------------------------------------------------------------------ */

  private bindUi(): void {
    this.nicknameInput.value = this.settings.nickname;
    this.updateNicknameCount();
    this.nicknameInput.addEventListener("input", () => {
      const value = this.nicknameInput.value.slice(0, MAX_NICKNAME);
      if (value !== this.nicknameInput.value) this.nicknameInput.value = value;
      this.settings.update({ nickname: value });
      this.updateNicknameCount();
      this.nicknameHint.textContent = "2–16 characters · no account required";
      this.nicknameHint.classList.remove("is-error");
      this.net.setPreferredName(value);
      if (this.nameTimer) clearTimeout(this.nameTimer);
      if (isValidNickname(value)) {
        this.nameTimer = setTimeout(() => {
          this.nameTimer = null;
          if (this.net.isOnline) this.net.setName(value);
        }, 550);
      }
    });
    this.nicknameInput.addEventListener("blur", () => {
      this.nicknameInput.value = this.nicknameInput.value.trim();
    });

    this.quickButton.addEventListener("click", () => this.quickMatch());
    this.createButton.addEventListener("click", () => this.createPrivateRoom());
    this.joinButton.addEventListener("click", () => this.openJoinModal());

    this.joinNameInput.addEventListener("input", () => {
      const value = this.joinNameInput.value.slice(0, MAX_NICKNAME);
      if (value !== this.joinNameInput.value) this.joinNameInput.value = value;
      this.joinError.hidden = true;
    });
    this.joinCodeInput.addEventListener("input", () => {
      const cleaned = this.joinCodeInput.value
        .toUpperCase()
        .replace(/[^A-Z2-9]/g, "")
        .replace(/[IO01]/g, "")
        .slice(0, 6);
      if (cleaned !== this.joinCodeInput.value) this.joinCodeInput.value = cleaned;
      this.joinError.hidden = true;
    });
    this.joinForm.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submitJoin();
    });

    this.pauseButton.addEventListener("click", () => {
      if (this.screen === "game") this.modal.open("pause");
    });
    this.resumeButton.addEventListener("click", () => {
      this.modal.closeAll();
    });
    this.pauseSettings.addEventListener("click", () => this.modal.open("settings"));
    this.pauseHelp.addEventListener("click", () => this.modal.open("help"));
    this.leaveMatchButton.addEventListener("click", () => {
      this.modal.closeAll();
      this.leaveRoom();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (this.modal.isOpen) {
          event.preventDefault();
          this.modal.closeTop();
          return;
        }
        if (this.screen === "game") {
          event.preventDefault();
          this.modal.open("pause");
        }
      }
    });

    document.addEventListener("visibilitychange", () => {
      this.tabHidden = document.hidden;
      this.refreshPauseState();
    });

    const unlock = () => this.audio.unlock();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });

    document.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest("button");
      if (button && !button.disabled) this.audio.play("ui", 0.5);
    });

    document.addEventListener("contextmenu", (event) => {
      if (this.screen === "game") event.preventDefault();
    });

    window.addEventListener("resize", () => {
      this.touch.setActive(this.screen === "game" && this.settings.touchActive);
    });

    window.addEventListener("beforeunload", () => {
      this.net.destroy();
      this.audio.dispose();
    });
  }

  private updateNicknameCount(): void {
    this.nicknameCount.textContent = `${[...this.nicknameInput.value].length}/${MAX_NICKNAME}`;
  }

  private setScreen(screen: ScreenName): void {
    this.screen = screen;
    document.body.dataset.screen = screen;
    for (const name of Object.keys(this.screens) as ScreenName[]) {
      const element = this.screens[name];
      const active = name === screen;
      element.hidden = !active;
      element.classList.toggle("is-active", active);
    }
    this.refreshPauseState();
    if (screen !== "game") this.touch.setActive(false);
    this.hud.setPing(this.net.latency, this.net.isOnline);
  }

  private refreshPauseState(): void {
    const paused = this.screen === "game" && (this.modal.isOpen || this.tabHidden);
    this.game.setArenaPaused(paused);
    if (paused) this.touch.reset();
  }

  private toast(message: string, tone: "info" | "warn" | "error" | "success" = "info"): void {
    const toast = document.createElement("div");
    toast.className = `toast toast--${tone}`;
    toast.textContent = message;
    this.toastRoot.appendChild(toast);
    window.setTimeout(() => {
      toast.classList.add("is-leaving");
      window.setTimeout(() => toast.remove(), 260);
    }, 3_600);
    while (this.toastRoot.children.length > 4) {
      this.toastRoot.firstElementChild?.remove();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Network                                                            */
  /* ------------------------------------------------------------------ */

  private bindNetwork(): void {
    this.net.on("status", (status) => {
      this.lastStatus = status.state;
      const online = status.state === "online";
      this.connectionPill.dataset.state = status.state;
      this.connectionText.textContent = online
        ? "RIFT NETWORK ONLINE"
        : status.state === "connecting"
          ? "LINKING TO RIFT NETWORK"
          : "RIFT LINK LOST — RETRYING";
      this.menuServerMode.textContent = online ? "ONLINE" : status.state === "connecting" ? "LINKING" : "OFFLINE";
      this.quickButton.disabled = !online;
      this.createButton.disabled = !online;
      this.joinButton.disabled = !online;
      this.lobby.setConnection(status.state);
      this.hud.setPing(this.net.latency, online);
      this.reconnectBanner.hidden = online || !this.net.everOnline;
      if (!online) {
        const retry = status.retryInMs ? ` · retry in ${Math.ceil(status.retryInMs / 1000)}s` : "";
        this.reconnectText.textContent = `Reconnecting to the arena${status.attempt > 1 ? ` (attempt ${status.attempt})` : ""}${retry}…`;
      }
    });

    this.net.on("welcome", (welcome) => {
      this.selfId = welcome.you;
      this.quickButton.disabled = false;
      this.createButton.disabled = false;
      this.joinButton.disabled = false;

      if (!isValidNickname(this.nicknameInput.value)) {
        this.nicknameInput.value = welcome.name;
        this.settings.update({ nickname: welcome.name });
        this.updateNicknameCount();
      }

      if (welcome.resumed) {
        this.toast("Rift link restored.", "success");
      }

      if (welcome.match) {
        if (
          this.currentMatch &&
          this.currentMatch.roomCode === welcome.match.roomCode &&
          this.currentMatch.startedAt === welcome.match.startedAt &&
          this.screen === "game"
        ) {
          return;
        }
        this.currentRoom = welcome.room;
        this.enterMatch(welcome.match);
        return;
      }

      if (welcome.results) {
        this.currentRoom = welcome.room;
        this.showResults(welcome.results, welcome.room);
        return;
      }

      if (welcome.room?.phase === "lobby") {
        this.showLobby(welcome.room);
        return;
      }

      if (this.pendingInviteCode) {
        const code = this.pendingInviteCode;
        this.pendingInviteCode = null;
        this.openJoinModal(code);
      }
    });

    this.net.on("room", (message) => {
      if (!this.selfId) return;
      const room = message.room;
      if (!room.players.some((player) => player.id === this.selfId)) return;
      this.pendingJoinCode = null;
      this.currentRoom = room;

      if (room.phase === "lobby") {
        this.currentMatch = null;
        this.currentResults = null;
        this.showLobby(room);
        return;
      }

      if (room.phase === "finished" && this.currentResults) {
        this.results.render(this.currentResults, this.selfId, room.hostId === this.selfId);
        this.results.setBusy(false);
      }
    });

    this.net.on("matchStart", (message) => {
      this.enterMatch(message.match);
    });

    this.net.on("snapshot", (snapshot) => this.handleSnapshot(snapshot));

    this.net.on("matchEnd", (message) => {
      this.showResults(message.results, this.currentRoom);
    });

    this.net.on("latency", (latency) => {
      this.menuPing.textContent = `${Math.round(latency)} ms`;
      if (this.screen === "game") this.hud.setPing(latency, true);
    });

    this.net.on("leftRoom", (message) => {
      const quick = this.pendingQuickMatch;
      this.pendingQuickMatch = false;
      this.currentRoom = null;
      this.currentMatch = null;
      this.currentResults = null;
      this.selfId = this.net.playerId;
      this.audio.setMusicMode("menu");
      this.setScreen("menu");
      this.touch.setActive(false);
      this.modal.closeAll();
      void this.game.showAmbient();
      this.updateUrl();
      if (message.reason === "voluntary") {
        this.toast("Left the arena.", "info");
      } else {
        this.toast(message.message ?? "The arena closed.", message.reason === "expired" ? "warn" : "info");
      }
      if (quick) {
        window.setTimeout(() => this.quickMatch(), 220);
      }
    });

    this.net.on("notice", (notice) => {
      this.toast(notice.message, notice.tone === "warn" ? "warn" : "info");
    });

    this.net.on("error", (error) => {
      this.results.setBusy(false);
      if (this.resultsBusyTimer) {
        clearTimeout(this.resultsBusyTimer);
        this.resultsBusyTimer = null;
      }

      const friendly = ERROR_MESSAGES[error.code] ?? error.message;
      if (
        this.pendingJoinCode &&
        (error.code === "room_not_found" ||
          error.code === "room_full" ||
          error.code === "room_started" ||
          error.code === "in_room")
      ) {
        this.pendingJoinCode = null;
        this.joinError.textContent = friendly;
        this.joinError.hidden = false;
        this.modal.open("join");
        this.audio.play("error", 0.7);
        return;
      }

      if (error.fatal && error.code === "session_takeover") {
        this.net.clearSession();
        void this.net.disconnect();
        this.toast("This pilot session was resumed in another tab.", "error");
        this.connectionText.textContent = "SESSION MOVED";
        this.connectionPill.dataset.state = "offline";
        return;
      }

      this.toast(friendly, error.fatal ? "error" : "warn");
      this.audio.play("error", 0.6);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Routing                                                            */
  /* ------------------------------------------------------------------ */

  private showLobby(room: RoomView): void {
    this.currentRoom = room;
    this.lobby.render(room, this.selfId ?? this.net.playerId ?? "");
    this.lobby.setConnection(this.net.isOnline ? "online" : this.lastStatus);
    this.setScreen("lobby");
    this.audio.setMusicMode("menu");
    this.touch.setActive(false);
    this.modal.closeAll();
    void this.game.showAmbient();
    this.updateUrl();
  }

  private enterMatch(match: MatchStartInfo): void {
    const selfId = this.selfId ?? this.net.playerId;
    if (!selfId) return;
    this.currentMatch = match;
    this.currentResults = null;
    this.lastSnapshot = null;
    this.lastCountdownSecond = null;
    this.pendingJoinCode = null;
    this.modal.closeAll();
    this.setScreen("game");
    this.hud.reset(match, selfId);
    this.hud.setPing(this.net.latency, this.net.isOnline);
    this.game.setInputSink((input: GameInput) => this.net.sendInput(input));
    void this.game.startMatch(match, selfId);
    this.game.setArenaPaused(false);
    this.touch.setActive(this.settings.touchActive);
    this.audio.setMusicMode("game");
    this.updateUrl();
    if (this.resultsBusyTimer) {
      clearTimeout(this.resultsBusyTimer);
      this.resultsBusyTimer = null;
    }
    this.results.setBusy(false);
  }

  private showResults(results: MatchResults, room: RoomView | null): void {
    const selfId = this.selfId ?? this.net.playerId;
    if (!selfId) return;
    if (this.resultsBusyTimer) {
      clearTimeout(this.resultsBusyTimer);
      this.resultsBusyTimer = null;
    }
    this.currentResults = results;
    this.currentMatch = null;
    this.currentRoom = room ?? this.currentRoom;
    const isHost = this.currentRoom?.hostId === selfId;
    this.results.render(results, selfId, isHost);
    this.setScreen("results");
    this.audio.setMusicMode("results");
    this.audio.play(results.winners.includes(selfId) ? "victory" : "defeat", 0.9);
    this.touch.setActive(false);
    this.modal.closeAll();
    this.game.endMatch();
    if (!this.game.isArenaActive) void this.game.showAmbient();
    this.updateUrl();
  }

  private updateUrl(): void {
    const room = this.currentRoom?.code;
    const next =
      this.screen === "menu"
        ? "/"
        : room
          ? `/play?room=${encodeURIComponent(room)}`
          : "/play";
    try {
      if (`${window.location.pathname}${window.location.search}` !== next) {
        window.history.replaceState(null, "", next);
      }
    } catch {
      // History can be unavailable in sandboxed frames.
    }
  }

  /* ------------------------------------------------------------------ */
  /* Menu actions                                                       */
  /* ------------------------------------------------------------------ */

  private requireCallsign(): boolean {
    const name = this.nicknameInput.value.trim();
    if (!this.applyCallsign(name)) {
      this.nicknameHint.textContent = "Enter a callsign of 2–16 letters or numbers.";
      this.nicknameHint.classList.add("is-error");
      this.nicknameInput.focus();
      this.toast("Choose a callsign before entering the rift.", "warn");
      this.audio.play("error", 0.6);
      return false;
    }
    if (!this.net.isOnline) {
      this.toast("The rift link is not online yet.", "warn");
      return false;
    }
    return true;
  }

  /** Validates a callsign and propagates it to settings + the live session. */
  private applyCallsign(raw: string): boolean {
    const name = raw.trim().replace(/\s+/g, " ");
    if (!isValidNickname(name)) return false;
    if (this.settings.nickname !== name) this.settings.update({ nickname: name });
    if (this.nicknameInput.value !== name && document.activeElement !== this.nicknameInput) {
      this.nicknameInput.value = name;
      this.updateNicknameCount();
    }
    this.net.setPreferredName(name);
    if (this.net.isOnline && this.net.playerName !== name) this.net.setName(name);
    return true;
  }

  private quickMatch(): void {
    if (!this.requireCallsign()) return;
    this.net.send({ t: "quick_match", v: PROTOCOL_VERSION });
    this.toast("Scanning the rift network for an open arena…", "info");
  }

  private createPrivateRoom(): void {
    if (!this.requireCallsign()) return;
    this.net.send({
      t: "create_room",
      v: PROTOCOL_VERSION,
      isPrivate: true,
      settings: DEFAULT_ROOM_SETTINGS,
    });
    this.toast("Opening a private arena…", "info");
  }

  private openJoinModal(code?: string): void {
    this.modal.open("join");
    this.joinError.hidden = true;
    if (this.joinNameInput.value.trim() === "") {
      this.joinNameInput.value = this.settings.nickname;
    }
    if (code) {
      this.joinCodeInput.value = code;
      this.joinInviteNote.hidden = false;
    } else {
      this.joinCodeInput.value = "";
      this.joinInviteNote.hidden = true;
    }
    window.setTimeout(() => {
      if (isValidNickname(this.joinNameInput.value)) {
        this.joinCodeInput.focus({ preventScroll: true });
        this.joinCodeInput.select();
      } else {
        this.joinNameInput.focus({ preventScroll: true });
        this.joinNameInput.select();
      }
    }, 80);
  }

  private submitJoin(): void {
    const code = normalizeRoomCode(this.joinCodeInput.value);
    if (!code) {
      this.joinError.textContent = "A rift key is six characters, e.g. NX7K2Q.";
      this.joinError.hidden = false;
      this.joinCodeInput.focus();
      return;
    }
    if (!this.applyCallsign(this.joinNameInput.value)) {
      this.joinError.textContent = "Enter a callsign of 2–16 letters or numbers.";
      this.joinError.hidden = false;
      this.joinNameInput.focus();
      this.audio.play("error", 0.6);
      return;
    }
    if (!this.net.isOnline) {
      this.joinError.textContent = "The rift link is offline. Retrying automatically…";
      this.joinError.hidden = false;
      return;
    }
    this.pendingJoinCode = code;
    this.net.send({ t: "join_room", v: PROTOCOL_VERSION, code });
    this.modal.close("join");
    this.toast(`Linking to arena ${code}…`, "info");
  }

  /* ------------------------------------------------------------------ */
  /* Lobby actions                                                      */
  /* ------------------------------------------------------------------ */

  private toggleReady(): void {
    if (!this.currentRoom || !this.selfId) return;
    const self = this.currentRoom.players.find((player) => player.id === this.selfId);
    this.net.send({ t: "set_ready", v: PROTOCOL_VERSION, ready: !self?.ready });
  }

  private startMatch(): void {
    if (!this.currentRoom || this.currentRoom.hostId !== this.selfId) return;
    this.net.send({ t: "start_match", v: PROTOCOL_VERSION });
  }

  private leaveRoom(): void {
    this.net.send({ t: "leave_room", v: PROTOCOL_VERSION });
  }

  private updateRoomSettings(settings: RoomSettings): void {
    if (!this.currentRoom) return;
    this.net.send({ t: "update_settings", v: PROTOCOL_VERSION, settings });
  }

  private roomCode(): string | null {
    return this.currentRoom?.code ?? null;
  }

  private async copyRoomCode(): Promise<void> {
    const code = this.roomCode();
    if (!code) return;
    const copied = await copyText(code);
    this.toast(copied ? `Room key ${code} copied.` : "Could not copy — select the key manually.", copied ? "success" : "warn");
  }

  private async copyInviteLink(): Promise<void> {
    const code = this.roomCode();
    if (!code) return;
    const copied = await copyText(invitationUrl(code));
    this.toast(copied ? "Invitation link copied." : "Could not copy the link.", copied ? "success" : "warn");
  }

  private async shareInvite(): Promise<void> {
    const code = this.roomCode();
    if (!code) return;
    const url = invitationUrl(code);
    const payload = {
      title: "NEON RIFT: ARENA",
      text: `Join my rift — room key ${code}.`,
      url,
    };
    if (navigator.share) {
      try {
        await navigator.share(payload);
        return;
      } catch {
        // Fall through to copying.
      }
    }
    const copied = await copyText(url);
    this.toast(copied ? "Invitation link copied." : "Could not share the invitation.", copied ? "success" : "warn");
  }

  /* ------------------------------------------------------------------ */
  /* Results actions                                                    */
  /* ------------------------------------------------------------------ */

  private requestRematch(): void {
    this.results.setBusy(true);
    this.net.send({ t: "rematch", v: PROTOCOL_VERSION });
    if (this.resultsBusyTimer) clearTimeout(this.resultsBusyTimer);
    this.resultsBusyTimer = setTimeout(() => {
      this.resultsBusyTimer = null;
      this.results.setBusy(false);
    }, 5_000);
  }

  private playAgain(): void {
    this.pendingQuickMatch = true;
    this.results.setBusy(true);
    if (!this.net.isOnline) {
      this.pendingQuickMatch = false;
      this.results.setBusy(false);
      this.toast("The rift link is offline. Reconnecting…", "warn");
      return;
    }
    this.net.send({ t: "leave_room", v: PROTOCOL_VERSION });
  }

  private returnToLobby(): void {
    if (!this.currentRoom || this.currentRoom.hostId !== this.selfId) return;
    this.results.setBusy(true);
    this.net.send({ t: "return_to_lobby", v: PROTOCOL_VERSION });
    this.toast("Returning the squad to the lobby…", "info");
  }

  /* ------------------------------------------------------------------ */
  /* Match snapshots                                                    */
  /* ------------------------------------------------------------------ */

  private handleSnapshot(snapshot: SnapshotMsg): void {
    this.lastSnapshot = snapshot;
    this.hud.update(snapshot);
    this.game.applySnapshot(snapshot);

    if (snapshot.phase === "countdown") {
      const second = Math.ceil(snapshot.countdownMs / 1000);
      if (second > 0 && second !== this.lastCountdownSecond) {
        this.lastCountdownSecond = second;
        this.audio.play("countdown", 0.7);
      }
    } else {
      this.lastCountdownSecond = null;
    }

    this.processFx(snapshot);
  }

  private processFx(snapshot: SnapshotMsg): void {
    const selfId = this.selfId;
    if (!selfId) return;
    const self = snapshot.players.find((player) => player.id === selfId);
    const selfX = self?.x ?? 0;
    const selfY = self?.y ?? 0;
    const rosterNames = new Map(
      (this.currentMatch?.roster ?? this.currentRoom?.players.map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
      })) ?? []).map((entry) => [entry.id, entry.name]),
    );

    for (const fx of snapshot.fx) {
      switch (fx.kind) {
        case "shot": {
          const distance = Math.hypot(fx.x - selfX, fx.y - selfY);
          if (fx.owner === selfId) {
            this.audio.play("shot", 0.55);
          } else if (distance < 850) {
            this.audio.play("enemyShot", 0.2 * (1 - distance / 850));
          }
          break;
        }
        case "hit": {
          if (fx.target === selfId) {
            this.audio.play("hurt", 0.85);
            this.hud.flashDamage((self?.hp ?? 100) <= 30);
          } else if (fx.attacker === selfId) {
            this.audio.play("hit", 0.8);
          }
          break;
        }
        case "death": {
          const killerName = rosterNames.get(fx.killer) ?? "THE RIFT";
          const victimName = rosterNames.get(fx.victim) ?? "A PILOT";
          if (killerName !== victimName) this.hud.addKillFeed(killerName, victimName);
          if (fx.victim === selfId) {
            this.audio.play("death", 1);
          } else if (fx.killer === selfId) {
            this.audio.play("hit", 1);
          }
          break;
        }
        case "respawn":
          if (fx.player === selfId) this.audio.play("respawn", 0.8);
          break;
        case "dash":
          if (fx.player === selfId) this.audio.play("dash", 0.7);
          break;
        case "crystal": {
          if (fx.player === selfId) {
            this.audio.play("crystal", 0.8);
            const name = rosterNames.get(selfId) ?? "PILOT";
            this.hud.addCrystalFeed(name, fx.amount);
          }
          break;
        }
        case "wall":
          break;
        case "match_live":
          this.audio.play("live", 1);
          this.hud.showFight();
          break;
        case "countdown":
          break;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Debug API + factory art                                            */
  /* ------------------------------------------------------------------ */

  private installDebugApi(): void {
    window.__NEON_RIFT__ = {
      version: "1.0.0",
      getState: (): NeonRiftDebugState => ({
        screen: this.screen,
        online: this.net.isOnline,
        selfId: this.selfId,
        nickname: this.settings.nickname,
        roomCode: this.currentRoom?.code ?? null,
        room: this.currentRoom,
        match: this.currentMatch,
        results: this.currentResults,
        snapshot: this.lastSnapshot,
        latency: this.net.latency,
        touchMode: this.settings.touchActive,
        arenaActive: this.game.isArenaActive,
        camera: this.game.getCameraState(),
      }),
    };
  }
}
