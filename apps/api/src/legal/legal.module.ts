import { Module, forwardRef } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { IdentityModule } from "../identity/identity.module";
import { AgentModule } from "../agents/agent.module";
import { EmployeesModule } from "../employees/employees.module";
import { LegalEmployeeService } from "./legal-employee.service";
import { LegalEmployeeController } from "./legal-employee.controller";
import { LegalDocumentController } from "./legal-document.controller";
import { LegalPdfService } from "./legal-pdf.service";

@Module({
  imports: [PrismaModule, IdentityModule, EmployeesModule, forwardRef(() => AgentModule)],
  controllers: [LegalEmployeeController, LegalDocumentController],
  providers: [LegalEmployeeService, LegalPdfService],
  exports: [LegalEmployeeService, LegalPdfService],
})
export class LegalModule {}
