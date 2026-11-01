import { PING_INTERVAL_MS, PROTOCOL_VERSION } from "@shared/constants";
import type {
  ClientMessage,
  LeftRoomMsg,
  MatchEndMsg,
  MatchStartMsg,
  NoticeMsg,
  RoomStateMsg,
  ServerErrorMsg,
  SnapshotMsg,
  WelcomeMsg,
} from "@shared/types";

export interface InputFrame {
  moveX: number;
  moveY: number;
  aim: number;
  fire: boolean;
  dash: boolean;
}

export interface NetStatus {
  state: "connecting" | "online" | "offline";
  attempt: number;
  retryInMs: number | null;
}

interface NetEvents {
  status: NetStatus;
  welcome: WelcomeMsg;
  room: RoomStateMsg;
  matchStart: MatchStartMsg;
  snapshot: SnapshotMsg;
  matchEnd: MatchEndMsg;
  error: ServerErrorMsg;
  notice: NoticeMsg;
  leftRoom: LeftRoomMsg;
  latency: number;
}

type Handler<K extends keyof NetEvents> = (payload: NetEvents[K]) => void;

const SESSION_KEY = "neon-rift.session.v1";
const WATCHDOG_MS = 15_000;

class TypedEmitter {
  private handlers = new Map<keyof NetEvents, Set<(payload: never) => void>>();

  on<K extends keyof NetEvents>(type: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as (payload: never) => void);
    return () => set.delete(handler as (payload: never) => void);
  }

  emit<K extends keyof NetEvents>(type: K, payload: NetEvents[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as Handler<K>)(payload);
      } catch (error) {
        console.error(`[net] ${String(type)} handler failed`, error);
      }
    }
  }
}

/**
 * Browser WebSocket client. It owns reconnection and the session token; the
 * application owns every screen transition. Inputs are sent at the fixed rate
 * driven by the game loop, not by this class.
 */
export class NetClient extends TypedEmitter {
  private socket: WebSocket | null = null;
  private token: string | null = null;
  private preferredName = "";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private inputSeq = 0;
  private pingSeq = 0;
  private pingSentAt = new Map<number, number>();
  private lastMessageAt = 0;
  private lastLatency: number | null = null;
  private manualClose = false;
  private ready = false;
  private destroyed = false;

  playerId: string | null = null;
  playerName = "";
  resumed = false;
  everOnline = false;

  constructor(name: string) {
    super();
    this.preferredName = name;
    try {
      this.token = window.localStorage.getItem(SESSION_KEY);
    } catch {
      this.token = null;
    }
    this.watchdogTimer = setInterval(() => this.watchdog(), 5_000);
  }

  get status(): NetStatus {
    if (this.socket?.readyState === WebSocket.OPEN && this.ready) {
      return { state: "online", attempt: 0, retryInMs: null };
    }
    return {
      state: this.reconnectTimer ? "offline" : this.socket ? "connecting" : "offline",
      attempt: this.attempt,
      retryInMs: null,
    };
  }

  get latency(): number | null {
    return this.lastLatency;
  }

  get isOnline(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.ready;
  }

  get hasToken(): boolean {
    return this.token !== null;
  }

  setPreferredName(name: string): void {
    this.preferredName = name;
  }

  connect(): void {
    if (this.destroyed) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.manualClose = false;
    this.clearReconnect();
    this.emit("status", { state: "connecting", attempt: this.attempt, retryInMs: null });

    const url = this.url();
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      console.error("[net] failed to construct WebSocket", error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.ready = false;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.lastMessageAt = Date.now();
      this.sendIdentify();
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.lastMessageAt = Date.now();
      this.handleRaw(event.data);
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      this.stopPing();
      if (this.manualClose || this.destroyed) {
        this.emit("status", { state: "offline", attempt: 0, retryInMs: null });
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // The close event that follows drives reconnection.
    });
  }

