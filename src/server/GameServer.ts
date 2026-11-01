import type { ServerWebSocket } from "bun";
import {
  AUTO_START_DELAY_MS,
  EMPTY_ROOM_TTL_MS,
  FINISHED_ROOM_TTL_MS,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES_PER_SECOND,
  MAX_PLAYERS_PER_ROOM,
  PROTOCOL_VERSION,
  RATE_LIMIT_BURST,
  RECONNECT_GRACE_MS,
  SESSION_TTL_MS,
  SNAPSHOT_INTERVAL_TICKS,
  SWEEP_INTERVAL_MS,
  TICK_MS,
  TICK_RATE,
} from "../shared/constants";
import { DEFAULT_ROOM_SETTINGS, SPAWN_PROTECTION_MS } from "../shared/game-rules";
import type { RoomSettings } from "../shared/game-rules";
import { ERROR_CODES, parseClientMessage, sanitizeName } from "../shared/protocol";
import type {
  ClientMessage,
  LeftRoomMsg,
  MatchEndMsg,
  MatchStartMsg,
  RoomStateMsg,
  ServerErrorMsg,
  ServerMessage,
  SnapshotMsg,
  WelcomeMsg,
} from "../shared/types";
import type { AppConfig } from "./config";
import { Matchmaker } from "./matchmaking/Matchmaker";
import type { Logger } from "./monitoring/logger";
import type { Metrics } from "./monitoring/metrics";
import { RoomManager } from "./rooms/RoomManager";
import type { Room } from "./rooms/Room";
import { TokenBucket } from "./security/rate-limit";

export interface WsData {
  connectionId: number;
}

interface Session {
  token: string;
  playerId: string;
  name: string;
  socket: ClientConnection | null;
  roomCode: string | null;
  createdAt: number;
  lastSeen: number;
  disconnectedAt: number | null;
}

interface ClientConnection {
  id: number;
  ws: ServerWebSocket<WsData>;
  session: Session | null;
  limiter: TokenBucket;
  closed: boolean;
  connectedAt: number;
  invalidStrikes: number;
  rateStrikes: number;
}

const MAX_SESSIONS = 2_000;
const MAX_CONNECTIONS = 1_000;

/**
 * Orchestrates WebSocket sessions, rooms, and the fixed-timestep simulation.
 * All mutation happens on the single Bun event loop, so no locking is needed.
 */
export class GameServer {
  readonly rooms = new RoomManager();
  readonly matchmaker: Matchmaker;
  readonly sessions = new Map<string, Session>();
  readonly sessionsByPlayerId = new Map<string, Session>();
  readonly connections = new Map<number, ClientConnection>();

