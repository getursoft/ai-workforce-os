import { PluginStatus, Prisma, type WorkflowExecution } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthorizationService } from "../identity/application/services/authorization.service";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { PluginAiService } from "../plugins/plugin-ai.service";
import type { ConnectorService } from "../connectors/connector.service";
import type { KnowledgeSearchService } from "../knowledge/knowledge.search";
import type { SecurityConfig } from "../identity/infrastructure/security/security-config";
import {
  TRAVEL_EMPLOYEE_PLUGIN_SLUG,
  entitiesToStoredState,
  EMPTY_TRAVEL_ENTITIES,
  EMPTY_TRAVEL_CONVERSATION_MEMORY
} from "../travel/travel.runtime";
import { AgentService, type MemoryService } from "./agent.service";
import { TravelLeadService } from "../travel/travel-lead.service";
import type { CustomerIdentityService } from "../customer-identity/customer-identity.service";
import { resolveCustomerIdentity } from "../customer-identity/customer-identity.types";
import { WorkflowExecutionService } from "../workflows/workflow-execution.service";
import { ContactCaptureWorkflowService } from "../workflows/contact-capture/contact-capture.service";
import { BookingHandoffWorkflowService } from "../workflows/booking-handoff/booking-handoff.service";
import { TripSubmissionWorkflowService } from "../workflows/trip-submission/trip-submission.service";
import { WorkflowCoordinator } from "../workflows/workflow-coordinator";

/**
 * Stage 9D: AgentService-level integration coverage for the TRIP_SUBMISSION workflow — proving, against a
 * real (mocked-persistence) AgentService stack, that the two migrated legacy flows
 * (confirm_booking_lead_capture, CONFIRM_STANDALONE_CONTACT_USE) are now owned end-to-end by
 * WorkflowExecution, never the legacy Travel Runtime engine.
 */

const SECURITY_CONFIG_STUB = { knowledge: { retrievalDebugLogging: false } } as unknown as SecurityConfig;

const CUSTOMER_IDENTITY_STUB = {
  resolve: resolveCustomerIdentity,
  loadProfile: vi.fn().mockResolvedValue(null),
  rememberName: vi.fn().mockResolvedValue(null)
} as unknown as CustomerIdentityService;

const UAT_TRIP = {
  ...EMPTY_TRAVEL_ENTITIES,
  customerName: "Krishna",
  originCity: "Delhi",
  destinationCity: "London",
  days: 3,
  totalTravellers: 5,
  adults: 5
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

function harness() {
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
    undefined,
    undefined,
    workflowCoordinator
  );

  return { service, provider, workflows, ...built };
}

function storedStateWithItineraryPresented() {
  return entitiesToStoredState(UAT_TRIP, "CONFIRM_BOOKING", {
    ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
    lastGeneratedItinerary: "Day 1: Arrive in London...\nDay 2: City tour...\nDay 3: Departure."
  });
}

function storedStateWithTripInProgress() {
  return entitiesToStoredState(UAT_TRIP, "RECOMMEND_OPTIONS", EMPTY_TRAVEL_CONVERSATION_MEMORY);
}

describe("AgentService Stage 9D: TRIP_SUBMISSION (confirm_booking_lead_capture migration)", () => {
  it("a booking confirmation after an itinerary was presented asks for a mobile number, then submits the trip request exactly once", async () => {
    const { service, provider, workflowRows, leadRows, assistantMessages, setTravelMemory } = harness();
    setTravelMemory(storedStateWithItineraryPresented());

    const confirm = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "yes, please confirm"
    });
    expect(confirm.response).toMatch(/mobile number/i);
    expect(confirm.response).not.toMatch(/CRM/i);
    expect(provider.complete).not.toHaveBeenCalled();

    const withPhone = await service.run("organization-1", "user-1", "request-2", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "+919876543210"
    });
    expect(withPhone.response).toMatch(/submitted successfully/i);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(leadRows).toHaveLength(1);
    expect(leadRows[0]).toMatchObject({ phoneNumber: "+919876543210", departureCity: "Delhi", destination: "London" });
    expect(workflowRows[0]).toMatchObject({ workflowType: "TRIP_SUBMISSION", status: "COMPLETED" });
    expect(assistantMessages.some((text) => /mobile number/i.test(text))).toBe(true);
  });
});

describe("AgentService Stage 9D: TRIP_SUBMISSION (CONFIRM_STANDALONE_CONTACT_USE migration)", () => {
  it("a volunteered phone number asks before using it, then creates the lead only after explicit confirmation", async () => {
    const { service, provider, workflowRows, leadRows, setTravelMemory } = harness();
    setTravelMemory(storedStateWithTripInProgress());

    const phone = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "8380031193"
    });
    expect(phone.response).toMatch(/looks like a mobile number/i);
    expect(phone.response).toMatch(/Delhi-to-London trip/i);
    expect(leadRows).toHaveLength(0);
    expect(provider.complete).not.toHaveBeenCalled();

    const confirmed = await service.run("organization-1", "user-1", "request-2", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "yes, create the enquiry"
    });
    expect(confirmed.response).toMatch(/submitted successfully/i);
    expect(leadRows).toHaveLength(1);
    expect(leadRows[0]).toMatchObject({ phoneNumber: "8380031193" });
    expect(workflowRows[0]).toMatchObject({ workflowType: "TRIP_SUBMISSION", status: "COMPLETED" });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("restart durability: a freshly constructed AgentService resumes a TRIP_SUBMISSION workflow persisted by a previous instance", async () => {
    const built = fakePrisma();
    built.setTravelMemory(storedStateWithTripInProgress());
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
        undefined,
        undefined,
        workflowCoordinator
      );
    };

    const serviceA = makeService();
    await serviceA.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "8380031193"
    });

    const serviceB = makeService();
    const result = await serviceB.run("organization-1", "user-1", "request-2", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "yes, create the enquiry"
    });

    expect(result.response).toMatch(/submitted successfully/i);
    expect(built.leadRows).toHaveLength(1);
  });
});

describe("AgentService Stage 9D: regression — unrelated turns are unaffected", () => {
  it("does not start TRIP_SUBMISSION on an unrelated message and falls through to the legacy path", async () => {
    const { service, provider, workflowRows } = harness();
    const result = await service.run("organization-1", "user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      conversationId: "conversation-1",
      message: "plan a trip to Dubai"
    });
    expect(workflowRows).toHaveLength(0);
    expect(result.status).toBe("COMPLETED");
    expect(provider.complete).toHaveBeenCalled();
  });
});
