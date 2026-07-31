import { Injectable } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { EmployeeService } from "../employees/employee.service";
import { EmployeeArtifactService } from "../employees/employee-artifact.service";
import type { EmployeeConfigDto } from "../employees/employee.service";
import {
  DEFAULT_LEGAL_EMPLOYEE_CONFIG,
  LEGAL_DOMAIN_SPEC,
  LEGAL_EMPLOYEE_PLUGIN_SLUG,
  LEGAL_REFERENCE_PREFIX
} from "./legal.runtime";

@Injectable()
export class LegalEmployeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeeService,
    private readonly artifacts: EmployeeArtifactService
  ) {}

  private get configModel() {
    return this.prisma.legalEmployeeConfiguration;
  }

  configuration(organizationId: string, pluginInstallationId: string) {
    return this.employees.configuration(
      organizationId,
      pluginInstallationId,
      this.configModel as never,
      DEFAULT_LEGAL_EMPLOYEE_CONFIG,
      LEGAL_EMPLOYEE_PLUGIN_SLUG,
      false,
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
      DEFAULT_LEGAL_EMPLOYEE_CONFIG,
      LEGAL_EMPLOYEE_PLUGIN_SLUG,
      dto,
      false,
      true
    );
  }

  state(organizationId: string, pluginInstallationId: string, conversationId: string) {
    return this.employees.state(organizationId, pluginInstallationId, conversationId, LEGAL_DOMAIN_SPEC);
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

  async createNotice(input: {
    organizationId: string;
    pluginInstallationId: string;
    conversationId: string;
    customerName?: string | null;
    phoneNumber: string;
    email?: string | null;
    conversationSummary: string;
    reference?: string | null;
    noticeType?: string | null;
    deadline?: string | null;
    summary?: string | null;
  }) {
    return this.artifacts.createInternal(
      this.prisma.legalNotice as never,
      "customerName",
      LEGAL_REFERENCE_PREFIX,
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
          ...(input.noticeType ? { noticeType: input.noticeType } : {}),
          ...(input.deadline ? { deadline: input.deadline } : {}),
          ...(input.summary ? { summary: input.summary } : {})
        }
      }
    );
  }

  async notices(organizationId: string, pluginInstallationId: string) {
    await this.employees.requirePlugin(organizationId, pluginInstallationId, LEGAL_EMPLOYEE_PLUGIN_SLUG);
    return this.prisma.legalNotice.findMany({
      where: { organizationId, pluginInstallationId },
      orderBy: { createdAt: "desc" }
    });
  }
}
