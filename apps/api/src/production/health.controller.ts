import { Controller, Get, HttpCode, HttpStatus } from "@nestjs/common";
import { IdentityApplicationError } from "../identity/application/errors/identity.error";
import { PrismaService } from "../infrastructure/prisma/prisma.service";

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
      return {
        status: "ready",
        checks: { database: "up", schema: "compatible" },
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