  sendInput(frame: InputFrame): number {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.ready) return 0;
    const seq = ++this.inputSeq;
    const message: ClientMessage = {
      t: "input",
      v: PROTOCOL_VERSION,
      seq,
      moveX: round(frame.moveX, 2),
      moveY: round(frame.moveY, 2),
      aim: round(frame.aim, 3),
      fire: frame.fire,
      dash: frame.dash,
    };
    this.send(message);
    return seq;
  }

  send(message: ClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      console.warn("[net] send failed", error);
    }
  }

  setName(name: string): void {
    this.preferredName = name;
    if (this.ready) {
      this.send({ t: "set_name", v: PROTOCOL_VERSION, name });
    }
  }

  async disconnect(): Promise<void> {
    this.manualClose = true;
    this.clearReconnect();
    this.stopPing();
    this.ready = false;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= WebSocket.OPEN) {
      socket.close(1000, "Client closing");
    }
  }

  destroy(): void {
    this.destroyed = true;
    void this.disconnect();
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  clearSession(): void {
    this.token = null;
    try {
      window.localStorage.removeItem(SESSION_KEY);
    } catch {
      // Storage unavailable.
    }
  }

  private url(): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws`;
  }

  private sendIdentify(): void {
    const name = validName(this.preferredName) ? this.preferredName : undefined;
    const message: ClientMessage = {
      t: "identify",
      v: PROTOCOL_VERSION,
      token: this.token ?? undefined,
      name,
    };
    this.send(message);
  }

  private handleRaw(data: unknown): void {
    if (typeof data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      console.warn("[net] dropped non-JSON frame");
      return;
    }
    if (!parsed || typeof parsed !== "object" || !("t" in parsed)) return;
    const message = parsed as { t: string; v?: number };
    if (message.v !== PROTOCOL_VERSION) return;

    switch (message.t) {
      case "welcome": {
        const welcome = parsed as WelcomeMsg;
        this.token = welcome.token;
        try {
          window.localStorage.setItem(SESSION_KEY, welcome.token);
        } catch {
          // Storage unavailable.
        }
        this.playerId = welcome.you;
        this.playerName = welcome.name;
        this.resumed = welcome.resumed;
        this.ready = true;
        this.everOnline = true;
        this.attempt = 0;
        this.lastLatency = null;
        this.emit("welcome", welcome);
        this.emit("status", { state: "online", attempt: 0, retryInMs: null });
        this.startPing();
        break;
      }
      case "room_state":
        this.emit("room", parsed as RoomStateMsg);
        break;
      case "match_start":
        this.emit("matchStart", parsed as MatchStartMsg);
        break;
      case "snapshot":
        this.emit("snapshot", parsed as SnapshotMsg);
        break;
      case "match_end":
        this.emit("matchEnd", parsed as MatchEndMsg);
        break;
      case "error":
        this.emit("error", parsed as ServerErrorMsg);
        break;
      case "notice":
        this.emit("notice", parsed as NoticeMsg);
        break;
      case "left_room":
        this.emit("leftRoom", parsed as LeftRoomMsg);
        break;
      case "pong": {
        const pong = parsed as unknown as { id: number; clientTime: number };
        const sentAt = this.pingSentAt.get(pong.id);
        if (sentAt !== undefined) {
          this.pingSentAt.delete(pong.id);
          const rtt = Math.max(0, performance.now() - sentAt);
          this.lastLatency = this.lastLatency === null ? rtt : this.lastLatency * 0.7 + rtt * 0.3;
          this.emit("latency", this.lastLatency);
        }
        break;
      }
      default:
        break;
    }
  }

  private startPing(): void {
    this.stopPing();
    const ping = () => {
      if (!this.ready) return;
      const id = ++this.pingSeq;
      const clientTime = Date.now();
      this.pingSentAt.set(id, performance.now());
      if (this.pingSentAt.size > 24) {
        const oldest = this.pingSentAt.keys().next().value;
        if (oldest !== undefined) this.pingSentAt.delete(oldest);
      }
      this.send({ t: "ping", v: PROTOCOL_VERSION, id, clientTime });
    };
    ping();
    this.pingTimer = setInterval(ping, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pingSentAt.clear();
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.manualClose) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(8_000, 500 * 2 ** Math.min(this.attempt, 4));
    this.attempt++;
    this.emit("status", { state: "offline", attempt: this.attempt, retryInMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private watchdog(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastMessageAt > WATCHDOG_MS) {
      console.warn("[net] socket watchdog timeout");
      try {
        this.socket.close();
      } catch {
        // Ignore.
      }
    }
  }
}

function validName(name: string): boolean {
  const trimmed = name.trim();
  if ([...trimmed].length < 2 || [...trimmed].length > 16) return false;
  return /[\p{L}\p{N}]/u.test(trimmed);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
