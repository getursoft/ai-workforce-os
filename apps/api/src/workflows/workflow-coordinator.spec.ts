import { Logger } from "@nestjs/common";
import { Prisma, type WorkflowExecution } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { TravelLeadService } from "../travel/travel-lead.service";
import { EMPTY_TRAVEL_ENTITIES } from "../travel/travel.runtime";
import { BookingHandoffWorkflowService } from "./booking-handoff/booking-handoff.service";
import type { BookingHandoffTripContext } from "./booking-handoff/booking-handoff.types";
import { ContactCaptureWorkflowService } from "./contact-capture/contact-capture.service";
import type { ContactCaptureStartSignals, ContactCaptureTripContext } from "./contact-capture/contact-capture.types";
import { TripSubmissionWorkflowService } from "./trip-submission/trip-submission.service";
import type { TripSubmissionStartSignals, TripSubmissionTripContext } from "./trip-submission/trip-submission.types";
import { WorkflowExecutionService } from "./workflow-execution.service";
import { detectWorkflowCancellationPhrase, WorkflowCoordinator } from "./workflow-coordinator";
import type { WorkflowSignal } from "./workflow-signal.contracts";

const SCOPE = { organizationId: "org-1", pluginInstallationId: "plugin-1", conversationId: "conversation-1" };

const NO_SIGNALS: ContactCaptureStartSignals = {
  providerFailure: null,
  completionStage: null
};

const CONTACT_TRIP_CONTEXT: ContactCaptureTripContext = {
  originCity: "Delhi",
  destinationCity: "Dubai",
  travelDates: "17 August 2026",
  passengers: "5",
  tripPurpose: null,
  budgetAmount: 500000,
  budgetCurrency: "INR",
  displayCurrency: "INR",
  journeyId: null,
  customerName: null
};

const BOOKING_TRIP_CONTEXT: BookingHandoffTripContext = {
  originCity: "Delhi",
  destinationCity: "Dubai",
  travelDates: "17 August 2026",
  skillExecutionId: "skill-execution-1",
  journeyId: null
};

const TRIP_STATE = { ...EMPTY_TRAVEL_ENTITIES, originCity: "Delhi", destinationCity: "Dubai" };

const NO_TRIP_SUBMISSION_SIGNALS: TripSubmissionStartSignals = {
  legacyPendingInputAction: null,
  legacyCompletionStage: null,
  itineraryPresented: false,
  hasActiveTripContext: false,
  tripState: TRIP_STATE,
  legacyPendingContactValue: null,
  legacyPendingAction: null
};

const TRIP_SUBMISSION_TRIP_CONTEXT: TripSubmissionTripContext = {
  entities: TRIP_STATE,
  responseLanguage: "ENGLISH",
  travelDates: "17 August 2026",
  passengers: "5",
  tripPurpose: null,
  budgetAmount: 500000,
  budgetCurrency: "INR",
  displayCurrency: "INR",
  journeyId: null,
  customerName: null
};

function fakePrisma() {
  const workflowRows: WorkflowExecution[] = [];
  const leadRows: Array<Record<string, unknown>> = [];
  let leadCounter = 0;
  return {
    workflowRows,
    leadRows,
    workflowExecution: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        workflowRows.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        workflowRows.filter((row) => matches(row, where)),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (workflowRows.some((row) => row.activeKey === data.activeKey))
          throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "6.19.3" });
        const now = new Date();
        const row = { id: `workflow-${workflowRows.length + 1}`, completedAt: null, createdAt: now, updatedAt: now, ...data } as WorkflowExecution;
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

