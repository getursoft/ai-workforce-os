/**
 * Regression coverage for replacing the previous fake ticket PDF (`Buffer.from(plainText)` served with an
 * `application/pdf` header) with a real PDF rendered via pdfkit. A genuine PDF file always starts with the
 * `%PDF-` magic bytes and ends with `%%EOF` — a plain-text buffer would never happen to look like that.
 */
import { describe, expect, it } from "vitest";
import type { PrismaService } from "../../infrastructure/prisma/prisma.service";
import { TicketGeneratorService } from "./ticket-generator.service";

function fakePrisma(booking: Record<string, unknown> | null) {
  return {
    travelBooking: {
      findFirst: async () => booking
    }
  } as unknown as PrismaService;
}

const BOOKING = {
  id: "11111111-2222-3333-4444-555555555555",
  organizationId: "org-1",
  providerBookingRef: "REF123",
  providerPnr: "PNR456",
  ticketNumbersJson: ["TKT-001", "TKT-002"],
  passengers: "2",
  flightDetailsJson: {
    segments: [
      {
        airline: "Qatar Airways",
        flightNumber: "QA123",
        departureCity: "Delhi",
        departureTime: "2026-08-12T09:25:00Z",
        arrivalCity: "Dubai",
        arrivalTime: "2026-08-12T13:25:00Z",
        cabin: "Economy Flex"
      }
    ]
  },
  cancellationTerms: null
};

describe("TicketGeneratorService.generatePdfContent", () => {
  it("throws when the booking doesn't exist (or belongs to another organization)", async () => {
    const service = new TicketGeneratorService(fakePrisma(null));
    await expect(service.generatePdfContent(BOOKING.id, BOOKING.organizationId)).rejects.toThrow();
  });

  it("produces a real PDF — starts with the %PDF- magic bytes and ends with %%EOF, not a plain-text buffer", async () => {
    const service = new TicketGeneratorService(fakePrisma(BOOKING));
    const pdf = await service.generatePdfContent(BOOKING.id, BOOKING.organizationId);

    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.subarray(-6).toString("ascii").trim()).toBe("%%EOF");
    // A real rendered PDF is binary and non-trivially sized — a plain-text placeholder of the same
    // content would be a few hundred bytes; pdfkit's page/font/stream overhead pushes this well past that.
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("generateTicketPackage still exposes the same structured data pdfkit renders from", async () => {
    const service = new TicketGeneratorService(fakePrisma(BOOKING));
    const pkg = await service.generateTicketPackage(BOOKING.id, BOOKING.organizationId);

    expect(pkg.pnr).toBe("PNR456");
    expect(pkg.bookingReference).toBe("REF123");
    expect(pkg.ticketNumbers).toEqual(["TKT-001", "TKT-002"]);
    expect(pkg.flightSegments).toHaveLength(1);
    expect(pkg.flightSegments[0]).toMatchObject({
      airline: "Qatar Airways",
      flightNumber: "QA123",
      cabin: "Economy Flex"
    });
  });

  it("falls back to generic 'Passenger N' placeholders when the booking has no recorded traveller details (older bookings predating passenger collection)", async () => {
    const service = new TicketGeneratorService(fakePrisma(BOOKING));
    const pkg = await service.generateTicketPackage(BOOKING.id, BOOKING.organizationId);

    expect(pkg.passengers).toEqual([
      { name: "Passenger 1", age: null, gender: null },
      { name: "Passenger 2", age: null, gender: null }
    ]);
  });

  it("uses the real recorded passenger names/ages/genders when the booking flow collected them (production-ready ticket, not a dummy placeholder)", async () => {
    const bookingWithPassengers = {
      ...BOOKING,
      passengers: "3",
      travellerSummaryJson: {
        passengers: [
          { name: "Krishna Pandey", age: 34, gender: "MALE" },
          { name: "Anita Pandey", age: 32, gender: "FEMALE" },
          { name: "Rohan Pandey", age: 8, gender: "MALE" }
        ]
      }
    };
    const service = new TicketGeneratorService(fakePrisma(bookingWithPassengers));
    const pkg = await service.generateTicketPackage(bookingWithPassengers.id, bookingWithPassengers.organizationId);

    expect(pkg.passengers).toEqual([
      { name: "Krishna Pandey", age: 34, gender: "MALE" },
      { name: "Anita Pandey", age: 32, gender: "FEMALE" },
      { name: "Rohan Pandey", age: 8, gender: "MALE" }
    ]);

    // Also confirms the PDF-rendering path (which reads pkg.passengers, not the raw booking row) doesn't
    // throw with real passenger data flowing through it — the PDF's own bytes are Flate-compressed by
    // pdfkit by default, so a raw substring search isn't a meaningful assertion here.
    const pdf = await service.generatePdfContent(bookingWithPassengers.id, bookingWithPassengers.organizationId);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });
});
