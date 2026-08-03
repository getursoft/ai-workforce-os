import { Module } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { IdentityModule } from "../identity/identity.module";
import { WorkforceModule } from "../workforce/workforce.module";
import { ChannelModule } from "../channels/channel.module";
import { ObservabilityMetricsService } from "./observability-metrics.service";
import { ObservabilityAlertsService } from "./observability-alerts.service";
import { ObservabilityOperationsService } from "./observability-operations.service";
import { ObservabilityHealthService } from "./observability-health.service";
import { ObservabilityRetentionService } from "./observability-retention.service";
import { ObservabilityController } from "./observability.controller";

/**
 * Sprint 4.7 Phase 13/16/17/18: the read/alert/operations surface built on top of ObservabilityService
 * (which lives in ObservabilityCoreModule, @Global, imported once in AppModule). This module only adds
 * the pieces that need OTHER services (WorkforceOrchestratorService for safe retries/cancels, identity
 * guards for RBAC) — kept separate from the core module so the core tracing primitive has no dependency
 * on the workforce/identity module graph.
 */
@Module({
  imports: [PrismaModule, IdentityModule, WorkforceModule, ChannelModule],
  controllers: [ObservabilityController],
  providers: [ObservabilityMetricsService, ObservabilityAlertsService, ObservabilityOperationsService, ObservabilityHealthService, ObservabilityRetentionService],
  exports: [ObservabilityMetricsService, ObservabilityAlertsService]
})
export class ObservabilityModule {}
