import { Global, Module } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { ObservabilityService } from "./observability.service";
import { TraceContextStore } from "./trace-context.store";
import { ObservabilityOtelExporterService } from "./observability-otel-exporter.service";

/**
 * Sprint 4.7: ObservabilityService needs to be injectable from AgentService, WorkforceOrchestratorService,
 * ApprovalService, the channel pipeline, etc. — a long, cross-cutting list of existing modules. Making it
 * @Global() (same pattern as WorkforceEventsModule from Sprint 4.6) means every one of those modules can
 * inject it without this module being added to each of their `imports` arrays individually.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [ObservabilityService, TraceContextStore, ObservabilityOtelExporterService],
  exports: [ObservabilityService, TraceContextStore, ObservabilityOtelExporterService]
})
export class ObservabilityCoreModule {}
