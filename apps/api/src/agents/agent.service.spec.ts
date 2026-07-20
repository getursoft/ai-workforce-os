import { AgentExecutionStatus, PluginStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthorizationService } from "../identity/application/services/authorization.service";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AiProviderError } from "../plugins/plugin-ai.runtime";
import type { PluginAiService } from "../plugins/plugin-ai.service";
import type { ConnectorService } from "../connectors/connector.service";
import { AgentService, type MemoryService } from "./agent.service";

describe("AgentService configured provider selection", () => {
  it("uses the request installation id and propagates quota failure without deterministic output", async () => {
    const assistantCreate = vi.fn();
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
        create: vi.fn().mockResolvedValue({
          id: "conversation-1",
          status: "ACTIVE"
        })
      },
      conversationMessage: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(async ({ data }: { data: { role: string } }) => {
          if (data.role === "ASSISTANT") return assistantCreate();
          return { id: "message-1" };
        })
      },
      agentExecution: {
        create: vi.fn().mockResolvedValue({ id: "execution-1" }),
        update: vi.fn().mockResolvedValue({})
      }
    } as unknown as PrismaService;
    const provider = {
      complete: vi.fn().mockRejectedValue(new AiProviderError("AI_PROVIDER_QUOTA_EXCEEDED", 429))
    };
    const pluginAi = {
      resolveProvider: vi.fn().mockResolvedValue({
        provider,
        settings: {
          providerType: "OPENAI_COMPATIBLE",
          model: "configured-model",
          timeoutMs: 30000
        }
      })
    } as unknown as PluginAiService;
    const service = new AgentService(
      prisma,
      {
        getEffectivePermissions: vi.fn().mockResolvedValue([])
      } as unknown as AuthorizationService,
      { search: vi.fn().mockResolvedValue([]) } as unknown as MemoryService,
      pluginAi,
      {
        toolHandlers: () => [],
        availableToolNames: vi.fn().mockResolvedValue([])
      } as unknown as ConnectorService
    );

    await expect(
      service.run("organization-1", "user-1", "request-1", {
        pluginInstallationId: "plugin-installation-1",
        message: "Plan a trip"
      })
    ).rejects.toMatchObject({ code: "AI_PROVIDER_QUOTA_EXCEEDED" });
    expect(pluginAi.resolveProvider).toHaveBeenCalledWith(
      "organization-1",
      "plugin-installation-1"
    );
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(assistantCreate).not.toHaveBeenCalled();
    expect(prisma.agentExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: AgentExecutionStatus.FAILED,
          errorCode: "AI_PROVIDER_QUOTA_EXCEEDED"
        })
      })
    );
  });

  it("persists an OpenAI-compatible assistant response", async () => {
    const { service, prisma, pluginAi } = harness({
      complete: vi.fn().mockResolvedValue({
        content: "New Delhi is India’s capital.",
        toolCalls: [],
        provider: "openai-compatible",
        model: "gpt-4.1-mini",
        usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 }
      })
    });

    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      message: "What is India’s capital?"
    });

    expect(result.response).toBe("New Delhi is India’s capital.");
    expect(pluginAi.resolveProvider).toHaveBeenCalledWith(
      "organization-1",
      "plugin-installation-1"
    );
    expect(prisma.conversationMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: "ASSISTANT",
          content: "New Delhi is India’s capital.",
          model: "gpt-4.1-mini"
        })
      })
    );
  });

  it("maps assistant persistence failures to AGENT_EXECUTION_FAILED", async () => {
    const { service } = harness(
      {
        complete: vi.fn().mockResolvedValue({
          content: "New Delhi",
          toolCalls: [],
          provider: "openai-compatible",
          model: "gpt-4.1-mini"
        })
      },
      true
    );
    await expect(
      service.run("organization-1", "user-1", "request-1", {
        pluginInstallationId: "plugin-installation-1",
        message: "What is India’s capital?"
      })
    ).rejects.toMatchObject({ code: "AGENT_EXECUTION_FAILED" });
  });
});

function harness(provider: { complete: ReturnType<typeof vi.fn> }, failAssistant = false) {
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
      create: vi.fn().mockResolvedValue({ id: "conversation-1", status: "ACTIVE" }),
      update: vi.fn().mockResolvedValue({})
    },
    conversationMessage: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }: { data: { role: string } }) => {
        if (data.role === "ASSISTANT" && failAssistant) throw new Error("database unavailable");
        return { id: data.role === "ASSISTANT" ? "assistant-1" : "message-1" };
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
      settings: {
        providerType: "OPENAI_COMPATIBLE",
        model: "gpt-4.1-mini",
        timeoutMs: 30000
      }
    })
  };
  return {
    prisma,
    pluginAi,
    service: new AgentService(
      prisma as unknown as PrismaService,
      {
        getEffectivePermissions: vi.fn().mockResolvedValue([])
      } as unknown as AuthorizationService,
      { search: vi.fn().mockResolvedValue([]) } as unknown as MemoryService,
      pluginAi as unknown as PluginAiService,
      {
        toolHandlers: () => [],
        availableToolNames: vi.fn().mockResolvedValue([])
      } as unknown as ConnectorService
    )
  };
}
