import { Module, forwardRef } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { IdentityModule } from "../identity/identity.module";
import { AgentModule } from "../agents/agent.module";
import { EmployeesModule } from "../employees/employees.module";
import { FinanceEmployeeService } from "./finance-employee.service";
import { FinanceEmployeeController } from "./finance-employee.controller";

@Module({
  imports: [PrismaModule, IdentityModule, EmployeesModule, forwardRef(() => AgentModule)],
  controllers: [FinanceEmployeeController],
  providers: [FinanceEmployeeService],
  exports: [FinanceEmployeeService],
})
export class FinanceModule {}
