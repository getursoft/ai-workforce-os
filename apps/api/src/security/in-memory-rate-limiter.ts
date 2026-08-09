import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { RATE_LIMIT_RULES, type RateLimitCategory, type RateLimitCheckResult, type RateLimiter } from "./rate-limit.types";

interface Bucket {
  count: number;
  windowStart: number;
}

const CLEANUP_INTERVAL_MS = 5 * 60_000;

/** Fixed-window counter per (category, key), single process. See rate-limit.types.ts for the
 *  multi-instance caveat. Buckets older than their window are swept periodically so memory never grows
 *  unbounded under high-cardinality keys (e.g. one bucket per attacking IP). */
@Injectable()
export class InMemoryRateLimiter implements RateLimiter, OnModuleDestroy {
  private readonly buckets = new Map<string, Bucket>();
  private readonly cleanupTimer: ReturnType<typeof setInterval> | null;

  constructor() {
    this.cleanupTimer =
      process.env.NODE_ENV === "test"
        ? null
        : setInterval(() => this.sweep(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer?.unref?.();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  consume(key: string, category: RateLimitCategory): RateLimitCheckResult {
    const rule = RATE_LIMIT_RULES[category];
    const now = Date.now();
    const bucketKey = `${category}:${key}`;
    const existing = this.buckets.get(bucketKey);
    if (!existing || now - existing.windowStart >= rule.windowMs) {
      this.buckets.set(bucketKey, { count: 1, windowStart: now });
      return { allowed: true, limit: rule.limit, remaining: rule.limit - 1, retryAfterMs: 0 };
    }
    if (existing.count >= rule.limit) {
      return { allowed: false, limit: rule.limit, remaining: 0, retryAfterMs: Math.max(rule.windowMs - (now - existing.windowStart), 0) };
    }
    existing.count += 1;
    return { allowed: true, limit: rule.limit, remaining: rule.limit - existing.count, retryAfterMs: 0 };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      const category = key.split(":", 1)[0] as RateLimitCategory;
      const rule = RATE_LIMIT_RULES[category];
      if (!rule || now - bucket.windowStart >= rule.windowMs) this.buckets.delete(key);
    }
  }
}
