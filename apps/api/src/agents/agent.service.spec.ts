import {
  AgentExecutionStatus,
  AgentToolExecutionStatus,
  Prisma,
  PluginStatus
} from "@prisma/client";
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider
} from "@ai-workforce-os/plugin-sdk";
import type { AuthorizationService } from "../identity/application/services/authorization.service";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AiProviderError } from "../plugins/plugin-ai.runtime";
import type { PluginAiService } from "../plugins/plugin-ai.service";
import type { ConnectorService } from "../connectors/connector.service";
import type { KnowledgeSearchService } from "../knowledge/knowledge.search";
import type { KnowledgeSource } from "../knowledge/knowledge.types";
import type { SecurityConfig } from "../identity/infrastructure/security/security-config";
import { TRAVEL_EMPLOYEE_PLUGIN_SLUG } from "../travel/travel.runtime";
import { AgentService, type MemoryService } from "./agent.service";
import { TravelLeadService } from "../travel/travel-lead.service";
import type { CustomerIdentityService } from "../customer-identity/customer-identity.service";
import { resolveCustomerIdentity } from "../customer-identity/customer-identity.types";
import type { SkillRuntimeService } from "../skills/skill-runtime.service";
import {
  SkillExecutionRevisionConflictError,
  type SkillExecutionService
} from "../skills/skill-execution.service";
import { emptyPlanTripSkillState, mergePlanTripState } from "../skills/travel/plan-trip.skill";

const SECURITY_CONFIG_STUB = {
  knowledge: { retrievalDebugLogging: false }
} as unknown as SecurityConfig;

// Every existing test here runs as a dashboard USER actor, which always resolves ANONYMOUS — so a
// stub that never finds/creates a profile reproduces today's (pre-customer-identity) behavior exactly.
const CUSTOMER_IDENTITY_STUB = {
  resolve: resolveCustomerIdentity,
  loadProfile: vi.fn().mockResolvedValue(null),
  rememberName: vi.fn().mockResolvedValue(null)
} as unknown as CustomerIdentityService;

// A stub for every test that doesn't itself exercise lead capture — the dedicated
// "travel.create_lead tool" describe block below builds a REAL TravelLeadService against its own mocked
// Prisma instead, so idempotency/persistence behavior is actually exercised, not just stubbed out.
const TRAVEL_LEAD_SERVICE_STUB = {
  buildIdempotencyKey: vi.fn(
    (organizationId: string, conversationId: string, journeyId?: string | null) =>
      `${organizationId}:${conversationId}:${journeyId ?? "single"}:LEAD_CAPTURE`
  ),
  createInternalLead: vi.fn().mockResolvedValue({ id: "lead-stub", reference: "TRV-STUB01" }),
  markCrmSyncStatus: vi.fn().mockResolvedValue(undefined)
} as unknown as TravelLeadService;

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
      { search: vi.fn().mockResolvedValue([]), searchWithMetrics: vi.fn().mockResolvedValue({ sources: [], metrics: {} }) } as unknown as KnowledgeSearchService,
      CUSTOMER_IDENTITY_STUB,
      TRAVEL_LEAD_SERVICE_STUB,
      SECURITY_CONFIG_STUB
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
  it("recovers from a failed travel tool execution with indicative recommendations and still persists the trip state, instead of throwing AGENT_EXECUTION_FAILED", async () => {
    const assistantCreate = vi.fn().mockReturnValue({ id: "assistant-1" });
    const state: { saved: Record<string, unknown> | null } = { saved: null };
    const memorySave = vi.fn(
      async (_org: string, _user: string | null, input: { value: unknown }) => {
        state.saved = input.value as Record<string, unknown>;
        return {};
      }
    );
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
          customerName: "Alex",
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
      {
        getEffectivePermissions: vi.fn().mockResolvedValue(["agents.tools.execute"])
      } as unknown as AuthorizationService,
      memories as unknown as MemoryService,
      pluginAi as unknown as PluginAiService,
      {
        toolHandlers: () => [],
        availableToolNames: vi.fn().mockResolvedValue([])
      } as unknown as ConnectorService,
      { search: vi.fn().mockResolvedValue([]), searchWithMetrics: vi.fn().mockResolvedValue({ sources: [], metrics: {} }) } as unknown as KnowledgeSearchService,
      CUSTOMER_IDENTITY_STUB,
      TRAVEL_LEAD_SERVICE_STUB,
      SECURITY_CONFIG_STUB
    );

    const first = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message:
        "My name is Alex. New Delhi to Adelaide in September for 5 days, 2 adults and 2 children, budget 20000 USD, 5-star hotel"
    });
    expect(first.response).toBe(
      "Got it — want me to look up flight and hotel options for your trip now?"
    );
    expect(prisma.agentToolExecution.create).not.toHaveBeenCalled();
    expect(prisma.agentExecution.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            skillShadow: expect.objectContaining({
              skillId: "travel.plan-trip",
              skillVersion: "1.0.0",
              mode: "SHADOW",
              existingDecision: "READY_FOR_PLAN",
              shadowDecision: "ASK_FOR_INPUT",
              agreement: false,
              reasonCodes: ["EXISTING_READY_SHADOW_MISSING_TRAVEL_YEAR"],
              shadowMissingField: "TRAVEL_YEAR"
            })
          })
        })
      })
    );
    // The shadow decision does not become state: the existing Travel memory document remains the
    // behavioural source of truth and contains no Skill Runtime envelope.
    expect(state.saved).toMatchObject({ originCity: "New Delhi", destinationCity: "Adelaide" });
    expect(state.saved).not.toHaveProperty("skillShadow");

    const result = await service.run("organization-1", "user-1", "request-2", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "yes"
    });

    expect(result.status).toBe("COMPLETED");
    // The failed live search is fed back into the orchestrator, which answers with provider-independent
    // indicative recommendations (never the old flat "options retrieve nahi ho paaye" dead end) and offers
    // to retry the live search instead.
    expect(result.response).toMatch(/indicative recommendations, not live availability/i);
    expect(result.response).toMatch(/live search again/i);
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
  return {
    content,
    toolCalls: [],
    provider: "openai-compatible",
    model: "gpt-4.1-mini",
    usage: {}
  };
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
    const memorySave = vi.fn(
      async (_org: string, _user: string | null, input: { value: unknown }) => {
        state.saved = input.value as Record<string, unknown>;
        return {};
      }
    );
    const memories = { search: vi.fn().mockResolvedValue([]), save: memorySave };
    const service = new AgentService(
      prisma as unknown as PrismaService,
      {
        getEffectivePermissions: vi.fn().mockResolvedValue(["agents.tools.execute"])
      } as unknown as AuthorizationService,
      memories as unknown as MemoryService,
      pluginAi as unknown as PluginAiService,
      {
        toolHandlers: () => [],
        availableToolNames: vi.fn().mockResolvedValue([])
      } as unknown as ConnectorService,
      { search: vi.fn().mockResolvedValue([]), searchWithMetrics: vi.fn().mockResolvedValue({ sources: [], metrics: {} }) } as unknown as KnowledgeSearchService,
      CUSTOMER_IDENTITY_STUB,
      TRAVEL_LEAD_SERVICE_STUB,
      SECURITY_CONFIG_STUB
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

describe("AgentService: BELOW_MINIMUM in the integrated (PLATFORM_MANAGED) path never calls a CRM tool directly, even when one is available and would fail", () => {
  it("Stage 9E.1: the CRM-tool sales-handoff path is converged onto TRIP_SUBMISSION — AgentService's integrated path always asks for a mobile number and never attempts the CRM tool itself, regardless of whether a configured CRM connector would throw", async () => {
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
          customerName: "Alex",
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
    const crmToolExecute = vi.fn().mockRejectedValue(new Error("CRM_CONNECTOR_UNAVAILABLE"));
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
          execute: crmToolExecute
        }
      ],
      availableToolNames: vi.fn().mockResolvedValue(["sales.crm.create_lead"])
    };
    const service = new AgentService(
      prisma as unknown as PrismaService,
      {
        getEffectivePermissions: vi.fn().mockResolvedValue(["agents.tools.execute"])
      } as unknown as AuthorizationService,
      memories as unknown as MemoryService,
      pluginAi as unknown as PluginAiService,
      connectors as unknown as ConnectorService,
      { search: vi.fn().mockResolvedValue([]), searchWithMetrics: vi.fn().mockResolvedValue({ sources: [], metrics: {} }) } as unknown as KnowledgeSearchService,
      CUSTOMER_IDENTITY_STUB,
      TRAVEL_LEAD_SERVICE_STUB,
      SECURITY_CONFIG_STUB
    );

    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      message: "My name is Alex. Chennai to Sydney in January for 5 days, 2 adults, budget 2000 USD"
    });

    expect(result.status).toBe("COMPLETED");
    // Never the generic search-tool-failure message — this was a business feasibility turn, not a search.
    expect(result.response).not.toMatch(/retrieve the options|retry the search/i);
    // The integrated path always asks for a mobile number — TRIP_SUBMISSION (not this legacy CRM-tool
    // path) now owns contact collection, and its own best-effort CRM sync (invisible to the response
    // either way) replaces this engine calling a CRM tool directly as a primary action.
    expect(result.response).toMatch(/mobile number/i);
    expect(result.response).not.toMatch(/wasn't able to save your enquiry|contact you shortly/i);
    // The CRM tool is never invoked directly by Travel Runtime in this path — no WorkflowCoordinator is
    // wired in this narrow unit test, so no best-effort sync attempt happens either; the point this test
    // proves is that the legacy toolResult-based CRM call never fires, regardless.
    expect(crmToolExecute).not.toHaveBeenCalled();
  });
});

