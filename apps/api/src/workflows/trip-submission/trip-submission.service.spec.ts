import { Prisma, type WorkflowExecution } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { PrismaService } from "../../infrastructure/prisma/prisma.service";
import { TravelLeadService } from "../../travel/travel-lead.service";
import { LeadService } from "../../leads/lead.service";
import { EMPTY_TRAVEL_ENTITIES, type TravelEntities } from "../../travel/travel.runtime";
import { WorkflowExecutionService } from "../workflow-execution.service";
import type { WorkflowExecutionScope } from "../workflow-runtime.contracts";
import { TripSubmissionWorkflowService } from "./trip-submission.service";
import type { TripSubmissionStartSignals, TripSubmissionTripContext } from "./trip-submission.types";

const scope: WorkflowExecutionScope = {
  organizationId: "org-1",
  pluginInstallationId: "plugin-1",
  conversationId: "conversation-1",
  workflowType: "TRIP_SUBMISSION"
};

const TRIP_STATE: TravelEntities = {
  ...EMPTY_TRAVEL_ENTITIES,
  originCity: "Delhi",
  destinationCity: "London",
  customerName: "Krishna"
};

const TRIP_CONTEXT: TripSubmissionTripContext = {
  entities: TRIP_STATE,
  responseLanguage: "ENGLISH",
  travelDates: "3 nights",
  passengers: "5",
  tripPurpose: null,
  budgetAmount: null,
  budgetCurrency: null,
  displayCurrency: null,
  journeyId: null,
  customerName: "Krishna"
};

const NO_SIGNALS: TripSubmissionStartSignals = {
  legacyPendingInputAction: null,
  legacyCompletionStage: null,
  itineraryPresented: false,
  hasActiveTripContext: false,
  tripState: TRIP_STATE,
  legacyPendingContactValue: null,
  legacyPendingAction: null
};

function must<T>(value: T | null): T {
  if (value === null) throw new Error("expected a non-null value in test setup");
  return value;
}

function fakeWorkflowPrisma() {
  const rows: WorkflowExecution[] = [];
  return {
    rows,
    workflowExecution: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => matchesWorkflow(row, where)) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((row) => matchesWorkflow(row, where)),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (rows.some((row) => row.activeKey === data.activeKey))
          throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "6.19.3" });
        const now = new Date();
        const row = { id: `workflow-${rows.length + 1}`, completedAt: null, createdAt: now, updatedAt: now, ...data } as WorkflowExecution;
        rows.push(row);
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = rows.find((candidate) => matchesWorkflow(candidate, where));
        if (!row) return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          if (key === "revision" && typeof value === "object" && value)
            row.revision += (value as { increment: number }).increment;
          else (row as unknown as Record<string, unknown>)[key] = value;
        }
        row.updatedAt = new Date();
        return { count: 1 };
      }
    }
  };
}

function fakeLeadPrisma() {
  const rows: Array<Record<string, unknown>> = [];
  let counter = 0;
  return {
    rows,
    travelLead: {
      findUnique: async ({ where }: { where: { idempotencyKey?: string } }) =>
        rows.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.idempotencyKey && rows.some((row) => row.idempotencyKey === data.idempotencyKey))
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "6.19.3",
            meta: { target: ["idempotency_key"] }
          });
        counter += 1;
        const row = { id: `lead-${counter}`, ...data };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        Object.assign(row as object, data);
        return row;
      }
    }
  };
}

