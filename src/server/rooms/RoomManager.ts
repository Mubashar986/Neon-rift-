import { randomBytes } from "node:crypto";
import { MAX_ROOMS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "../../shared/constants";
import type { RoomSettings } from "../../shared/game-rules";
import { Room } from "./Room";

export type CreateRoomResult =
  | { ok: true; room: Room }
  | { ok: false; code: "server_full" | "code_exhausted" };

/**
 * Owns the in-memory room table and room-code generation. There is
 * intentionally no persistence: this is a single-process game server.
 */
export class RoomManager {
  private rooms = new Map<string, Room>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get size(): number {
    return this.rooms.size;
  }

  all(): Room[] {
    return [...this.rooms.values()];
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  create(
    isPrivate: boolean,
    hostId: string,
    hostName: string,
    settings?: Partial<RoomSettings>,
  ): CreateRoomResult {
    if (this.rooms.size >= MAX_ROOMS) return { ok: false, code: "server_full" };

    const code = this.generateCode();
    if (!code) return { ok: false, code: "code_exhausted" };

    const room = new Room({
      code,
      isPrivate,
      hostId,
      hostName,
      settings,
      now: this.now(),
    });
    this.rooms.set(code, room);
    return { ok: true, room };
  }

  delete(code: string): Room | undefined {
    const room = this.rooms.get(code);
    if (room) this.rooms.delete(code);
    return room;
  }

  /** Public lobby rooms that still have space, best fit first. */
  findPublicJoinable(): Room | undefined {
    const candidates = [...this.rooms.values()].filter(
      (room) => !room.isPrivate && room.phase === "lobby" && room.players.size < room.settings.maxPlayers,
    );

    candidates.sort((a, b) => {
      if (b.connectedPlayers.length !== a.connectedPlayers.length) {
        return b.connectedPlayers.length - a.connectedPlayers.length;
      }
      return a.createdAt - b.createdAt;
    });

    return candidates[0];
  }

  private generateCode(): string | null {
    for (let attempt = 0; attempt < 64; attempt++) {
      const bytes = randomBytes(ROOM_CODE_LENGTH);
      let code = "";
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
      }
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  stats(): { total: number; lobby: number; playing: number; finished: number; players: number } {
    let lobby = 0;
    let playing = 0;
    let finished = 0;
    let players = 0;
    for (const room of this.rooms.values()) {
      if (room.phase === "lobby") lobby++;
      else if (room.phase === "playing") playing++;
      else finished++;
      players += room.connectedPlayers.length;
    }
    return { total: this.rooms.size, lobby, playing, finished, players };
  }
}