function harness() {
  const prisma = fakePrisma();
  const workflows = new WorkflowExecutionService(prisma as unknown as PrismaService);
  const travelLeadService = new TravelLeadService(prisma as unknown as PrismaService);
  const contactCapture = new ContactCaptureWorkflowService(workflows, travelLeadService);
  const bookingHandoff = new BookingHandoffWorkflowService(workflows);
  const tripSubmission = new TripSubmissionWorkflowService(workflows, travelLeadService);
  const coordinator = new WorkflowCoordinator(workflows, contactCapture, bookingHandoff, tripSubmission);
  const signals = (
    overrides: Partial<ContactCaptureStartSignals> = {},
    tripSubmissionOverrides: Partial<TripSubmissionStartSignals> = {}
  ) => ({
    contactCapture: { ...NO_SIGNALS, ...overrides },
    contactCaptureTripContext: CONTACT_TRIP_CONTEXT,
    bookingHandoffTripContext: BOOKING_TRIP_CONTEXT,
    tripSubmission: { ...NO_TRIP_SUBMISSION_SIGNALS, ...tripSubmissionOverrides },
    tripSubmissionTripContext: TRIP_SUBMISSION_TRIP_CONTEXT
  });
  return { coordinator, workflows, contactCapture, bookingHandoff, tripSubmission, prisma, signals };
}

describe("detectWorkflowCancellationPhrase", () => {
  it.each(["cancel", "Cancel.", "stop", "never mind", "nevermind", "don't contact me", "do not contact me"])(
    "recognizes %j as a cancellation",
    (text) => {
      expect(detectWorkflowCancellationPhrase(text)).toBe(true);
    }
  );

  it.each(["cancel my hotel room, not the trip", "please stop searching for flights below my budget", "8380031193"])(
    "does not misclassify an unrelated travel correction as a cancellation: %j",
    (text) => {
      expect(detectWorkflowCancellationPhrase(text)).toBe(false);
    }
  );
});

describe("WorkflowCoordinator.dispatchTurn: starting and resuming CONTACT_CAPTURE", () => {
  it("starts CONTACT_CAPTURE from an explicit callback phrase and returns handled:true", async () => {
    const { coordinator, signals } = harness();
    const outcome = await coordinator.dispatchTurn(SCOPE, "callback", "turn-1", signals());
    expect(outcome.handled).toBe(true);
    expect(outcome.workflowType).toBe("CONTACT_CAPTURE");
    expect(outcome.decision).toBe("ASK_FOR_INPUT");
  });

  it("does not start any workflow for an unrelated message", async () => {
    const { coordinator, signals } = harness();
    const outcome = await coordinator.dispatchTurn(SCOPE, "plan a trip to Dubai", "turn-1", signals());
    expect(outcome.handled).toBe(false);
  });

  it("duplicate callback requests resume the existing workflow rather than creating a second row", async () => {
    const { coordinator, prisma, signals } = harness();
    await coordinator.dispatchTurn(SCOPE, "callback", "turn-1", signals());
    await coordinator.dispatchTurn(SCOPE, "callback", "turn-2", signals());
    expect(prisma.workflowRows).toHaveLength(1);
  });

  it("completes CONTACT_CAPTURE and reports the created lead for the caller's CRM-sync side effect", async () => {
    const { coordinator, signals } = harness();
    await coordinator.dispatchTurn(SCOPE, "callback", "turn-1", signals());
    const outcome = await coordinator.dispatchTurn(SCOPE, "8380031193", "turn-2", signals());
    expect(outcome.decision).toBe("COMPLETE");
    expect(outcome.leadCreated).not.toBeNull();
    expect(outcome.leadCreated?.phoneNumber).toBe("8380031193");
  });
});

describe("WorkflowCoordinator.dispatchTurn: priority — an active waiting workflow always owns the turn", () => {
  it("a phone number submitted during CONTACT_CAPTURE is never routed to a new workflow start", async () => {
    const { coordinator, signals } = harness();
    await coordinator.dispatchTurn(SCOPE, "callback", "turn-1", signals());
    const outcome = await coordinator.dispatchTurn(SCOPE, "8380031193", "turn-2", signals());
    expect(outcome.workflowType).toBe("CONTACT_CAPTURE");
    expect(outcome.decision).not.toBe("NOT_APPLICABLE");
  });

  it("BOOKING_HANDOFF, once active and waiting, is never bypassed by a callback-style message in the same turn", async () => {
    const { coordinator, workflows, signals } = harness();
    await coordinator.startBookingHandoff(SCOPE, "turn-1", BOOKING_TRIP_CONTEXT);
    const outcome = await coordinator.dispatchTurn(SCOPE, "callback", "turn-2", signals());
    expect(outcome.workflowType).toBe("BOOKING_HANDOFF");
    expect(outcome.decision).toBe("ASK_FOR_INPUT");
    await expect(
      workflows.findActiveWorkflow({ ...SCOPE, workflowType: "CONTACT_CAPTURE" })
    ).resolves.toBeNull();
  });
});

