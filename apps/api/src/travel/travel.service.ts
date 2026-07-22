import { Injectable, NotFoundException } from "@nestjs/common";
import { AgentMemoryScope, ConversationStatus } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import { AgentService } from "../agents/agent.service";
import type { UpdateTravelConfigurationDto } from "./travel.dto";
import {
  DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
  TRAVEL_EMPLOYEE_PLUGIN_SLUG,
  TRAVEL_TRIP_STATE_MEMORY_KEY,
  deriveTravelState,
  type TravelState
} from "./travel.runtime";

@Injectable()
export class TravelEmployeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentService,
    private readonly auditLogger: AuditEventLogger
  ) {}

  async configuration(organizationId: string, pluginInstallationId: string) {
    await this.requirePlugin(organizationId, pluginInstallationId);
    const row = await this.prisma.travelEmployeeConfiguration.findFirst({
      where: { organizationId, pluginInstallationId }
    });
    if (!row) return { pluginInstallationId, configured: false, ...DEFAULT_TRAVEL_EMPLOYEE_CONFIG };
    return {
      pluginInstallationId,
      configured: true,
      persona: row.persona,
      welcomeMessage: row.welcomeMessage,
      businessHoursTimezone: row.businessHoursTimezone,
      businessHoursStart: row.businessHoursStart,
      businessHoursEnd: row.businessHoursEnd,
      escalationContact: row.escalationContact,
      brandTone: row.brandTone,
      defaultCurrency: row.defaultCurrency,
      defaultLanguage: row.defaultLanguage,
      updatedAt: row.updatedAt
    };
  }

  async updateConfiguration(
    organizationId: string,
    userId: string,
    requestId: string,
    pluginInstallationId: string,
    dto: UpdateTravelConfigurationDto
  ) {
    await this.requirePlugin(organizationId, pluginInstallationId);
    const existing = await this.prisma.travelEmployeeConfiguration.findFirst({
      where: { organizationId, pluginInstallationId }
    });
    const merged = {
      persona: dto.persona ?? existing?.persona ?? DEFAULT_TRAVEL_EMPLOYEE_CONFIG.persona,
      welcomeMessage:
        dto.welcomeMessage ?? existing?.welcomeMessage ?? DEFAULT_TRAVEL_EMPLOYEE_CONFIG.welcomeMessage,
      businessHoursTimezone: dto.businessHoursTimezone ?? existing?.businessHoursTimezone ?? null,
      businessHoursStart: dto.businessHoursStart ?? existing?.businessHoursStart ?? null,
      businessHoursEnd: dto.businessHoursEnd ?? existing?.businessHoursEnd ?? null,
      escalationContact:
        dto.escalationContact ?? existing?.escalationContact ?? DEFAULT_TRAVEL_EMPLOYEE_CONFIG.escalationContact,
      brandTone: dto.brandTone ?? existing?.brandTone ?? DEFAULT_TRAVEL_EMPLOYEE_CONFIG.brandTone,
      defaultCurrency:
        dto.defaultCurrency ?? existing?.defaultCurrency ?? DEFAULT_TRAVEL_EMPLOYEE_CONFIG.defaultCurrency,
      defaultLanguage:
        dto.defaultLanguage ?? existing?.defaultLanguage ?? DEFAULT_TRAVEL_EMPLOYEE_CONFIG.defaultLanguage
    };
    const row = existing
      ? await this.prisma.travelEmployeeConfiguration.update({
          where: { id: existing.id },
          data: merged
        })
      : await this.prisma.travelEmployeeConfiguration.create({
          data: { organizationId, pluginInstallationId, createdByUserId: userId, ...merged }
        });
    this.auditLogger.record("TRAVEL_CONFIGURATION_UPDATED", requestId, {
      organizationId,
      userId,
      targetId: pluginInstallationId
    });
    return this.configuration(organizationId, row.pluginInstallationId);
  }

  async state(organizationId: string, pluginInstallationId: string, conversationId: string): Promise<TravelState> {
    await this.requirePlugin(organizationId, pluginInstallationId);
    await this.requireConversation(organizationId, pluginInstallationId, conversationId);
    const memory = await this.prisma.agentMemory.findFirst({
      where: {
        organizationId,
        pluginInstallationId,
        conversationId,
        scope: AgentMemoryScope.CONVERSATION,
        key: TRAVEL_TRIP_STATE_MEMORY_KEY,
        deletedAt: null
      }
    });
    if (memory) return memory.value as unknown as TravelState;
    const messages = await this.prisma.conversationMessage.findMany({
      where: { conversationId, organizationId },
      orderBy: { createdAt: "asc" }
    });
    return deriveTravelState(
      messages.map((message) => ({ role: toLowerRole(message.role), content: message.content }))
    );
  }

  async resetConversation(
    organizationId: string,
    userId: string,
    requestId: string,
    pluginInstallationId: string,
    conversationId: string
  ) {
    await this.requirePlugin(organizationId, pluginInstallationId);
    await this.requireConversation(organizationId, pluginInstallationId, conversationId);
    const result = await this.agents.archive(organizationId, conversationId, ConversationStatus.ARCHIVED);
    this.auditLogger.record("TRAVEL_CONVERSATION_RESET", requestId, {
      organizationId,
      userId,
      targetId: conversationId
    });
    return result;
  }

  private async requirePlugin(organizationId: string, pluginInstallationId: string) {
    const plugin = await this.prisma.plugin.findFirst({
      where: { id: pluginInstallationId, organizationId, deletedAt: null }
    });
    if (!plugin || plugin.slug !== TRAVEL_EMPLOYEE_PLUGIN_SLUG)
      throw new NotFoundException("TRAVEL_EMPLOYEE_NOT_FOUND");
    return plugin;
  }

  private async requireConversation(
    organizationId: string,
    pluginInstallationId: string,
    conversationId: string
  ) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId, pluginInstallationId, deletedAt: null }
    });
    if (!conversation) throw new NotFoundException("CONVERSATION_NOT_FOUND");
    return conversation;
  }
}

function toLowerRole(role: string): "system" | "user" | "assistant" | "tool" {
  const lower = role.toLowerCase();
  return lower === "user" || lower === "assistant" || lower === "tool" ? lower : "system";
}
