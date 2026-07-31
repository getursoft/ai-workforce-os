import { Injectable } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { EmployeeService } from "../employees/employee.service";
import { EmployeeArtifactService } from "../employees/employee-artifact.service";
import {
  DEFAULT_HR_EMPLOYEE_CONFIG,
  HR_DOMAIN_SPEC,
  HR_EMPLOYEE_PLUGIN_SLUG,
  HR_REFERENCE_PREFIX
} from "./hr.runtime";
import type { EmployeeConfigDto } from "../employees/employee.service";

@Injectable()
export class HrEmployeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeeService,
    private readonly artifacts: EmployeeArtifactService
  ) {}

  private get configModel() {
    return this.prisma.hrEmployeeConfiguration;
  }

  configuration(organizationId: string, pluginInstallationId: string) {
    return this.employees.configuration(
      organizationId,
      pluginInstallationId,
      this.configModel as never,
      DEFAULT_HR_EMPLOYEE_CONFIG,
      HR_EMPLOYEE_PLUGIN_SLUG,
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
      DEFAULT_HR_EMPLOYEE_CONFIG,
      HR_EMPLOYEE_PLUGIN_SLUG,
      dto,
      true
    );
  }

  state(organizationId: string, pluginInstallationId: string, conversationId: string) {
    return this.employees.state(organizationId, pluginInstallationId, conversationId, HR_DOMAIN_SPEC);
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

  /** Persists an HR ticket after consent + contact were collected (idempotent per conversation). */
  async createTicket(input: {
    organizationId: string;
    pluginInstallationId: string;
    conversationId: string;
    customerName?: string | null;
    phoneNumber: string;
    email?: string | null;
    conversationSummary: string;
    reference?: string | null;
    topic?: string | null;
    details?: string | null;
  }) {
    return this.artifacts.createInternal(
      this.prisma.hrTicket as never,
      "employeeName",
      HR_REFERENCE_PREFIX,
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
          ...(input.details ? { details: input.details } : {})
        }
      }
    );
  }

  async tickets(organizationId: string, pluginInstallationId: string) {
    await this.employees.requirePlugin(organizationId, pluginInstallationId, HR_EMPLOYEE_PLUGIN_SLUG);
    return this.prisma.hrTicket.findMany({
      where: { organizationId, pluginInstallationId },
      orderBy: { createdAt: "desc" }
    });
  }
}
