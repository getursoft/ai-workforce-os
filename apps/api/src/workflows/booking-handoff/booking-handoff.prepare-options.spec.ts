/**
 * Regression test for a real bug found while wiring the booking flow into BookingHandoffWorkflowService:
 * TravelBookingService.VALID_TRANSITIONS only allows DRAFT -> OPTIONS_PREPARED -> WAITING_FOR_CUSTOMER_
 * APPROVAL. `confirmAndRequestApproval` previously called `create()` (leaves a booking in DRAFT) and then
 * `requestCustomerApproval()` (requires OPTIONS_PREPARED) directly — always throwing, silently caught, so
 * every booking was permanently stranded in DRAFT and fell back to a generic booking-less approval. The
 * fix inserts a `prepareOptions()` call between them, also persisting the SPECIFIC selected package's
 * flight/hotel/price snapshot onto the booking. This test exercises the REAL call sequence with a fake
 * TravelBookingService that enforces the same transition rule, so a regression here throws instead of
 * silently passing.
 */
import { Prisma, type WorkflowExecution } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../infrastructure/prisma/prisma.service";
import type { ApprovalService } from "../../approval/approval.service";
import type { TravelBookingService } from "../../travel/booking/travel-booking.service";
import { WorkflowExecutionService } from "../workflow-execution.service";
import type { WorkflowExecutionScope } from "../workflow-runtime.contracts";
import { BookingHandoffWorkflowService } from "./booking-handoff.service";
import type { BookingHandoffTripContext } from "./booking-handoff.types";

const scope: WorkflowExecutionScope = {
  organizationId: "org-1",
  pluginInstallationId: "plugin-1",
  conversationId: "conversation-1",
  workflowType: "BOOKING_HANDOFF"
};

const SELECTED_OPTION = {
  recommendationId: "rec-1",
  optionNumber: 2,
  totalAmount: 26203,
  currency: "AED",
  flight: {
    carrierName: "Qatar Airways",
    flightNumber: "QA123",
    outboundDepartureTime: "2026-08-12T09:25:00Z",
    outboundArrivalTime: "2026-08-12T13:25:00Z",
    cabinClass: "Economy Flex"
  },
  hotel: { hotelName: "Downtown Dubai 4-Star Hotel" }
};

const PASSENGER_DETAILS = [
  { name: "Krishna Pandey", age: 34, gender: "MALE" },
  { name: "Anita Pandey", age: 32, gender: "FEMALE" },
  { name: "Rohan Pandey", age: 8, gender: "MALE" }
];

const TRIP_CONTEXT: BookingHandoffTripContext = {
  originCity: "Delhi",
  destinationCity: "Dubai",
  travelDates: "2026-08-12",
  skillExecutionId: null,
  journeyId: null,
  selectedOption: SELECTED_OPTION,
  travellerCount: 3,
  vegetarianPreference: true,
  passengerDetails: PASSENGER_DETAILS
};

function must<T>(value: T | null): T {
  if (value === null) throw new Error("expected a non-null value in test setup");
  return value;
}

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
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = rows.find((candidate) => matches(candidate, where));
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

/** Mirrors TravelBookingService.VALID_TRANSITIONS just enough to fail the same way the real service would
 *  if `confirmAndRequestApproval` ever regresses back to skipping `prepareOptions`. */
function fakeBookingService(autoApproveCustomer = false) {
  const bookings = new Map<string, { status: string }>();
  const calls: string[] = [];
  const service = {
    create: vi.fn(async () => {
      const id = `booking-${bookings.size + 1}`;
      bookings.set(id, { status: "DRAFT" });
      calls.push("create");
      return { id, status: "DRAFT" };
    }),
    prepareOptions: vi.fn(async (bookingId: string) => {
      const booking = must(bookings.get(bookingId) ?? null);
      if (booking.status !== "DRAFT") throw new Error(`Cannot transition booking from ${booking.status} to OPTIONS_PREPARED`);
      booking.status = "OPTIONS_PREPARED";
      calls.push("prepareOptions");
    }),
    requestCustomerApproval: vi.fn(async (bookingId: string) => {
      const booking = must(bookings.get(bookingId) ?? null);
      if (booking.status !== "OPTIONS_PREPARED")
        throw new Error(`Cannot transition booking from ${booking.status} to WAITING_FOR_CUSTOMER_APPROVAL`);
      booking.status = autoApproveCustomer ? "CUSTOMER_APPROVED" : "WAITING_FOR_CUSTOMER_APPROVAL";
      calls.push("requestCustomerApproval");
      return { approvalRequestId: "approval-1", autoApproved: autoApproveCustomer };
    }),
    confirmApprovalAndBook: vi.fn(async (bookingId: string) => {
      const booking = must(bookings.get(bookingId) ?? null);
      booking.status = "TICKETS_DELIVERED";
      calls.push("confirmApprovalAndBook");
      return { bookingRef: "REF1", pnr: "PNR1", ticketCount: 1 };
    }),
    markRejectedAfterApprovalDecision: vi.fn(async (bookingId: string) => {
      const booking = must(bookings.get(bookingId) ?? null);
      if (booking.status !== "WAITING_FOR_CUSTOMER_APPROVAL")
        throw new Error(`Cannot transition booking from ${booking.status} to CUSTOMER_REJECTED`);
      booking.status = "CUSTOMER_REJECTED";
      calls.push("markRejectedAfterApprovalDecision");
    })
  };
  return { service: service as unknown as TravelBookingService, bookings, calls };
}

