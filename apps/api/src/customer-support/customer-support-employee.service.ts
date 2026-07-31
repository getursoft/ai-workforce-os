import { Injectable } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { EmployeeService } from "../employees/employee.service";
import { EmployeeArtifactService } from "../employees/employee-artifact.service";
import type { EmployeeConfigDto } from "../employees/employee.service";
import {
  CUSTOMER_SUPPORT_DOMAIN_SPEC,
  CUSTOMER_SUPPORT_EMPLOYEE_PLUGIN_SLUG,
  CUSTOMER_SUPPORT_REFERENCE_PREFIX,
  DEFAULT_CUSTOMER_SUPPORT_EMPLOYEE_CONFIG
} from "./customer-support.runtime";

@Injectable()
export class CustomerSupportEmployeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeeService,
    private readonly artifacts: EmployeeArtifactService
  ) {}

  private get configModel() {
    return this.prisma.customerSupportEmployeeConfiguration;
  }

  configuration(organizationId: string, pluginInstallationId: string) {
    return this.employees.configuration(
      organizationId,
      pluginInstallationId,
      this.configModel as never,
      DEFAULT_CUSTOMER_SUPPORT_EMPLOYEE_CONFIG,
      CUSTOMER_SUPPORT_EMPLOYEE_PLUGIN_SLUG,
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
      DEFAULT_CUSTOMER_SUPPORT_EMPLOYEE_CONFIG,
      CUSTOMER_SUPPORT_EMPLOYEE_PLUGIN_SLUG,
      dto,
      true
    );
  }

  state(organizationId: string, pluginInstallationId: string, conversationId: string) {
    return this.employees.state(
      organizationId,
      pluginInstallationId,
      conversationId,
      CUSTOMER_SUPPORT_DOMAIN_SPEC
    );
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
    description?: string | null;
  }) {
    return this.artifacts.createInternal(
      this.prisma.customerSupportTicket as never,
      "customerName",
      CUSTOMER_SUPPORT_REFERENCE_PREFIX,
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
          ...(input.description ? { description: input.description } : {})
        }
      }
    );
  }

  async tickets(organizationId: string, pluginInstallationId: string) {
    await this.employees.requirePlugin(
      organizationId,
      pluginInstallationId,
      CUSTOMER_SUPPORT_EMPLOYEE_PLUGIN_SLUG
    );
    return this.prisma.customerSupportTicket.findMany({
      where: { organizationId, pluginInstallationId },
      orderBy: { createdAt: "desc" }
    });
  }
}