function matchesWorkflow(row: WorkflowExecution, where: Record<string, unknown>): boolean {
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

function harness() {
  const workflowPrisma = fakeWorkflowPrisma();
  const leadPrisma = fakeLeadPrisma();
  const workflows = new WorkflowExecutionService(workflowPrisma as unknown as PrismaService);
  const travelLeadService = new TravelLeadService(leadPrisma as unknown as PrismaService, new LeadService(leadPrisma as unknown as PrismaService));
  const service = new TripSubmissionWorkflowService(workflows, travelLeadService);
  return { service, workflows, travelLeadService, workflowPrisma, leadPrisma };
}

describe("TripSubmissionWorkflowService.shouldStart", () => {
  const { service } = harness();

  it("starts on a booking confirmation once an itinerary has been presented (was confirm_booking_lead_capture)", () => {
    expect(service.shouldStart("yes, please confirm", { ...NO_SIGNALS, itineraryPresented: true })).toBe(
      "CONFIRM_SUBMISSION"
    );
  });

  it("does not start on a booking confirmation before any itinerary was presented", () => {
    expect(service.shouldStart("yes, please confirm", NO_SIGNALS)).toBe("NONE");
  });

  it("starts on a volunteered contact value once a trip is already in progress (was CONFIRM_STANDALONE_CONTACT_USE)", () => {
    expect(service.shouldStart("8380031193", { ...NO_SIGNALS, hasActiveTripContext: true })).toBe(
      "STANDALONE_CONTACT"
    );
  });

  it("does not start on a bare contact value with no active trip context", () => {
    expect(service.shouldStart("8380031193", NO_SIGNALS)).toBe("NONE");
  });

  it("never starts while the legacy engine already has its own pending contact question in flight (e.g. BELOW_MINIMUM)", () => {
    expect(
      service.shouldStart("8380031193", {
        ...NO_SIGNALS,
        hasActiveTripContext: true,
        legacyPendingInputAction: "AWAITING_LEAD_CONTACT"
      })
    ).toBe("NONE");
    expect(
      service.shouldStart("yes, please confirm", {
        ...NO_SIGNALS,
        itineraryPresented: true,
        legacyCompletionStage: "AWAITING_CONTACT"
      })
    ).toBe("NONE");
  });

  it("does not start on an unrelated message", () => {
    expect(service.shouldStart("plan a trip to Dubai", NO_SIGNALS)).toBe("NONE");
  });

  it("never starts on a volunteered email/phone while Travel Runtime's own booking-options/ticket-contact/resend flow owns the turn (real UAT regression: an email typed at the ticket-contact prompt was hijacked into a TRIP_SUBMISSION lead instead of being read as delivery contact)", () => {
    for (const pendingAction of [
      "AWAITING_OPTION_SELECTION",
      "AWAITING_PASSENGER_DETAILS",
      "AWAITING_TICKET_CONTACT",
      "AWAITING_BOOKING_CONFIRMATION",
      "AWAITING_RESEND_TICKET_DETAILS"
    ]) {
      expect(
        service.shouldStart("krishna@example.com", {
          ...NO_SIGNALS,
          hasActiveTripContext: true,
          legacyPendingAction: pendingAction
        })
      ).toBe("NONE");
    }
  });
});

describe("TripSubmissionWorkflowService: starting via CONFIRM_SUBMISSION", () => {
  it("asks for a mobile number when the confirming message has no contact value", async () => {
    const { service, workflows } = harness();
    const result = await service.start(scope, "turn-1", TRIP_CONTEXT, "CONFIRM_SUBMISSION", "yes, please confirm");
    expect(result.decision).toBe("ASK_FOR_INPUT");
    expect(result.responseText).toMatch(/mobile number/i);
    await expect(workflows.findActiveWorkflow(scope)).resolves.toMatchObject({
      status: "WAITING_FOR_INPUT",
      pendingInput: "MOBILE_NUMBER"
    });
  });

  it("submits immediately when the confirming message already contains a phone number", async () => {
    const { service, workflows, leadPrisma } = harness();
    const result = await service.start(
      scope,
      "turn-1",
      TRIP_CONTEXT,
      "CONFIRM_SUBMISSION",
      "yes confirm, my number is +919876543210"
    );
    expect(result.decision).toBe("COMPLETE");
    expect(result.responseText).toMatch(/submitted successfully/i);
    expect(result.leadCreated?.phoneNumber).toBe("+919876543210");
    expect(leadPrisma.rows).toHaveLength(1);
    await expect(workflows.findActiveWorkflow(scope)).resolves.toBeNull();
  });
});

describe("TripSubmissionWorkflowService: starting via BELOW_MINIMUM_BUDGET (Stage 9E signal-based start)", () => {
  it("asks for a mobile number when the triggering budget message has no contact value", async () => {
    const { service, workflows } = harness();
    const result = await service.start(scope, "turn-1", TRIP_CONTEXT, "BELOW_MINIMUM_BUDGET", "1000 USD");
    expect(result.decision).toBe("ASK_FOR_INPUT");
    expect(result.responseText).toMatch(/mobile number/i);
    await expect(workflows.findActiveWorkflow(scope)).resolves.toMatchObject({
      status: "WAITING_FOR_INPUT",
      pendingInput: "MOBILE_NUMBER"
    });
  });

  it("submits immediately when the same budget message also contains a phone number", async () => {
    const { service, leadPrisma } = harness();
    const result = await service.start(
      scope,
      "turn-1",
      TRIP_CONTEXT,
      "BELOW_MINIMUM_BUDGET",
      "1000 USD, call me at 9876543210"
    );
    expect(result.decision).toBe("COMPLETE");
    expect(result.leadCreated?.phoneNumber).toBe("9876543210");
    expect(leadPrisma.rows).toHaveLength(1);
  });
});

describe("TripSubmissionWorkflowService.migrateFromLegacyState (Stage 9E historical translation)", () => {
  it("creates a workflow WAITING_FOR_INPUT/MOBILE_NUMBER for a legacy AWAITING_LEAD_CONTACT conversation, generating no response text", async () => {
    const { service, workflows } = harness();
    const execution = await service.migrateFromLegacyState(
      scope,
      "turn-1:historical-migration",
      "AWAITING_LEAD_CONTACT",
      TRIP_CONTEXT
    );
    expect(execution.status).toBe("WAITING_FOR_INPUT");
    expect(execution.pendingInput).toBe("MOBILE_NUMBER");
    await expect(workflows.findActiveWorkflow(scope)).resolves.toMatchObject({ id: execution.id });
  });

  it("creates a workflow WAITING_FOR_INPUT/CONFIRM_CONTACT_USE for a legacy CONFIRM_STANDALONE_CONTACT_USE conversation, carrying forward the volunteered contact value", async () => {
    const { service } = harness();
    const execution = await service.migrateFromLegacyState(
      scope,
      "turn-1:historical-migration",
      "CONFIRM_STANDALONE_CONTACT_USE",
      TRIP_CONTEXT,
      "8380031193"
    );
    expect(execution.status).toBe("WAITING_FOR_INPUT");
    expect(execution.pendingInput).toBe("CONFIRM_CONTACT_USE");
    expect((execution.state as { contactValue: string | null }).contactValue).toBe("8380031193");
  });

  it("resuming a migrated CONFIRM_STANDALONE_CONTACT_USE workflow with a confirmation completes using the carried-forward contact value", async () => {
    const { service } = harness();
    const migrated = await service.migrateFromLegacyState(
      scope,
      "turn-1:historical-migration",
      "CONFIRM_STANDALONE_CONTACT_USE",
      TRIP_CONTEXT,
      "8380031193"
    );
    const result = await service.resume(migrated, "yes, create the enquiry", "turn-1", TRIP_CONTEXT);
    expect(result.decision).toBe("COMPLETE");
    expect(result.leadCreated?.phoneNumber).toBe("8380031193");
  });

  it("without a carried-forward contact value, resuming a migrated CONFIRM_STANDALONE_CONTACT_USE workflow defers rather than guessing", async () => {
    const { service } = harness();
    const migrated = await service.migrateFromLegacyState(
      scope,
      "turn-1:historical-migration",
      "CONFIRM_STANDALONE_CONTACT_USE",
      TRIP_CONTEXT
    );
    const result = await service.resume(migrated, "yes, create the enquiry", "turn-1", TRIP_CONTEXT);
    expect(result.decision).toBe("DEFER");
    expect(result.responseText).toBeNull();
    expect(result.status).toBe("WAITING_FOR_INPUT");
  });

  it("is idempotent: a second concurrent migration attempt reuses the same row instead of creating a duplicate", async () => {
    const { service, workflowPrisma } = harness();
    const first = await service.migrateFromLegacyState(
      scope,
      "turn-1:historical-migration",
      "AWAITING_LEAD_CONTACT",
      TRIP_CONTEXT
    );
    const second = await service.migrateFromLegacyState(
      scope,
      "turn-2:historical-migration",
      "AWAITING_LEAD_CONTACT",
      TRIP_CONTEXT
    );
    expect(second.id).toBe(first.id);
    expect(workflowPrisma.rows).toHaveLength(1);
  });

  it("the migrated workflow can be resumed with the SAME turn's text immediately afterward, without the migration's own turnId causing a false idempotent-replay", async () => {
    const { service } = harness();
    const migrated = await service.migrateFromLegacyState(
      scope,
      "turn-1:historical-migration",
      "AWAITING_LEAD_CONTACT",
      TRIP_CONTEXT
    );
    const result = await service.resume(migrated, "8380031193", "turn-1", TRIP_CONTEXT);
    expect(result.decision).toBe("COMPLETE");
    expect(result.leadCreated?.phoneNumber).toBe("8380031193");
  });
});

describe("TripSubmissionWorkflowService: starting via STANDALONE_CONTACT", () => {
  it("asks before using the volunteered number, mentioning the route, without creating a lead yet", async () => {
    const { service, workflows, leadPrisma } = harness();
    const result = await service.start(scope, "turn-1", TRIP_CONTEXT, "STANDALONE_CONTACT", "8380031193");
    expect(result.decision).toBe("ASK_FOR_INPUT");
    expect(result.responseText).toMatch(/looks like a mobile number/i);
    expect(result.responseText).toMatch(/Delhi-to-London trip/i);
    expect(leadPrisma.rows).toHaveLength(0);
    await expect(workflows.findActiveWorkflow(scope)).resolves.toMatchObject({
      status: "WAITING_FOR_INPUT",
      pendingInput: "CONFIRM_CONTACT_USE"
    });
  });
});

describe("TripSubmissionWorkflowService: resuming", () => {
  it("creates the lead and completes on a valid phone number reply", async () => {
    const { service, workflows, leadPrisma } = harness();
    await service.start(scope, "turn-1", TRIP_CONTEXT, "CONFIRM_SUBMISSION", "yes, please confirm");
    const execution = must(await workflows.findActiveWorkflow(scope));

    const result = await service.resume(execution, "8380031193", "turn-2", TRIP_CONTEXT);

    expect(result.decision).toBe("COMPLETE");
    expect(result.responseText).toMatch(/submitted successfully/i);
    expect(result.responseText).toContain(result.leadCreated?.reference);
    expect(leadPrisma.rows).toHaveLength(1);
    await expect(workflows.findActiveWorkflow(scope)).resolves.toBeNull();
  });

  it("rejects a phone-shaped invalid attempt, remains WAITING_FOR_INPUT, creates no lead", async () => {
    const { service, workflows, leadPrisma } = harness();
    await service.start(scope, "turn-1", TRIP_CONTEXT, "CONFIRM_SUBMISSION", "yes, please confirm");
    const execution = must(await workflows.findActiveWorkflow(scope));

    const result = await service.resume(execution, "0000000000", "turn-2", TRIP_CONTEXT);

    expect(result.decision).toBe("ASK_FOR_INPUT");
    expect(result.responseText).toMatch(/valid mobile number/i);
    expect(leadPrisma.rows).toHaveLength(0);
    await expect(workflows.findActiveWorkflow(scope)).resolves.toMatchObject({ status: "WAITING_FOR_INPUT" });
  });

  it("keeps the workflow pending through a farewell/thanks reply while awaiting contact", async () => {
    const { service, workflows } = harness();
    await service.start(scope, "turn-1", TRIP_CONTEXT, "CONFIRM_SUBMISSION", "yes, please confirm");
    const execution = must(await workflows.findActiveWorkflow(scope));

    const result = await service.resume(execution, "okay thank you", "turn-2", TRIP_CONTEXT);

    expect(result.decision).toBe("ASK_FOR_INPUT");
    expect(result.responseText).toMatch(/whenever you're ready/i);
    expect(result.responseText).not.toMatch(/doesn't look like a valid mobile/i);
    await expect(workflows.findActiveWorkflow(scope)).resolves.toMatchObject({ status: "WAITING_FOR_INPUT" });
  });

  it("Stage 9E.1: defers an unrelated semantic detour (e.g. a policy question) instead of misreading it as a contact reply or re-asking", async () => {
    const { service, workflows } = harness();
    await service.start(scope, "turn-1", TRIP_CONTEXT, "CONFIRM_SUBMISSION", "yes, please confirm");
    const before = must(await workflows.findActiveWorkflow(scope));

    const result = await service.resume(before, "what documents are needed for a Singapore visa?", "turn-2", TRIP_CONTEXT);

    expect(result.decision).toBe("DEFER");
    expect(result.responseText).toBeNull();
    expect(result.status).toBe("WAITING_FOR_INPUT");
    expect(result.leadCreated).toBeNull();
    // No persistence write happened at all — same revision, same pendingInput, still active.
    const after = must(await workflows.findActiveWorkflow(scope));
    expect(after.revision).toBe(before.revision);
    expect(after.pendingInput).toBe("MOBILE_NUMBER");

    // The deferred turn does not consume the workflow: a genuine phone number on the NEXT turn still
    // completes it normally.
    const completed = await service.resume(after, "8380031193", "turn-3", TRIP_CONTEXT);
    expect(completed.decision).toBe("COMPLETE");
    expect(completed.leadCreated?.phoneNumber).toBe("8380031193");
  });

  it("declines gracefully on a clear negative reply — cancels, no lead, audit row preserved", async () => {
    const { service, workflows, leadPrisma } = harness();
    await service.start(scope, "turn-1", TRIP_CONTEXT, "CONFIRM_SUBMISSION", "yes, please confirm");
    const execution = must(await workflows.findActiveWorkflow(scope));

    const result = await service.resume(execution, "no, not interested", "turn-2", TRIP_CONTEXT);

    expect(result.decision).toBe("CANCELLED");
    expect(leadPrisma.rows).toHaveLength(0);
    await expect(workflows.findActiveWorkflow(scope)).resolves.toBeNull();
  });

  it("completes the lead on an explicit confirmation to use a volunteered contact (STANDALONE_CONTACT_CONFIRMED)", async () => {
    const { service, workflows, leadPrisma } = harness();
    await service.start(scope, "turn-1", TRIP_CONTEXT, "STANDALONE_CONTACT", "8380031193");
    const execution = must(await workflows.findActiveWorkflow(scope));

    const result = await service.resume(execution, "yes, create the enquiry", "turn-2", TRIP_CONTEXT);

    expect(result.decision).toBe("COMPLETE");
    expect(result.leadCreated?.phoneNumber).toBe("8380031193");
    expect(leadPrisma.rows).toHaveLength(1);
  });

  it("declines the standalone-contact confirmation on a clear negative reply", async () => {
    const { service, workflows, leadPrisma } = harness();
    await service.start(scope, "turn-1", TRIP_CONTEXT, "STANDALONE_CONTACT", "8380031193");
    const execution = must(await workflows.findActiveWorkflow(scope));

    const result = await service.resume(execution, "no thanks", "turn-2", TRIP_CONTEXT);

    expect(result.decision).toBe("CANCELLED");
    expect(leadPrisma.rows).toHaveLength(0);
  });

  it("retry/idempotency: processing the exact same phone turn twice creates exactly one lead", async () => {
    const { service, workflows, leadPrisma } = harness();
    await service.start(scope, "turn-1", TRIP_CONTEXT, "CONFIRM_SUBMISSION", "yes, please confirm");
    const execution = must(await workflows.findActiveWorkflow(scope));
    const staleSnapshot = structuredClone(execution);

    const first = await service.resume(execution, "8380031193", "duplicate-turn", TRIP_CONTEXT);
    const second = await service.resume(staleSnapshot, "8380031193", "duplicate-turn", TRIP_CONTEXT);

    expect(first.leadCreated).not.toBeNull();
    expect(second.leadCreated).toBeNull();
    expect(leadPrisma.rows).toHaveLength(1);
    expect(second.responseText).toBe(first.responseText);
  });

  it("restart durability: a freshly constructed service resumes a workflow persisted by a previous instance", async () => {
    const { workflowPrisma, leadPrisma } = harness();
    const workflowsA = new WorkflowExecutionService(workflowPrisma as unknown as PrismaService);
    const leadServiceA = new TravelLeadService(leadPrisma as unknown as PrismaService, new LeadService(leadPrisma as unknown as PrismaService));
    const serviceA = new TripSubmissionWorkflowService(workflowsA, leadServiceA);
    await serviceA.start(scope, "turn-1", TRIP_CONTEXT, "CONFIRM_SUBMISSION", "yes, please confirm");

    const workflowsB = new WorkflowExecutionService(workflowPrisma as unknown as PrismaService);
    const leadServiceB = new TravelLeadService(leadPrisma as unknown as PrismaService, new LeadService(leadPrisma as unknown as PrismaService));
    const serviceB = new TripSubmissionWorkflowService(workflowsB, leadServiceB);
    const active = must(await workflowsB.findActiveWorkflow(scope));
    const result = await serviceB.resume(active, "8380031193", "turn-2", TRIP_CONTEXT);

    expect(result.decision).toBe("COMPLETE");
    expect(result.responseText).toMatch(/submitted successfully/i);
  });
});

describe("TripSubmissionWorkflowService.cancelIfBelowMinimumTriggerResolved (Stage 9F trigger re-evaluation)", () => {
  it("cancels a WAITING_FOR_INPUT workflow whose trigger was BELOW_MINIMUM_BUDGET", async () => {
    const { service, workflows } = harness();
    await service.start(scope, "turn-1", TRIP_CONTEXT, "BELOW_MINIMUM_BUDGET", "1000 USD");
    const execution = must(await workflows.findActiveWorkflow(scope));

    const cancelled = await service.cancelIfBelowMinimumTriggerResolved(execution);

    expect(cancelled).toBe(true);
    await expect(workflows.findActiveWorkflow(scope)).resolves.toBeNull();
  });

  it("never cancels a workflow started by an explicit CONFIRM_SUBMISSION request", async () => {
    const { service, workflows } = harness();
    await service.start(scope, "turn-1", TRIP_CONTEXT, "CONFIRM_SUBMISSION", "yes, please confirm");
    const execution = must(await workflows.findActiveWorkflow(scope));

    const cancelled = await service.cancelIfBelowMinimumTriggerResolved(execution);

    expect(cancelled).toBe(false);
    await expect(workflows.findActiveWorkflow(scope)).resolves.toMatchObject({ status: "WAITING_FOR_INPUT" });
  });

  it("never cancels a workflow started by an explicit STANDALONE_CONTACT request", async () => {
    const { service, workflows } = harness();
    await service.start(scope, "turn-1", TRIP_CONTEXT, "STANDALONE_CONTACT", "8380031193");
    const execution = must(await workflows.findActiveWorkflow(scope));

    const cancelled = await service.cancelIfBelowMinimumTriggerResolved(execution);

    expect(cancelled).toBe(false);
  });

  it("never cancels an unknown-provenance migrated workflow (safe default: don't auto-cancel)", async () => {
    const { service } = harness();
    const migrated = await service.migrateFromLegacyState(
      scope,
      "turn-1:historical-migration",
      "AWAITING_LEAD_CONTACT",
      TRIP_CONTEXT
    );

    const cancelled = await service.cancelIfBelowMinimumTriggerResolved(migrated);

    expect(cancelled).toBe(false);
  });

  it("never cancels an already-completed workflow", async () => {
    const { service, workflows } = harness();
    await service.start(scope, "turn-1", TRIP_CONTEXT, "BELOW_MINIMUM_BUDGET", "1000 USD");
    const waiting = must(await workflows.findActiveWorkflow(scope));
    await service.resume(waiting, "8380031193", "turn-2", TRIP_CONTEXT);

    const completed = await workflows.loadWorkflow(scope.organizationId, waiting.id);
    const cancelled = await service.cancelIfBelowMinimumTriggerResolved(must(completed));

    expect(cancelled).toBe(false);
  });
});
