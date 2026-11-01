import type { Room } from "../rooms/Room";
import type { RoomManager } from "../rooms/RoomManager";

/**
 * Public matchmaking is deliberately simple and honest: quick match reuses
 * the most populated public lobby that still has capacity, or creates a new
 * one. Public lobbies auto-start shortly after the first player arrives so a
 * solo player still gets into a match quickly, and late arrivals are never
 * dropped into an in-progress game.
 */
export class Matchmaker {
  quickMatches = 0;

  constructor(private readonly rooms: RoomManager) {}

  findRoom(): Room | undefined {
    return this.rooms.findPublicJoinable();
  }

  recordQuickMatch(): void {
    this.quickMatches++;
  }
}