function harness(approvalStatus: "APPROVED" | "REJECTED" | null = null, autoApproveCustomer = false) {
  const prisma = fakePrisma();
  const workflows = new WorkflowExecutionService(prisma as unknown as PrismaService);
  const approvalService = {
    create: vi.fn(async () => ({ id: "fallback-approval" })),
    findById: vi.fn(async () => (approvalStatus ? { status: approvalStatus } : null))
  } as unknown as ApprovalService;
  const { service: bookingService, bookings, calls } = fakeBookingService(autoApproveCustomer);
  const service = new BookingHandoffWorkflowService(workflows, approvalService, bookingService);
  return { service, workflows, bookings, calls, approvalService, bookingService };
}

describe("BookingHandoffWorkflowService.confirmAndRequestApproval: DRAFT -> OPTIONS_PREPARED -> WAITING_FOR_CUSTOMER_APPROVAL", () => {
  // TRIP_CONTEXT carries a selectedOption, meaning Travel Runtime's own turn already captured the
  // customer's explicit "Confirm booking" reply — start() proceeds straight to requesting approval rather
  // than waiting for a second confirmation nobody would ever be asked for (see start()'s own doc comment).
  it("start() with an already-confirmed selectedOption calls prepareOptions between create and requestCustomerApproval, in order, exactly once each — never leaves the booking stuck in DRAFT", async () => {
    const { service, bookings, calls, approvalService } = harness();

    const result = await service.start(scope, "turn-1", TRIP_CONTEXT);

    expect(result.decision).toBe("REQUEST_APPROVAL");
    expect(calls).toEqual(["create", "prepareOptions", "requestCustomerApproval"]);
    expect(bookings.size).toBe(1);
    expect([...bookings.values()][0]?.status).toBe("WAITING_FOR_CUSTOMER_APPROVAL");
    // The real customer-approval path succeeded, so the generic booking-less fallback approval must
    // never be created.
    expect(approvalService.create).not.toHaveBeenCalled();
  });

  it("persists the selected package's flight/hotel/price snapshot onto the booking via prepareOptions", async () => {
    const { service, bookingService } = harness();
    await service.start(scope, "turn-1", TRIP_CONTEXT);

    expect(bookingService.prepareOptions).toHaveBeenCalledTimes(1);
    const [, , options] = (bookingService.prepareOptions as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, string, Record<string, unknown>];
    expect(options.quotedAmount).toBe(SELECTED_OPTION.totalAmount);
    expect(options.quotedCurrency).toBe(SELECTED_OPTION.currency);
    const flights = options.flights as { segments: Array<Record<string, unknown>> };
    expect(flights.segments[0]).toMatchObject({
      airline: "Qatar Airways",
      flightNumber: "QA123",
      departureCity: "Delhi",
      arrivalCity: "Dubai",
      cabin: "Economy Flex"
    });
    expect(options.hotels).toMatchObject({ hotelName: "Downtown Dubai 4-Star Hotel" });
  });

  it("persists the full passenger roster (name/age/gender) onto the booking via prepareOptions — the whole reason a real ticket can name real travellers instead of 'Passenger 1'/'Passenger 2'", async () => {
    const { service, bookingService } = harness();
    await service.start(scope, "turn-1", TRIP_CONTEXT);

    const [, , options] = (bookingService.prepareOptions as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, string, Record<string, unknown>];
    expect(options.travellerSummary).toEqual({ passengers: PASSENGER_DETAILS });
  });

  it("omits travellerSummary entirely when no passenger details were collected (older/simpler callers)", async () => {
    const { service, bookingService } = harness();
    await service.start(scope, "turn-1", { ...TRIP_CONTEXT, passengerDetails: null });

    const [, , options] = (bookingService.prepareOptions as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, string, Record<string, unknown>];
    expect(options.travellerSummary).toBeUndefined();
  });

  it("without a selectedOption, start() still just asks its own confirmation question — the resume()-driven two-step flow (Skill Runtime's READY_FOR_BOOKING path) is unaffected", async () => {
    const { service, workflows, calls } = harness();
    const noSelectionContext = { ...TRIP_CONTEXT, selectedOption: null };

    const started = await service.start(scope, "turn-1", noSelectionContext);
    expect(started.decision).toBe("ASK_FOR_INPUT");
    expect(calls).toEqual([]);

    const execution = must(await workflows.findActiveWorkflow(scope));
    const resumed = await service.resume(execution, "confirm booking", "turn-2", noSelectionContext);

    expect(resumed.decision).toBe("REQUEST_APPROVAL");
    expect(calls).toEqual(["create", "prepareOptions", "requestCustomerApproval"]);
  });
});

