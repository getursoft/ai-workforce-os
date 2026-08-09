import { SetMetadata } from "@nestjs/common";
import type { RateLimitCategory } from "./rate-limit.types";

export const RATE_LIMIT_METADATA = "rate-limit:category";

/** Overrides the global default (GENERAL_API) rate-limit category for a route or controller. */
export const RateLimit = (category: RateLimitCategory) => SetMetadata(RATE_LIMIT_METADATA, category);

/** Marks a route as exempt from rate limiting entirely — for container health checks only. */
export const RATE_LIMIT_EXEMPT_METADATA = "rate-limit:exempt";
export const RateLimitExempt = () => SetMetadata(RATE_LIMIT_EXEMPT_METADATA, true);
