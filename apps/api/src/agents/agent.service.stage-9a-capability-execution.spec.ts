import { PluginStatus } from "@prisma/client";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { AuthorizationService } from "../identity/application/services/authorization.service";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { PluginAiService } from "../plugins/plugin-ai.service";
import type { ConnectorService } from "../connectors/connector.service";
import type { KnowledgeSearchService } from "../knowledge/knowledge.search";
import type { SecurityConfig } from "../identity/infrastructure/security/security-config";
import { TRAVEL_EMPLOYEE_PLUGIN_SLUG } from "../travel/travel.runtime";
import { AgentService, type MemoryService } from "./agent.service";
import type { TravelLeadService } from "../travel/travel-lead.service";
import type { CustomerIdentityService } from "../customer-identity/customer-identity.service";
import { resolveCustomerIdentity } from "../customer-identity/customer-identity.types";
import type { InputCollectionService } from "../skills/travel/input-collection.service";
import type { InputDecision } from "../skills/travel/input-decision.dto";
import type { CapabilityExecutionAdapter } from "../skills/travel/capability-execution.adapter";
import { TravelDecisionAdapter } from "../skills/travel/travel-decision-adapter";
import {
  initializeSkillRuntimeConfig,
  loadSkillRuntimeAuthoritativeConfig
} from "../skills/travel/skill-runtime-authoritative-config";

/**
 * Stage 9A: AgentService-level integration coverage for the CapabilityExecutionAdapter.
 *
 * Confirms:
 *   - READY_FOR_BOOKING short-circuits to the adapter's typed BOOKING_WORKFLOW_PENDING handoff, without
 *     ever executing a booking, a provider call, or a tool call.
 *   - READY_FOR_ITINERARY / READY_FOR_ESTIMATE / READY_FOR_LIVE_SEARCH are recorded via the adapter but do
 *     NOT change today's response — Travel Runtime remains the sole executor (backward compatible).
 *   - The adapter is invoked at most once per turn (no duplicate execution).
 *   - A failing adapter falls back to the legacy Travel Runtime path instead of failing the request.
 */

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

function harness(options: { inputCollection: InputCollectionService; capabilityExecution?: CapabilityExecutionAdapter }) {
  const provider = {
    complete: vi.fn().mockResolvedValue({
      content: "legacy travel runtime response",
      toolCalls: [],
      provider: "openai-compatible",
      model: "gpt-4.1-mini",
      usage: {}
    })
  };
  const memories = { search: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue({}) };
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
    agentToolExecution: { create: vi.fn(), update: vi.fn() }
  };
  const pluginAi = {
    resolveProvider: vi.fn().mockResolvedValue({
      provider,
      settings: { providerType: "OPENAI_COMPATIBLE", model: "gpt-4.1-mini", timeoutMs: 30000 }
    })
  };
  const knowledge = { search: vi.fn().mockResolvedValue([]) };
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
    undefined,
    undefined,
    options.inputCollection,
    options.capabilityExecution
  );
  return { service, provider, prisma, memories };
}

function readyDecision(
  decisionType: InputDecision["decision"],
  capability: keyof InputDecision["readinessCapabilities"]
): InputDecision {
  return {
    decision: decisionType,
    pendingInput: null,
    missingFields: [],
    readinessCapabilities: {
      itinerary: capability === "itinerary",
      estimate: capability === "estimate",
      liveSearch: capability === "liveSearch",
      booking: capability === "booking"
    },
    policyWarnings: [],
    explanationCode: "READY",
    skillVersion: "1.0.0",
    policyVersion: "1.0.0",
    stateRevision: 1
  };
}

function enableAuthoritativeMode() {
  initializeSkillRuntimeConfig({
    enableAuthoritativeInputCollection: true,
    fallbackToLegacy: true,
    emitDiagnosticsOnFallback: true,
    allowTestOverride: true
  });
}

