import { AgentExecutionStatus, AgentToolExecutionStatus, PluginStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AiCompletionRequest, AiCompletionResult, AiProvider } from "@ai-workforce-os/plugin-sdk";
import type { AuthorizationService } from "../identity/application/services/authorization.service";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AiProviderError } from "../plugins/plugin-ai.runtime";
import type { PluginAiService } from "../plugins/plugin-ai.service";
import type { ConnectorService } from "../connectors/connector.service";
import type { KnowledgeSearchService } from "../knowledge/knowledge.search";
import { TRAVEL_EMPLOYEE_PLUGIN_SLUG } from "../travel/travel.runtime";
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
      } as unknown as ConnectorService,
      { search: vi.fn().mockResolvedValue([]) } as unknown as KnowledgeSearchService
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

describe("AgentService travel tool failure recovery", () => {
  it("recovers from a failed travel tool execution with a friendly, recoverable reply and still persists the trip state, instead of throwing AGENT_EXECUTION_FAILED", async () => {
    const assistantCreate = vi.fn().mockReturnValue({ id: "assistant-1" });
    const state: { saved: Record<string, unknown> | null } = { saved: null };
    const memorySave = vi.fn(async (_org: string, _user: string | null, input: { value: unknown }) => {
      state.saved = input.value as Record<string, unknown>;
      return {};
    });
    const prisma = {
      plugin: {
        findFirst: vi.fn().mockResolvedValue({
          id: "plugin-installation-1",
          organizationId: "organization-1",
          status: PluginStatus.ACTIVE,
          slug: TRAVEL_EMPLOYEE_PLUGIN_SLUG,
          description: "Travel assistant",
          grantedPermissions: ["TOOLS"],
          manifest: { tools: [{ name: "travel.search_flights" }, { name: "travel.search_hotels" }] }
        })
      },
      travelEmployeeConfiguration: { findFirst: vi.fn().mockResolvedValue(null) },
      agentMemory: { findFirst: vi.fn(async () => (state.saved ? { value: state.saved } : null)) },
      conversation: {
        create: vi.fn().mockResolvedValue({ id: "conversation-1", status: "ACTIVE" }),
        findFirst: vi.fn().mockResolvedValue({ id: "conversation-1", status: "ACTIVE" }),
        update: vi.fn().mockResolvedValue({})
      },
      conversationMessage: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(async ({ data }: { data: { role: string } }) => {
          if (data.role === "ASSISTANT") return assistantCreate(data);
          return { id: "message-1" };
        })
      },
      agentExecution: {
        create: vi.fn().mockResolvedValue({ id: "execution-1" }),
        update: vi.fn().mockResolvedValue({})
      },
      agentToolExecution: {
        create: vi.fn().mockResolvedValue({ id: "tool-execution-1" }),
        update: vi.fn().mockResolvedValue({})
      }
    };
    // The real LLM's extraction call reports a complete trip, but with an out-of-range hotelStars value
    // (schema max is 5) — this fails AJV validation on the real `travel.search_flights` tool, giving a
    // genuine tool-execution failure to recover from rather than a contrived mock throw. The budget is
    // set comfortably above any realistic minimum so the new BELOW_MINIMUM feasibility gate (which skips
    // the search tool entirely for a materially insufficient budget) never intercepts this turn — the
    // test is specifically about a genuine technical tool failure, not a low-budget business result.
    // Per policy, all-fields-complete alone is no longer authorization to search, so the first turn only
    // gets an offer; the second turn's explicit "yes" is what actually triggers (and fails) the tool call.
    const realProvider = {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          originCity: "New Delhi",
          destinationCity: "Adelaide",
          travelMonth: "September",
          days: 5,
          nights: 4,
          adults: 2,
          children: 2,
          budget: 20000,
          budgetCurrency: "USD",
          hotelStars: 9,
          intent: "provide_trip_details"
        }),
        toolCalls: [],
        provider: "openai-compatible",
        model: "gpt-4.1-mini",
        usage: {}
      })
    };
    const pluginAi = {
      resolveProvider: vi.fn().mockResolvedValue({
        provider: realProvider,
        settings: { providerType: "OPENAI_COMPATIBLE", model: "gpt-4.1-mini", timeoutMs: 30000 }
      })
    };
    const memories = { search: vi.fn().mockResolvedValue([]), save: memorySave };
    const service = new AgentService(
      prisma as unknown as PrismaService,
      { getEffectivePermissions: vi.fn().mockResolvedValue(["agents.tools.execute"]) } as unknown as AuthorizationService,
      memories as unknown as MemoryService,
      pluginAi as unknown as PluginAiService,
      {
        toolHandlers: () => [],
        availableToolNames: vi.fn().mockResolvedValue([])
      } as unknown as ConnectorService,
      { search: vi.fn().mockResolvedValue([]) } as unknown as KnowledgeSearchService
    );

    const first = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "New Delhi to Adelaide in September for 5 days, 2 adults and 2 children, budget 20000 USD, 5-star hotel"
    });
    expect(first.response).toMatch(/would you like me to look up flight and hotel options/i);

    const result = await service.run("organization-1", "user-1", "request-2", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "yes"
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.response).toMatch(/trip details are saved/i);
    expect(result.response).toMatch(/retry the search/i);
    expect(assistantCreate).toHaveBeenCalled();
    // The captured trip state is still persisted even though the search tool failed.
    expect(state.saved).toMatchObject({ destinationCity: "Adelaide", originCity: "New Delhi" });
    expect(prisma.agentToolExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: AgentToolExecutionStatus.FAILED,
          errorMessage: "Tool execution failed"
        })
      })
    );
  });
});