  tickCount = 0;
  private nextConnectionId = 1;
  private accumulatorMs = 0;
  private lastTickAt = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly now: () => number = Date.now,
  ) {
    this.matchmaker = new Matchmaker(this.rooms);
  }

  get websocketHandlers(): Bun.WebSocketHandler<WsData> {
    return {
      data: { connectionId: -1 },
      open: (ws) => this.handleOpen(ws),
      message: (ws, raw) => this.handleMessage(ws, raw),
      close: (ws, code, reason) => this.handleClose(ws, code, reason),
      error: (error, ws) => {
        this.metrics.errors++;
        this.logger.error("WebSocket handler error", {
          connectionId: ws.data?.connectionId,
          error: error.message,
        });
      },
      maxPayloadLength: MAX_MESSAGE_BYTES,
      backpressureLimit: 512 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: 120,
    };
  }

  start(): void {
    if (this.tickTimer !== null) return;
    this.lastTickAt = performance.now();
    this.tickTimer = setInterval(() => this.tick(), 1000 / TICK_RATE);
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.tickTimer = null;
    this.sweepTimer = null;

    for (const connection of [...this.connections.values()]) {
      try {
        connection.ws.close(1001, "Server shutting down");
      } catch {
        // Socket already gone.
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* WebSocket lifecycle                                                */
  /* ------------------------------------------------------------------ */

  private handleOpen(ws: ServerWebSocket<WsData>): void {
    if (this.connections.size >= MAX_CONNECTIONS) {
      try {
        ws.close(1013, "Server busy");
      } catch {
        // Ignore.
      }
      return;
    }

    const connection: ClientConnection = {
      id: this.nextConnectionId++,
      ws,
      session: null,
      limiter: new TokenBucket(RATE_LIMIT_BURST, MAX_MESSAGES_PER_SECOND),
      closed: false,
      connectedAt: this.now(),
      invalidStrikes: 0,
      rateStrikes: 0,
    };
    ws.data.connectionId = connection.id;
    this.connections.set(connection.id, connection);
    this.metrics.activeConnections++;
    this.metrics.connectionsTotal++;
    this.logger.debug("socket connected", { connectionId: connection.id });
  }

  private handleMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
    const connection = this.connections.get(ws.data?.connectionId ?? -1);
    if (!connection || connection.closed) return;

    if (!connection.limiter.tryConsume()) {
      this.metrics.rateLimited++;
      connection.rateStrikes++;
      if (connection.rateStrikes === 1) {
        this.sendError(connection, ERROR_CODES.RATE_LIMITED, "Slow down — too many messages.", false);
      }
      if (connection.rateStrikes >= 12) {
        this.closeConnection(connection, 4008, "Rate limit exceeded");
      }
      return;
    }

    if (typeof raw !== "string") {
      this.handleInvalid(
        connection,
        ERROR_CODES.INVALID_MESSAGE,
        "Binary frames are not supported.",
      );
      return;
    }

    if (raw.length > MAX_MESSAGE_BYTES) {
      this.handleInvalid(connection, ERROR_CODES.INVALID_MESSAGE, "Message exceeds the limit.");
      return;
    }

    this.metrics.messagesIn++;
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.handleInvalid(connection, parsed.code, parsed.message, true);
      return;
    }

    connection.invalidStrikes = 0;
    connection.rateStrikes = 0;

    try {
      this.route(connection, parsed.message);
    } catch (error) {
      this.metrics.errors++;
      this.logger.error("Unhandled message error", {
        connectionId: connection.id,
        type: parsed.message.t,
        error: error instanceof Error ? error.message : String(error),
      });
      this.sendError(connection, ERROR_CODES.INTERNAL, "Internal server error.", false);
    }
  }

  private handleClose(ws: ServerWebSocket<WsData>, code: number, reason: string): void {
    const connection = this.connections.get(ws.data?.connectionId ?? -1);
    if (!connection || connection.closed) return;
    connection.closed = true;
    this.connections.delete(connection.id);
    this.metrics.activeConnections = Math.max(0, this.metrics.activeConnections - 1);

    const session = connection.session;
    connection.session = null;
    if (!session || session.socket !== connection) return;

    const now = this.now();
    session.socket = null;
    session.disconnectedAt = now;
    session.lastSeen = now;

    const room = session.roomCode ? this.rooms.get(session.roomCode) : undefined;
    if (room) {
      room.setConnected(session.playerId, false, now);
      if (room.phase === "lobby") this.broadcastRoomState(room);
      this.logger.info("player disconnected — slot reserved", {
        room: room.code,
        playerId: session.playerId,
        graceSec: Math.round(RECONNECT_GRACE_MS / 1000),
      });
    } else {
      this.logger.debug("connection closed", {
        connectionId: connection.id,
        code,
        reason: reason.slice(0, 48),
      });
    }
  }

  private handleInvalid(
    connection: ClientConnection,
    code: string,
    message: string,
    strike = true,
  ): void {
    this.metrics.invalidMessages++;
    if (strike) connection.invalidStrikes++;
    this.sendError(connection, code, message, false);
    if (connection.invalidStrikes >= 8) {
      this.closeConnection(connection, 4008, "Too many invalid messages");
    }
  }

  /* ------------------------------------------------------------------ */
  /* Message routing                                                    */
  /* ------------------------------------------------------------------ */

  private route(connection: ClientConnection, message: ClientMessage): void {
    if (message.t === "identify") {
      this.handleIdentify(connection, message);
      return;
    }

    const session = connection.session;
    if (!session) {
      this.sendError(connection, ERROR_CODES.NOT_IDENTIFIED, "Identify before sending commands.", false);
      return;
    }
    session.lastSeen = this.now();

    switch (message.t) {
      case "ping":
        this.send(connection, {
          t: "pong",
          v: PROTOCOL_VERSION,
          id: message.id,
          clientTime: message.clientTime,
          serverTime: this.now(),
        });
        break;
      case "set_name":
        this.handleSetName(connection, session, message.name);
        break;
      case "create_room":
        this.handleCreateRoom(connection, session, message.isPrivate, message.settings);
        break;
      case "quick_match":
        this.handleQuickMatch(connection, session);
        break;
      case "join_room":
        this.handleJoinRoom(connection, session, message.code);
        break;
      case "leave_room":
        this.handleLeaveRoom(connection, session);
        break;
      case "set_ready":
        this.handleReady(connection, session, message.ready);
        break;
      case "update_settings":
        this.handleUpdateSettings(connection, session, message.settings);
        break;
      case "start_match":
        this.handleStartMatch(connection, session);
        break;
      case "input":
        this.handleInput(connection, session, message);
        break;
      case "rematch":
        this.handleRematch(connection, session);
        break;
      case "return_to_lobby":
        this.handleReturnToLobby(connection, session);
        break;
      default:
        this.sendError(connection, ERROR_CODES.INVALID_MESSAGE, "Unknown command.", false);
    }
  }

  private handleIdentify(connection: ClientConnection, message: Extract<ClientMessage, { t: "identify" }>): void {
    if (connection.session) {
      this.sendError(connection, ERROR_CODES.ALREADY_IDENTIFIED, "This socket is already identified.", false);
      return;
    }

    const now = this.now();
    let session = message.token ? this.sessions.get(message.token) : undefined;
    let resumed = false;
    let room: Room | undefined;

    if (session) {
      resumed = true;
      room = session.roomCode ? this.rooms.get(session.roomCode) : undefined;
      if (session.roomCode && (!room || !room.players.has(session.playerId))) {
        session.roomCode = null;
        room = undefined;
      }

      if (session.socket && session.socket !== connection) {
        this.sendError(session.socket, ERROR_CODES.SESSION_TAKEOVER, "Session resumed in another tab.", true);
        const oldSocket = session.socket;
        oldSocket.session = null;
        this.closeConnection(oldSocket, 4001, "Session resumed elsewhere");
      }

      session.socket = connection;
      session.disconnectedAt = null;
      session.lastSeen = now;
      connection.session = session;

      if (message.name && message.name !== session.name && room?.phase !== "playing") {
        session.name = message.name;
        if (room) room.setName(session.playerId, message.name, now);
      }

      if (room) {
        room.setConnected(session.playerId, true, now);
        if (room.match) room.match.setConnected(session.playerId, true);
      }

      this.logger.info("session resumed", {
        playerId: session.playerId,
        room: room?.code ?? null,
      });
    } else {
      if (this.sessions.size >= MAX_SESSIONS) {
        this.sendError(connection, ERROR_CODES.SERVER_FULL, "The arena is at capacity. Try again shortly.", true);
        this.closeConnection(connection, 1013, "Server full");
        return;
      }

      const name = message.name ?? this.generatePilotName();
      const token = this.generateToken();
      const playerId = this.generatePlayerId();
      session = {
        token,
        playerId,
        name,
        socket: connection,
        roomCode: null,
        createdAt: now,
        lastSeen: now,
        disconnectedAt: null,
      };
      this.sessions.set(token, session);
      this.sessionsByPlayerId.set(playerId, session);
      connection.session = session;
      this.logger.info("new session", { playerId, name });
    }

    const welcome: WelcomeMsg = {
      t: "welcome",
      v: PROTOCOL_VERSION,
      you: session.playerId,
      name: session.name,
      token: session.token,
      resumed,
      serverTime: now,
      room: room ? room.toView(now) : null,
      match: room?.phase === "playing" ? room.matchStart : null,
      results: room?.phase === "finished" ? room.results : null,
    };
    this.send(connection, welcome);

    if (room) {
      this.broadcastRoomState(room);
      this.logger.info("player reattached", {
        playerId: session.playerId,
        room: room.code,
        phase: room.phase,
      });
    }
  }

  private handleSetName(connection: ClientConnection, session: Session, name: string): void {
    const room = session.roomCode ? this.rooms.get(session.roomCode) : undefined;
    if (room?.phase === "playing") {
      this.sendError(connection, ERROR_CODES.INVALID_NAME, "Names cannot change mid-match.", false);
      return;
    }

    session.name = name;
    if (room) {
      room.setName(session.playerId, name, this.now());
      this.broadcastRoomState(room);
    }
    this.logger.debug("name updated", { playerId: session.playerId });
  }

  private handleCreateRoom(
    connection: ClientConnection,
    session: Session,
    isPrivate: boolean,
    settings?: Partial<RoomSettings>,
  ): void {
    if (session.roomCode) {
      this.sendError(connection, ERROR_CODES.IN_ROOM, "Leave your current room first.", false);
      return;
    }

    const created = this.rooms.create(isPrivate, session.playerId, session.name, settings);
    if (!created.ok) {
      this.sendError(
        connection,
        ERROR_CODES.SERVER_FULL,
        created.code === "server_full" ? "Too many rooms right now." : "Could not allocate a room code.",
        false,
      );
      return;
    }

    const room = created.room;
    session.roomCode = room.code;
    this.metrics.roomsCreated++;
    if (!isPrivate) this.scheduleAutoStart(room);
    this.broadcastRoomState(room);
    this.logger.info("room created", {
      room: room.code,
      private: isPrivate,
      host: session.playerId,
      settings: room.settings,
    });
  }

  private handleQuickMatch(connection: ClientConnection, session: Session): void {
    if (session.roomCode) {
      this.sendError(connection, ERROR_CODES.IN_ROOM, "Leave your current room first.", false);
      return;
    }

    this.matchmaker.recordQuickMatch();
    let room = this.matchmaker.findRoom();

    if (!room) {
      const created = this.rooms.create(false, session.playerId, session.name, DEFAULT_ROOM_SETTINGS);
      if (!created.ok) {
        this.sendError(connection, ERROR_CODES.SERVER_FULL, "No match slots available.", false);
        return;
      }
      room = created.room;
      session.roomCode = room.code;
      this.metrics.roomsCreated++;
      this.scheduleAutoStart(room);
      this.broadcastRoomState(room);
      this.logger.info("quick match created room", {
        room: room.code,
        playerId: session.playerId,
      });
      return;
    }

    const player = room.addPlayer(session.playerId, session.name, this.now());
    if (!player) {
      this.sendError(connection, ERROR_CODES.ROOM_FULL, "That room just filled up.", false);
      return;
    }
    session.roomCode = room.code;
    this.scheduleAutoStart(room);
    this.broadcastRoomState(room);
    this.logger.info("quick match joined room", {
      room: room.code,
      playerId: session.playerId,
    });
  }

  private handleJoinRoom(connection: ClientConnection, session: Session, code: string): void {
    if (session.roomCode) {
      this.sendError(connection, ERROR_CODES.IN_ROOM, "Leave your current room first.", false);
      return;
    }

    const room = this.rooms.get(code);
    if (!room) {
      this.sendError(connection, ERROR_CODES.ROOM_NOT_FOUND, "That room does not exist.", false);
      return;
    }
    if (room.phase !== "lobby") {
      this.sendError(connection, ERROR_CODES.ROOM_STARTED, "That match has already started.", false);
      return;
    }
    if (room.players.size >= room.settings.maxPlayers) {
      this.sendError(connection, ERROR_CODES.ROOM_FULL, "That room is full.", false);
      return;
    }

    const player = room.addPlayer(session.playerId, session.name, this.now());
    if (!player) {
      this.sendError(connection, ERROR_CODES.ROOM_FULL, "That room is full.", false);
      return;
    }

    session.roomCode = room.code;
    if (!room.isPrivate) this.scheduleAutoStart(room);
    this.broadcastRoomState(room);
    this.logger.info("player joined room", {
      room: room.code,
      playerId: session.playerId,
    });
  }

  private handleLeaveRoom(connection: ClientConnection, session: Session): void {
    const room = session.roomCode ? this.rooms.get(session.roomCode) : undefined;
    if (!room) {
      session.roomCode = null;
      this.sendLeftRoom(connection, session, null, "voluntary");
      return;
    }

    const leavingId = session.playerId;
    const wasPlaying = room.phase === "playing";
    room.removePlayer(leavingId, this.now());
    session.roomCode = null;

    if (room.isEmpty) {
      this.rooms.delete(room.code);
      this.logger.info("room deleted (empty)", { room: room.code });
    } else {
      this.broadcastRoomState(room);
    }

    this.sendLeftRoom(connection, session, room.code, "voluntary");
    this.logger.info("player left room", {
      room: room.code,
      playerId: leavingId,
      phase: room.phase,
      wasPlaying,
    });
  }

  private handleReady(connection: ClientConnection, session: Session, ready: boolean): void {
    const room = session.roomCode ? this.rooms.get(session.roomCode) : undefined;
    if (!room) {
      this.sendError(connection, ERROR_CODES.NOT_IN_ROOM, "Join a room first.", false);
      return;
    }
    if (room.phase !== "lobby") {
      this.sendError(connection, ERROR_CODES.ROOM_STARTED, "The match has already started.", false);
      return;
    }
    room.setReady(session.playerId, ready, this.now());
    this.broadcastRoomState(room);
  }

  private handleUpdateSettings(
    connection: ClientConnection,
    session: Session,
    settings: RoomSettings,
  ): void {
    const room = session.roomCode ? this.rooms.get(session.roomCode) : undefined;
    if (!room) {
      this.sendError(connection, ERROR_CODES.NOT_IN_ROOM, "Join a room first.", false);
      return;
    }
    if (room.hostId !== session.playerId) {
      this.sendError(connection, ERROR_CODES.NOT_HOST, "Only the host can change settings.", false);
      return;
    }
    if (room.phase !== "lobby") {
      this.sendError(connection, ERROR_CODES.ROOM_STARTED, "Settings are locked during a match.", false);
      return;
    }
    if (!room.setSettings(settings, this.now())) {
      this.sendError(
        connection,
        ERROR_CODES.INVALID_SETTINGS,
        "Player capacity cannot be lower than the current roster.",
        false,
      );
      return;
    }
    this.broadcastRoomState(room);
    this.logger.info("room settings updated", { room: room.code, settings });
  }

  private handleStartMatch(connection: ClientConnection, session: Session): void {
    const room = session.roomCode ? this.rooms.get(session.roomCode) : undefined;
    if (!room) {
      this.sendError(connection, ERROR_CODES.NOT_IN_ROOM, "Join a room first.", false);
      return;
    }
    if (room.hostId !== session.playerId) {
      this.sendError(connection, ERROR_CODES.NOT_HOST, "Only the host can start the match.", false);
      return;
    }
    if (room.phase !== "lobby") {
      this.sendError(connection, ERROR_CODES.ROOM_STARTED, "This room is not in the lobby.", false);
      return;
    }
    if (room.connectedPlayers.length === 0) {
      this.sendError(connection, ERROR_CODES.INVALID_INPUT, "No connected players.", false);
      return;
    }

    this.startMatch(room);
  }

  private handleRematch(connection: ClientConnection, session: Session): void {
    const room = session.roomCode ? this.rooms.get(session.roomCode) : undefined;
    if (!room) {
      this.sendError(connection, ERROR_CODES.NOT_IN_ROOM, "Join a room first.", false);
      return;
    }
    if (room.phase !== "finished") {
      this.sendError(connection, ERROR_CODES.ROOM_STARTED, "No finished match to rematch.", false);
      return;
    }
    this.startMatch(room);
  }

  private handleReturnToLobby(connection: ClientConnection, session: Session): void {
    const room = session.roomCode ? this.rooms.get(session.roomCode) : undefined;
    if (!room) {
      this.sendError(connection, ERROR_CODES.NOT_IN_ROOM, "Join a room first.", false);
      return;
    }
    if (room.hostId !== session.playerId) {
      this.sendError(connection, ERROR_CODES.NOT_HOST, "Only the host can return the room to the lobby.", false);
      return;
    }
    if (room.phase !== "finished") {
      this.sendError(connection, ERROR_CODES.ROOM_STARTED, "The match is still running.", false);
      return;
    }

    room.returnToLobby(this.now());
    if (!room.isPrivate) this.scheduleAutoStart(room);
    this.broadcastRoomState(room);
    this.logger.info("room returned to lobby", { room: room.code });
  }

  private handleInput(
    connection: ClientConnection,
    session: Session,
    message: Extract<ClientMessage, { t: "input" }>,
  ): void {
    const room = session.roomCode ? this.rooms.get(session.roomCode) : undefined;
    if (!room) {
      this.sendError(connection, ERROR_CODES.NOT_IN_ROOM, "No active room.", false);
      return;
    }
    if (room.phase !== "playing" || !room.match) {
      this.sendError(connection, ERROR_CODES.ROOM_STARTED, "No active match.", false);
      return;
    }
    room.match.applyInput(session.playerId, message);
  }

  /* ------------------------------------------------------------------ */
  /* Match lifecycle                                                    */
  /* ------------------------------------------------------------------ */

  private startMatch(room: Room): void {
    const info = room.startMatch(this.now());
    if (!info) {
      this.sendToRoom(room, {
        t: "error",
        v: PROTOCOL_VERSION,
        code: ERROR_CODES.INVALID_INPUT,
        message: "No connected players are available to start.",
        fatal: false,
      });
      return;
    }

    this.metrics.matchesStarted++;
    const message: MatchStartMsg = { t: "match_start", v: PROTOCOL_VERSION, match: info };
    this.sendToRoom(room, message);
    this.logger.info("match started", {
      room: room.code,
      players: info.roster.length,
      durationSec: info.durationSec,
      scoreLimit: info.scoreLimit,
    });
  }

  private endMatch(room: Room): void {
    const results = room.finishMatch(this.now());
    if (!results) return;
    room.ensureHost();
    const message: MatchEndMsg = { t: "match_end", v: PROTOCOL_VERSION, results };
    this.sendToRoom(room, message);
    this.broadcastRoomState(room);
    this.metrics.matchesFinished++;
    this.logger.info("match finished", {
      room: room.code,
      reason: results.reason,
      durationSec: Math.round(results.durationMs / 1000),
      winner: results.rankings[0]?.name ?? "nobody",
      winnerScore: results.rankings[0]?.score ?? 0,
    });
  }

  private scheduleAutoStart(room: Room): void {
    if (room.phase !== "lobby" || room.isPrivate) return;
    if (room.autoStartAt === null && room.players.size > 0) {
      room.autoStartAt = this.now() + AUTO_START_DELAY_MS;
      room.updatedAt = this.now();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Tick + housekeeping                                                */
  /* ------------------------------------------------------------------ */

  private tick(): void {
    if (this.stopped) return;
    const tickStart = performance.now();
    const delta = tickStart - this.lastTickAt;
    this.lastTickAt = tickStart;
    this.accumulatorMs = Math.min(this.accumulatorMs + Math.max(0, delta), 250);

    let steps = 0;
    while (this.accumulatorMs >= TICK_MS && steps < 8) {
      this.accumulatorMs -= TICK_MS;
      this.tickCount++;
      steps++;
      this.simulateTick();
    }

    this.metrics.recordTick(performance.now() - tickStart);
  }

  private simulateTick(): void {
    for (const room of this.rooms.all()) {
      if (room.phase !== "playing" || !room.match) continue;
      const match = room.match;
      match.step();

      if (match.phase === "finished") {
        // Deliver the final death/hit effects before the results screen.
        this.broadcastSnapshot(room);
        this.endMatch(room);
        continue;
      }

      if (this.tickCount % SNAPSHOT_INTERVAL_TICKS === 0) {
        this.broadcastSnapshot(room);
      }
    }
  }

  private broadcastSnapshot(room: Room): void {
    if (!room.match) return;
    const snapshot = room.match.buildSnapshot(this.tickCount);
    const message: SnapshotMsg = {
      t: "snapshot",
      v: PROTOCOL_VERSION,
      ...snapshot,
    };
    this.sendToRoom(room, message);
  }

  private sweep(): void {
    if (this.stopped) return;
    const now = this.now();

    for (const room of this.rooms.all()) {
      let changed = false;
      for (const player of [...room.players.values()]) {
        if (
          !player.connected &&
          player.disconnectedAt !== null &&
          now - player.disconnectedAt >= RECONNECT_GRACE_MS
        ) {
          room.removePlayer(player.id, now);
          const session = this.sessionsByPlayerId.get(player.id);
          if (session && session.roomCode === room.code) session.roomCode = null;
          changed = true;
          this.logger.info("reserved slot expired", { room: room.code, playerId: player.id });
        }
      }

      if (room.isEmpty) {
        this.rooms.delete(room.code);
        this.logger.info("room deleted (empty after grace)", { room: room.code });
        continue;
      }

      if (
        room.phase === "lobby" &&
        room.autoStartAt !== null &&
        now >= room.autoStartAt &&
        room.connectedPlayers.length > 0
      ) {
        this.logger.info("public room auto-starting", { room: room.code });
        this.startMatch(room);
        continue;
      }

      if (changed) this.broadcastRoomState(room);

      if (room.phase === "finished" && now - room.updatedAt > FINISHED_ROOM_TTL_MS) {
        this.closeRoom(room, "expired", "The room expired after being inactive.");
        continue;
      }

      if (room.isEmpty && now - room.updatedAt > EMPTY_ROOM_TTL_MS) {
        this.rooms.delete(room.code);
      }
    }

    for (const session of [...this.sessions.values()]) {
      if (
        !session.socket &&
        !session.roomCode &&
        session.disconnectedAt !== null &&
        now - session.disconnectedAt >= SESSION_TTL_MS
      ) {
        this.sessions.delete(session.token);
        this.sessionsByPlayerId.delete(session.playerId);
      }
    }
  }

  private closeRoom(room: Room, reason: "closed" | "expired", message: string): void {
    const left: LeftRoomMsg = {
      t: "left_room",
      v: PROTOCOL_VERSION,
      roomCode: room.code,
      reason,
      message,
    };
    for (const player of room.players.values()) {
      const session = this.sessionsByPlayerId.get(player.id);
      if (session) {
        session.roomCode = null;
        if (session.socket) this.send(session.socket, left);
      }
    }
    this.rooms.delete(room.code);
    this.logger.info("room closed", { room: room.code, reason });
  }

  /* ------------------------------------------------------------------ */
  /* Test hook (explicitly gated by config.enableTestEndpoints)          */
  /* ------------------------------------------------------------------ */

  finishRoomForTest(code: string): boolean {
    if (!this.config.enableTestEndpoints) return false;
    const room = this.rooms.get(code);
    if (!room || room.phase !== "playing" || !room.match) return false;
    room.match.finish("time");
    this.broadcastSnapshot(room);
    this.endMatch(room);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Status + helpers                                                   */
  /* ------------------------------------------------------------------ */

  status(): Record<string, unknown> {
    return {
      ok: true,
      name: "neon-rift-arena",
      version: this.config.version,
      protocolVersion: PROTOCOL_VERSION,
      simulation: {
        tickRate: TICK_RATE,
        snapshotRate: TICK_RATE / SNAPSHOT_INTERVAL_TICKS,
        spawnProtectionMs: SPAWN_PROTECTION_MS,
        maxPlayersPerRoom: MAX_PLAYERS_PER_ROOM,
      },
      sessions: this.sessions.size,
      quickMatches: this.matchmaker.quickMatches,
      rooms: this.rooms.stats(),
      ...this.metrics.snapshot(this.rooms.stats()),
    };
  }

  private broadcastRoomState(room: Room): void {
    const message: RoomStateMsg = {
      t: "room_state",
      v: PROTOCOL_VERSION,
      room: room.toView(this.now()),
    };
    this.sendToRoom(room, message);
  }

  private sendToRoom(room: Room, message: ServerMessage): void {
    for (const player of room.players.values()) {
      if (!player.connected) continue;
      const session = this.sessionsByPlayerId.get(player.id);
      if (session?.socket) this.send(session.socket, message);
    }
  }

  private sendLeftRoom(
    connection: ClientConnection,
    session: Session,
    roomCode: string | null,
    reason: LeftRoomMsg["reason"],
  ): void {
    this.send(connection, {
      t: "left_room",
      v: PROTOCOL_VERSION,
      roomCode: roomCode ?? "",
      reason,
    });
    void session;
  }

  private send(connection: ClientConnection, message: ServerMessage): void {
    if (connection.closed || connection.ws.readyState !== 1) return;
    try {
      connection.ws.send(JSON.stringify(message));
      this.metrics.messagesOut++;
    } catch (error) {
      this.logger.warn("send failed", {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private sendError(
    connection: ClientConnection,
    code: string,
    message: string,
    fatal: boolean,
  ): void {
    const payload: ServerErrorMsg = { t: "error", v: PROTOCOL_VERSION, code, message, fatal };
    this.send(connection, payload);
  }

  private closeConnection(connection: ClientConnection, code: number, reason: string): void {
    try {
      connection.ws.close(code, reason);
    } catch {
      // Socket already closed.
    }
  }

  private generateToken(): string {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private generatePlayerId(): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      const bytes = new Uint8Array(6);
      crypto.getRandomValues(bytes);
      const id = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (!this.sessionsByPlayerId.has(id)) return id;
    }
    return `p${this.nextConnectionId}${this.now()}`;
  }

  private generatePilotName(): string {
    return `Pilot-${Math.floor(1000 + Math.random() * 9000)}`;
  }
}

/** Used by the HTTP layer to sanitize anything that reaches a room name. */
export function safeNameOrFallback(raw: unknown, fallback: string): string {
  return sanitizeName(raw) ?? fallback;
}
