import { Module, forwardRef } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { IdentityModule } from "../identity/identity.module";
import { AgentModule } from "../agents/agent.module";
import { EmployeesModule } from "../employees/employees.module";
import { CustomerSupportEmployeeService } from "./customer-support-employee.service";
import { CustomerSupportEmployeeController } from "./customer-support-employee.controller";

@Module({
  imports: [PrismaModule, IdentityModule, EmployeesModule, forwardRef(() => AgentModule)],
  controllers: [CustomerSupportEmployeeController],
  providers: [CustomerSupportEmployeeService],
  exports: [CustomerSupportEmployeeService],
})
export class CustomerSupportModule {}