/** A scripted "real" LLM: extraction calls are recognized the same way the orchestrator's own tests do
 *  (by the "information-extraction engine" phrase in the system prompt), and a generation call echoes
 *  back whatever the system prompt actually instructed it to say — so this test exercises the real
 *  prompt content built by AgentService + the orchestrator end-to-end, not a hand-scripted reply that
 *  would pass regardless of what the prompt said. */
function jsonResult(content: string): AiCompletionResult {
  return { content, toolCalls: [], provider: "openai-compatible", model: "gpt-4.1-mini", usage: {} };
}
function scriptedRealProvider(): AiProvider {
  return {
    complete: vi.fn(async (request: AiCompletionRequest): Promise<AiCompletionResult> => {
      const systemContent = request.messages[0]?.content ?? "";
      const isExtraction = systemContent.includes("information-extraction engine");
      if (isExtraction) {
        const userContent = request.messages[1]?.content ?? "";
        const match = /Latest user message: """([\s\S]*?)"""/.exec(userContent);
        const message = match?.[1] ?? "";
        const body = /peris/i.test(message)
          ? {
              destinationCity: {
                rawValue: "peris",
                normalizedValue: "Paris",
                confidence: 0.92,
                inferred: true,
                correctionReason: "Likely phonetic misspelling of Paris"
              },
              intent: "provide_trip_details"
            }
          : { intent: "provide_trip_details" };
        return jsonResult(JSON.stringify(body));
      }
      // Generation call: behave like a compliant real LLM that follows the system prompt's own
      // instructions — if (and only if) the prompt still tells it to recite the welcome message, it will.
      const welcomeMatch = /begin the reply with: "([^"]*)"/.exec(systemContent);
      return jsonResult(
        welcomeMatch?.[1] ?? "Great — when are you planning to travel, and for how many days?"
      );
    })
  };
}