describe("BookingHandoffWorkflowService.start: customer-confirmation bookings auto-approve and complete in the SAME turn", () => {
  // Real UAT gap: TravelBookingService.requestCustomerApproval now auto-approves whenever the resolved
  // policy's approverType is CUSTOMER (the no-custom-policy default for a BOOKING) — there is no separate
  // customer-facing "approve" action to wait for. start() must reflect that immediately instead of leaving
  // the chat saying "waiting for approval" for something that already finished.
  it("calls confirmApprovalAndBook and returns decision COMPLETE with the real PNR in the same turn as 'Confirm booking' — never leaves the booking sitting at WAITING_FOR_CUSTOMER_APPROVAL", async () => {
    const { service, bookings, calls } = harness(null, true);

    const result = await service.start(scope, "turn-1", TRIP_CONTEXT);

    expect(calls).toEqual(["create", "prepareOptions", "requestCustomerApproval", "confirmApprovalAndBook"]);
    expect(result.decision).toBe("COMPLETE");
    expect(result.responseText).toMatch(/booking is confirmed/i);
    expect(result.responseText).toMatch(/PNR1/);
    expect([...bookings.values()][0]?.status).toBe("TICKETS_DELIVERED");
  });

  it("does NOT auto-complete when requestCustomerApproval reports autoApproved: false (a custom policy routing to a real approver) — falls through to the normal waiting-for-approval response", async () => {
    const { service, calls } = harness(null, false);

    const result = await service.start(scope, "turn-1", TRIP_CONTEXT);

    expect(calls).toEqual(["create", "prepareOptions", "requestCustomerApproval"]);
    expect(result.decision).toBe("REQUEST_APPROVAL");
    expect(result.responseText).toMatch(/waiting for approval/i);
  });
});

describe("BookingHandoffWorkflowService.resume: approval decision reached (pull-based, polled on the next turn)", () => {
  // Regression test for a real bug found via manual UAT: a manager REJECTING a booking correctly told the
  // customer "not approved" in chat, but the TravelBooking row itself was never transitioned away from
  // WAITING_FOR_CUSTOMER_APPROVAL — the bookings dashboard showed it as perpetually awaiting approval.
  it("REJECTED: transitions the booking to CUSTOMER_REJECTED (via markRejectedAfterApprovalDecision, never re-recording the decision) and cancels the workflow", async () => {
    const { service, workflows, bookings, calls } = harness("REJECTED");
    await service.start(scope, "turn-1", TRIP_CONTEXT);
    const execution = must(await workflows.findActiveWorkflow(scope));
    expect(execution.status).toBe("WAITING_FOR_APPROVAL");

    const resumed = await service.resume(execution, "any update?", "turn-2", TRIP_CONTEXT);

    expect(resumed.decision).toBe("CANCELLED");
    expect(resumed.responseText).toMatch(/not approved/i);
    expect(calls).toContain("markRejectedAfterApprovalDecision");
    expect([...bookings.values()][0]?.status).toBe("CUSTOMER_REJECTED");
  });

  it("APPROVED: still runs confirmApprovalAndBook and completes the workflow (unaffected by the rejection fix)", async () => {
    const { service, workflows, bookings, calls } = harness("APPROVED");
    await service.start(scope, "turn-1", TRIP_CONTEXT);
    const execution = must(await workflows.findActiveWorkflow(scope));

    const resumed = await service.resume(execution, "any update?", "turn-2", TRIP_CONTEXT);

    expect(resumed.decision).toBe("COMPLETE");
    expect(calls).toContain("confirmApprovalAndBook");
    expect(calls).not.toContain("markRejectedAfterApprovalDecision");
    expect([...bookings.values()][0]?.status).toBe("TICKETS_DELIVERED");
  });
});
