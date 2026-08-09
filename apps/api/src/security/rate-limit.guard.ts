import { CanActivate, ExecutionContext, Inject, Injectable, Optional } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IdentityApplicationError } from "../identity/application/errors/identity.error";
import type { IdentityRequest, IdentityResponse } from "../identity/presentation/http/request-context";
import { RATE_LIMIT_EXEMPT_METADATA, RATE_LIMIT_METADATA } from "./rate-limit.decorator";
import { RATE_LIMITER } from "./rate-limit.tokens";
import type { RateLimitCategory, RateLimiter } from "./rate-limit.types";

type RateLimitRequest = IdentityRequest & { ip?: string; ips?: string[]; path?: string; url?: string };

/**
 * Sprint 5.0 — Phase 9. Registered globally (APP_GUARD) so every route gets at least the GENERAL_API
 * default; routes can opt into a stricter category via @RateLimit(...) or opt out entirely via
 * @RateLimitExempt() (container healthchecks only). Runs before per-controller auth guards, so keying is
 * IP-based here — controllers that want organization/user-aware limiting apply RateLimitGuard again
 * locally (after JwtAccessGuard), where `request.principal` is already populated.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject(RATE_LIMITER) private readonly limiter?: RateLimiter
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Matches the established convention for every other cross-cutting enforcement loop in this codebase
    // (scheduler/workforce/channel/retention workers all skip themselves in test) — e2e specs routinely
    // call register/login or agents.run far more than a real client would in the same window, via fast,
    // back-to-back supertest calls with no real network latency between them. Rate-limit logic itself is
    // covered by direct unit tests against InMemoryRateLimiter/RateLimitGuard, not the e2e suite.
    if (!this.limiter || process.env.NODE_ENV === "test") return true;
    const exempt = this.reflector.getAllAndOverride<boolean>(RATE_LIMIT_EXEMPT_METADATA, [context.getHandler(), context.getClass()]);
    if (exempt) return true;

    const category = this.reflector.getAllAndOverride<RateLimitCategory>(RATE_LIMIT_METADATA, [context.getHandler(), context.getClass()]) ?? "GENERAL_API";
    const request = context.switchToHttp().getRequest<RateLimitRequest>();
    const response = context.switchToHttp().getResponse<IdentityResponse>();

    const clientIp = request.ip ?? request.ips?.[0] ?? "unknown";
    const key = request.principal ? `org:${request.principal.organizationId.toString()}` : `ip:${clientIp}`;

    const result = this.limiter.consume(key, category);
    response.setHeader("X-RateLimit-Limit", String(result.limit));
    response.setHeader("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      response.setHeader("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
      throw new IdentityApplicationError("RATE_LIMIT_EXCEEDED", "Too many requests. Please slow down and try again shortly.");
    }
    return true;
  }
}
