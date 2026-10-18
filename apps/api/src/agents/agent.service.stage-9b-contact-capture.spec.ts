import { PluginStatus, Prisma, type WorkflowExecution } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthorizationService } from "../identity/application/services/authorization.service";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { PluginAiService } from "../plugins/plugin-ai.service";
import type { ConnectorService } from "../connectors/connector.service";
import type { KnowledgeSearchService } from "../knowledge/knowledge.search";
import type { SecurityConfig } from "../identity/infrastructure/security/security-config";
import { TRAVEL_EMPLOYEE_PLUGIN_SLUG, entitiesToStoredState, EMPTY_TRAVEL_ENTITIES } from "../travel/travel.runtime";
import { AgentService, type MemoryService } from "./agent.service";
import { TravelLeadService } from "../travel/travel-lead.service";
import { LeadService } from "../leads/lead.service";
import type { CustomerIdentityService } from "../customer-identity/customer-identity.service";
import { resolveCustomerIdentity } from "../customer-identity/customer-identity.types";
import { WorkflowExecutionService } from "../workflows/workflow-execution.service";
import { ContactCaptureWorkflowService } from "../workflows/contact-capture/contact-capture.service";
import { BookingHandoffWorkflowService } from "../workflows/booking-handoff/booking-handoff.service";
import { TripSubmissionWorkflowService } from "../workflows/trip-submission/trip-submission.service";
import { WorkflowCoordinator } from "../workflows/workflow-coordinator";

/**
 * Stage 9B: AgentService-level integration coverage for the Pending Workflow Runtime / Contact Capture.
 *
 * This is the completion-criteria test: it proves, against a real (mocked-persistence) AgentService
 * stack, that:
 *   1. selecting option 3 starts Contact Capture
 *   2. the next phone-number message resumes that same workflow
 *   3. the phone message is never classified as travel search or knowledge
 *   4. no live-search retry response is ever produced
 *   5. the callback request is persisted (a real TravelLead row is created)
 *   6. the user never has to repeat trip details or their mobile number
 */

const SECURITY_CONFIG_STUB = {
  knowledge: { retrievalDebugLogging: false }
} as unknown as SecurityConfig;

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
      // AgentService writes travel.trip_state back via memories.save (MemoryService), not directly —
      // the memories mock below is what actually updates travelMemoryValue for this harness.
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
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "6.19.3"
          });
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
      updateMany: async ({
        where,
        data
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
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
        if (data.idempotencyKey && leadRows.some((row) => row.idempotencyKey === data.idempotencyKey)) {
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "6.19.3",
            meta: { target: ["idempotency_key"] }
          });
        }
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