describe("WorkflowCoordinator.startBookingHandoff", () => {
  it("starts BOOKING_HANDOFF and preserves an already-active CONTACT_CAPTURE workflow instead of overwriting it", async () => {
    const { coordinator, signals } = harness();
    await coordinator.dispatchTurn(SCOPE, "callback", "turn-1", signals());
    const outcome = await coordinator.startBookingHandoff(SCOPE, "turn-2", BOOKING_TRIP_CONTEXT);
    expect(outcome).toBeNull();
  });

  it("starts BOOKING_HANDOFF cleanly when no workflow is active", async () => {
    const { coordinator } = harness();
    const outcome = await coordinator.startBookingHandoff(SCOPE, "turn-1", BOOKING_TRIP_CONTEXT);
    expect(outcome?.handled).toBe(true);
    expect(outcome?.workflowType).toBe("BOOKING_HANDOFF");
    expect(outcome?.decision).toBe("ASK_FOR_INPUT");
  });
});

describe("WorkflowCoordinator.dispatchTurn: cancellation", () => {
  it("cancels an active CONTACT_CAPTURE workflow, releases activeKey, creates no lead, and returns a truthful confirmation", async () => {
    const { coordinator, workflows, prisma, signals } = harness();
    await coordinator.dispatchTurn(SCOPE, "callback", "turn-1", signals());
    const outcome = await coordinator.dispatchTurn(SCOPE, "don't contact me", "turn-2", signals());

    expect(outcome.decision).toBe("CANCELLED");
    expect(outcome.responseText).toMatch(/won't ask for your contact details/i);
    expect(prisma.leadRows).toHaveLength(0);
    await expect(
      workflows.findActiveWorkflow({ ...SCOPE, workflowType: "CONTACT_CAPTURE" })
    ).resolves.toBeNull();
    const row = prisma.workflowRows[0];
    expect(row?.status).toBe("CANCELLED");
    expect(row?.activeKey).toBeNull();
    // Audit-safe: the row itself still exists, it is not deleted.
    expect(prisma.workflowRows).toHaveLength(1);
  });

  it("a normal travel request after cancellation is free to proceed (not handled by the coordinator)", async () => {
    const { coordinator, signals } = harness();
    await coordinator.dispatchTurn(SCOPE, "callback", "turn-1", signals());
    await coordinator.dispatchTurn(SCOPE, "don't contact me", "turn-2", signals());
    const outcome = await coordinator.dispatchTurn(SCOPE, "plan a trip to Goa instead", "turn-3", signals());
    expect(outcome.handled).toBe(false);
  });
});

describe("WorkflowCoordinator.dispatchTurn: starting and resuming TRIP_SUBMISSION", () => {
  it("starts TRIP_SUBMISSION from a booking confirmation once an itinerary has been presented", async () => {
    const { coordinator, signals } = harness();
    const outcome = await coordinator.dispatchTurn(
      SCOPE,
      "yes, please confirm",
      "turn-1",
      signals({}, { itineraryPresented: true })
    );
    expect(outcome.handled).toBe(true);
    expect(outcome.workflowType).toBe("TRIP_SUBMISSION");
    expect(outcome.decision).toBe("ASK_FOR_INPUT");
  });

  it("starts TRIP_SUBMISSION from a volunteered contact value and completes it on confirmation", async () => {
    const { coordinator, signals } = harness();
    const started = await coordinator.dispatchTurn(
      SCOPE,
      "8380031193",
      "turn-1",
      signals({}, { hasActiveTripContext: true })
    );
    expect(started.workflowType).toBe("TRIP_SUBMISSION");
    expect(started.decision).toBe("ASK_FOR_INPUT");

    const confirmed = await coordinator.dispatchTurn(
      SCOPE,
      "yes, create the enquiry",
      "turn-2",
      signals({}, { hasActiveTripContext: true })
    );
    expect(confirmed.decision).toBe("COMPLETE");
    expect(confirmed.leadCreated).not.toBeNull();
  });

  it("a phone number submitted during CONTACT_CAPTURE is never routed to TRIP_SUBMISSION", async () => {
    const { coordinator, signals } = harness();
    await coordinator.dispatchTurn(SCOPE, "callback", "turn-1", signals());
    const outcome = await coordinator.dispatchTurn(
      SCOPE,
      "8380031193",
      "turn-2",
      signals({}, { hasActiveTripContext: true })
    );
    expect(outcome.workflowType).toBe("CONTACT_CAPTURE");
  });

  it("does not start a NEW TRIP_SUBMISSION signal-derived trigger while the legacy engine already has its own pending contact question in flight (it migrates instead — see historical state translation below)", async () => {
    const { coordinator, signals } = harness();
    const outcome = await coordinator.dispatchTurn(
      SCOPE,
      "8380031193",
      "turn-1",
      signals({}, { hasActiveTripContext: true, legacyPendingInputAction: "AWAITING_LEAD_CONTACT" })
    );
    // Stage 9E: this conversation's legacy pendingInputAction is translated into a real TRIP_SUBMISSION
    // workflow, then immediately resumed with this same turn's phone number — see the migration describe
    // block below for dedicated coverage of the translation step itself.
    expect(outcome.handled).toBe(true);
    expect(outcome.workflowType).toBe("TRIP_SUBMISSION");
    expect(outcome.decision).toBe("COMPLETE");
    expect(outcome.leadCreated).not.toBeNull();
  });
});

describe("WorkflowCoordinator.dispatchTurn: Stage 9E historical state migration", () => {
  it("Stage 9E.1 runtime-authority guarantee: legacy pending-contact memory NEVER triggers migration (or otherwise overrides) while a real workflow is already active for the conversation, even a DIFFERENT workflow type", async () => {
    const { coordinator, prisma, signals } = harness();
    await coordinator.dispatchTurn(SCOPE, "callback", "turn-1", signals());
    expect(prisma.workflowRows).toHaveLength(1);
    expect(prisma.workflowRows[0]?.workflowType).toBe("CONTACT_CAPTURE");

    // Legacy memory says BELOW_MINIMUM-style contact state exists too — must be completely ignored while
    // CONTACT_CAPTURE already owns this conversation; no migration, no second workflow, no state change.
    const outcome = await coordinator.dispatchTurn(
      SCOPE,
      "some unrelated reply",
      "turn-2",
      signals({}, { legacyPendingInputAction: "AWAITING_LEAD_CONTACT" })
    );
    expect(outcome.handled).toBe(true);
    expect(outcome.workflowType).toBe("CONTACT_CAPTURE");
    expect(prisma.workflowRows).toHaveLength(1);
    expect(prisma.workflowRows.some((row) => row.workflowType === "TRIP_SUBMISSION")).toBe(false);
  });

  it("migrates a legacy AWAITING_LEAD_CONTACT conversation into a real TRIP_SUBMISSION workflow and resumes it with this turn's text, creating exactly one workflow row", async () => {
    const { coordinator, prisma, signals } = harness();
    const outcome = await coordinator.dispatchTurn(
      SCOPE,
      "8380031193",
      "turn-1",
      signals({}, { legacyPendingInputAction: "AWAITING_LEAD_CONTACT" })
    );
    expect(outcome.handled).toBe(true);
    expect(outcome.workflowType).toBe("TRIP_SUBMISSION");
    expect(outcome.decision).toBe("COMPLETE");
    expect(outcome.leadCreated?.phoneNumber).toBe("8380031193");
    expect(prisma.workflowRows).toHaveLength(1);
    expect(prisma.workflowRows[0]?.status).toBe("COMPLETED");
  });

  it("migrates a legacy CONFIRM_STANDALONE_CONTACT_USE conversation (carrying forward the volunteered contact value) and resumes it as the standalone-confirm step", async () => {
    const { coordinator, prisma, signals } = harness();
    const outcome = await coordinator.dispatchTurn(
      SCOPE,
      "yes, create the enquiry",
      "turn-1",
      signals(
        {},
        { legacyPendingInputAction: "CONFIRM_STANDALONE_CONTACT_USE", legacyPendingContactValue: "8380031193" }
      )
    );
    expect(outcome.handled).toBe(true);
    expect(outcome.workflowType).toBe("TRIP_SUBMISSION");
    expect(outcome.decision).toBe("COMPLETE");
    expect(outcome.leadCreated?.phoneNumber).toBe("8380031193");
    expect(prisma.workflowRows).toHaveLength(1);
  });

  it("migrating a legacy CONFIRM_STANDALONE_CONTACT_USE conversation WITHOUT a carried-forward contact value defers rather than incorrectly completing", async () => {
    const { coordinator, signals } = harness();
    const outcome = await coordinator.dispatchTurn(
      SCOPE,
      "yes, create the enquiry",
      "turn-1",
      signals({}, { legacyPendingInputAction: "CONFIRM_STANDALONE_CONTACT_USE" })
    );
    expect(outcome.handled).toBe(false);
  });

  it("migrates a legacy completionStage=AWAITING_CONTACT conversation even without a pendingInputAction", async () => {
    const { coordinator, prisma, signals } = harness();
    const outcome = await coordinator.dispatchTurn(
      SCOPE,
      "8380031193",
      "turn-1",
      signals({}, { legacyCompletionStage: "AWAITING_CONTACT" })
    );
    expect(outcome.handled).toBe(true);
    expect(outcome.workflowType).toBe("TRIP_SUBMISSION");
    expect(prisma.workflowRows).toHaveLength(1);
  });

  it("never migrates twice for the same conversation — a second turn resumes the already-migrated workflow instead of creating another", async () => {
    const { coordinator, prisma, signals } = harness();
    await coordinator.dispatchTurn(
      SCOPE,
      "sorry, one more thing",
      "turn-1",
      signals({}, { legacyPendingInputAction: "AWAITING_LEAD_CONTACT" })
    );
    expect(prisma.workflowRows).toHaveLength(1);
    await coordinator.dispatchTurn(
      SCOPE,
      "8380031193",
      "turn-2",
      signals({}, { legacyPendingInputAction: "AWAITING_LEAD_CONTACT" })
    );
    expect(prisma.workflowRows).toHaveLength(1);
  });

  it("does not migrate when no legacy pending-contact state exists", async () => {
    const { coordinator, prisma, signals } = harness();
    const outcome = await coordinator.dispatchTurn(SCOPE, "plan a trip to Goa", "turn-1", signals());
    expect(outcome.handled).toBe(false);
    expect(prisma.workflowRows).toHaveLength(0);
  });
});

describe("WorkflowCoordinator.dispatchTurn: Stage 9E.1 semantic-detour deferral", () => {
  it("reports handled:false for a DEFER'd turn, leaves the workflow untouched, and the SAME conversation's next relevant turn still completes it", async () => {
    const { coordinator, prisma, signals } = harness();
    await coordinator.dispatchTurn(
      SCOPE,
      "yes, please confirm",
      "turn-1",
      signals({}, { itineraryPresented: true })
    );
    const beforeRow = prisma.workflowRows[0];
    expect(beforeRow?.status).toBe("WAITING_FOR_INPUT");

    const deferred = await coordinator.dispatchTurn(
      SCOPE,
      "what documents are needed for a Singapore visa?",
      "turn-2",
      signals({}, { itineraryPresented: true })
    );
    expect(deferred.handled).toBe(false);
    expect(prisma.workflowRows).toHaveLength(1);
    expect(prisma.workflowRows[0]?.revision).toBe(beforeRow?.revision);
    expect(prisma.workflowRows[0]?.status).toBe("WAITING_FOR_INPUT");

    const completed = await coordinator.dispatchTurn(
      SCOPE,
      "8380031193",
      "turn-3",
      signals({}, { itineraryPresented: true })
    );
    expect(completed.decision).toBe("COMPLETE");
    expect(completed.leadCreated).not.toBeNull();
  });

  it("a deferred turn never starts a conflicting second workflow for the same conversation", async () => {
    const { coordinator, prisma, signals } = harness();
    await coordinator.dispatchTurn(SCOPE, "yes, please confirm", "turn-1", signals({}, { itineraryPresented: true }));

    // "callback" would normally start CONTACT_CAPTURE from free text — it must not, because TRIP_SUBMISSION
    // still owns this conversation even though it just deferred a turn.
    const deferred = await coordinator.dispatchTurn(SCOPE, "callback", "turn-2", signals({}, { itineraryPresented: true }));
    expect(deferred.handled).toBe(false);
    expect(prisma.workflowRows.filter((row) => row.status !== "CANCELLED")).toHaveLength(1);
    expect(prisma.workflowRows[0]?.workflowType).toBe("TRIP_SUBMISSION");
  });

  it("cancellation still works after a deferred turn", async () => {
    const { coordinator, signals } = harness();
    await coordinator.dispatchTurn(SCOPE, "yes, please confirm", "turn-1", signals({}, { itineraryPresented: true }));
    await coordinator.dispatchTurn(
      SCOPE,
      "what documents are needed for a Singapore visa?",
      "turn-2",
      signals({}, { itineraryPresented: true })
    );
    const cancelled = await coordinator.dispatchTurn(SCOPE, "cancel", "turn-3", signals({}, { itineraryPresented: true }));
    expect(cancelled.decision).toBe("CANCELLED");
  });
});

describe("WorkflowCoordinator.dispatchSignal", () => {
  it("returns null for a NONE signal without touching persistence", async () => {
    const { coordinator, prisma, signals } = harness();
    const outcome = await coordinator.dispatchSignal(
      SCOPE,
      { signalType: "NONE", workflowType: null, source: null, sourceTurnId: "turn-1", sourceSkillExecutionId: null, payload: {}, confidence: 0 },
      "turn-1",
      signals()
    );
    expect(outcome).toBeNull();
    expect(prisma.workflowRows).toHaveLength(0);
  });

  it("starts TRIP_SUBMISSION directly from a typed START_TRIP_SUBMISSION signal (the same mechanism Travel Runtime's BELOW_MINIMUM budget result uses)", async () => {
    const { coordinator, signals } = harness();
    const outcome = await coordinator.dispatchSignal(
      SCOPE,
      {
        signalType: "START_TRIP_SUBMISSION",
        workflowType: "TRIP_SUBMISSION",
        source: "BELOW_MINIMUM_BUDGET_FEASIBILITY",
        sourceTurnId: "turn-1",
        sourceSkillExecutionId: null,
        payload: { trigger: "BELOW_MINIMUM_BUDGET" },
        confidence: 1
      },
      "turn-1",
      signals(),
      "1000 USD"
    );
    expect(outcome?.handled).toBe(true);
    expect(outcome?.workflowType).toBe("TRIP_SUBMISSION");
    expect(outcome?.decision).toBe("ASK_FOR_INPUT");
  });

  it("never overwrites an already-active workflow", async () => {
    const { coordinator, signals } = harness();
    await coordinator.dispatchTurn(SCOPE, "callback", "turn-1", signals());
    const outcome = await coordinator.dispatchSignal(
      SCOPE,
      {
        signalType: "START_TRIP_SUBMISSION",
        workflowType: "TRIP_SUBMISSION",
        source: "BELOW_MINIMUM_BUDGET_FEASIBILITY",
        sourceTurnId: "turn-2",
        sourceSkillExecutionId: null,
        payload: { trigger: "BELOW_MINIMUM_BUDGET" },
        confidence: 1
      },
      "turn-2",
      signals(),
      "1000 USD"
    );
    expect(outcome).toBeNull();
  });
});

describe("WorkflowCoordinator: Stage 9E.1 employee-agnostic signal-provider injection", () => {
  it("an injected custom WorkflowSignalProvider array fully replaces the default registry — proving the coordinator's start-time dispatch is DI-pluggable, not hardcoded", async () => {
    const { workflows, contactCapture, bookingHandoff, tripSubmission, signals } = harness();
    const fixtureProvider = {
      signalType: "START_BOOKING_HANDOFF" as const,
      handler: async () => ({
        handled: true,
        workflowType: "BOOKING_HANDOFF" as const,
        decision: "ASK_FOR_INPUT" as const,
        responseText: "fixture handled this",
        leadCreated: null
      })
    };
    const coordinatorWithCustomProviders = new WorkflowCoordinator(
      workflows,
      contactCapture,
      bookingHandoff,
      tripSubmission,
      undefined,
      [fixtureProvider]
    );
    // START_CONTACT_CAPTURE has no provider in this custom array — the default ContactCapture handler is
    // gone entirely, so a callback phrase is simply not handled (never silently falls back to the default).
    const outcome = await coordinatorWithCustomProviders.dispatchTurn(SCOPE, "callback", "turn-1", signals());
    expect(outcome.handled).toBe(false);
  });

  it("logs WORKFLOW_SIGNAL_HANDLER_MISSING (never silently falls through) when a signal fires with no registered handler", async () => {
    const { workflows, contactCapture, bookingHandoff, tripSubmission, signals } = harness();
    const coordinatorNoProviders = new WorkflowCoordinator(
      workflows,
      contactCapture,
      bookingHandoff,
      tripSubmission,
      undefined,
      []
    );
    const warnSpy = vi.spyOn(Logger.prototype, "warn");
    const outcome = await coordinatorNoProviders.dispatchSignal(
      SCOPE,
      {
        signalType: "START_BOOKING_HANDOFF",
        workflowType: "BOOKING_HANDOFF",
        source: "BOOKING_READY_CAPABILITY",
        sourceTurnId: "turn-1",
        sourceSkillExecutionId: null,
        payload: {},
        confidence: 1
      },
      "turn-1",
      signals()
    );
    expect(outcome).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ event: "WORKFLOW_SIGNAL_HANDLER_MISSING" }));
    warnSpy.mockRestore();
  });
});

