import { Module, forwardRef } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { IdentityModule } from "../identity/identity.module";
import { AgentModule } from "../agents/agent.module";
import { EmployeeService } from "./employee.service";
import { EmployeeArtifactService } from "./employee-artifact.service";

/**
 * Shared module for every non-Travel domain AI Employee (HR, Finance, IT Support, Sales, Marketing, Legal,
 * Customer Support). Provides the common configuration/state service and the common artifact-persistence
 * service; each domain employee supplies its own runtime spec (see `employee-runtime.ts`) and its own
 * thin module wiring. The Travel Employee deliberately does NOT use this module — it predates it and keeps
 * its own deeper runtime untouched.
 */
@Module({
  imports: [PrismaModule, IdentityModule, forwardRef(() => AgentModule)],
  controllers: [],
  providers: [EmployeeService, EmployeeArtifactService],
  exports: [EmployeeService, EmployeeArtifactService]
})
export class EmployeesModule {}
