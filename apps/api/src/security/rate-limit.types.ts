/**
 * Sprint 5.0 — Phase 9: rate limiting and abuse protection.
 *
 * Category-based limits. No Redis dependency exists in this repo yet (confirmed: no ioredis/redis
 * package, REDIS_URL is an unused env-schema entry) — InMemoryRateLimiter below is safe for a single
 * process today and is exactly the "safe local adapter for development" the spec asks for. It is NOT
 * safe across multiple API replicas without a shared backing store (documented limitation, matching the
 * two pre-existing ad hoc webhook limiters this consolidates the pattern from). A Redis-backed
 * RateLimiter can be added behind the same interface later without touching call sites.
 */

export type RateLimitCategory =
  | "AUTH_STRICT"
  | "PUBLIC_APPROVAL_STRICT"
  | "AI_EXECUTION"
  | "FILE_UPLOAD"
  | "WEBHOOK"
  | "GENERAL_API"
  | "ADMIN_API";

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export const RATE_LIMIT_RULES: Record<RateLimitCategory, RateLimitRule> = {
  AUTH_STRICT: { limit: 10, windowMs: 5 * 60_000 },
  PUBLIC_APPROVAL_STRICT: { limit: 20, windowMs: 5 * 60_000 },
  AI_EXECUTION: { limit: 60, windowMs: 60_000 },
  FILE_UPLOAD: { limit: 20, windowMs: 5 * 60_000 },
  WEBHOOK: { limit: 60, windowMs: 10_000 },
  GENERAL_API: { limit: 300, windowMs: 60_000 },
  ADMIN_API: { limit: 120, windowMs: 60_000 }
};

export interface RateLimitCheckResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimiter {
  consume(key: string, category: RateLimitCategory): RateLimitCheckResult;
}
