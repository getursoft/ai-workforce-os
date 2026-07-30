import { PluginStatus, Prisma, type WorkflowExecution } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthorizationService } from "../identity/application/services/authorization.service";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { PluginAiService } from "../plugins/plugin-ai.service";
import type { ConnectorService } from "../connectors/connector.service";
import type { KnowledgeSearchService } from "../knowledge/knowledge.search";
import type { SecurityConfig } from "../identity/infrastructure/security/security-config";
import { TRAVEL_EMPLOYEE_PLUGIN_SLUG, entitiesToStoredState, EMPTY_TRAVEL_ENTITIES } from "../travel/travel.runtime";
import { AgentService, type MemoryService } from "./agent.service";
import { TravelLeadService } from "../travel/travel-lead.service";
import type { CustomerIdentityService } from "../customer-identity/customer-identity.service";
import { resolveCustomerIdentity } from "../customer-identity/customer-identity.types";
import type { InputCollectionService } from "../skills/travel/input-collection.service";
import type { InputDecision } from "../skills/travel/input-decision.dto";
import {
  initializeSkillRuntimeConfig,
  loadSkillRuntimeAuthoritativeConfig
} from "../skills/travel/skill-runtime-authoritative-config";
import { WorkflowExecutionService } from "../workflows/workflow-execution.service";
import { ContactCaptureWorkflowService } from "../workflows/contact-capture/contact-capture.service";
import { BookingHandoffWorkflowService } from "../workflows/booking-handoff/booking-handoff.service";
import { TripSubmissionWorkflowService } from "../workflows/trip-submission/trip-submission.service";
import { WorkflowCoordinator } from "../workflows/workflow-coordinator";

/**
 * Stage 9C: AgentService-level integration coverage for Workflow Authority Consolidation —
 * ContactCaptureWorkflowService and BookingHandoffWorkflowService as the sole authorities for their
 * respective multi-turn processes, coordinated (priority, conflict, cancellation) by WorkflowCoordinator.
 */

const SECURITY_CONFIG_STUB = { knowledge: { retrievalDebugLogging: false } } as unknown as SecurityConfig;

const CUSTOMER_IDENTITY_STUB = {
  resolve: resolveCustomerIdentity,
  loadProfile: vi.fn().mockResolvedValue(null),
  rememberName: vi.fn().mockResolvedValue(null)
} as unknown as CustomerIdentityService;

const UAT_TRIP = {
  ...EMPTY_TRAVEL_ENTITIES,
  customerName: "Rahul",
  originCity: "Delhi",
  destinationCity: "Dubai",
  days: 3,
  departureDate: "2026-08-17",
  totalTravellers: 5,
  adults: 5,
  budget: 500000,
  budgetCurrency: "INR"
};

function matches(row: WorkflowExecution, where: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(where)) {
    const actual = (row as unknown as Record<string, unknown>)[key];
    if (typeof expected === "object" && expected !== null) {
      const condition = expected as { in?: unknown[]; not?: unknown };
      if (condition.in && !condition.in.includes(actual)) return false;
      if ("not" in condition && actual === condition.not) return false;
    } else if (actual !== expected) return false;
  }
  return true;
}