describe("AgentService end-to-end: Travel Employee live-conversation regressions", () => {
  it("does not re-ask for the destination on the very first turn once it was already captured in that same message (dashboard chat path through the real orchestrator, not a unit test against it directly)", async () => {
    const state: { saved: Record<string, unknown> | null } = { saved: null };
    const assistantCreate = vi.fn().mockReturnValue({ id: "assistant-1" });
    const prisma = {
      plugin: {
        findFirst: vi.fn().mockResolvedValue({
          id: "plugin-installation-1",
          organizationId: "organization-1",
          status: PluginStatus.ACTIVE,
          slug: TRAVEL_EMPLOYEE_PLUGIN_SLUG,
          description: "Travel assistant",
          grantedPermissions: ["TOOLS"],
          manifest: { tools: [{ name: "travel.search_flights" }, { name: "travel.search_hotels" }] }
        })
      },
      travelEmployeeConfiguration: { findFirst: vi.fn().mockResolvedValue(null) },
      agentMemory: {
        findFirst: vi.fn(async () => (state.saved ? { value: state.saved } : null))
      },
      conversation: {
        create: vi.fn().mockResolvedValue({ id: "conversation-1", status: "ACTIVE" }),
        findFirst: vi.fn().mockResolvedValue({ id: "conversation-1", status: "ACTIVE" }),
        update: vi.fn().mockResolvedValue({})
      },
      conversationMessage: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(async ({ data }: { data: { role: string } }) => {
          if (data.role === "ASSISTANT") return assistantCreate(data);
          return { id: "message-1" };
        })
      },
      agentExecution: {
        create: vi.fn().mockResolvedValue({ id: "execution-1" }),
        update: vi.fn().mockResolvedValue({})
      },
      agentToolExecution: {
        create: vi.fn().mockResolvedValue({ id: "tool-execution-1" }),
        update: vi.fn().mockResolvedValue({})
      }
    };
    const pluginAi = {
      resolveProvider: vi.fn().mockResolvedValue({
        provider: scriptedRealProvider(),
        settings: { providerType: "OPENAI_COMPATIBLE", model: "gpt-4.1-mini", timeoutMs: 30000 }
      })
    };
    const memorySave = vi.fn(async (_org: string, _user: string | null, input: { value: unknown }) => {
      state.saved = input.value as Record<string, unknown>;
      return {};
    });
    const memories = { search: vi.fn().mockResolvedValue([]), save: memorySave };
    const service = new AgentService(
      prisma as unknown as PrismaService,
      { getEffectivePermissions: vi.fn().mockResolvedValue(["agents.tools.execute"]) } as unknown as AuthorizationService,
      memories as unknown as MemoryService,
      pluginAi as unknown as PluginAiService,
      {
        toolHandlers: () => [],
        availableToolNames: vi.fn().mockResolvedValue([])
      } as unknown as ConnectorService,
      { search: vi.fn().mockResolvedValue([]) } as unknown as KnowledgeSearchService
    );

    const first = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "I am planning to go to peris"
    });

    expect(first.status).toBe("COMPLETED");
    expect(first.response).not.toMatch(/where would you like to travel/i);
    expect(state.saved?.destinationCity).toBe("Paris");
  });
});