describe("AgentService end-to-end: live transcript regression (currency conversion, itinerary, no unauthorized search)", () => {
  it("walks the exact live transcript through AgentService.execute(): budget in USD, 'give in INR' converts it, then a day-plan request generates an itinerary without ever requiring passenger composition or calling an unrequested search", async () => {
    const assistantCreate = vi.fn().mockReturnValue({ id: "assistant-1" });
    const state: { saved: Record<string, unknown> | null } = { saved: null };
    const memorySave = vi.fn(
      async (_org: string, _user: string | null, input: { value: unknown }) => {
        state.saved = input.value as Record<string, unknown>;
        return {};
      }
    );
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
                customerName: "Alex",
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
          if (/budget kitna/i.test(message))
            return jsonResult(JSON.stringify({ intent: "ask_budget_guidance" }));
          if (/give in inr/i.test(message))
            return jsonResult(JSON.stringify({ intent: "provide_trip_details" }));
          if (/trip wise day optimise/i.test(message))
            return jsonResult(JSON.stringify({ intent: "request_plan" }));
          return jsonResult(JSON.stringify({ intent: "provide_trip_details" }));
        }
        // Generation call: only the itinerary turn reaches here (every other turn in this transcript is
        // fully deterministic) — return a simple day-by-day plan.
        return jsonResult("Day 1\n14:00 Eiffel Tower\n16:30 Louvre Museum\n19:00 Dinner");
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
      {
        getEffectivePermissions: vi.fn().mockResolvedValue(["agents.tools.execute"])
      } as unknown as AuthorizationService,
      memories as unknown as MemoryService,
      pluginAi as unknown as PluginAiService,
      {
        toolHandlers: () => [],
        availableToolNames: vi.fn().mockResolvedValue([])
      } as unknown as ConnectorService,
      { search: vi.fn().mockResolvedValue([]), searchWithMetrics: vi.fn().mockResolvedValue({ sources: [], metrics: {} }) } as unknown as KnowledgeSearchService,
      CUSTOMER_IDENTITY_STUB,
      TRAVEL_LEAD_SERVICE_STUB,
      SECURITY_CONFIG_STUB
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
    expect(turn3.response).not.toMatch(
      /what'?s your approximate budget|which city will you be departing/i
    );
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
      { search: vi.fn().mockResolvedValue([]), searchWithMetrics: vi.fn().mockResolvedValue({ sources: [], metrics: {} }) } as unknown as KnowledgeSearchService,
      CUSTOMER_IDENTITY_STUB,
      TRAVEL_LEAD_SERVICE_STUB,
      SECURITY_CONFIG_STUB
    )
  };
}

