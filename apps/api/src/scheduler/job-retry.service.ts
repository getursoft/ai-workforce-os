/**
 * Sprint 4.8 — Retry Engine (Phase 5).
 *
 * Every execution that fails (or times out) with retries remaining is scheduled for a future attempt
 * using an exponential backoff ladder. The ladder is configurable per job (retryPolicy on the
 * JobDefinition) and always bounded by maxRetry. Executions that exhaust the ladder are parked on the
 * dead letter queue (DEAD_LETTERED) for manual intervention via the API/dashboard.
 */

import { Injectable } from "@nestjs/common";

export type RetryPolicy =
  "IMMEDIATE" | "30_SEC" | "2_MIN" | "5_MIN" | "30_MIN" | "2_HOUR" | "24_HOUR" | "NONE";

/** Ordered ladder of retry-policy delays applied per attempt: attempt 1 → first delay, etc. */
const RETRY_LADDERS: Record<Exclude<RetryPolicy, "NONE">, readonly number[]> = {
  IMMEDIATE: [0, 0, 0, 0, 0, 0],
  "30_SEC": [30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000],
  "2_MIN": [120_000, 300_000, 600_000, 1_800_000, 3_600_000, 7_200_000],
  "5_MIN": [300_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 43_200_000],
  "30_MIN": [1_800_000, 3_600_000, 7_200_000, 21_600_000, 86_400_000, 172_800_000],
  "2_HOUR": [7_200_000, 14_400_000, 43_200_000, 86_400_000, 172_800_000, 604_800_000],
  "24_HOUR": [86_400_000, 172_800_000, 345_600_000, 604_800_000, 1_209_600_000, 2_419_200_000]
};

const VALID_POLICIES: ReadonlySet<string> = new Set(Object.keys(RETRY_LADDERS).concat(["NONE"]));

export function isRetryPolicy(value: string): boolean {
  return VALID_POLICIES.has(value);
}

export function normalizeRetryPolicy(value: string | null | undefined): RetryPolicy {
  if (value && isRetryPolicy(value)) return value as RetryPolicy;
  return "5_MIN";
}

/** Human-readable labels for the retry policies (used by the dashboard/API docs). */
export const RETRY_POLICY_LABELS: Record<RetryPolicy, string> = {
  IMMEDIATE: "Immediate",
  "30_SEC": "30 seconds",
  "2_MIN": "2 minutes",
  "5_MIN": "5 minutes",
  "30_MIN": "30 minutes",
  "2_HOUR": "2 hours",
  "24_HOUR": "24 hours",
  NONE: "No retry"
};

export interface RetryDecision {
  /** Whether this failure should be retried. */
  shouldRetry: boolean;
  /** The policy ladder applied. */
  policy: RetryPolicy;
  /** Milliseconds to wait before the next attempt (0 for IMMEDIATE). */
  delayMs: number;
  /** The attempt count after which the job is dead-lettered. */
  maxRetry: number;
  /** True when retries are exhausted — the execution is parked on the DLQ. */
  deadLettered: boolean;
}

export function backoffDelayForAttempt(policy: RetryPolicy, attempt: number): number {
  if (policy === "NONE") return 0;
  const ladder = RETRY_LADDERS[policy];
  if (!ladder || ladder.length === 0) return 0;
  const delay = ladder[Math.min(Math.max(attempt - 1, 0), ladder.length - 1)];
  return delay ?? 0;
}

/**
 * Decides what to do after a failed execution at `attemptCount` (1-based). Exponential backoff means
 * later attempts wait longer, bounded by maxRetry (default 5). After maxRetry attempts the execution is
 * dead-lettered.
 */
export function decideRetry(input: {
  policy: string | null | undefined;
  attemptCount: number;
  maxRetry?: number;
}): RetryDecision {
  const policy = normalizeRetryPolicy(input.policy);
  const maxRetry = Math.max(input.maxRetry ?? 5, 0);
  if (policy === "NONE" || maxRetry === 0) {
    return {
      shouldRetry: false,
      policy,
      delayMs: 0,
      maxRetry,
      deadLettered: true
    };
  }
  const shouldRetry = input.attemptCount <= maxRetry;
  if (!shouldRetry) {
    return { shouldRetry: false, policy, delayMs: 0, maxRetry, deadLettered: true };
  }
  return {
    shouldRetry: true,
    policy,
    delayMs: backoffDelayForAttempt(policy, input.attemptCount),
    maxRetry,
    deadLettered: false
  };
}

@Injectable()
export class JobRetryService {
  decide = decideRetry;
  backoffDelayForAttempt = backoffDelayForAttempt;
  labels = RETRY_POLICY_LABELS;
}
