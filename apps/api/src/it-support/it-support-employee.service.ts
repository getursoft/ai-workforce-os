import { Injectable } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { EmployeeService } from "../employees/employee.service";
import { EmployeeArtifactService } from "../employees/employee-artifact.service";
import type { EmployeeConfigDto } from "../employees/employee.service";
import {
  DEFAULT_IT_SUPPORT_EMPLOYEE_CONFIG,
  IT_SUPPORT_DOMAIN_SPEC,
  IT_SUPPORT_EMPLOYEE_PLUGIN_SLUG,
  IT_SUPPORT_REFERENCE_PREFIX
} from "./it-support.runtime";

@Injectable()
export class ItSupportEmployeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeeService,
    private readonly artifacts: EmployeeArtifactService
  ) {}

  private get configModel() {
    return this.prisma.itSupportEmployeeConfiguration;
  }

  configuration(organizationId: string, pluginInstallationId: string) {
    return this.employees.configuration(
      organizationId,
      pluginInstallationId,
      this.configModel as never,
      DEFAULT_IT_SUPPORT_EMPLOYEE_CONFIG,
      IT_SUPPORT_EMPLOYEE_PLUGIN_SLUG,
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
      DEFAULT_IT_SUPPORT_EMPLOYEE_CONFIG,
      IT_SUPPORT_EMPLOYEE_PLUGIN_SLUG,
      dto,
      true
    );
  }

  state(organizationId: string, pluginInstallationId: string, conversationId: string) {
    return this.employees.state(organizationId, pluginInstallationId, conversationId, IT_SUPPORT_DOMAIN_SPEC);
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
    category?: string | null;
    description?: string | null;
  }) {
    return this.artifacts.createInternal(
      this.prisma.itSupportTicket as never,
      "employeeName",
      IT_SUPPORT_REFERENCE_PREFIX,
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
          ...(input.category ? { category: input.category } : {}),
          ...(input.description ? { description: input.description } : {})
        }
      }
    );
  }

  async tickets(organizationId: string, pluginInstallationId: string) {
    await this.employees.requirePlugin(organizationId, pluginInstallationId, IT_SUPPORT_EMPLOYEE_PLUGIN_SLUG);
    return this.prisma.itSupportTicket.findMany({
      where: { organizationId, pluginInstallationId },
      orderBy: { createdAt: "desc" }
    });
  }
}