describe("WorkflowCoordinator.reevaluateBelowMinimumTrigger (Stage 9F)", () => {
  it("cancels an active BELOW_MINIMUM_BUDGET-triggered TRIP_SUBMISSION once feasibility is resolved", async () => {
    const { coordinator, prisma, signals } = harness();
    const signal: WorkflowSignal = {
      signalType: "START_TRIP_SUBMISSION",
      workflowType: "TRIP_SUBMISSION",
      source: "BELOW_MINIMUM_BUDGET_FEASIBILITY",
      sourceTurnId: "turn-1",
      sourceSkillExecutionId: null,
      payload: { trigger: "BELOW_MINIMUM_BUDGET" },
      confidence: 1
    };
    await coordinator.dispatchSignal(SCOPE, signal, "turn-1", signals(), "1000 USD");
    expect(prisma.workflowRows).toHaveLength(1);
    expect(prisma.workflowRows[0]?.status).toBe("WAITING_FOR_INPUT");

    const cancelled = await coordinator.reevaluateBelowMinimumTrigger(SCOPE, false);

    expect(cancelled).toBe(true);
    expect(prisma.workflowRows[0]?.status).toBe("CANCELLED");
  });

  it("does nothing when the budget is still BELOW_MINIMUM", async () => {
    const { coordinator, prisma, signals } = harness();
    const signal: WorkflowSignal = {
      signalType: "START_TRIP_SUBMISSION",
      workflowType: "TRIP_SUBMISSION",
      source: "BELOW_MINIMUM_BUDGET_FEASIBILITY",
      sourceTurnId: "turn-1",
      sourceSkillExecutionId: null,
      payload: { trigger: "BELOW_MINIMUM_BUDGET" },
      confidence: 1
    };
    await coordinator.dispatchSignal(SCOPE, signal, "turn-1", signals(), "1000 USD");

    const cancelled = await coordinator.reevaluateBelowMinimumTrigger(SCOPE, true);

    expect(cancelled).toBe(false);
    expect(prisma.workflowRows[0]?.status).toBe("WAITING_FOR_INPUT");
  });

  it("does nothing when no TRIP_SUBMISSION workflow is active for the conversation", async () => {
    const { coordinator } = harness();
    const cancelled = await coordinator.reevaluateBelowMinimumTrigger(SCOPE, false);
    expect(cancelled).toBe(false);
  });

  it("never cancels a CONTACT_CAPTURE workflow even if one is active", async () => {
    const { coordinator, prisma, signals } = harness();
    await coordinator.dispatchTurn(SCOPE, "callback", "turn-1", signals());
    expect(prisma.workflowRows[0]?.workflowType).toBe("CONTACT_CAPTURE");

    const cancelled = await coordinator.reevaluateBelowMinimumTrigger(SCOPE, false);

    expect(cancelled).toBe(false);
    expect(prisma.workflowRows[0]?.status).toBe("WAITING_FOR_INPUT");
  });
});
