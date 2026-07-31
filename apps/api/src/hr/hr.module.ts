import { Module, forwardRef } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { IdentityModule } from "../identity/identity.module";
import { AgentModule } from "../agents/agent.module";
import { EmployeesModule } from "../employees/employees.module";
import { HrLeaveService } from "./hr-leave.service";
import { HrLeaveController } from "./hr-leave.controller";
import { HrEmployeeService } from "./hr-employee.service";
import { HrEmployeeController } from "./hr-employee.controller";

@Module({
  imports: [PrismaModule, IdentityModule, EmployeesModule, forwardRef(() => AgentModule)],
  controllers: [HrLeaveController, HrEmployeeController],
  providers: [HrLeaveService, HrEmployeeService],
  exports: [HrLeaveService, HrEmployeeService],
})
export class HrModule {}
