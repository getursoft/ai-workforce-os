import { Module, forwardRef } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { IdentityModule } from "../identity/identity.module";
import { AgentModule } from "../agents/agent.module";
import { EmployeesModule } from "../employees/employees.module";
import { ItSupportEmployeeService } from "./it-support-employee.service";
import { ItSupportEmployeeController } from "./it-support-employee.controller";

@Module({
  imports: [PrismaModule, IdentityModule, EmployeesModule, forwardRef(() => AgentModule)],
  controllers: [ItSupportEmployeeController],
  providers: [ItSupportEmployeeService],
  exports: [ItSupportEmployeeService],
})
export class ItSupportModule {}
