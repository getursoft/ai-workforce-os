import { Prisma, type WorkflowExecution } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { TravelLeadService } from "../travel/travel-lead.service";
import { LeadService } from "../leads/lead.service";
import { EMPTY_TRAVEL_ENTITIES } from "../travel/travel.runtime";
import { ContactCaptureWorkflowService } from "./contact-capture/contact-capture.service";
import { TripSubmissionWorkflowService } from "./trip-submission/trip-submission.service";
import type { TripSubmissionStartSignals, TripSubmissionTripContext } from "./trip-submission/trip-submission.types";
import type { ContactCaptureStartSignals, ContactCaptureTripContext } from "./contact-capture/contact-capture.types";
import { WorkflowExecutionService } from "./workflow-execution.service";
import type { WorkflowDispatchSignals } from "./workflow-runtime.contracts";
import { WorkflowSignalEngine } from "./workflow-signal-engine";

const TRIP_STATE = { ...EMPTY_TRAVEL_ENTITIES, originCity: "Delhi", destinationCity: "Dubai" };

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
  const rows: WorkflowExecution[] = [];
  return {
    rows,
    workflowExecution: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, where)),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (rows.some((row) => row.activeKey === data.activeKey))
          throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "6.19.3" });
        const now = new Date();
        const row = { id: `workflow-${rows.length + 1}`, completedAt: null, createdAt: now, updatedAt: now, ...data } as WorkflowExecution;
        rows.push(row);
        return row;
      },
      updateMany: async () => ({ count: 0 })
    },
    travelLead: { findUnique: async () => null, create: async () => ({}) }
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
  const travelLeadService = new TravelLeadService(prisma as unknown as PrismaService, new LeadService(prisma as unknown as PrismaService));
  const contactCapture = new ContactCaptureWorkflowService(workflows, travelLeadService);
  const tripSubmission = new TripSubmissionWorkflowService(workflows, travelLeadService);
  const engine = new WorkflowSignalEngine(contactCapture, tripSubmission);
  return { engine };
}

const NO_CONTACT_SIGNALS: ContactCaptureStartSignals = { providerFailure: null, completionStage: null };
const NO_TRIP_SIGNALS: TripSubmissionStartSignals = {
  legacyPendingInputAction: null,
  legacyCompletionStage: null,
  itineraryPresented: false,
  hasActiveTripContext: false,
  tripState: TRIP_STATE,
  legacyPendingContactValue: null,
  legacyPendingAction: null
};

function dispatchSignals(overrides: Partial<TripSubmissionStartSignals> = {}): WorkflowDispatchSignals {
  return {
    contactCapture: NO_CONTACT_SIGNALS,
    contactCaptureTripContext: CONTACT_TRIP_CONTEXT,
    bookingHandoffTripContext: {
      originCity: "Delhi",
      destinationCity: "Dubai",
      travelDates: null,
      skillExecutionId: null,
      journeyId: null
    },
    tripSubmission: { ...NO_TRIP_SIGNALS, ...overrides },
    tripSubmissionTripContext: TRIP_SUBMISSION_TRIP_CONTEXT
  };
}

describe("WorkflowSignalEngine.deriveSignal", () => {
  it("returns a NONE signal for unrelated text", () => {
    const { engine } = harness();
    const signal = engine.deriveSignal("plan a trip to Goa", dispatchSignals(), "turn-1");
    expect(signal.signalType).toBe("NONE");
    expect(signal.workflowType).toBeNull();
  });

  it("derives START_CONTACT_CAPTURE from an explicit callback phrase", () => {
    const { engine } = harness();
    const signal = engine.deriveSignal("callback", dispatchSignals(), "turn-1");
    expect(signal.signalType).toBe("START_CONTACT_CAPTURE");
    expect(signal.workflowType).toBe("CONTACT_CAPTURE");
    expect(signal.source).toBe("CALLBACK_INTENT_PHRASE");
    expect(signal.sourceTurnId).toBe("turn-1");
  });

  it("derives START_TRIP_SUBMISSION with a CONFIRM_SUBMISSION trigger payload once an itinerary was presented", () => {
    const { engine } = harness();
    const signal = engine.deriveSignal(
      "yes, please confirm",
      dispatchSignals({ itineraryPresented: true }),
      "turn-1"
    );
    expect(signal.signalType).toBe("START_TRIP_SUBMISSION");
    expect(signal.source).toBe("TRIP_SUBMISSION_CONFIRMATION");
    expect(signal.payload.trigger).toBe("CONFIRM_SUBMISSION");
  });

  it("derives START_TRIP_SUBMISSION with a STANDALONE_CONTACT trigger payload for a volunteered phone number", () => {
    const { engine } = harness();
    const signal = engine.deriveSignal(
      "8380031193",
      dispatchSignals({ hasActiveTripContext: true }),
      "turn-1"
    );
    expect(signal.signalType).toBe("START_TRIP_SUBMISSION");
    expect(signal.source).toBe("STANDALONE_CONTACT_VOLUNTEERED");
    expect(signal.payload.trigger).toBe("STANDALONE_CONTACT");
  });

  it("never derives a signal while the legacy engine already owns this turn's pending contact question", () => {
    const { engine } = harness();
    const signal = engine.deriveSignal(
      "8380031193",
      dispatchSignals({ hasActiveTripContext: true, legacyPendingInputAction: "AWAITING_LEAD_CONTACT" }),
      "turn-1"
    );
    expect(signal.signalType).toBe("NONE");
  });
});