function fakePrisma() {
  const workflowRows: WorkflowExecution[] = [];
  const leadRows: Array<Record<string, unknown>> = [];
  const assistantMessages: string[] = [];
  let leadCounter = 0;
  let travelMemoryValue: Record<string, unknown> | null = null;

  const prisma = {
    plugin: {
      findFirst: vi.fn().mockResolvedValue({
        id: "plugin-installation-1",
        organizationId: "organization-1",
        status: PluginStatus.ACTIVE,
        slug: TRAVEL_EMPLOYEE_PLUGIN_SLUG,
        description: "Travel assistant",
        grantedPermissions: []
      }),
      findUnique: vi.fn().mockResolvedValue({
        id: "plugin-installation-1",
        organizationId: "organization-1",
        grantedPermissions: []
      })
    },
    travelEmployeeConfiguration: { findFirst: vi.fn().mockResolvedValue(null) },
    agentMemory: {
      findFirst: vi.fn(async () => (travelMemoryValue ? { value: travelMemoryValue } : null)),
      create: vi.fn()
    },
    conversation: {
      findFirst: vi.fn().mockResolvedValue({ id: "conversation-1", status: "ACTIVE" }),
      update: vi.fn().mockResolvedValue({})
    },
    conversationMessage: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }: { data: { role: string; content: string } }) => {
        if (data.role === "ASSISTANT") assistantMessages.push(data.content);
        return { id: `message-${assistantMessages.length}` };
      })
    },
    agentExecution: {
      create: vi.fn().mockResolvedValue({ id: "execution-1" }),
      update: vi.fn().mockResolvedValue({})
    },
    agentToolExecution: { create: vi.fn(), update: vi.fn() },
    workflowExecution: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        workflowRows.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        workflowRows.filter((row) => matches(row, where)),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (workflowRows.some((row) => row.activeKey === data.activeKey))
          throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "6.19.3" });
        const now = new Date();
        const row = {
          id: `workflow-${workflowRows.length + 1}`,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
          ...data
        } as WorkflowExecution;
        workflowRows.push(row);
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = workflowRows.find((candidate) => matches(candidate, where));
        if (!row) return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          if (key === "revision" && typeof value === "object" && value)
            row.revision += (value as { increment: number }).increment;
          else (row as unknown as Record<string, unknown>)[key] = value;
        }
        row.updatedAt = new Date();
        return { count: 1 };
      }
    },
    travelLead: {
      findUnique: async ({ where }: { where: { idempotencyKey?: string } }) =>
        leadRows.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        leadCounter += 1;
        const row = { id: `lead-${leadCounter}`, ...data };
        leadRows.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = leadRows.find((candidate) => candidate.id === where.id);
        Object.assign(row as object, data);
        return row;
      }
    }
  };

  return {
    prisma: prisma as unknown as PrismaService,
    workflowRows,
    leadRows,
    assistantMessages,
    setTravelMemory: (value: Record<string, unknown>) => {
      travelMemoryValue = value;
    }
  };
}

function storedStateWithRecoveryMenu() {
  return {
    ...entitiesToStoredState(UAT_TRIP, "ITINERARY_SUMMARY"),
    providerFailure: {
      failedAction: "SEARCH_LIVE_OPTIONS",
      provider: "test-provider",
      failedAt: new Date().toISOString(),
      retryable: true,
      selectedRecoveryAction: null,
      menuActive: true,
      menuExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
    }
  };
}