describe("AgentService Stage 9A: CapabilityExecutionAdapter wiring", () => {
  afterEach(() => {
    initializeSkillRuntimeConfig(loadSkillRuntimeAuthoritativeConfig());
  });

  it("READY_FOR_BOOKING short-circuits to the typed BOOKING_WORKFLOW_PENDING handoff without calling the provider or any tool", async () => {
    enableAuthoritativeMode();
    const decision = readyDecision("READY_FOR_BOOKING", "booking");
    const inputCollection = {
      collectInput: vi.fn().mockResolvedValue({ decision, loadedExecution: null }),
      getQuestionForPendingInput: vi.fn()
    } as unknown as InputCollectionService;
    const { service, provider, prisma } = harness({ inputCollection });

    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "plan a trip to Dubai"
    });

    const expectedExplanation = TravelDecisionAdapter.route(decision).explanation;
    expect(result.response).toBe(expectedExplanation);
    expect(result.response).toContain("would you like to proceed");
    expect(result.model).toBe("capability-execution-v1");
    expect(provider.complete).not.toHaveBeenCalled();
    expect(prisma.agentToolExecution.create).not.toHaveBeenCalled();
  });

  it("the adapter is invoked at most once for a booking-ready turn (no duplicate execution)", async () => {
    enableAuthoritativeMode();
    const executeSpy = vi.fn().mockReturnValue({
      capability: "BOOKING",
      executionStatus: "DEFERRED",
      executionType: "WORKFLOW_PENDING",
      executionTarget: null,
      requiresWorkflow: true,
      requiresHumanApproval: false,
      metadata: { bookingSupported: false, workflowRequired: true }
    });
    const capabilityExecution = { execute: executeSpy } as unknown as CapabilityExecutionAdapter;
    const inputCollection = {
      collectInput: vi.fn().mockResolvedValue({
        decision: readyDecision("READY_FOR_BOOKING", "booking"),
        loadedExecution: null
      }),
      getQuestionForPendingInput: vi.fn()
    } as unknown as InputCollectionService;
    const { service, provider } = harness({ inputCollection, capabilityExecution });

    await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "plan a trip to Dubai"
    });

    expect(executeSpy).toHaveBeenCalledOnce();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it.each([
    ["READY_FOR_ITINERARY" as const, "itinerary" as const],
    ["READY_FOR_ESTIMATE" as const, "estimate" as const],
    ["READY_FOR_LIVE_SEARCH" as const, "liveSearch" as const]
  ])(
    "%s is recorded via the adapter but does not change today's response — Travel Runtime remains the executor",
    async (decisionType, capability) => {
      enableAuthoritativeMode();
      const executeSpy = vi.fn().mockReturnValue({
        capability: capability === "itinerary" ? "ITINERARY" : capability === "estimate" ? "ESTIMATE" : "LIVE_SEARCH",
        executionStatus: capability === "estimate" ? "EXECUTED" : capability === "itinerary" ? "DELEGATED" : "PREPARED",
        executionType:
          capability === "estimate"
            ? "DETERMINISTIC_CALCULATION"
            : capability === "itinerary"
              ? "LLM_ORCHESTRATED"
              : "TOOL_DELEGATED",
        executionTarget: "test-target",
        requiresWorkflow: false,
        requiresHumanApproval: false,
        metadata: {}
      });
      const capabilityExecution = { execute: executeSpy } as unknown as CapabilityExecutionAdapter;
      const inputCollection = {
        collectInput: vi.fn().mockResolvedValue({
          decision: readyDecision(decisionType, capability),
          loadedExecution: null
        }),
        getQuestionForPendingInput: vi.fn()
      } as unknown as InputCollectionService;
      const { service, provider } = harness({ inputCollection, capabilityExecution });

      const result = await service.run("organization-1", "user-1", "request-1", {
        pluginInstallationId: "plugin-installation-1",
        conversationId: "conversation-1",
        message: "plan a trip to Dubai"
      });

      // The adapter is consulted exactly once for diagnostics ...
      expect(executeSpy).toHaveBeenCalledOnce();
      // ... but the response was never replaced by the capability-execution short-circuit: the legacy
      // Travel Runtime provider path ran normally, exactly as it did before Stage 9A (no breaking change).
      expect(provider.complete).toHaveBeenCalled();
      expect(result.model).not.toBe("capability-execution-v1");
      expect(result.status).toBe("COMPLETED");
    }
  );

  it("a throwing CapabilityExecutionAdapter falls back to the legacy Travel Runtime path instead of failing the request", async () => {
    enableAuthoritativeMode();
    const executeSpy = vi.fn().mockImplementation(() => {
      throw new Error("boom");
    });
    const capabilityExecution = { execute: executeSpy } as unknown as CapabilityExecutionAdapter;
    const inputCollection = {
      collectInput: vi.fn().mockResolvedValue({
        decision: readyDecision("READY_FOR_BOOKING", "booking"),
        loadedExecution: null
      }),
      getQuestionForPendingInput: vi.fn()
    } as unknown as InputCollectionService;
    const { service, provider } = harness({ inputCollection, capabilityExecution });

    // Even though the real adapter is designed to never throw, AgentService defensively catches an
    // adapter failure and degrades to the legacy Travel Runtime path exactly once — never failing the
    // request and never retrying the adapter.
    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "plan a trip to Dubai"
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.model).not.toBe("capability-execution-v1");
    expect(executeSpy).toHaveBeenCalledOnce();
    expect(provider.complete).toHaveBeenCalled();
  });
});
