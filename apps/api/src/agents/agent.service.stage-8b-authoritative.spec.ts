import { PluginStatus } from "@prisma/client";
import { BadRequestException } from "@nestjs/common";
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
import type { SkillExecutionService } from "../skills/skill-execution.service";
import type { InputCollectionService } from "../skills/travel/input-collection.service";
import type { InputDecision } from "../skills/travel/input-decision.dto";
import {
  initializeSkillRuntimeConfig,
  loadSkillRuntimeAuthoritativeConfig
} from "../skills/travel/skill-runtime-authoritative-config";

/**
 * Stage 8B: AgentService-level integration coverage for authoritative input collection.
 *
 * Confirms the wiring in AgentService.execute() itself (not just the pure Skill Runtime
 * services exercised in stage-8b-integration.spec.ts):
 *   - AUTHORITATIVE_INPUT_COLLECTION mode's InputDecision actually controls the next question.
 *   - SHADOW mode never touches InputCollectionService and keeps using the legacy Travel Runtime.
 *   - A Skill Runtime / InputCollection failure results in exactly one legacy fallback, never a retry.
 *   - No duplicate provider or tool calls occur when the authoritative path answers directly.
 *   - SkillExecution is persisted before travel.trip_state is mirrored (AgentMemory save).
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

function harness(options: {
  inputCollection?: InputCollectionService;
  skillExecutions?: SkillExecutionService;
  deterministic?: boolean;
}) {
  const provider = {
    complete: vi.fn().mockResolvedValue({
      content: JSON.stringify({ intent: "provide_trip_details" }),
      toolCalls: [],
      provider: "openai-compatible",
      model: "gpt-4.1-mini",
      usage: {}
    })
  };
  const memories = {
    search: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockResolvedValue({})
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
    agentToolExecution: { create: vi.fn(), update: vi.fn() }
  };
  const pluginAi = {
    resolveProvider: options.deterministic
      ? vi.fn().mockRejectedValue(new BadRequestException("AI_PROVIDER_NOT_CONFIGURED"))
      : vi.fn().mockResolvedValue({
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
    options.skillExecutions,
    options.inputCollection
  );
  return { service, provider, prisma, memories };
}

function askForInputDecision(pendingInput: InputDecision["pendingInput"]): InputDecision {
  return {
    decision: "ASK_FOR_INPUT",
    pendingInput,
    missingFields: pendingInput ? [`MISSING_${pendingInput}`] : [],
    readinessCapabilities: { itinerary: false, estimate: false, liveSearch: false, booking: false },
    policyWarnings: [],
    explanationCode: "ASKING",
    skillVersion: "1.0.0",
    policyVersion: "1.0.0",
    stateRevision: 1
  };
}

function errorStateLossDecision(): InputDecision {
  return {
    decision: "ERROR_STATE_LOSS",
    pendingInput: null,
    missingFields: [],
    readinessCapabilities: { itinerary: false, estimate: false, liveSearch: false, booking: false },
    policyWarnings: [],
    explanationCode: "ERROR_TEST",
    skillVersion: "1.0.0",
    policyVersion: "1.0.0",
    stateRevision: 0
  };
}

describe("AgentService Stage 8B: authoritative input collection wiring", () => {
  afterEach(() => {
    // Every test that flips the feature flag must restore the default (disabled) config so it can
    // never leak into another test in this file.
    initializeSkillRuntimeConfig(loadSkillRuntimeAuthoritativeConfig());
  });

  it("AUTHORITATIVE_INPUT_COLLECTION mode's decision controls the next question and skips the provider entirely", async () => {
    initializeSkillRuntimeConfig({
      enableAuthoritativeInputCollection: true,
      fallbackToLegacy: true,
      emitDiagnosticsOnFallback: true,
      allowTestOverride: true
    });
    const inputCollection = {
      collectInput: vi.fn().mockResolvedValue({
        decision: askForInputDecision("DESTINATION"),
        loadedExecution: null
      }),
      getQuestionForPendingInput: vi.fn().mockReturnValue({
        brief: "Where to?",
        full: "Where are you traveling to?"
      })
    } as unknown as InputCollectionService;
    const { service, provider, prisma } = harness({ inputCollection });

    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "plan a trip to Dubai"
    });

    expect(inputCollection.collectInput).toHaveBeenCalledOnce();
    expect(result.response).toBe("Where are you traveling to?");
    expect(result.model).toBe("skill-input-collection-v1");
    // The authoritative question short-circuits the turn: no LLM round trip, no tool calls.
    expect(provider.complete).not.toHaveBeenCalled();
    expect(prisma.agentToolExecution.create).not.toHaveBeenCalled();
  });

  it("SHADOW mode (the default) never calls InputCollectionService and keeps using the legacy Travel Runtime", async () => {
    const inputCollection = {
      collectInput: vi.fn(),
      getQuestionForPendingInput: vi.fn()
    } as unknown as InputCollectionService;
    const { service, provider } = harness({ inputCollection });

    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "plan a trip to Dubai"
    });

    expect(inputCollection.collectInput).not.toHaveBeenCalled();
    expect(result.status).toBe("COMPLETED");
    // The legacy LLM orchestrator path ran normally.
    expect(provider.complete).toHaveBeenCalled();
  });

  it("a Skill Runtime failure (ERROR_STATE_LOSS) triggers exactly one legacy fallback, never a duplicate provider call", async () => {
    initializeSkillRuntimeConfig({
      enableAuthoritativeInputCollection: true,
      fallbackToLegacy: true,
      emitDiagnosticsOnFallback: true,
      allowTestOverride: true
    });
    const inputCollection = {
      collectInput: vi.fn().mockResolvedValue({
        decision: errorStateLossDecision(),
        loadedExecution: null,
        migrationReason: "DECISION_ERROR"
      }),
      getQuestionForPendingInput: vi.fn()
    } as unknown as InputCollectionService;
    const { service, provider } = harness({ inputCollection });

    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "plan a trip to Dubai"
    });

    expect(inputCollection.collectInput).toHaveBeenCalledOnce();
    expect(result.status).toBe("COMPLETED");
    // Falls all the way through to the legacy LLM path exactly once — no retry of the authoritative
    // path, no second provider call.
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(inputCollection.getQuestionForPendingInput).not.toHaveBeenCalled();
  });

  it("when InputCollectionService itself throws, AgentService falls back once to the legacy runtime instead of failing the request", async () => {
    const inputCollection = {
      collectInput: vi.fn().mockRejectedValue(new Error("boom")),
      getQuestionForPendingInput: vi.fn()
    } as unknown as InputCollectionService;
    initializeSkillRuntimeConfig({
      enableAuthoritativeInputCollection: true,
      fallbackToLegacy: true,
      emitDiagnosticsOnFallback: true,
      allowTestOverride: true
    });
    const { service, provider } = harness({ inputCollection });

    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "plan a trip to Dubai"
    });

    expect(inputCollection.collectInput).toHaveBeenCalledOnce();
    expect(result.status).toBe("COMPLETED");
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it("persists SkillExecution before travel.trip_state is mirrored into AgentMemory", async () => {
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
    const { service, memories } = harness({ skillExecutions, deterministic: true });

    const result = await service.run("organization-1", "user-1", "ordering-turn-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "my name is Alex, plan a trip to Dubai in January for 5 days and 2 travellers"
    });

    expect(result.status).toBe("COMPLETED");
    expect(skillExecutions.createExecution).toHaveBeenCalledOnce();
    expect(memories.save).toHaveBeenCalled();

    const skillExecutionOrders = (skillExecutions.createExecution as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder;
    const mirrorOrders = (memories.save as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
    expect(skillExecutionOrders.length).toBeGreaterThan(0);
    expect(mirrorOrders.length).toBeGreaterThan(0);
    expect(Math.min(...skillExecutionOrders)).toBeLessThan(Math.min(...mirrorOrders));
  });
});
