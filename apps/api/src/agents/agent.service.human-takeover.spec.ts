import { PluginStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthorizationService } from "../identity/application/services/authorization.service";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { PluginAiService } from "../plugins/plugin-ai.service";
import type { ConnectorService } from "../connectors/connector.service";
import type { KnowledgeSearchService } from "../knowledge/knowledge.search";
import type { SecurityConfig } from "../identity/infrastructure/security/security-config";
import { AgentService, type MemoryService } from "./agent.service";
import { TravelLeadService } from "../travel/travel-lead.service";
import type { CustomerIdentityService } from "../customer-identity/customer-identity.service";
import { resolveCustomerIdentity } from "../customer-identity/customer-identity.types";

const SECURITY_CONFIG_STUB = {
  knowledge: { retrievalDebugLogging: false }
} as unknown as SecurityConfig;

const CUSTOMER_IDENTITY_STUB = {
  resolve: resolveCustomerIdentity,
  loadProfile: vi.fn().mockResolvedValue(null),
  rememberName: vi.fn().mockResolvedValue(null)
} as unknown as CustomerIdentityService;

const TRAVEL_LEAD_SERVICE_STUB = {
  buildIdempotencyKey: vi.fn(() => "idempotency-key"),
  createInternalLead: vi.fn().mockResolvedValue({ id: "lead-stub", reference: "TRV-STUB01" }),
  markCrmSyncStatus: vi.fn().mockResolvedValue(undefined)
} as unknown as TravelLeadService;

function harness(conversation: Record<string, unknown>) {
  const messages: Record<string, unknown>[] = [];
  const conversationUpdate = vi.fn().mockResolvedValue({});
  const provider = { complete: vi.fn() };
  const prisma = {
    plugin: {
      findFirst: vi.fn().mockResolvedValue({
        id: "plugin-installation-1",
        organizationId: "organization-1",
        status: PluginStatus.ACTIVE,
        description: "Travel assistant",
        grantedPermissions: []
      })
    },
    conversation: {
      findFirst: vi.fn().mockResolvedValue(conversation),
      update: conversationUpdate
    },
    conversationMessage: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `message-${messages.length + 1}`, ...data };
        messages.push(row);
        return row;
      })
    },
    agentExecution: {
      create: vi.fn().mockResolvedValue({ id: "execution-1" }),
      update: vi.fn().mockResolvedValue({})
    }
  };
  const pluginAi = {
    resolveProvider: vi.fn().mockResolvedValue({
      provider,
      settings: { providerType: "OPENAI_COMPATIBLE", model: "gpt-4.1-mini", timeoutMs: 30000 }
    })
  };
  const service = new AgentService(
    prisma as unknown as PrismaService,
    { getEffectivePermissions: vi.fn().mockResolvedValue([]) } as unknown as AuthorizationService,
    { search: vi.fn().mockResolvedValue([]) } as unknown as MemoryService,
    pluginAi as unknown as PluginAiService,
    { toolHandlers: () => [], availableToolNames: vi.fn().mockResolvedValue([]) } as unknown as ConnectorService,
    {
      search: vi.fn().mockResolvedValue([]),
      searchWithMetrics: vi.fn().mockResolvedValue({ sources: [], metrics: {} })
    } as unknown as KnowledgeSearchService,
    CUSTOMER_IDENTITY_STUB,
    TRAVEL_LEAD_SERVICE_STUB,
    SECURITY_CONFIG_STUB
  );
  return { service, prisma, provider, messages, conversationUpdate };
}

describe("Sprint 6.7 — human takeover gate (AgentService.executeTraced)", () => {
  it("stores the USER message but does NOT dispatch to any employee when the conversation is HUMAN_ACTIVE", async () => {
    const { service, prisma, provider, messages } = harness({
      id: "conversation-1",
      status: "ACTIVE",
      aiControlState: "HUMAN_ACTIVE"
    });

    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "Where is my ticket?"
    });

    expect(result.response).toBe("");
    expect((result as { aiPaused?: boolean }).aiPaused).toBe(true);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(prisma.agentExecution.create).not.toHaveBeenCalled();
    expect(messages.some((m) => m.role === "USER" && m.content === "Where is my ticket?")).toBe(true);
    expect(messages.filter((m) => m.role === "ASSISTANT")).toHaveLength(0);
  });

  it("attributes the stored USER message with actorType USER", async () => {
    const { messages, service } = harness({ id: "conversation-1", status: "ACTIVE", aiControlState: "AI_ACTIVE" });
    // A genuinely deterministic-free message would still reach provider dispatch; we only assert the
    // USER message's own actor attribution here, which is written before any dispatch decision.
    await service
      .run("organization-1", "user-1", "request-1", {
        pluginInstallationId: "plugin-installation-1",
        conversationId: "conversation-1",
        message: "Hello"
      })
      .catch(() => undefined);
    const userMessage = messages.find((m) => m.role === "USER");
    expect(userMessage?.actorType).toBe("USER");
  });

  it("an explicit English escalation request flips AI_ACTIVE -> HUMAN_ACTIVE and returns ONE natural acknowledgement", async () => {
    const { service, conversationUpdate, provider, messages } = harness({
      id: "conversation-1",
      status: "ACTIVE",
      aiControlState: "AI_ACTIVE"
    });

    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "I want to speak to a person."
    });

    expect(result.response).toBe("Sure — I'll hand this over to a team member.");
    expect(provider.complete).not.toHaveBeenCalled();
    expect(conversationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ aiControlState: "HUMAN_ACTIVE", aiPausedReason: "ESCALATION_REQUEST" })
      })
    );
    const assistantMessage = messages.find((m) => m.role === "ASSISTANT");
    expect(assistantMessage?.actorType).toBe("AI");
    expect(assistantMessage?.content).toBe("Sure — I'll hand this over to a team member.");
  });

  it("a Hinglish escalation request ('Agent se baat karni hai') gets the Hinglish acknowledgement", async () => {
    const { service } = harness({ id: "conversation-1", status: "ACTIVE", aiControlState: "AI_ACTIVE" });

    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "Agent se baat karni hai"
    });

    expect(result.response).toBe("Bilkul — main ye conversation team member ko hand over kar raha hoon.");
  });

  it("'Human chahiye' also triggers escalation", async () => {
    const { service, conversationUpdate } = harness({
      id: "conversation-1",
      status: "ACTIVE",
      aiControlState: "AI_ACTIVE"
    });
    await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "Human chahiye"
    });
    expect(conversationUpdate).toHaveBeenCalled();
  });

  it("does NOT trigger escalation for an ordinary message that merely mentions 'human' or 'person' in passing", async () => {
    const { conversationUpdate, service, provider } = harness({
      id: "conversation-1",
      status: "ACTIVE",
      aiControlState: "AI_ACTIVE"
    });
    provider.complete.mockResolvedValue({
      content: "Sure, I can help with that.",
      toolCalls: [],
      provider: "openai-compatible",
      model: "gpt-4.1-mini",
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }
    });
    await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "I need a human-friendly summary of my trip."
    });
    expect(conversationUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ aiControlState: "HUMAN_ACTIVE" }) })
    );
  });
});
