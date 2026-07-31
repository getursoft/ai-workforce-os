import { Module, forwardRef } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { IdentityModule } from "../identity/identity.module";
import { AgentModule } from "../agents/agent.module";
import { EmployeesModule } from "../employees/employees.module";
import { SalesEmployeeService } from "./sales-employee.service";
import { SalesEmployeeController } from "./sales-employee.controller";

@Module({
  imports: [PrismaModule, IdentityModule, EmployeesModule, forwardRef(() => AgentModule)],
  controllers: [SalesEmployeeController],
  providers: [SalesEmployeeService],
  exports: [SalesEmployeeService],
})
export class SalesModule {}
