import { Injectable, NotFoundException } from "@nestjs/common";
import { AgentMemoryScope, ConversationStatus } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import { AgentService } from "../agents/agent.service";
import {
  type EmployeeDomainSpec,
  type EmployeeRuntimeConfig,
  deriveEmployeeStage,
  employeeEntitiesFromStoredState,
  employeeMemoryFromStoredState
} from "./employee-runtime";

/** The subset of a config-model Prisma delegate the shared service needs. */
export interface EmployeeConfigDelegate {
  findFirst(args: unknown): Promise<Record<string, unknown> | null>;
  update(args: unknown): Promise<Record<string, unknown>>;
  create(args: unknown): Promise<Record<string, unknown>>;
}

export interface EmployeeConfigDto {
  persona?: string;
  welcomeMessage?: string;
  businessHoursTimezone?: string;
  businessHoursStart?: string;
  businessHoursEnd?: string;
  escalationContact?: string;
  brandTone?: string;
  defaultCurrency?: string;
  defaultLanguage?: string;
  /** When ON, the employee uses the configured real API flow instead of the built-in dummy flow. */
  apiEnabled?: boolean;
  /** Base URL of the real backend API used when `apiEnabled` is ON. */
  apiEndpoint?: string;
  /** API key/secret for the real backend API used when `apiEnabled` is ON. */
  apiKey?: string;
  /** Default jurisdiction/country for legal queries (Legal Employee) — e.g. "India". */
  defaultCountry?: string;
}

export interface EmployeeState {
  customerName: string | null;
  stage: string;
  onboardingCompleted: boolean;
  greetingSent: boolean;
  missingFields: string[];
  [key: string]: string | boolean | string[] | null;
}

/**
 * Shared configuration + state service for every non-Travel domain employee. Travel keeps its own
 * (it predates this module and has deeper semantics); every new employee wires a {@link EmployeeDomainSpec}
 * + a config Prisma delegate + its plugin slug into this one class, so config CRUD, conversation state
 * reads, and conversation reset behave identically across HR / Finance / IT / Sales / Marketing / Legal /
 * Customer Support. This is the direct structural mirror of `travel.service.ts`.
 */
