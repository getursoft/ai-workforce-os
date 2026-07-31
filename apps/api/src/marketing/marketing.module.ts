import { Module, forwardRef } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { IdentityModule } from "../identity/identity.module";
import { AgentModule } from "../agents/agent.module";
import { EmployeesModule } from "../employees/employees.module";
import { MarketingEmployeeService } from "./marketing-employee.service";
import { MarketingEmployeeController } from "./marketing-employee.controller";

@Module({
  imports: [PrismaModule, IdentityModule, EmployeesModule, forwardRef(() => AgentModule)],
  controllers: [MarketingEmployeeController],
  providers: [MarketingEmployeeService],
  exports: [MarketingEmployeeService],
})
export class MarketingModule {}
