import { Injectable } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { EmployeeService } from "../employees/employee.service";
import { EmployeeArtifactService } from "../employees/employee-artifact.service";
import type { EmployeeConfigDto } from "../employees/employee.service";
import {
  DEFAULT_FINANCE_EMPLOYEE_CONFIG,
  FINANCE_DOMAIN_SPEC,
  FINANCE_EMPLOYEE_PLUGIN_SLUG,
  FINANCE_REFERENCE_PREFIX
} from "./finance.runtime";

@Injectable()
export class FinanceEmployeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeeService,
    private readonly artifacts: EmployeeArtifactService
  ) {}

  private get configModel() {
    return this.prisma.financeEmployeeConfiguration;
  }

  configuration(organizationId: string, pluginInstallationId: string) {
    return this.employees.configuration(
      organizationId,
      pluginInstallationId,
      this.configModel as never,
      DEFAULT_FINANCE_EMPLOYEE_CONFIG,
      FINANCE_EMPLOYEE_PLUGIN_SLUG,
      true
    );
  }

  updateConfiguration(
    organizationId: string,
    userId: string,
    requestId: string,
    pluginInstallationId: string,
    dto: EmployeeConfigDto
  ) {
    return this.employees.updateConfiguration(
      organizationId,
      userId,
      requestId,
      pluginInstallationId,
      this.configModel as never,
      DEFAULT_FINANCE_EMPLOYEE_CONFIG,
      FINANCE_EMPLOYEE_PLUGIN_SLUG,
      dto,
      true
    );
  }

  state(organizationId: string, pluginInstallationId: string, conversationId: string) {
    return this.employees.state(organizationId, pluginInstallationId, conversationId, FINANCE_DOMAIN_SPEC);
  }

  resetConversation(
    organizationId: string,
    userId: string,
    requestId: string,
    pluginInstallationId: string,
    conversationId: string
  ) {
    return this.employees.resetConversation(
      organizationId,
      userId,
      requestId,
      pluginInstallationId,
      conversationId
    );
  }

  async createRecord(input: {
    organizationId: string;
    pluginInstallationId: string;
    conversationId: string;
    customerName?: string | null;
    phoneNumber: string;
    email?: string | null;
    conversationSummary: string;
    reference?: string | null;
    topic?: string | null;
    amount?: string | null;
    details?: string | null;
  }) {
    return this.artifacts.createInternal(
      this.prisma.financeRecord as never,
      "customerName",
      FINANCE_REFERENCE_PREFIX,
      {
        organizationId: input.organizationId,
        pluginInstallationId: input.pluginInstallationId,
        conversationId: input.conversationId,
        customerName: input.customerName ?? null,
        phoneNumber: input.phoneNumber,
        email: input.email ?? null,
        conversationSummary: input.conversationSummary,
        reference: input.reference ?? null,
        fields: {
          ...(input.topic ? { topic: input.topic } : {}),
          ...(input.amount ? { amount: input.amount } : {}),
          ...(input.details ? { details: input.details } : {})
        }
      }
    );
  }

  async records(organizationId: string, pluginInstallationId: string) {
    await this.employees.requirePlugin(organizationId, pluginInstallationId, FINANCE_EMPLOYEE_PLUGIN_SLUG);
    return this.prisma.financeRecord.findMany({
      where: { organizationId, pluginInstallationId },
      orderBy: { createdAt: "desc" }
    });
  }
}
