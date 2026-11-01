import { describe, expect, test } from "bun:test";
import { TokenBucket } from "../../src/server/security/rate-limit";

describe("TokenBucket", () => {
  test("allows a burst up to capacity then rejects", () => {
    let now = 0;
    const bucket = new TokenBucket(5, 10, () => now);
    for (let i = 0; i < 5; i += 1) expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  test("refills at the configured sustained rate", () => {
    let now = 0;
    const bucket = new TokenBucket(2, 10, () => now);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);

    now = 50; // 50ms → 0.5 tokens
    expect(bucket.tryConsume()).toBe(false);

    now = 100; // 100ms → 1 token
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  test("never exceeds capacity after a long idle period", () => {
    let now = 0;
    const bucket = new TokenBucket(3, 100, () => now);
    now = 60_000;
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  test("supports weighted consumption", () => {
    let now = 0;
    const bucket = new TokenBucket(10, 1, () => now);
    expect(bucket.tryConsume(8)).toBe(true);
    expect(bucket.tryConsume(3)).toBe(false);
    now = 2_000;
    expect(bucket.tryConsume(3)).toBe(true);
  });
});
