import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { InMemoryRateLimiter } from "./in-memory-rate-limiter";
import { RATE_LIMITER } from "./rate-limit.tokens";
import { RateLimitGuard } from "./rate-limit.guard";

/** Sprint 5.0 — Phase 9: global abuse protection. @Global so any controller can apply @RateLimit(...)
 *  without importing this module explicitly, matching the ConfigModule/QueueModule convention. */
@Global()
@Module({
  providers: [
    { provide: RATE_LIMITER, useClass: InMemoryRateLimiter },
    RateLimitGuard,
    { provide: APP_GUARD, useClass: RateLimitGuard }
  ],
  exports: [RATE_LIMITER, RateLimitGuard]
})
export class SecurityModule {}
