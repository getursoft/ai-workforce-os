import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitGuard } from "./rate-limit.guard";
import { RATE_LIMIT_EXEMPT_METADATA, RATE_LIMIT_METADATA } from "./rate-limit.decorator";

function context(request: Record<string, unknown> = { ip: "1.2.3.4" }) {
  const response = { setHeader: vi.fn() };
  return {
    ctx: {
      getHandler: () => "handler",
      getClass: () => "class",
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response })
    } as never,
    response
  };
}

describe("RateLimitGuard", () => {
  const originalEnv = process.env.NODE_ENV;
  beforeEach(() => {
    // The guard bypasses entirely under NODE_ENV=test (see rate-limit.guard.ts) so the e2e suite isn't
    // flaky; force it off here to exercise the real enforcement path.
    process.env.NODE_ENV = "not-test";
  });
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("allows requests when no limiter is injected (Optional DI, e.g. isolated unit construction)", () => {
    const reflector = { getAllAndOverride: vi.fn() };
    const guard = new RateLimitGuard(reflector as never, undefined);
    expect(guard.canActivate(context().ctx)).toBe(true);
  });

  it("skips entirely for a route marked @RateLimitExempt()", () => {
    const reflector = { getAllAndOverride: vi.fn((key: string) => key === RATE_LIMIT_EXEMPT_METADATA) };
    const limiter = { consume: vi.fn() };
    const guard = new RateLimitGuard(reflector as never, limiter as never);
    expect(guard.canActivate(context().ctx)).toBe(true);
    expect(limiter.consume).not.toHaveBeenCalled();
  });

  it("defaults to GENERAL_API when no @RateLimit category is set, and keys by IP pre-auth", () => {
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(undefined) };
    const limiter = { consume: vi.fn().mockReturnValue({ allowed: true, limit: 300, remaining: 299, retryAfterMs: 0 }) };
    const guard = new RateLimitGuard(reflector as never, limiter as never);
    const { ctx } = context({ ip: "9.9.9.9" });
    expect(guard.canActivate(ctx)).toBe(true);
    expect(limiter.consume).toHaveBeenCalledWith("ip:9.9.9.9", "GENERAL_API");
  });

  it("keys by organization once a principal is attached (post-auth pass)", () => {
    const reflector = { getAllAndOverride: vi.fn((key: string) => (key === RATE_LIMIT_METADATA ? "AI_EXECUTION" : undefined)) };
    const limiter = { consume: vi.fn().mockReturnValue({ allowed: true, limit: 60, remaining: 59, retryAfterMs: 0 }) };
    const guard = new RateLimitGuard(reflector as never, limiter as never);
    const { ctx } = context({ ip: "9.9.9.9", principal: { organizationId: { toString: () => "org-1" } } });
    guard.canActivate(ctx);
    expect(limiter.consume).toHaveBeenCalledWith("org:org-1", "AI_EXECUTION");
  });

  it("throws a mapped, typed error and sets Retry-After when the limit is exceeded", () => {
    const reflector = { getAllAndOverride: vi.fn((key: string) => (key === RATE_LIMIT_METADATA ? "AUTH_STRICT" : undefined)) };
    const limiter = { consume: vi.fn().mockReturnValue({ allowed: false, limit: 10, remaining: 0, retryAfterMs: 42_000 }) };
    const guard = new RateLimitGuard(reflector as never, limiter as never);
    const { ctx, response } = context({ ip: "1.2.3.4" });
    expect(() => guard.canActivate(ctx)).toThrow(expect.objectContaining({ code: "RATE_LIMIT_EXCEEDED" }));
    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "42");
  });
});