describe("AgentService knowledge grounding: conversation-context isolation", () => {
  function chunk(
    partial: Pick<
      KnowledgeSource,
      "chunkId" | "chunkIndex" | "heading" | "content" | "headingPath" | "score"
    >
  ): KnowledgeSource {
    return {
      documentId: "doc-policy",
      collectionId: "collection-travel",
      title: "travel_portal_policy_document",
      pageNumber: null,
      sectionTitle: partial.heading,
      isTable: false,
      ...partial
    };
  }
  const CANCELLATION_SECTION: KnowledgeSource[] = [
    chunk({
      chunkId: "c-2-1",
      chunkIndex: 20,
      heading: "2.1 Scope",
      content: "This policy applies to all flight and hotel bookings.",
      headingPath: ["Master Travel Policy", "2. Cancellation Policy", "2.1 Scope"],
      score: 0.5
    }),
    chunk({
      chunkId: "c-2-2",
      chunkIndex: 21,
      heading: "2.2 Standard Cancellation Windows",
      content:
        "Cancellations more than 72 hours before departure receive a full refund minus a 5% fee.",
      headingPath: [
        "Master Travel Policy",
        "2. Cancellation Policy",
        "2.2 Standard Cancellation Windows"
      ],
      score: 0.55
    }),
    chunk({
      chunkId: "c-2-7",
      chunkIndex: 26,
      heading: "2.7 Force Majeure / Medical Emergencies",
      content:
        "Cancellations due to declared natural disasters, government travel bans, or medical emergencies are eligible for special consideration.",
      headingPath: [
        "Master Travel Policy",
        "2. Cancellation Policy",
        "2.7 Force Majeure / Medical Emergencies"
      ],
      // Highest-scoring subsection on its own — reproduces the reported UAT bug where the answer came
      // only from 2.7 instead of the whole cancellation-policy section.
      score: 0.7
    })
  ];

  it("answers a Hinglish, mid-booking policy question from the full cancellation-policy section (not just 2.7), never calls the LLM provider, and does not ask the next itinerary question", async () => {
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
        findFirst: vi.fn().mockResolvedValue({ id: "conversation-1", status: "ACTIVE" }),
        update: vi.fn().mockResolvedValue({})
      },
      conversationMessage: {
        // Prior booking-context turns already in history — the retrieval query below must not be
        // distorted by this dialogue (see `knowledge.search` assertion at the bottom).
        findMany: vi.fn().mockResolvedValue([
          { role: "USER", content: "delhi se london jana hai" },
          {
            role: "ASSISTANT",
            content: "Hey! Delhi se London ka trip set karte hain. Kab ka plan hai travel karne ka?"
          }
        ]),
        create: vi.fn(async ({ data }: { data: { role: string } }) => ({
          id: data.role === "ASSISTANT" ? "assistant-1" : "message-1"
        }))
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
    const knowledge = {
      search: vi.fn().mockResolvedValue(CANCELLATION_SECTION),
      searchWithMetrics: vi.fn().mockResolvedValue({ sources: CANCELLATION_SECTION, metrics: {} })
    };
    const service = new AgentService(
      prisma as unknown as PrismaService,
      { getEffectivePermissions: vi.fn().mockResolvedValue([]) } as unknown as AuthorizationService,
      { search: vi.fn().mockResolvedValue([]) } as unknown as MemoryService,
      pluginAi as unknown as PluginAiService,
      {
        toolHandlers: () => [],
        availableToolNames: vi.fn().mockResolvedValue([])
      } as unknown as ConnectorService,
      knowledge as unknown as KnowledgeSearchService,
      CUSTOMER_IDENTITY_STUB,
      TRAVEL_LEAD_SERVICE_STUB,
      SECURITY_CONFIG_STUB
    );

    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "phle cancelation policy btao"
    });

    expect(result.response).toContain("This policy applies to all flight and hotel bookings.");
    expect(result.response).toContain(
      "Cancellations due to declared natural disasters, government travel bans, or medical emergencies are eligible for special consideration."
    );
    // Not just the single highest-scoring subsection (2.7) — the whole section.
    expect(result.response).not.toMatch(/^Answer:/);
    expect(result.response).not.toMatch(
      /according to the uploaded|supporting (?:policy|sections)|confidence|chunk \d|document type/i
    );
    expect(provider.complete).not.toHaveBeenCalled();
    expect(result.response).not.toMatch(/which date|kab ka plan|what date|travel date/i);
    // The retrieval query is the current message alone, not the booking dialogue appended to it — the
    // prior "delhi se london jana hai" / "Kab ka plan hai" turns must not distort policy retrieval.
    expect(knowledge.searchWithMetrics).toHaveBeenCalledWith("organization-1", "plugin-installation-1", {
      query: "phle cancelation policy btao"
    });
  });
});

describe("AgentService proactive greeting", () => {
  function greetHarness() {
    const provider = { complete: vi.fn() };
    const messageCreate = vi.fn(async ({ data }: { data: { role: string } }) => ({
      id: data.role === "ASSISTANT" ? "assistant-1" : "message-1"
    }));
    const prisma = {
      plugin: {
        findFirst: vi.fn().mockResolvedValue({
          id: "plugin-installation-1",
          organizationId: "organization-1",
          status: PluginStatus.ACTIVE,
          slug: TRAVEL_EMPLOYEE_PLUGIN_SLUG,
          description: "Travel assistant",
          grantedPermissions: []
        })
      },
      travelEmployeeConfiguration: { findFirst: vi.fn().mockResolvedValue(null) },
      agentMemory: { findFirst: vi.fn().mockResolvedValue(null) },
      conversation: {
        create: vi.fn().mockResolvedValue({ id: "conversation-1", status: "ACTIVE" }),
        findFirst: vi.fn().mockResolvedValue({ id: "conversation-1", status: "ACTIVE" }),
        update: vi.fn().mockResolvedValue({})
      },
      conversationMessage: {
        findMany: vi.fn().mockResolvedValue([]),
        create: messageCreate
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
      {
        search: vi.fn().mockResolvedValue([]),
        save: vi.fn().mockResolvedValue({})
      } as unknown as MemoryService,
      pluginAi as unknown as PluginAiService,
      {
        toolHandlers: () => [],
        availableToolNames: vi.fn().mockResolvedValue([])
      } as unknown as ConnectorService,
      { search: vi.fn().mockResolvedValue([]), searchWithMetrics: vi.fn().mockResolvedValue({ sources: [], metrics: {} }) } as unknown as KnowledgeSearchService,
      CUSTOMER_IDENTITY_STUB,
      TRAVEL_LEAD_SERVICE_STUB,
      SECURITY_CONFIG_STUB
    );
    return { service, provider, messageCreate, prisma };
  }

  it("greets proactively — an empty message on a brand-new conversation returns the welcome message with no LLM call and no synthetic user turn", async () => {
    const { service, provider, messageCreate } = greetHarness();
    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      message: ""
    });
    expect(result.response).toMatch(/may i know your name/i);
    expect(provider.complete).not.toHaveBeenCalled();
    // Only the assistant greeting is persisted — no USER row for a message that was never actually sent.
    expect(messageCreate).toHaveBeenCalledTimes(1);
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: "ASSISTANT" }) })
    );
  });

  it("does not greet again once the conversation already has messages — the empty-message shortcut only applies to a brand-new conversation", async () => {
    const { service, prisma } = greetHarness();
    prisma.conversationMessage.findMany = vi.fn().mockResolvedValue([
      {
        role: "ASSISTANT",
        content: "Hi! I'm your AI travel assistant. Where would you like to travel to?"
      }
    ]);
    await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: ""
    });
    // Falls through to the normal (non-greeting) path — proven by a USER row being persisted this time.
    expect(prisma.conversationMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: "USER", content: "" }) })
    );
  });
});

