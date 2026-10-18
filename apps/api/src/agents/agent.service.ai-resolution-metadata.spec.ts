import { PluginStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthorizationService } from "../identity/application/services/authorization.service";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { PluginAiService } from "../plugins/plugin-ai.service";
import type { ConnectorService } from "../connectors/connector.service";
import type { KnowledgeSearchService } from "../knowledge/knowledge.search";
import type { SecurityConfig } from "../identity/infrastructure/security/security-config";
import type { ObservabilityService } from "../observability/observability.service";
import type { CustomerIdentityService } from "../customer-identity/customer-identity.service";
import { resolveCustomerIdentity } from "../customer-identity/customer-identity.types";
import { TRAVEL_EMPLOYEE_PLUGIN_SLUG } from "../travel/travel.runtime";
import { AgentService, type MemoryService } from "./agent.service";
import { TravelLeadService } from "../travel/travel-lead.service";
import { LeadService } from "../leads/lead.service";

/**
 * Regression coverage for the AiConfigurationResolverService metadata-propagation gap found during the
 * shared-organization-level-LLM-configuration production-verification pass: aiResolutionSource /
 * aiProviderConnectionId / aiModelProfileId were only ever attached to the execution span when a turn
 * went through the generic (non-Travel, non-employee-domain) provider branch — Travel's and every
 * employee-domain's own LLM-orchestrator branches called the exact same PluginAiService.resolveProvider,
 * but silently dropped the resolution metadata it returned.
 */

const SECURITY_CONFIG_STUB = { knowledge: { retrievalDebugLogging: false } } as unknown as SecurityConfig;

const CUSTOMER_IDENTITY_STUB = {
  resolve: resolveCustomerIdentity,
  loadProfile: vi.fn().mockResolvedValue(null),
  rememberName: vi.fn().mockResolvedValue(null)
} as unknown as CustomerIdentityService;

function observabilityStub() {
  const addAttribute = vi.fn().mockResolvedValue(undefined);
  const observability = {
    withSpan: vi.fn(async (context: unknown, _metadata: unknown, callback: (span: unknown) => unknown) =>
      callback(context ?? {})
    ),
    addAttribute,
    linkTrace: vi.fn().mockResolvedValue(undefined)
  } as unknown as ObservabilityService;
  return { observability, addAttribute };
}

function basePrisma(slug: string) {
  return {
    plugin: {
      findFirst: vi.fn().mockResolvedValue({
        id: "plugin-installation-1",
        organizationId: "organization-1",
        status: PluginStatus.ACTIVE,
        slug,
        description: "Employee under test",
        grantedPermissions: []
      })
    },
    travelEmployeeConfiguration: { findFirst: vi.fn().mockResolvedValue(null) },
    hrEmployeeConfiguration: { findFirst: vi.fn().mockResolvedValue(null) },
    agentMemory: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    conversation: {
      create: vi.fn().mockResolvedValue({ id: "conversation-1", status: "ACTIVE" }),
      update: vi.fn().mockResolvedValue({})
    },
    conversationMessage: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }: { data: { role: string } }) => ({
        id: data.role === "ASSISTANT" ? "assistant-1" : "message-1"
      }))
    },
    agentExecution: {
      create: vi.fn().mockResolvedValue({ id: "execution-1" }),
      update: vi.fn().mockResolvedValue({})
    }
  };
}

const RESOLVED_METADATA = {
  resolutionSource: "EMPLOYEE_PURPOSE_PROFILE",
  providerConnectionId: "connection-shared-1",
  modelProfileId: "profile-shared-1"
};

describe("AgentService: shared AI-configuration resolution metadata propagation", () => {
  it("attaches aiResolutionSource/aiProviderConnectionId/aiModelProfileId when Travel's LLM orchestrator serves the turn", async () => {
    const prisma = basePrisma(TRAVEL_EMPLOYEE_PLUGIN_SLUG);
    const provider = {
      complete: vi.fn().mockResolvedValue({
        content: "Sure, where would you like to travel?",
        toolCalls: [],
        provider: "openai-compatible",
        model: "gpt-4.1",
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }
      })
    };
    const pluginAi = {
      resolveProvider: vi.fn().mockResolvedValue({
        provider,
        settings: { providerType: "OPENAI_COMPATIBLE", model: "gpt-4.1", timeoutMs: 30000 },
        ...RESOLVED_METADATA
      })
    };
    const { observability, addAttribute } = observabilityStub();

    const service = new AgentService(
      prisma as unknown as PrismaService,
      { getEffectivePermissions: vi.fn().mockResolvedValue([]) } as unknown as AuthorizationService,
      { search: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue({}) } as unknown as MemoryService,
      pluginAi as unknown as PluginAiService,
      { toolHandlers: () => [], availableToolNames: vi.fn().mockResolvedValue([]) } as unknown as ConnectorService,
      { search: vi.fn().mockResolvedValue([]) } as unknown as KnowledgeSearchService,
      CUSTOMER_IDENTITY_STUB,
      new TravelLeadService(prisma as unknown as PrismaService, new LeadService(prisma as unknown as PrismaService)),
      SECURITY_CONFIG_STUB,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      observability
    );

    await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      message: "I want to plan a trip to Dubai"
    });

    const executionAttributeCall = addAttribute.mock.calls.find(([, key]) => key === "execution");
    expect(executionAttributeCall?.[2]).toMatchObject({
      aiResolutionSource: RESOLVED_METADATA.resolutionSource,
      aiProviderConnectionId: RESOLVED_METADATA.providerConnectionId,
      aiModelProfileId: RESOLVED_METADATA.modelProfileId
    });
  });

  it("attaches aiResolutionSource/aiProviderConnectionId/aiModelProfileId when an employee-domain LLM orchestrator serves the turn", async () => {
    const prisma = basePrisma("hr-employee");
    const provider = {
      complete: vi.fn().mockResolvedValue({
        content: "Here is our leave policy summary.",
        toolCalls: [],
        provider: "openai-compatible",
        model: "gpt-4.1",
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }
      })
    };
    const pluginAi = {
      resolveProvider: vi.fn().mockResolvedValue({
        provider,
        settings: { providerType: "OPENAI_COMPATIBLE", model: "gpt-4.1", timeoutMs: 30000 },
        ...RESOLVED_METADATA
      })
    };
    const { observability, addAttribute } = observabilityStub();

    const service = new AgentService(
      prisma as unknown as PrismaService,
      { getEffectivePermissions: vi.fn().mockResolvedValue([]) } as unknown as AuthorizationService,
      { search: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue({}) } as unknown as MemoryService,
      pluginAi as unknown as PluginAiService,
      { toolHandlers: () => [], availableToolNames: vi.fn().mockResolvedValue([]) } as unknown as ConnectorService,
      { search: vi.fn().mockResolvedValue([]) } as unknown as KnowledgeSearchService,
      CUSTOMER_IDENTITY_STUB,
      new TravelLeadService(prisma as unknown as PrismaService, new LeadService(prisma as unknown as PrismaService)),
      SECURITY_CONFIG_STUB,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      observability
    );

    await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      message: "What is our leave policy?"
    });

    const executionAttributeCall = addAttribute.mock.calls.find(([, key]) => key === "execution");
    expect(executionAttributeCall?.[2]).toMatchObject({
      aiResolutionSource: RESOLVED_METADATA.resolutionSource,
      aiProviderConnectionId: RESOLVED_METADATA.providerConnectionId,
      aiModelProfileId: RESOLVED_METADATA.modelProfileId
    });
  });
});
