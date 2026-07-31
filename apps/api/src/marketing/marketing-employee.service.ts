import { Injectable } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { EmployeeService } from "../employees/employee.service";
import { EmployeeArtifactService } from "../employees/employee-artifact.service";
import type { EmployeeConfigDto } from "../employees/employee.service";
import {
  DEFAULT_MARKETING_EMPLOYEE_CONFIG,
  MARKETING_DOMAIN_SPEC,
  MARKETING_EMPLOYEE_PLUGIN_SLUG,
  MARKETING_REFERENCE_PREFIX
} from "./marketing.runtime";

@Injectable()
export class MarketingEmployeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeeService,
    private readonly artifacts: EmployeeArtifactService
  ) {}

  private get configModel() {
    return this.prisma.marketingEmployeeConfiguration;
  }

  configuration(organizationId: string, pluginInstallationId: string) {
    return this.employees.configuration(
      organizationId,
      pluginInstallationId,
      this.configModel as never,
      DEFAULT_MARKETING_EMPLOYEE_CONFIG,
      MARKETING_EMPLOYEE_PLUGIN_SLUG,
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
      DEFAULT_MARKETING_EMPLOYEE_CONFIG,
      MARKETING_EMPLOYEE_PLUGIN_SLUG,
      dto,
      true
    );
  }

  state(organizationId: string, pluginInstallationId: string, conversationId: string) {
    return this.employees.state(organizationId, pluginInstallationId, conversationId, MARKETING_DOMAIN_SPEC);
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

  async createCampaign(input: {
    organizationId: string;
    pluginInstallationId: string;
    conversationId: string;
    customerName?: string | null;
    phoneNumber: string;
    email?: string | null;
    conversationSummary: string;
    reference?: string | null;
    campaignName?: string | null;
    channel?: string | null;
    goals?: string | null;
  }) {
    return this.artifacts.createInternal(
      this.prisma.marketingCampaign as never,
      "customerName",
      MARKETING_REFERENCE_PREFIX,
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
          ...(input.campaignName ? { campaignName: input.campaignName } : {}),
          ...(input.channel ? { channel: input.channel } : {}),
          ...(input.goals ? { goals: input.goals } : {})
        }
      }
    );
  }

  async campaigns(organizationId: string, pluginInstallationId: string) {
    await this.employees.requirePlugin(organizationId, pluginInstallationId, MARKETING_EMPLOYEE_PLUGIN_SLUG);
    return this.prisma.marketingCampaign.findMany({
      where: { organizationId, pluginInstallationId },
      orderBy: { createdAt: "desc" }
    });
  }
}