describe("AgentService request routing: travel-planning bypass gate", () => {
  function travelHarness(knowledgeSources: KnowledgeSource[]) {
    const provider = {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          destinationCity: "Mumbai",
          originCity: "Delhi",
          intent: "provide_trip_details"
        }),
        toolCalls: [],
        provider: "openai-compatible",
        model: "gpt-4.1-mini",
        usage: {}
      })
    };
    const prisma = {
      plugin: {
        findFirst: vi.fn().mockResolvedValue({
          id: "plugin-installation-1",
          organizationId: "organization-1",
          status: PluginStatus.ACTIVE,
          slug: TRAVEL_EMPLOYEE_PLUGIN_SLUG,
          description: "Travel assistant",
          grantedPermissions: []
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
        create: vi.fn(async ({ data }: { data: { role: string } }) => ({
          id: data.role === "ASSISTANT" ? "assistant-1" : "message-1"
        }))
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
    const memories = { search: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue({}) };
    const knowledge = {
      search: vi.fn().mockResolvedValue(knowledgeSources),
      searchWithMetrics: vi.fn().mockResolvedValue({ sources: knowledgeSources, metrics: {} })
    };
    const service = new AgentService(
      prisma as unknown as PrismaService,
      { getEffectivePermissions: vi.fn().mockResolvedValue([]) } as unknown as AuthorizationService,
      memories as unknown as MemoryService,
      pluginAi as unknown as PluginAiService,
      {
        toolHandlers: () => [],
        availableToolNames: vi.fn().mockResolvedValue([])
      } as unknown as ConnectorService,
      knowledge as unknown as KnowledgeSearchService,
      CUSTOMER_IDENTITY_STUB,
      TRAVEL_LEAD_SERVICE_STUB,
      SECURITY_CONFIG_STUB
    );
    return { service, provider, knowledge };
  }

  // A weak, off-topic knowledge chunk (23-34%-relevance-equivalent, well below the confidence floor) —
  // modeling exactly the kind of low-relevance retrieval hit that used to hijack an unrelated turn into
  // the knowledge-not-found fallback, back when the bypass fired on `sources.length > 0` alone.
  const WEAK_UNRELATED_SOURCE: KnowledgeSource = {
    chunkId: "chunk-weak",
    documentId: "doc-policy",
    collectionId: "collection-travel",
    title: "travel_portal_policy_document",
    content: "This portal supports English and Hindi language preferences.",
    chunkIndex: 90,
    pageNumber: null,
    heading: "9.9 Language Support",
    sectionTitle: "9.9 Language Support",
    isTable: false,
    headingPath: ["Master Travel Policy", "9. Miscellaneous", "9.9 Language Support"],
    score: 0.25
  };

  it("does not hijack an explicit travel-planning request into the knowledge-not-found fallback, even when a weak/irrelevant knowledge source is returned", async () => {
    const { service, provider, knowledge } = travelHarness([WEAK_UNRELATED_SOURCE]);
    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      message: "i want to travel delhi to mumbai on 10 dec 26"
    });
    expect(result.response).not.toBe(
      "I could not find this information in the uploaded knowledge."
    );
    expect(provider.complete).toHaveBeenCalled();
    expect(knowledge.search).not.toHaveBeenCalled();
  });

  it.each([
    "4 rat ke liye jana hai 3 adult 1 kid",
    "15 August",
    "5 log",
    "Dubai me 5 din",
    "sab piche bataya hai"
  ])("never invokes knowledge search for travel state message %j", async (message) => {
    const { service, knowledge } = travelHarness([WEAK_UNRELATED_SOURCE]);
    await service.run("organization-1", "user-1", `request-${message}`, {
      pluginInstallationId: "plugin-installation-1",
      message
    });
    expect(knowledge.search).not.toHaveBeenCalled();
  });

  it('continues the travel-planning workflow for "plan the trip" instead of the knowledge fallback', async () => {
    const { service, provider } = travelHarness([]);
    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      message: "plan the trip"
    });
    expect(result.response).not.toBe(
      "I could not find this information in the uploaded knowledge."
    );
    expect(provider.complete).toHaveBeenCalled();
  });

  it("weak knowledge results returned for a travel query are ignored by the grounded-answer bypass regardless of retrieval score", async () => {
    // Same weak source as above, but the assertion is specifically about the bypass never even being
    // consulted for this turn — a travel-planning message must not be gated on retrieval score at all.
    const { service } = travelHarness([{ ...WEAK_UNRELATED_SOURCE, score: 0.9 }]);
    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      message: "delhi se mumbai jana hai"
    });
    expect(result.response).not.toBe(
      "I could not find this information in the uploaded knowledge."
    );
    expect(result.response).not.toContain("9.9 Language Support");
  });
});

