const TICK_WINDOW = 300;

/**
 * Process-local observability. The public snapshot deliberately excludes
 * player names, session tokens, and room codes.
 */
export class Metrics {
  readonly startedAt = Date.now();

  connectionsTotal = 0;
  activeConnections = 0;
  messagesIn = 0;
  messagesOut = 0;
  invalidMessages = 0;
  rateLimited = 0;
  roomsCreated = 0;
  matchesStarted = 0;
  matchesFinished = 0;
  errors = 0;

  private tickDurations: number[] = [];
  private lastTickAt = 0;

  recordTick(durationMs: number): void {
    this.lastTickAt = Date.now();
    this.tickDurations.push(durationMs);
    if (this.tickDurations.length > TICK_WINDOW) this.tickDurations.shift();
  }

  tickStats(): { avgMs: number; maxMs: number; lastMs: number; samples: number } {
    if (this.tickDurations.length === 0) {
      return { avgMs: 0, maxMs: 0, lastMs: 0, samples: 0 };
    }
    let total = 0;
    let max = 0;
    for (const duration of this.tickDurations) {
      total += duration;
      if (duration > max) max = duration;
    }
    return {
      avgMs: round(total / this.tickDurations.length, 3),
      maxMs: round(max, 3),
      lastMs: round(this.tickDurations[this.tickDurations.length - 1], 3),
      samples: this.tickDurations.length,
    };
  }

  lastTickAgeMs(): number {
    return this.lastTickAt === 0 ? 0 : Date.now() - this.lastTickAt;
  }

  snapshot(rooms: {
    total: number;
    lobby: number;
    playing: number;
    finished: number;
    players: number;
  }): Record<string, unknown> {
    const memory = process.memoryUsage();
    return {
      ok: true,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      rooms,
      connections: {
        active: this.activeConnections,
        total: this.connectionsTotal,
      },
      messages: {
        in: this.messagesIn,
        out: this.messagesOut,
        invalid: this.invalidMessages,
        rateLimited: this.rateLimited,
      },
      matches: {
        started: this.matchesStarted,
        finished: this.matchesFinished,
      },
      roomsCreated: this.roomsCreated,
      tick: {
        ...this.tickStats(),
        lastTickAgeMs: this.lastTickAgeMs(),
      },
      memoryMb: {
        rss: round(memory.rss / 1024 / 1024, 1),
        heapUsed: round(memory.heapUsed / 1024 / 1024, 1),
      },
      errors: this.errors,
    };
  }
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