function readyForBookingDecision(): InputDecision {
  return {
    decision: "READY_FOR_BOOKING",
    pendingInput: null,
    missingFields: [],
    readinessCapabilities: { itinerary: false, estimate: false, liveSearch: false, booking: true },
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

function harness(options: { inputCollection?: InputCollectionService } = {}) {
  const built = fakePrisma();
  const provider = {
    complete: vi.fn().mockRejectedValue(new Error("PROVIDER MUST NOT BE CALLED FOR A WORKFLOW-OWNED TURN"))
  };
  const memories = {
    search: vi.fn().mockResolvedValue([]),
    save: vi.fn(async (_org: string, _user: string | null, input: { value: unknown }) => {
      built.setTravelMemory(input.value as Record<string, unknown>);
      return {};
    })
  };
  const knowledge = { search: vi.fn().mockResolvedValue([]) };
  const pluginAi = {
    resolveProvider: vi.fn().mockResolvedValue({
      provider,
      settings: { providerType: "OPENAI_COMPATIBLE", model: "gpt-4.1-mini", timeoutMs: 30000 }
    })
  };
  const connectors = { toolHandlers: () => [], availableToolNames: vi.fn().mockResolvedValue([]) };
  const workflows = new WorkflowExecutionService(built.prisma);
  const travelLeadService = new TravelLeadService(built.prisma);
  const contactCapture = new ContactCaptureWorkflowService(workflows, travelLeadService);
  const bookingHandoff = new BookingHandoffWorkflowService(workflows);
  const tripSubmission = new TripSubmissionWorkflowService(workflows, travelLeadService);
  const workflowCoordinator = new WorkflowCoordinator(workflows, contactCapture, bookingHandoff, tripSubmission);

  const service = new AgentService(
    built.prisma,
    { getEffectivePermissions: vi.fn().mockResolvedValue([]) } as unknown as AuthorizationService,
    memories as unknown as MemoryService,
    pluginAi as unknown as PluginAiService,
    connectors as unknown as ConnectorService,
    knowledge as unknown as KnowledgeSearchService,
    CUSTOMER_IDENTITY_STUB,
    travelLeadService,
    SECURITY_CONFIG_STUB,
    undefined,
    undefined,
    options.inputCollection,
    undefined,
    workflowCoordinator
  );

  return { service, provider, workflowCoordinator, workflows, ...built };
}

describe("AgentService Stage 9C: BOOKING_HANDOFF via a real READY_FOR_BOOKING turn", () => {
  afterEach(() => {
    initializeSkillRuntimeConfig(loadSkillRuntimeAuthoritativeConfig());
  });

  it("5: starts BOOKING_HANDOFF from READY_FOR_BOOKING — no provider, tool, CRM, or live-search call", async () => {
    enableAuthoritativeMode();
    const inputCollection = {
      collectInput: vi.fn().mockResolvedValue({ decision: readyForBookingDecision(), loadedExecution: null }),
      getQuestionForPendingInput: vi.fn()
    } as unknown as InputCollectionService;
    const { service, provider, workflowRows, prisma } = harness({ inputCollection });

    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "plan a trip to Dubai"
    });

    expect(result.response).toMatch(/booking request/i);
    expect(result.response).toMatch(/shall i proceed/i);
    expect(workflowRows).toHaveLength(1);
    expect(workflowRows[0]).toMatchObject({
      workflowType: "BOOKING_HANDOFF",
      status: "WAITING_FOR_INPUT",
      pendingInput: "BOOKING_CONFIRMATION"
    });
    expect(provider.complete).not.toHaveBeenCalled();
    expect(prisma.agentToolExecution.create).not.toHaveBeenCalled();
  });

  it("6: an explicit confirmation persists the booking intent and returns an honest no-reservation response", async () => {
    enableAuthoritativeMode();
    const inputCollection = {
      collectInput: vi.fn().mockResolvedValue({ decision: readyForBookingDecision(), loadedExecution: null }),
      getQuestionForPendingInput: vi.fn()
    } as unknown as InputCollectionService;
    const { service, workflowRows, setTravelMemory } = harness({ inputCollection });
    setTravelMemory(entitiesToStoredState(UAT_TRIP, "ITINERARY_SUMMARY"));

    await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "plan a trip to Dubai"
    });

    const result = await service.run("organization-1", "user-1", "request-2", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "yes, please proceed"
    });

    expect(result.response).toMatch(/booking request has been saved/i);
    expect(result.response).toMatch(/no reservation or payment has been made/i);
    expect(result.response).not.toMatch(/booking confirmed|seat reserved|payment initiated|advisor assigned/i);
    expect(workflowRows[0]?.status).toBe("COMPLETED");
  });

  it("conflict: an already-active CONTACT_CAPTURE workflow is preserved instead of being overwritten by a later READY_FOR_BOOKING turn", async () => {
    enableAuthoritativeMode();
    const inputCollection = {
      collectInput: vi.fn().mockResolvedValue({ decision: readyForBookingDecision(), loadedExecution: null }),
      getQuestionForPendingInput: vi.fn()
    } as unknown as InputCollectionService;
    const { service, workflowRows, setTravelMemory } = harness({ inputCollection });
    setTravelMemory(storedStateWithRecoveryMenu());

    // Turn 1: start CONTACT_CAPTURE via the recovery-menu selection.
    await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "3"
    });
    expect(workflowRows).toHaveLength(1);
    expect(workflowRows[0]?.workflowType).toBe("CONTACT_CAPTURE");

    // Turn 2: the authoritative decision reaches READY_FOR_BOOKING for the same conversation. Since
    // CONTACT_CAPTURE is already WAITING_FOR_INPUT, that workflow owns the turn — the phone-number
    // continuation must win, and BOOKING_HANDOFF must never be started underneath it.
    const result = await service.run("organization-1", "user-1", "request-2", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "8380031193"
    });

    expect(workflowRows).toHaveLength(1);
    expect(workflowRows[0]?.workflowType).toBe("CONTACT_CAPTURE");
    expect(result.response).toContain("8380031193");
  });

  it("restart durability: a freshly constructed AgentService resumes a BOOKING_HANDOFF workflow persisted by a previous instance", async () => {
    enableAuthoritativeMode();
    const inputCollection = {
      collectInput: vi.fn().mockResolvedValue({ decision: readyForBookingDecision(), loadedExecution: null }),
      getQuestionForPendingInput: vi.fn()
    } as unknown as InputCollectionService;

    const built = fakePrisma();
    const makeService = () => {
      const provider = { complete: vi.fn().mockRejectedValue(new Error("must not be called")) };
      const memories = {
        search: vi.fn().mockResolvedValue([]),
        save: vi.fn(async (_o: string, _u: string | null, input: { value: unknown }) => {
          built.setTravelMemory(input.value as Record<string, unknown>);
          return {};
        })
      };
      const pluginAi = {
        resolveProvider: vi.fn().mockResolvedValue({
          provider,
          settings: { providerType: "OPENAI_COMPATIBLE", model: "gpt-4.1-mini", timeoutMs: 30000 }
        })
      };
      const workflows = new WorkflowExecutionService(built.prisma);
      const travelLeadService = new TravelLeadService(built.prisma);
      const contactCapture = new ContactCaptureWorkflowService(workflows, travelLeadService);
      const bookingHandoff = new BookingHandoffWorkflowService(workflows);
      const tripSubmission = new TripSubmissionWorkflowService(workflows, travelLeadService);
      const workflowCoordinator = new WorkflowCoordinator(workflows, contactCapture, bookingHandoff, tripSubmission);
      return new AgentService(
        built.prisma,
        { getEffectivePermissions: vi.fn().mockResolvedValue([]) } as unknown as AuthorizationService,
        memories as unknown as MemoryService,
        pluginAi as unknown as PluginAiService,
        { toolHandlers: () => [], availableToolNames: vi.fn().mockResolvedValue([]) } as unknown as ConnectorService,
        { search: vi.fn().mockResolvedValue([]) } as unknown as KnowledgeSearchService,
        CUSTOMER_IDENTITY_STUB,
        travelLeadService,
        SECURITY_CONFIG_STUB,
        undefined,
        undefined,
        inputCollection,
        undefined,
        workflowCoordinator
      );
    };

    const serviceA = makeService();
    await serviceA.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "plan a trip to Dubai"
    });

    const serviceB = makeService();
    const result = await serviceB.run("organization-1", "user-1", "request-2", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "yes"
    });

    expect(result.response).toMatch(/no reservation or payment has been made/i);
    expect(built.workflowRows[0]?.status).toBe("COMPLETED");
  });
});

