import { describe, expect, it } from "vitest";
import {
  backoffDelayForAttempt,
  decideRetry,
  isRetryPolicy,
  normalizeRetryPolicy
} from "./job-retry.service";

describe("retry policy validation", () => {
  it("accepts the documented ladder", () => {
    for (const policy of [
      "IMMEDIATE",
      "30_SEC",
      "2_MIN",
      "5_MIN",
      "30_MIN",
      "2_HOUR",
      "24_HOUR",
      "NONE"
    ]) {
      expect(isRetryPolicy(policy)).toBe(true);
    }
    expect(isRetryPolicy("EVERY_10_SECONDS")).toBe(false);
  });
  it("normalizes unknown/absent policies to 5_MIN", () => {
    expect(normalizeRetryPolicy(null)).toBe("5_MIN");
    expect(normalizeRetryPolicy(undefined)).toBe("5_MIN");
    expect(normalizeRetryPolicy("bogus")).toBe("5_MIN");
    expect(normalizeRetryPolicy("IMMEDIATE")).toBe("IMMEDIATE");
  });
});

describe("decideRetry / exponential backoff", () => {
  it("returns an increasing backoff ladder", () => {
    expect(backoffDelayForAttempt("30_SEC", 1)).toBe(30_000);
    expect(backoffDelayForAttempt("30_SEC", 2)).toBe(60_000);
    expect(backoffDelayForAttempt("30_SEC", 3)).toBe(120_000);
    expect(backoffDelayForAttempt("2_MIN", 1)).toBe(120_000);
    expect(backoffDelayForAttempt("2_MIN", 2)).toBe(300_000);
  });

  it("retries within the budget then dead-letters", () => {
    const attempt1 = decideRetry({ policy: "IMMEDIATE", attemptCount: 1, maxRetry: 2 });
    expect(attempt1.shouldRetry).toBe(true);
    expect(attempt1.deadLettered).toBe(false);
    expect(attempt1.delayMs).toBe(0);

    const attempt2 = decideRetry({ policy: "IMMEDIATE", attemptCount: 2, maxRetry: 2 });
    expect(attempt2.shouldRetry).toBe(true);

    const attempt3 = decideRetry({ policy: "IMMEDIATE", attemptCount: 3, maxRetry: 2 });
    expect(attempt3.shouldRetry).toBe(false);
    expect(attempt3.deadLettered).toBe(true);
  });

  it("NONE policy never retries", () => {
    const decision = decideRetry({ policy: "NONE", attemptCount: 1, maxRetry: 5 });
    expect(decision.shouldRetry).toBe(false);
    expect(decision.deadLettered).toBe(true);
  });

  it("maxRetry 0 disables retries", () => {
    const decision = decideRetry({ policy: "5_MIN", attemptCount: 1, maxRetry: 0 });
    expect(decision.shouldRetry).toBe(false);
    expect(decision.deadLettered).toBe(true);
  });
});
