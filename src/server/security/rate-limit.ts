/**
 * Token-bucket rate limiter. One bucket per WebSocket connection.
 * Uses a monotonic clock by default so wall-clock changes cannot refill it.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  tryConsume(count = 1): boolean {
    const now = this.now();
    const elapsedSeconds = Math.max(0, (now - this.lastRefill) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefill = now;

    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }
}

/** Small helper for tests: refill instantly. */
export function createTestLimiter(capacity: number, perSecond: number): TokenBucket {
  return new TokenBucket(capacity, perSecond);
}
