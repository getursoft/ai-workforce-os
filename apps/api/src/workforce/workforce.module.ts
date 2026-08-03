import { Module } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { IdentityModule } from "../identity/identity.module";
import { AgentModule } from "../agents/agent.module";
import { MemoryModule } from "../memory/memory.module";
import { EmployeeRegistry } from "./employee-registry";
import { EmployeeCollaborationRouter } from "./employee-collaboration-router";
import { DelegationContractValidator } from "./delegation-contract";
import { WorkforceCollaborationPolicyService } from "./workforce-collaboration-policy.service";
import { WorkforceOrchestratorService } from "./workforce-orchestrator.service";
import { WorkforceTaskProcessor } from "./workforce-task-processor";
import { WorkforceController } from "./workforce.controller";

@Module({
  imports: [PrismaModule, IdentityModule, AgentModule, MemoryModule],
  controllers: [WorkforceController],
  providers: [
    EmployeeRegistry,
    EmployeeCollaborationRouter,
    DelegationContractValidator,
    WorkforceCollaborationPolicyService,
    WorkforceOrchestratorService,
    WorkforceTaskProcessor
  ],
  exports: [EmployeeRegistry, EmployeeCollaborationRouter, WorkforceOrchestratorService, WorkforceCollaborationPolicyService]
})
export class WorkforceModule {}
