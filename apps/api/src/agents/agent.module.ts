import { Module, forwardRef } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { PluginModule } from "../plugins/plugin.module";
import { ConnectorModule } from "../connectors/connector.module";
import { AgentController } from "./agent.controller";
import { AgentService, MemoryService } from "./agent.service";
import { KnowledgeModule } from "../knowledge/knowledge.module";
import { MemoryModule } from "../memory/memory.module";
import { CustomerIdentityModule } from "../customer-identity/customer-identity.module";
import { TravelModule } from "../travel/travel.module";
import { TravelLeadService } from "../travel/travel-lead.service";
import { EmployeesModule } from "../employees/employees.module";
import { SkillRegistry } from "../skills/skill-registry";
import { SkillRuntimeService } from "../skills/skill-runtime.service";
import { PlanTripSkillHandler } from "../skills/travel/plan-trip.skill";
import { SkillExecutionService } from "../skills/skill-execution.service";
import { SkillDiagnosticsController } from "../skills/skill-diagnostics.controller";
import { PlanTripSkillDiagnosticsService } from "../skills/plan-trip-skill-diagnostics.service";
import { PlanTripShadowReviewService } from "../skills/plan-trip-shadow-review.service";
import { InputDecisionService } from "../skills/travel/input-decision.service";
import { PendingInputQuestionService } from "../skills/travel/pending-input-question.service";
import { SkillExecutionMirrorService } from "../skills/travel/skill-execution-mirror.service";
import { InputCollectionService } from "../skills/travel/input-collection.service";
import { CapabilityExecutionAdapter } from "../skills/travel/capability-execution.adapter";
import { WorkflowExecutionService } from "../workflows/workflow-execution.service";
import { ContactCaptureWorkflowService } from "../workflows/contact-capture/contact-capture.service";
import { BookingHandoffWorkflowService } from "../workflows/booking-handoff/booking-handoff.service";
import { TripSubmissionWorkflowService } from "../workflows/trip-submission/trip-submission.service";
import { WorkflowCoordinator } from "../workflows/workflow-coordinator";
import { buildDefaultWorkflowSignalProviders, WORKFLOW_SIGNAL_PROVIDERS } from "../workflows/workflow-signal-registry";

@Module({
  imports: [
    PrismaModule,
    IdentityModule,
    PluginModule,
    ConnectorModule,
    KnowledgeModule,
    MemoryModule,
    CustomerIdentityModule,
    forwardRef(() => TravelModule),
    forwardRef(() => EmployeesModule)
  ],
  controllers: [AgentController, SkillDiagnosticsController],
  providers: [
    MemoryService,
    TravelLeadService,
    PlanTripSkillHandler,
    {
      provide: SkillRegistry,
      inject: [PlanTripSkillHandler],
      useFactory: (planTrip: PlanTripSkillHandler) => {
        const registry = new SkillRegistry();
        registry.register(planTrip);
        return registry;
      }
    },
    SkillRuntimeService,
    SkillExecutionService,
    PlanTripSkillDiagnosticsService,
    PlanTripShadowReviewService,
    InputDecisionService,
    PendingInputQuestionService,
    SkillExecutionMirrorService,
    InputCollectionService,
    CapabilityExecutionAdapter,
    WorkflowExecutionService,
    ContactCaptureWorkflowService,
    BookingHandoffWorkflowService,
    TripSubmissionWorkflowService,
    {
      // Stage 9E.1: the real, DI-driven Workflow Signal Provider registration — proves
      // WorkflowCoordinator's start-time registry is composed from injected providers, not hardcoded
      // inside workflow-coordinator.ts. A future second AI Employee's module would supply its own
      // provider(s) under this same token rather than editing this factory.
      provide: WORKFLOW_SIGNAL_PROVIDERS,
      useFactory: buildDefaultWorkflowSignalProviders,
      inject: [ContactCaptureWorkflowService, BookingHandoffWorkflowService, TripSubmissionWorkflowService]
    },
    WorkflowCoordinator,
    AgentService
  ],
  exports: [AgentService, MemoryService, TravelLeadService, SkillRuntimeService]
})
export class AgentModule {}