@Injectable()
export class EmployeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentService,
    private readonly auditLogger: AuditEventLogger
  ) {}

  async configuration(
    organizationId: string,
    pluginInstallationId: string,
    configModel: EmployeeConfigDelegate,
    defaults: EmployeeRuntimeConfig,
    pluginSlug: string,
    supportsApi = false,
    supportsCountry = false
  ) {
    await this.requirePlugin(organizationId, pluginInstallationId, pluginSlug);
    const row = await configModel.findFirst({ where: { organizationId, pluginInstallationId } });
    if (!row) return { pluginInstallationId, configured: false, ...defaults };
    return {
      pluginInstallationId,
      configured: true,
      persona: row.persona ?? defaults.persona,
      welcomeMessage: row.welcomeMessage ?? defaults.welcomeMessage,
      businessHoursTimezone: (row.businessHoursTimezone as string | null) ?? null,
      businessHoursStart: (row.businessHoursStart as string | null) ?? null,
      businessHoursEnd: (row.businessHoursEnd as string | null) ?? null,
      escalationContact: row.escalationContact ?? defaults.escalationContact,
      brandTone: row.brandTone ?? defaults.brandTone,
      defaultCurrency: row.defaultCurrency ?? defaults.defaultCurrency,
      defaultLanguage: row.defaultLanguage ?? defaults.defaultLanguage,
      ...(supportsApi
        ? {
            apiEnabled: row.apiEnabled === true,
            apiEndpoint: (row.apiEndpoint as string | null) ?? null,
            apiKey: (row.apiKey as string | null) ?? null
          }
        : {}),
      ...(supportsCountry
        ? { defaultCountry: (row.defaultCountry as string | null) ?? "India" }
        : {}),
      updatedAt: row.updatedAt as Date | undefined
    };
  }

  async updateConfiguration(
    organizationId: string,
    userId: string,
    requestId: string,
    pluginInstallationId: string,
    configModel: EmployeeConfigDelegate,
    defaults: EmployeeRuntimeConfig,
    pluginSlug: string,
    dto: EmployeeConfigDto,
    supportsApi = false,
    supportsCountry = false
  ) {
    await this.requirePlugin(organizationId, pluginInstallationId, pluginSlug);
    const existing = await configModel.findFirst({ where: { organizationId, pluginInstallationId } });
    const merged = {
      persona: dto.persona ?? existing?.persona ?? defaults.persona,
      welcomeMessage: dto.welcomeMessage ?? existing?.welcomeMessage ?? defaults.welcomeMessage,
      businessHoursTimezone: dto.businessHoursTimezone ?? existing?.businessHoursTimezone ?? null,
      businessHoursStart: dto.businessHoursStart ?? existing?.businessHoursStart ?? null,
      businessHoursEnd: dto.businessHoursEnd ?? existing?.businessHoursEnd ?? null,
      escalationContact: dto.escalationContact ?? existing?.escalationContact ?? defaults.escalationContact,
      brandTone: dto.brandTone ?? existing?.brandTone ?? defaults.brandTone,
      defaultCurrency: dto.defaultCurrency ?? existing?.defaultCurrency ?? defaults.defaultCurrency,
      defaultLanguage: dto.defaultLanguage ?? existing?.defaultLanguage ?? defaults.defaultLanguage,
      ...(supportsApi
        ? {
            apiEnabled: dto.apiEnabled ?? existing?.apiEnabled ?? false,
            apiEndpoint: dto.apiEndpoint ?? existing?.apiEndpoint ?? null,
            apiKey: dto.apiKey ?? existing?.apiKey ?? null
          }
        : {}),
      ...(supportsCountry
        ? { defaultCountry: dto.defaultCountry ?? existing?.defaultCountry ?? "India" }
        : {})
    };
    const row = existing
      ? await configModel.update({
          where: { id: existing.id },
          data: merged
        })
      : await configModel.create({
          data: { organizationId, pluginInstallationId, createdByUserId: userId, ...merged }
        });
    this.auditLogger.record("EMPLOYEE_CONFIGURATION_UPDATED", requestId, {
      organizationId,
      userId,
      targetId: pluginInstallationId
    });
    return this.configuration(
      organizationId,
      row.pluginInstallationId as string,
      configModel,
      defaults,
      pluginSlug,
      supportsApi,
      supportsCountry
    );
  }

  async state(
    organizationId: string,
    pluginInstallationId: string,
    conversationId: string,
    spec: EmployeeDomainSpec
  ): Promise<EmployeeState> {
    await this.requirePlugin(organizationId, pluginInstallationId, spec.slug);
    await this.requireConversation(organizationId, pluginInstallationId, conversationId);
    const memory = await this.prisma.agentMemory.findFirst({
      where: {
        organizationId,
        pluginInstallationId,
        conversationId,
        scope: AgentMemoryScope.CONVERSATION,
        key: spec.memoryKey,
        deletedAt: null
      }
    });
    const stored = (memory?.value as Record<string, unknown> | undefined) ?? null;
    const entities = employeeEntitiesFromStoredState(stored, spec.fields);
    const convoMemory = employeeMemoryFromStoredState(stored);
    const hasRecommendation =
      stored?.stage === "RECOMMEND" || stored?.stage === "AWAITING_CONTACT" || stored?.stage === "CAPTURED";
    return {
      customerName: entities.customerName,
      stage: deriveEmployeeStage(stored, hasRecommendation),
      onboardingCompleted: entities.customerName !== null,
      greetingSent: stored?.greetingSent === true,
      missingFields: spec.fields
        .filter(
          (field) =>
            !field.optional &&
            (typeof entities[field.key] !== "string" || !entities[field.key])
        )
        .map((field) => field.key),
      completionStage: convoMemory.completionStage,
      capturedReference: convoMemory.capturedReference
    };
  }

  async resetConversation(
    organizationId: string,
    userId: string,
    requestId: string,
    pluginInstallationId: string,
    conversationId: string
  ) {
    await this.requireConversation(organizationId, pluginInstallationId, conversationId);
    const result = await this.agents.archive(organizationId, conversationId, ConversationStatus.ARCHIVED);
    this.auditLogger.record("EMPLOYEE_CONVERSATION_RESET", requestId, {
      organizationId,
      userId,
      targetId: conversationId
    });
    return result;
  }

  async requirePlugin(organizationId: string, pluginInstallationId: string, pluginSlug: string) {
    const plugin = await this.prisma.plugin.findFirst({
      where: { id: pluginInstallationId, organizationId, deletedAt: null }
    });
    if (!plugin || plugin.slug !== pluginSlug) throw new NotFoundException("EMPLOYEE_NOT_FOUND");
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