describe("AgentService orchestration: mixed conversations", () => {
  function mixedHarness(
    knowledgeSearchImpl: (query: string) => KnowledgeSource[],
    skillRuntime?: SkillRuntimeService,
    deterministic = false,
    skillExecutions?: SkillExecutionService
  ) {
    const provider = {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({ intent: "provide_trip_details" }),
        toolCalls: [],
        provider: "openai-compatible",
        model: "gpt-4.1-mini",
        usage: {}
      })
    };
    const prisma = {
      plugin: {
        findFirst: vi.fn().mockResolvedValue({
          id: "plugin-installation-1",
          organizationId: "organization-1",
          status: PluginStatus.ACTIVE,
          slug: TRAVEL_EMPLOYEE_PLUGIN_SLUG,
          description: "Travel assistant",
          grantedPermissions: []
        })
      },
      travelEmployeeConfiguration: { findFirst: vi.fn().mockResolvedValue(null) },
      agentMemory: { findFirst: vi.fn().mockResolvedValue(null) },
      conversation: {
        findFirst: vi.fn().mockResolvedValue({ id: "conversation-1", status: "ACTIVE" }),
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
      },
      agentToolExecution: {
        create: vi.fn(),
        update: vi.fn()
      }
    };
    const pluginAi = {
      resolveProvider: deterministic
        ? vi.fn().mockRejectedValue(new BadRequestException("AI_PROVIDER_NOT_CONFIGURED"))
        : vi.fn().mockResolvedValue({
            provider,
            settings: { providerType: "OPENAI_COMPATIBLE", model: "gpt-4.1-mini", timeoutMs: 30000 }
          })
    };
    const memories = { search: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue({}) };
    const knowledge = {
      search: vi.fn(async (_org: string, _emp: string, input: { query: string }) =>
        knowledgeSearchImpl(input.query)
      ),
      searchWithMetrics: vi.fn(async (_org: string, _emp: string, input: { query: string }) => ({
        sources: knowledgeSearchImpl(input.query),
        metrics: {}
      }))
    };
    const service = new AgentService(
      prisma as unknown as PrismaService,
      { getEffectivePermissions: vi.fn().mockResolvedValue([]) } as unknown as AuthorizationService,
      memories as unknown as MemoryService,
      pluginAi as unknown as PluginAiService,
      {
        toolHandlers: () => [],
        availableToolNames: vi.fn().mockResolvedValue([])
      } as unknown as ConnectorService,
      knowledge as unknown as KnowledgeSearchService,
      CUSTOMER_IDENTITY_STUB,
      TRAVEL_LEAD_SERVICE_STUB,
      SECURITY_CONFIG_STUB,
      skillRuntime,
      skillExecutions
    );
    return { service, provider, knowledge, prisma };
  }

  function policyChunk(query: string): KnowledgeSource[] {
    if (!/cancellation policy|infant fare/i.test(query)) return [];
    if (/infant fare/i.test(query))
      return [
        {
          chunkId: "chunk-3-3",
          documentId: "doc-policy",
          collectionId: "collection-travel",
          title: "travel_portal_policy_document",
          content: "Infant fares are charged at 10% of the applicable adult fare.",
          chunkIndex: 32,
          pageNumber: null,
          heading: "3.3 Infant Fare & Discount",
          sectionTitle: "3.3 Infant Fare & Discount",
          isTable: false,
          headingPath: [
            "Master Travel Policy",
            "3. Infant & Child Policy",
            "3.3 Infant Fare & Discount"
          ],
          score: 0.7
        }
      ];
    return [
      {
        chunkId: "chunk-2-2",
        documentId: "doc-policy",
        collectionId: "collection-travel",
        title: "travel_portal_policy_document",
        content:
          "Cancellations more than 72 hours before departure receive a full refund minus a 5% fee.",
        chunkIndex: 21,
        pageNumber: null,
        heading: "2.2 Standard Cancellation Windows",
        sectionTitle: "2.2 Standard Cancellation Windows",
        isTable: false,
        headingPath: [
          "Master Travel Policy",
          "2. Cancellation Policy",
          "2.2 Standard Cancellation Windows"
        ],
        score: 0.7
      }
    ];
  }

  it("knowledge -> travel -> knowledge: each turn is routed independently, never bleeding into the wrong pipeline", async () => {
    const { service, provider } = mixedHarness(policyChunk);

    const first = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "what is the cancellation policy"
    });
    expect(first.response).toContain(
      "Cancellations more than 72 hours before departure receive a full refund minus a 5% fee."
    );
    expect(provider.complete).not.toHaveBeenCalled();

    const second = await service.run("organization-1", "user-1", "request-2", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "delhi se mumbai jana hai"
    });
    expect(second.response).not.toBe(
      "I could not find this information in the uploaded knowledge."
    );
    // The travel turn calls the provider (extraction + reply generation); the knowledge turns before and
    // after it never do — that's the routing behavior under test, not the exact provider call count.
    expect(provider.complete).toHaveBeenCalled();
    const callsAfterTravelTurn = provider.complete.mock.calls.length;

    const third = await service.run("organization-1", "user-1", "request-3", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "what is the cancellation policy"
    });
    expect(third.response).toContain(
      "Cancellations more than 72 hours before departure receive a full refund minus a 5% fee."
    );
    // No new provider calls from this knowledge turn.
    expect(provider.complete.mock.calls.length).toBe(callsAfterTravelTurn);
  });

  it("policy -> trip -> policy: a specific policy question, a planning turn, then the same policy question again", async () => {
    const { service, provider } = mixedHarness(policyChunk);

    const first = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "infant fare"
    });
    expect(first.response).toContain(
      "Infant fares are charged at 10% of the applicable adult fare."
    );
    expect(provider.complete).not.toHaveBeenCalled();

    const second = await service.run("organization-1", "user-1", "request-2", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "plan the trip"
    });
    expect(second.response).not.toBe(
      "I could not find this information in the uploaded knowledge."
    );
    expect(provider.complete).toHaveBeenCalled();

    const third = await service.run("organization-1", "user-1", "request-3", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "infant fare"
    });
    expect(third.response).toContain(
      "Infant fares are charged at 10% of the applicable adult fare."
    );
  });

  it("travel -> correction -> planning: a route statement, an explicit correction, then a bare slot update — none ever hit the knowledge fallback", async () => {
    const { service, provider } = mixedHarness(() => []);

    const first = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "mujhe london jana hai"
    });
    expect(first.response).not.toBe("I could not find this information in the uploaded knowledge.");

    const second = await service.run("organization-1", "user-1", "request-2", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "change destination to Paris"
    });
    expect(second.response).not.toBe(
      "I could not find this information in the uploaded knowledge."
    );

    const third = await service.run("organization-1", "user-1", "request-3", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "5 days"
    });
    expect(third.response).not.toBe("I could not find this information in the uploaded knowledge.");
    // All three turns (planning, correction, slot update) reached the real provider — none were
    // hijacked into the knowledge fallback.
    expect(provider.complete).toHaveBeenCalled();
  });

  it("a shadow evaluation failure is metadata-only and cannot alter the response or add provider/tool calls", async () => {
    const skillRuntime = {
      evaluate: vi.fn(() => {
        throw new Error("SHADOW_TEST_FAILURE");
      })
    } as unknown as SkillRuntimeService;
    const { service, provider, prisma } = mixedHarness(() => [], skillRuntime);
    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "plan the trip"
    });
    expect(result.response).toBe("Before we get started, may I know your name?");
    expect(skillRuntime.evaluate).toHaveBeenCalledOnce();
    // One existing extraction call; this deterministic response branch needs no reply-generation call,
    // and shadow comparison adds neither kind of provider call.
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(prisma.agentToolExecution.create).not.toHaveBeenCalled();
    const completionUpdate = prisma.agentExecution.update.mock.calls.at(-1)?.[0];
    expect(completionUpdate).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            skillShadow: expect.objectContaining({
              mode: "SHADOW",
              agreement: false,
              shadowDecision: "UNKNOWN",
              reasonCodes: ["SHADOW_EVALUATION_FAILED"]
            })
          })
        })
      })
    );
    const serializedMetadata = JSON.stringify(completionUpdate?.data.metadata);
    expect(serializedMetadata).not.toContain("plan the trip");
    expect(serializedMetadata).not.toMatch(/phone|email|contact|prompt|credential/i);
  });

  it("produces comparison metadata in deterministic Travel mode without calling an additional provider or tool", async () => {
    const { service, provider, prisma } = mixedHarness(() => [], undefined, true);
    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "my name is Alex, plan a trip to Dubai in January for 5 days and 2 travellers"
    });

    expect(result.status).toBe("COMPLETED");
    expect(provider.complete).not.toHaveBeenCalled();
    expect(prisma.agentToolExecution.create).not.toHaveBeenCalled();
    expect(prisma.agentExecution.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            skillShadow: expect.objectContaining({
              skillId: "travel.plan-trip",
              skillVersion: "1.0.0",
              mode: "SHADOW",
              adapterWarnings: expect.arrayContaining(["DETERMINISTIC_TRANSCRIPT_DERIVED"])
            })
          })
        })
      })
    );
  });

  it.each([
    ["deterministic", true],
    ["LLM", false]
  ])(
    "persists the %s Travel shadow decision without adding provider or tool calls",
    async (_mode, deterministic) => {
      const persisted = {
        id: "50000000-0000-0000-0000-000000000001",
        status: "WAITING_FOR_INPUT",
        revision: 1
      };
      const skillExecutions = {
        findActiveExecution: vi.fn().mockResolvedValue(null),
        createExecution: vi.fn().mockResolvedValue({
          execution: persisted,
          applied: true,
          idempotentReplay: false
        }),
        updateExecutionState: vi.fn()
      } as unknown as SkillExecutionService;
      const { service, provider, prisma } = mixedHarness(
        () => [],
        undefined,
        deterministic,
        skillExecutions
      );

      const result = await service.run("organization-1", "user-1", "mirror-turn-1", {
        pluginInstallationId: "plugin-installation-1",
        conversationId: "conversation-1",
        message: "my name is Alex, plan a trip to Dubai in January for 5 days and 2 travellers"
      });

      expect(result.status).toBe("COMPLETED");
      expect(skillExecutions.findActiveExecution).toHaveBeenCalledOnce();
      expect(skillExecutions.createExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          turnId: "mirror-turn-1",
          skillVersion: "1.0.0",
          scope: expect.objectContaining({
            organizationId: "organization-1",
            pluginInstallationId: "plugin-installation-1",
            conversationId: "conversation-1",
            skillId: "travel.plan-trip"
          })
        })
      );
      expect(prisma.agentToolExecution.create).not.toHaveBeenCalled();
      expect(provider.complete).toHaveBeenCalledTimes(deterministic ? 0 : 1);
      expect(prisma.agentExecution.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: expect.objectContaining({
              skillShadow: expect.objectContaining({
                persistence: {
                  executionId: persisted.id,
                  status: persisted.status,
                  revision: persisted.revision,
                  applied: true,
                  idempotentReplay: false,
                  warning: null
                }
              })
            })
          })
        })
      );
    }
  );

  it("loads and resumes persisted canonical state on the next Travel turn", async () => {
    const state = mergePlanTripState(emptyPlanTripSkillState(), {
      data: {
        origin: { value: "Delhi", source: "USER_EXPLICIT" },
        destination: { value: "Dubai", source: "USER_EXPLICIT" },
        departureDate: {
          value: { value: "12 January", day: 12, month: 1, year: null },
          source: "USER_EXPLICIT"
        },
        duration: { value: { value: 4, unit: "NIGHTS" }, source: "USER_EXPLICIT" },
        travellers: { value: { total: 5 }, source: "USER_EXPLICIT" }
      }
    });
    const active = {
      id: "50000000-0000-0000-0000-000000000001",
      skillVersion: "1.0.0",
      status: "WAITING_FOR_INPUT",
      revision: state.revision,
      state
    };
    const skillExecutions = {
      findActiveExecution: vi.fn().mockResolvedValue(active),
      updateExecutionState: vi.fn().mockImplementation(async ({ state: nextState }) => ({
        execution: { ...active, state: nextState, revision: active.revision + 1 },
        applied: true,
        idempotentReplay: false
      })),
      createExecution: vi.fn()
    } as unknown as SkillExecutionService;
    const { service } = mixedHarness(() => [], undefined, true, skillExecutions);

    await service.run("organization-1", "user-1", "mirror-resume-turn", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "plan the trip"
    });

    expect(skillExecutions.createExecution).not.toHaveBeenCalled();
    expect(skillExecutions.updateExecutionState).toHaveBeenCalledWith(
      expect.objectContaining({
        id: active.id,
        expectedRevision: active.revision,
        state: expect.objectContaining({
          origin: "Delhi",
          destination: "Dubai",
          duration: { value: 4, unit: "NIGHTS" },
          travellers: { total: 5, adults: null, children: null, infants: null }
        })
      })
    );
  });

  it("does not create a plan-trip execution for a non-planning request", async () => {
    const skillExecutions = {
      findActiveExecution: vi.fn(),
      createExecution: vi.fn(),
      updateExecutionState: vi.fn()
    } as unknown as SkillExecutionService;
    const { service } = mixedHarness(() => [], undefined, true, skillExecutions);

    await service.run("organization-1", "user-1", "mirror-non-planning", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "what is the cancellation policy"
    });

    expect(skillExecutions.findActiveExecution).not.toHaveBeenCalled();
    expect(skillExecutions.createExecution).not.toHaveBeenCalled();
    expect(skillExecutions.updateExecutionState).not.toHaveBeenCalled();
  });

  it.each([
    ["storage failure", new Error("database unavailable"), "SKILL_PERSISTENCE_FAILED"],
    ["revision conflict", new SkillExecutionRevisionConflictError(), "SKILL_REVISION_CONFLICT"]
  ])(
    "isolates a SkillExecution %s from the authoritative response",
    async (_case, failure, warning) => {
      const active = {
        id: "50000000-0000-0000-0000-000000000001",
        skillVersion: "1.0.0",
        status: "WAITING_FOR_INPUT",
        revision: 0,
        state: emptyPlanTripSkillState()
      };
      const skillExecutions = {
        findActiveExecution: vi.fn().mockResolvedValue(active),
        updateExecutionState: vi.fn().mockRejectedValue(failure),
        createExecution: vi.fn()
      } as unknown as SkillExecutionService;
      const { service, provider, prisma } = mixedHarness(
        () => [],
        undefined,
        true,
        skillExecutions
      );

      const result = await service.run("organization-1", "user-1", `mirror-${warning}`, {
        pluginInstallationId: "plugin-installation-1",
        conversationId: "conversation-1",
        message: "my name is Alex, plan a trip to Dubai in January for 5 days and 2 travellers"
      });

      expect(result.status).toBe("COMPLETED");
      expect(provider.complete).not.toHaveBeenCalled();
      expect(prisma.agentToolExecution.create).not.toHaveBeenCalled();
      expect(prisma.agentExecution.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: expect.objectContaining({
              skillShadow: expect.objectContaining({
                reasonCodes: expect.arrayContaining([warning]),
                persistence: expect.objectContaining({ warning, applied: false })
              })
            })
          })
        })
      );
    }
  );

  // Regression coverage for the reported production bug: "Create itinerary" / "Estimate budget" /
  // "Suggest hotels" / "Suggest flights" must reach the travel engine (which has TripState), never the
  // knowledge-grounded-answer bypass — even when retrieval (called on every turn, to build prompt context;
  // see AgentService.execute) comes back with a plausible-looking chunk that COULD be misused as an
  // answer. Proves the routing decision itself, not just that this particular mock returned nothing.
  function alwaysReturnsAChunk(): KnowledgeSource[] {
    return [
      {
        chunkId: "chunk-x",
        documentId: "doc-x",
        collectionId: "collection-x",
        title: "travel_portal_policy_document",
        content: "This chunk must never be used to answer an action request like this one.",
        chunkIndex: 0,
        pageNumber: null,
        heading: "Some Policy",
        sectionTitle: "Some Policy",
        isTable: false,
        headingPath: ["Master Travel Policy", "Some Policy"],
        score: 0.9
      }
    ];
  }
  it.each(["Create itinerary", "Estimate budget", "Suggest hotels", "Suggest flights"])(
    "%j reaches the travel engine (real provider called), never the knowledge bypass, even when retrieval returns a plausible chunk",
    async (message) => {
      const { service, provider } = mixedHarness(alwaysReturnsAChunk);
      const result = await service.run("organization-1", "user-1", "request-1", {
        pluginInstallationId: "plugin-installation-1",
        conversationId: "conversation-1",
        message
      });
      expect(result.response).not.toContain("This chunk must never be used");
      expect(result.response).not.toBe(
        "I could not find this information in the uploaded knowledge."
      );
      expect(provider.complete).toHaveBeenCalled();
    }
  );
});