function harness(options: { crmConfigured?: boolean } = {}) {
  const { prisma, workflowRows, leadRows, assistantMessages, setTravelMemory } = fakePrisma();
  const provider = { complete: vi.fn().mockRejectedValue(new Error("PROVIDER MUST NOT BE CALLED FOR A WORKFLOW-OWNED TURN")) };
  const memories = {
    search: vi.fn().mockResolvedValue([]),
    save: vi.fn(async (_org: string, _user: string | null, input: { value: unknown }) => {
      setTravelMemory(input.value as Record<string, unknown>);
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
  const connectors = {
    toolHandlers: () => [],
    availableToolNames: vi.fn().mockResolvedValue(options.crmConfigured ? ["sales.crm.create_lead"] : [])
  };
  const workflows = new WorkflowExecutionService(prisma);
  const travelLeadService = new TravelLeadService(prisma, new LeadService(prisma));
  const contactCapture = new ContactCaptureWorkflowService(workflows, travelLeadService);
  const bookingHandoff = new BookingHandoffWorkflowService(workflows);
  const tripSubmission = new TripSubmissionWorkflowService(workflows, travelLeadService);
  const workflowCoordinator = new WorkflowCoordinator(workflows, contactCapture, bookingHandoff, tripSubmission);

  const service = new AgentService(
    prisma,
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
    undefined,
    undefined,
    workflowCoordinator
  );

  return { service, provider, knowledge, workflowRows, leadRows, assistantMessages, setTravelMemory, connectors, workflows, prisma };
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

describe("AgentService Stage 9B: Pending Workflow Runtime + Contact Capture (completion criteria)", () => {
  it("A+B+completion-criteria: option 3 starts Contact Capture, and the phone reply resumes it, persists the lead, and never touches search/RAG/the provider", async () => {
    const { service, provider, knowledge, workflowRows, leadRows, assistantMessages, setTravelMemory } = harness();
    setTravelMemory(storedStateWithRecoveryMenu());

    // Turn 1: user selects option 3.
    const first = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "3"
    });

    expect(first.response).toMatch(/mobile number/i);
    expect(workflowRows).toHaveLength(1);
    expect(workflowRows[0]).toMatchObject({ status: "WAITING_FOR_INPUT", pendingInput: "MOBILE_NUMBER" });
    expect(provider.complete).not.toHaveBeenCalled();
    expect(knowledge.search).not.toHaveBeenCalled();

    // Turn 2: user replies with the UAT phone number. Trip details/mobile number are never repeated.
    const second = await service.run("organization-1", "user-1", "request-2", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "8380031193"
    });

    expect(second.response).toBe(
      "Your callback request has been saved. A travel advisor can contact you on 8380031193 regarding your Delhi to Dubai trip."
    );
    // Completion criterion 3 & 4: never a search/knowledge retry message.
    expect(second.response).not.toMatch(/retrieve the options|retry the search/i);
    // Completion criterion 4: the provider (LLM/legacy Travel Runtime) is never invoked for either turn.
    expect(provider.complete).not.toHaveBeenCalled();
    expect(knowledge.search).not.toHaveBeenCalled();
    // Completion criterion 5: the callback request is actually persisted.
    expect(leadRows).toHaveLength(1);
    expect(leadRows[0]).toMatchObject({ phoneNumber: "8380031193", destination: "Dubai", departureCity: "Delhi" });
    expect(workflowRows[0]?.status).toBe("COMPLETED");
    // The assistant never re-asked for anything already known.
    expect(assistantMessages.some((text) => /mobile number/i.test(text))).toBe(true);
    expect(assistantMessages[assistantMessages.length - 1]).not.toMatch(/mobile number\?/i);
  });

  it("C: an invalid phone number keeps the workflow WAITING_FOR_INPUT, preserves trip state, and creates no lead", async () => {
    const { service, workflowRows, leadRows, setTravelMemory } = harness();
    setTravelMemory(storedStateWithRecoveryMenu());
    await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "3"
    });

    const result = await service.run("organization-1", "user-1", "request-2", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "12345"
    });

    expect(result.response).toMatch(/valid.*mobile number/i);
    expect(workflowRows[0]?.status).toBe("WAITING_FOR_INPUT");
    expect(leadRows).toHaveLength(0);
  });

  it("E: restart durability — a freshly constructed AgentService resumes a workflow persisted by a previous instance", async () => {
    const built = fakePrisma();
    built.setTravelMemory(storedStateWithRecoveryMenu());
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
      const travelLeadService = new TravelLeadService(built.prisma, new LeadService(built.prisma));
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
        undefined,
        undefined,
        workflowCoordinator
      );
    };

    const serviceA = makeService();
    await serviceA.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "3"
    });

    // Simulate an app restart: a completely new AgentService (and its own new workflow/lead services),
    // sharing only the persisted (fake) database.
    const serviceB = makeService();
    const result = await serviceB.run("organization-1", "user-1", "request-2", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "8380031193"
    });

    expect(result.response).toContain("8380031193");
    expect(built.leadRows).toHaveLength(1);
  });

  it("F: CRM unavailable — the callback request is still safely persisted with a truthful confirmation, and the phone is never requested again", async () => {
    const { service, workflowRows, leadRows, connectors, setTravelMemory } = harness({ crmConfigured: false });
    setTravelMemory(storedStateWithRecoveryMenu());
    await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "3"
    });

    const result = await service.run("organization-1", "user-1", "request-2", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "8380031193"
    });

    expect(leadRows).toHaveLength(1);
    expect(result.response).not.toMatch(/mobile number\?/i);
    expect(result.response).toContain("Your callback request has been saved.");
    expect(workflowRows[0]?.status).toBe("COMPLETED");
    // AgentService still attempts the existing best-effort CRM sync in the background; with no CRM tool
    // configured it truthfully marks SKIPPED — never claims a CRM lead was created, never blocks or
    // alters the (already-sent) response, never re-asks for the phone number.
    await vi.waitFor(() => expect(leadRows[0]?.crmSyncStatus).toBe("SKIPPED"));
    expect(connectors.availableToolNames).toHaveBeenCalled();
  });

  it("H: SHADOW-mode behaviour and non-travel turns are unaffected — no workflow starts on an unrelated message", async () => {
    const { service, provider, workflowRows } = harness();
    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "plan a trip to Dubai"
    });

    expect(workflowRows).toHaveLength(0);
    expect(result.status).toBe("COMPLETED");
    // Falls straight through to the existing legacy Travel Runtime path, unchanged.
    expect(provider.complete).toHaveBeenCalled();
  });
});
