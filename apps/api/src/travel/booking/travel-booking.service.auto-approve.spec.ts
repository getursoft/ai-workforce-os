/**
 * Real UAT gap: the default approval policy for a BOOKING (no custom ApprovalPolicy row configured — see
 * ApprovalPolicyEngine.defaultPolicy) makes the CUSTOMER their own approver (CUSTOMER_CONFIRMATION mode).
 * The customer already gave that approval by advancing the chat to an explicit "Confirm booking" reply —
 * there is no separate customer-facing "approve" action they could ever take, so every such booking sat
 * PENDING forever unless an admin manually hit the internal approve endpoint. requestCustomerApproval now
 * auto-approves in that case, running the same provider-submission + ticket-delivery path a manual
 * approval would, synchronously, so the PDF/PNR are ready before the chat turn's response is sent.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../infrastructure/prisma/prisma.service";
import type { ApprovalService } from "../../approval/approval.service";
import type { ApprovalAuditService } from "../../approval/approval-audit.service";
import type { BookingProviderAdapter } from "../provider/booking-provider-adapter";
import type { TicketGeneratorService } from "../delivery/ticket-generator.service";
import type { DeliveryRecorderService } from "../delivery/delivery-recorder.service";
import { TravelBookingService } from "./travel-booking.service";

interface FakeBookingRow {
  id: string;
  organizationId: string;
  workflowExecutionId: string | null;
  status: string;
  approvalRequestId: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  quotedAmount: number | null;
  [key: string]: unknown;
}

function harness(approverType: "CUSTOMER" | "MANAGER" = "CUSTOMER") {
  const bookings = new Map<string, FakeBookingRow>();
  const prisma = {
    travelBooking: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; organizationId: string } }) => {
        const row = bookings.get(where.id);
        return row && row.organizationId === where.organizationId ? row : null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = bookings.get(where.id);
        if (!row) throw new Error("booking not found");
        Object.assign(row, data);
        return row;
      }),
    },
  } as unknown as PrismaService;

  const auditService = { record: vi.fn(async () => undefined) } as unknown as ApprovalAuditService;

  let approvalStatus: "PENDING" | "APPROVED" = "PENDING";
  const approvalService = {
    create: vi.fn(async () => ({ id: "approval-1", approverType })),
    recordDecision: vi.fn(async () => {
      approvalStatus = "APPROVED";
      return { id: "approval-1", status: approvalStatus };
    }),
    findById: vi.fn(async () => ({ id: "approval-1", status: approvalStatus })),
  } as unknown as ApprovalService;

  const bookingProvider = {
    book: vi.fn(async () => ({
      success: true,
      providerBookingRef: "REF1",
      providerPnr: "PNR1",
      ticketNumbers: ["TKT-1"],
      providerResponse: {},
    })),
  } as unknown as BookingProviderAdapter;
  const ticketGenerator = {
    generateTicketPackage: vi.fn(async () => ({ pnr: "PNR1", bookingReference: "REF1" })),
  } as unknown as TicketGeneratorService;
  // The real DeliveryRecorderService transitions the booking to TICKETS_DELIVERED itself once it has
  // attempted delivery (see delivery-recorder.service.ts) — mirrored here so this test still observes the
  // full real status chain, not an artificially truncated one.
  const deliveryRecorder = {
    recordTicketDelivery: vi.fn(async (bookingId: string) => {
      const row = bookings.get(bookingId);
      if (row) row.status = "TICKETS_DELIVERED";
      return { email: null, whatsapp: null };
    }),
  } as unknown as DeliveryRecorderService;

  const service = new TravelBookingService(
    prisma,
    approvalService,
    auditService,
    bookingProvider,
    ticketGenerator,
    deliveryRecorder,
  );

  bookings.set("booking-1", {
    id: "booking-1",
    organizationId: "org-1",
    workflowExecutionId: "workflow-1",
    pluginInstallationId: "plugin-1",
    status: "OPTIONS_PREPARED",
    approvalRequestId: null,
    customerEmail: "krishna@example.com",
    customerPhone: null,
    quotedAmount: 26203,
    quotedCurrency: "AED",
    destinationCity: "Dubai",
  });

  return { service, bookings, bookingProvider, deliveryRecorder, approvalService };
}

describe("TravelBookingService.requestCustomerApproval: auto-approval for customer-confirmation bookings", () => {
  it("auto-approves, submits to the provider exactly once, and delivers tickets — booking ends TICKETS_DELIVERED with a real PNR", async () => {
    const { service, bookings, bookingProvider, deliveryRecorder, approvalService } = harness("CUSTOMER");

    const result = await service.requestCustomerApproval("booking-1", "org-1", {});

    expect(result.autoApproved).toBe(true);
    expect(approvalService.recordDecision).toHaveBeenCalledWith(
      "approval-1",
      "org-1",
      "APPROVE",
      expect.objectContaining({ actorType: "CUSTOMER", channel: "chat" })
    );
    expect(bookingProvider.book).toHaveBeenCalledTimes(1);
    expect(deliveryRecorder.recordTicketDelivery).toHaveBeenCalledTimes(1);
    const booking = bookings.get("booking-1");
    expect(booking?.status).toBe("TICKETS_DELIVERED");
    expect(booking?.providerPnr).toBe("PNR1");
  });

  it("does NOT auto-approve when the resolved policy routes to a real (non-customer) approver — leaves the booking waiting, never calls the provider", async () => {
    const { service, bookings, bookingProvider, approvalService } = harness("MANAGER");

    const result = await service.requestCustomerApproval("booking-1", "org-1", {});

    expect(result.autoApproved).toBe(false);
    expect(approvalService.recordDecision).not.toHaveBeenCalled();
    expect(bookingProvider.book).not.toHaveBeenCalled();
    expect(bookings.get("booking-1")?.status).toBe("WAITING_FOR_CUSTOMER_APPROVAL");
  });
});
