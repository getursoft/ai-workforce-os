import { Module } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { ObservabilityModule } from "../observability/observability.module";
import { SchedulerModule } from "../scheduler/scheduler.module";
import { HealthController } from "./health.controller";
import { MetricsController } from "./metrics.controller";
import { DiskHealthService } from "./disk-health.service";
import { RetentionService } from "../retention/retention.service";

@Module({
  imports: [PrismaModule, ObservabilityModule, SchedulerModule],
  controllers: [HealthController, MetricsController],
  providers: [DiskHealthService, RetentionService]
})
export class ProductionModule {}