describe("AgentService: travel.create_lead tool (Conversation Completion & Lead Capture — always-on, CRM-independent persistence)", () => {
  interface FakeToolHandler {
    execute(input: Record<string, unknown>, context: Record<string, unknown>): Promise<unknown>;
  }
  function buildService() {
    const prisma = {
      travelLead: {
        // No existing row for any idempotency key by default — each test that wants to exercise dedup
        // overrides this.
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "lead-1",
          ...data
        })),
        update: vi.fn().mockResolvedValue({})
      },
      plugin: { findUnique: vi.fn().mockResolvedValue({ grantedPermissions: [] }) }
    };
    const connectors = {
      toolHandlers: () => [],
      availableToolNames: vi.fn().mockResolvedValue([])
    };
    // A REAL TravelLeadService against the same mocked Prisma — idempotency and persistence behavior is
    // actually exercised here, not stubbed out (contrast with TRAVEL_LEAD_SERVICE_STUB used elsewhere).
    const travelLeadService = new TravelLeadService(prisma as unknown as PrismaService);
    const service = new AgentService(
      prisma as unknown as PrismaService,
      { getEffectivePermissions: vi.fn().mockResolvedValue([]) } as unknown as AuthorizationService,
      { search: vi.fn().mockResolvedValue([]) } as unknown as MemoryService,
      { resolveProvider: vi.fn() } as unknown as PluginAiService,
      connectors as unknown as ConnectorService,
      { search: vi.fn().mockResolvedValue([]), searchWithMetrics: vi.fn().mockResolvedValue({ sources: [], metrics: {} }) } as unknown as KnowledgeSearchService,
      CUSTOMER_IDENTITY_STUB,
      travelLeadService,
      SECURITY_CONFIG_STUB
    );
    const tool = (
      service as unknown as { tools: { get(name: string): FakeToolHandler } }
    ).tools.get("travel.create_lead");
    return { tool, prisma, connectors, travelLeadService };
  }
  const context = {
    organizationId: "organization-1",
    userId: "user-1",
    pluginInstallationId: "plugin-installation-1",
    conversationId: "conversation-1"
  };
  const baseInput = {
    reference: "TRV-TEST01",
    customerName: "Alex",
    phoneNumber: "+919876543210",
    destination: "Paris",
    conversationSummary: "New Delhi -> Paris"
  };

  it("persists a TravelLead row directly — no CRM connector required at all", async () => {
    const { tool, prisma } = buildService();
    const result = await tool.execute(baseInput, context);
    expect(result).toEqual({ leadId: "lead-1", reference: "TRV-TEST01" });
    expect(prisma.travelLead.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reference: "TRV-TEST01",
        phoneNumber: "+919876543210",
        organizationId: "organization-1",
        conversationId: "conversation-1"
      })
    });
  });

  it("retries once with a freshly generated reference on a unique-constraint collision", async () => {
    const { tool, prisma } = buildService();
    let attempt = 0;
    prisma.travelLead.create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "6.19.3"
        });
      }
      return { id: "lead-2", ...data };
    });
    const result = (await tool.execute(baseInput, context)) as { reference: string };
    expect(prisma.travelLead.create).toHaveBeenCalledTimes(2);
    expect(result.reference).not.toBe("TRV-TEST01");
  });

  it("never throws when no CRM connector is configured — the best-effort sync is a safe no-op, and marks crmSyncStatus SKIPPED", async () => {
    const { tool, connectors, prisma } = buildService();
    await expect(tool.execute(baseInput, context)).resolves.toEqual({
      leadId: "lead-1",
      reference: "TRV-TEST01"
    });
    // The sync attempt is fire-and-forget (not awaited by execute) — flush microtasks so it has run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(connectors.availableToolNames).toHaveBeenCalled();
    expect(prisma.travelLead.update).toHaveBeenCalledWith({
      where: { id: "lead-1" },
      data: { crmSyncStatus: "SKIPPED" }
    });
  });

  it("required test #4: a CRM connector that THROWS never propagates — the lead remains persisted, the reference is still returned, and crmSyncStatus is marked FAILED", async () => {
    const { tool, connectors, prisma } = buildService();
    connectors.availableToolNames = vi.fn().mockRejectedValue(new Error("connector lookup failed"));
    await expect(tool.execute(baseInput, context)).resolves.toEqual({
      leadId: "lead-1",
      reference: "TRV-TEST01"
    });
    expect(prisma.travelLead.create).toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(prisma.travelLead.update).toHaveBeenCalledWith({
      where: { id: "lead-1" },
      data: { crmSyncStatus: "FAILED" }
    });
  });

  it("required test #5: a CRM connector that TIMES OUT (registered but never resolves in time) leaves the customer-facing result successful and marks crmSyncStatus FAILED", async () => {
    const prisma = {
      travelLead: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "lead-1",
          ...data
        })),
        update: vi.fn().mockResolvedValue({})
      },
      plugin: { findUnique: vi.fn().mockResolvedValue({ grantedPermissions: [] }) }
    };
    const timedOutHandler = {
      definition: {
        name: "connector.dummy-crm.crm.create_lead",
        version: "1.0.0",
        description: "",
        requiredPermissions: ["agents.tools.execute"],
        timeoutMs: 5,
        inputSchema: { type: "object", additionalProperties: true, properties: {} }
      },
      execute: () =>
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("ETIMEDOUT")), 20))
    };
    const connectors = {
      toolHandlers: () => [timedOutHandler],
      availableToolNames: vi.fn().mockResolvedValue(["connector.dummy-crm.crm.create_lead"])
    };
    const travelLeadService = new TravelLeadService(prisma as unknown as PrismaService);
    const service = new AgentService(
      prisma as unknown as PrismaService,
      { getEffectivePermissions: vi.fn().mockResolvedValue([]) } as unknown as AuthorizationService,
      { search: vi.fn().mockResolvedValue([]) } as unknown as MemoryService,
      { resolveProvider: vi.fn() } as unknown as PluginAiService,
      connectors as unknown as ConnectorService,
      { search: vi.fn().mockResolvedValue([]), searchWithMetrics: vi.fn().mockResolvedValue({ sources: [], metrics: {} }) } as unknown as KnowledgeSearchService,
      CUSTOMER_IDENTITY_STUB,
      travelLeadService,
      SECURITY_CONFIG_STUB
    );
    const tool = (
      service as unknown as {
        tools: {
          get(name: string): { execute(input: unknown, context: unknown): Promise<unknown> };
        };
      }
    ).tools.get("travel.create_lead");
    const result = await tool.execute(baseInput, context);
    expect(result).toEqual({ leadId: "lead-1", reference: "TRV-TEST01" });
    // Give the timeout (20ms) time to fire and the fire-and-forget sync's catch block to run.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(prisma.travelLead.update).toHaveBeenCalledWith({
      where: { id: "lead-1" },
      data: { crmSyncStatus: "FAILED" }
    });
  });

  // Regression guard for the production defect where contact details were never persisted: the
  // orchestrator emits a `travel.create_lead` tool call, but the tool is only added to the per-turn
  // `available` set when the plugin MANIFEST declares it. If the manifest omits it, the executor rejects
  // the call (TOOL_NOT_PERMITTED) and the lead — with the captured phone number — is silently lost.
  it("is declared in the travel-employee plugin manifest (so it reaches the agent runtime's available-tool set)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const manifestPath = resolve(process.cwd(), "../../plugins/travel-employee/plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      tools: Array<{ name: string }>;
    };
    const toolNames = manifest.tools.map((tool) => tool.name);
    expect(toolNames).toContain("travel.create_lead");
    // The other travel tools the orchestrator can emit must stay declared too.
    expect(toolNames).toEqual(
      expect.arrayContaining(["travel.search_flights", "travel.search_hotels", "travel.escalate"])
    );
  });
});
