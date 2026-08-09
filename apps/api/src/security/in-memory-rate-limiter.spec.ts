import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryRateLimiter } from "./in-memory-rate-limiter";

describe("InMemoryRateLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("allows requests up to the category limit, then blocks with a retryAfterMs pointing at the window reset", () => {
    const limiter = new InMemoryRateLimiter();
    for (let i = 0; i < 10; i++) {
      const result = limiter.consume("ip:1.2.3.4", "AUTH_STRICT");
      expect(result.allowed).toBe(true);
    }
    const blocked = limiter.consume("ip:1.2.3.4", "AUTH_STRICT");
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(5 * 60_000);
  });

  it("tracks separate buckets per key so one IP being blocked never affects another", () => {
    const limiter = new InMemoryRateLimiter();
    for (let i = 0; i < 10; i++) limiter.consume("ip:1.1.1.1", "AUTH_STRICT");
    expect(limiter.consume("ip:1.1.1.1", "AUTH_STRICT").allowed).toBe(false);
    expect(limiter.consume("ip:2.2.2.2", "AUTH_STRICT").allowed).toBe(true);
  });

  it("tracks separate buckets per category for the same key", () => {
    const limiter = new InMemoryRateLimiter();
    for (let i = 0; i < 10; i++) limiter.consume("ip:1.1.1.1", "AUTH_STRICT");
    expect(limiter.consume("ip:1.1.1.1", "AUTH_STRICT").allowed).toBe(false);
    expect(limiter.consume("ip:1.1.1.1", "GENERAL_API").allowed).toBe(true);
  });

  it("resets the window and allows requests again once the window elapses", () => {
    const limiter = new InMemoryRateLimiter();
    for (let i = 0; i < 10; i++) limiter.consume("ip:1.1.1.1", "AUTH_STRICT");
    expect(limiter.consume("ip:1.1.1.1", "AUTH_STRICT").allowed).toBe(false);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(limiter.consume("ip:1.1.1.1", "AUTH_STRICT").allowed).toBe(true);
  });
});
