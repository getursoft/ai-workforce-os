import { Controller, Get, HttpCode, HttpStatus } from "@nestjs/common";
import { IdentityApplicationError } from "../identity/application/errors/identity.error";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { RateLimitExempt } from "../security/rate-limit.decorator";

@RateLimitExempt()
@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("live")
  @HttpCode(HttpStatus.OK)
  live() {
    return { status: "live", timestamp: new Date().toISOString() };
  }

  @Get("ready")
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      await this.prisma.connectorDefinition.count({ take: 1 });
      // Sprint 5.0 Phase 22: the durable queue is a required dependency for background processing —
      // confirm the table is reachable through the same connection pool, not just that Postgres is up.
      await this.prisma.queueMessage.count({ take: 1 });
      return {
        status: "ready",
        checks: { database: "up", schema: "compatible", queue: "up" },
        timestamp: new Date().toISOString()
      };
    } catch {
      throw new IdentityApplicationError(
        "PRODUCTION_CONFIGURATION_INVALID",
        "The application is not ready."
      );
    }
  }
}