describe("AgentService Stage 9C: cancellation via a full run() turn", () => {
  it("8: 'don't contact me' cancels an active CONTACT_CAPTURE workflow, creates no lead, and a later normal request proceeds", async () => {
    const { service, provider, workflowRows, leadRows, setTravelMemory } = harness();
    setTravelMemory(storedStateWithRecoveryMenu());

    await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "3"
    });
    expect(workflowRows[0]?.status).toBe("WAITING_FOR_INPUT");

    const cancelled = await service.run("organization-1", "user-1", "request-2", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "don't contact me"
    });

    expect(cancelled.response).toMatch(/won't ask for your contact details/i);
    expect(leadRows).toHaveLength(0);
    expect(workflowRows[0]?.status).toBe("CANCELLED");
    expect(workflowRows[0]?.activeKey).toBeNull();
    expect(workflowRows).toHaveLength(1);

    // Provider must still never have run for either of the two workflow-owned turns above.
    expect(provider.complete).not.toHaveBeenCalled();

    provider.complete.mockResolvedValueOnce({
      content: "Let's plan your Goa trip!",
      toolCalls: [],
      provider: "openai-compatible",
      model: "gpt-4.1-mini",
      usage: {}
    });
    const next = await service.run("organization-1", "user-1", "request-3", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "plan a trip to Goa instead"
    });
    expect(next.status).toBe("COMPLETED");
    expect(provider.complete).toHaveBeenCalled();
  });
});
