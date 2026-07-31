/**
 * Focused unit coverage for the "resend my ticket" lookup/resend path added to TravelBookingService —
 * kept in its own file (rather than the controller permissions spec) since it needs a full service
 * instance with fake Prisma/ApprovalService/DeliveryRecorderService, not just reflection metadata.
 */
import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { PrismaService } from "../../infrastructure/prisma/prisma.service";
import type { ApprovalService } from "../../approval/approval.service";
import type { ApprovalAuditService } from "../../approval/approval-audit.service";
import type { BookingProviderAdapter } from "../provider/booking-provider-adapter";
import type { TicketGeneratorService } from "../delivery/ticket-generator.service";
import type { DeliveryRecorderService } from "../delivery/delivery-recorder.service";
import { TravelBookingService } from "./travel-booking.service";

function harness(bookings: Array<Record<string, unknown>>) {
  const findMany = vi.fn(async () => bookings);
  const findFirst = vi.fn(async ({ where }: { where: { status?: unknown } }) => {
    return bookings.find((b) => {
      if (!where.status) return true;
      const statuses = (where.status as { in?: string[] }).in ?? [];
      return statuses.includes(b.status as string);
    }) ?? null;
  });
  const prisma = { travelBooking: { findMany, findFirst } } as unknown as PrismaService;
  const recordTicketDelivery = vi.fn(async () => ({
    email: { channel: "email" as const, recipient: "x", status: "SENT" as const, messageId: "m1", errorCode: null, sentAt: "now" },
    whatsapp: null,
  }));
  const deliveryRecorder = { recordTicketDelivery } as unknown as DeliveryRecorderService;

  const service = new TravelBookingService(
    prisma,
    {} as ApprovalService,
    {} as ApprovalAuditService,
    {} as BookingProviderAdapter,
    {} as TicketGeneratorService,
    deliveryRecorder
  );
  return { service, findMany, findFirst, recordTicketDelivery };
}

describe("TravelBookingService.findBookingForResend", () => {
  it("returns null when no ticketed booking exists for that email", async () => {
    const { service } = harness([]);
    const result = await service.findBookingForResend("org-1", { email: "nobody@example.com", travelDate: null });
    expect(result).toBeNull();
  });

  it("matches the booking whose travelDates contains the given date when the email has multiple ticketed bookings", async () => {
    const { service } = harness([
      { id: "booking-recent", status: "TICKETS_DELIVERED", travelDates: "2026-11-01", createdAt: new Date("2026-06-01") },
      { id: "booking-target", status: "BOOKED", travelDates: "2026-08-12", createdAt: new Date("2026-01-01") },
    ]);
    const result = await service.findBookingForResend("org-1", { email: "krishna@example.com", travelDate: "2026-08-12" });
    expect(result?.id).toBe("booking-target");
  });

  it("falls back to the most recently ticketed booking when no date is given or none matches", async () => {
    const { service } = harness([
      { id: "booking-newest", status: "TICKETS_DELIVERED", travelDates: "2026-11-01", createdAt: new Date("2026-06-01") },
      { id: "booking-older", status: "BOOKED", travelDates: "2026-08-12", createdAt: new Date("2026-01-01") },
    ]);
    const result = await service.findBookingForResend("org-1", { email: "krishna@example.com", travelDate: null });
    expect(result?.id).toBe("booking-newest");
  });

  it("only ever considers ticketed bookings (BOOKED/TICKETS_DELIVERED) — never a draft awaiting approval", async () => {
    const { service, findMany } = harness([]);
    await service.findBookingForResend("org-1", { email: "krishna@example.com", travelDate: null });
    const [{ where }] = findMany.mock.calls[0] as unknown as [{ where: { status: { in: string[] } } }];
    expect(where.status.in.sort()).toEqual(["BOOKED", "TICKETS_DELIVERED"]);
  });
});

describe("TravelBookingService.resendTicket", () => {
  it("regenerates and resends the ticket for an already-ticketed booking", async () => {
    const { service, recordTicketDelivery } = harness([{ id: "booking-1", status: "BOOKED" }]);
    const result = await service.resendTicket("booking-1", "org-1");
    expect(recordTicketDelivery).toHaveBeenCalledWith("booking-1", "org-1");
    expect(result.email?.status).toBe("SENT");
  });

  it("throws rather than resending a booking that was never ticketed (e.g. still DRAFT)", async () => {
    const { service } = harness([]);
    await expect(service.resendTicket("booking-1", "org-1")).rejects.toBeInstanceOf(NotFoundException);
  });
});