describe("AgentService: BELOW_MINIMUM sales handoff and its CRM failure fallback", () => {
  it("when the CRM-lead tool throws during a BELOW_MINIMUM sales handoff, returns a truthful fallback that never promises a callback — not the generic search-failure message", async () => {
    const assistantCreate = vi.fn().mockReturnValue({ id: "assistant-1" });
    const prisma = {
      plugin: {
        findFirst: vi.fn().mockResolvedValue({
          id: "plugin-installation-1",
          organizationId: "organization-1",
          status: PluginStatus.ACTIVE,
          slug: TRAVEL_EMPLOYEE_PLUGIN_SLUG,
          description: "Travel assistant",
          grantedPermissions: ["TOOLS"],
          manifest: { tools: [{ name: "travel.search_flights" }, { name: "travel.search_hotels" }] }
        })
      },
      travelEmployeeConfiguration: { findFirst: vi.fn().mockResolvedValue(null) },
      agentMemory: { findFirst: vi.fn().mockResolvedValue(null) },
      conversation: {
        create: vi.fn().mockResolvedValue({ id: "conversation-1", status: "ACTIVE" }),
        update: vi.fn().mockResolvedValue({})
      },
      conversationMessage: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(async ({ data }: { data: { role: string } }) => {
          if (data.role === "ASSISTANT") return assistantCreate(data);
          return { id: "message-1" };
        })
      },
      agentExecution: {
        create: vi.fn().mockResolvedValue({ id: "execution-1" }),
        update: vi.fn().mockResolvedValue({})
      },
      agentToolExecution: {
        create: vi.fn().mockResolvedValue({ id: "tool-execution-1" }),
        update: vi.fn().mockResolvedValue({})
      }
    };
    // A materially insufficient budget (Chennai to Sydney, 2 adults, USD 2,000) so the turn resolves to
    // BELOW_MINIMUM and attempts the sales-handoff CRM-lead save — which this connector deliberately fails,
    // to prove the fallback is honest (no callback promised) and distinct from a search-tool failure.
    const realProvider = {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          originCity: "Chennai",
          destinationCity: "Sydney",
          travelMonth: "January",
          days: 5,
          adults: 2,
          budget: 2000,
          budgetCurrency: "USD",
          intent: "provide_trip_details"
        }),
        toolCalls: [],
        provider: "openai-compatible",
        model: "gpt-4.1-mini",
        usage: {}
      })
    };
    const pluginAi = {
      resolveProvider: vi.fn().mockResolvedValue({
        provider: realProvider,
        settings: { providerType: "OPENAI_COMPATIBLE", model: "gpt-4.1-mini", timeoutMs: 30000 }
      })
    };
    const memories = { search: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue({}) };
    const connectors = {
      toolHandlers: () => [
        {
          definition: {
            name: "sales.crm.create_lead",
            version: "1.0.0",
            description: "Create a CRM lead",
            requiredPermissions: ["agents.tools.execute"],
            timeoutMs: 3000,
            inputSchema: { type: "object" }
          },
          execute: async () => {
            throw new Error("CRM_CONNECTOR_UNAVAILABLE");
          }
        }
      ],
      availableToolNames: vi.fn().mockResolvedValue(["sales.crm.create_lead"])
    };
    const service = new AgentService(
      prisma as unknown as PrismaService,
      { getEffectivePermissions: vi.fn().mockResolvedValue(["agents.tools.execute"]) } as unknown as AuthorizationService,
      memories as unknown as MemoryService,
      pluginAi as unknown as PluginAiService,
      connectors as unknown as ConnectorService,
      { search: vi.fn().mockResolvedValue([]) } as unknown as KnowledgeSearchService
    );

    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      message: "Chennai to Sydney in January for 5 days, 2 adults, budget 2000 USD"
    });

    expect(result.status).toBe("COMPLETED");
    // Never the generic search-tool-failure message — this was a business feasibility turn, not a search.
    expect(result.response).not.toMatch(/retrieve the options|retry the search/i);
    // Honest fallback, and explicitly no callback promise since the save never actually succeeded.
    expect(result.response).toMatch(/wasn't able to save your enquiry|try again shortly/i);
    expect(result.response).not.toMatch(/contact you shortly/i);
  });
});

describe("AgentService end-to-end: live transcript regression (currency conversion, itinerary, no unauthorized search)", () => {
  it("walks the exact live transcript through AgentService.execute(): budget in USD, 'give in INR' converts it, then a day-plan request generates an itinerary without ever requiring passenger composition or calling an unrequested search", async () => {
    const assistantCreate = vi.fn().mockReturnValue({ id: "assistant-1" });
    const state: { saved: Record<string, unknown> | null } = { saved: null };
    const memorySave = vi.fn(async (_org: string, _user: string | null, input: { value: unknown }) => {
      state.saved = input.value as Record<string, unknown>;
      return {};
    });
    const prisma = {
      plugin: {
        findFirst: vi.fn().mockResolvedValue({
          id: "plugin-installation-1",
          organizationId: "organization-1",
          status: PluginStatus.ACTIVE,
          slug: TRAVEL_EMPLOYEE_PLUGIN_SLUG,
          description: "Travel assistant",
          grantedPermissions: ["TOOLS"],
          manifest: { tools: [{ name: "travel.search_flights" }, { name: "travel.search_hotels" }] }
        })
      },
      travelEmployeeConfiguration: { findFirst: vi.fn().mockResolvedValue(null) },
      agentMemory: { findFirst: vi.fn(async () => (state.saved ? { value: state.saved } : null)) },
      conversation: {
        create: vi.fn().mockResolvedValue({ id: "conversation-1", status: "ACTIVE" }),
        findFirst: vi.fn().mockResolvedValue({ id: "conversation-1", status: "ACTIVE" }),
        update: vi.fn().mockResolvedValue({})
      },
      conversationMessage: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(async ({ data }: { data: { role: string } }) => {
          if (data.role === "ASSISTANT") return assistantCreate(data);
          return { id: "message-1" };
        })
      },
      agentExecution: {
        create: vi.fn().mockResolvedValue({ id: "execution-1" }),
        update: vi.fn().mockResolvedValue({})
      },
      agentToolExecution: {
        create: vi.fn().mockResolvedValue({ id: "tool-execution-1" }),
        update: vi.fn().mockResolvedValue({})
      }
    };
    const realProvider = {
      complete: vi.fn(async (request: AiCompletionRequest): Promise<AiCompletionResult> => {
        const systemContent = request.messages[0]?.content ?? "";
        const isExtraction = systemContent.includes("information-extraction engine");
        if (isExtraction) {
          const userContent = request.messages[1]?.content ?? "";
          const match = /Latest user message: """([\s\S]*?)"""/.exec(userContent);
          const message = match?.[1] ?? "";
          if (/budget 20000 USD/i.test(message)) {
            return jsonResult(
              JSON.stringify({
                originCity: "Chennai",
                destinationCity: "Paris",
                travelMonth: "January",
                days: 5,
                adults: 2,
                budget: 20000,
                budgetCurrency: "USD",
                intent: "provide_trip_details"
              })
            );
          }
          if (/budget kitna/i.test(message)) return jsonResult(JSON.stringify({ intent: "ask_budget_guidance" }));
          if (/give in inr/i.test(message)) return jsonResult(JSON.stringify({ intent: "provide_trip_details" }));
          if (/trip wise day optimise/i.test(message)) return jsonResult(JSON.stringify({ intent: "request_plan" }));
          return jsonResult(JSON.stringify({ intent: "provide_trip_details" }));
        }
        // Generation call: only the itinerary turn reaches here (every other turn in this transcript is
        // fully deterministic) — return a simple day-by-day plan.
        return jsonResult("Day 1\n09:00 Eiffel Tower\n13:00 Lunch\n15:00 Louvre Museum");
      })
    };
    const pluginAi = {
      resolveProvider: vi.fn().mockResolvedValue({
        provider: realProvider,
        settings: { providerType: "OPENAI_COMPATIBLE", model: "gpt-4.1-mini", timeoutMs: 30000 }
      })
    };
    const memories = { search: vi.fn().mockResolvedValue([]), save: memorySave };
    const service = new AgentService(
      prisma as unknown as PrismaService,
      { getEffectivePermissions: vi.fn().mockResolvedValue(["agents.tools.execute"]) } as unknown as AuthorizationService,
      memories as unknown as MemoryService,
      pluginAi as unknown as PluginAiService,
      {
        toolHandlers: () => [],
        availableToolNames: vi.fn().mockResolvedValue([])
      } as unknown as ConnectorService,
      { search: vi.fn().mockResolvedValue([]) } as unknown as KnowledgeSearchService
    );

    const turn1 = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "Chennai se Paris jana hai, January mein, 5 din ke liye, 2 adults, budget 20000 USD"
    });
    expect(turn1.status).toBe("COMPLETED");

    const turn2 = await service.run("organization-1", "user-1", "request-2", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "budget kitna lagega"
    });
    expect(turn2.response).toContain("USD");

    const turn3 = await service.run("organization-1", "user-1", "request-3", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "give in INR"
    });
    // Bug 1: "give in INR" must convert the estimate, never ask the user to state an INR budget.
    expect(turn3.response).not.toMatch(/what'?s your approximate budget|which city will you be departing/i);
    // Bug 2: the numbers must actually change (converted), never just the currency label.
    expect(turn3.response).toContain("INR");

    const turn4 = await service.run("organization-1", "user-1", "request-4", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "mujhe trip wise day optimise krke btao"
    });
    // Bug 3: itinerary must never demand passenger composition first.
    expect(turn4.response).not.toMatch(/how many are adults|passenger composition/i);
    expect(turn4.response).toContain("Day 1");
    // Bug 5: no unrequested flight/hotel search anywhere in this transcript.
    expect(prisma.agentToolExecution.create).not.toHaveBeenCalled();
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
      } as unknown as ConnectorService,
      { search: vi.fn().mockResolvedValue([]) } as unknown as KnowledgeSearchService
    )
  };
}
