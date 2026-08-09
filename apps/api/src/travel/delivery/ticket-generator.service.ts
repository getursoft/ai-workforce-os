import { Injectable, Logger } from "@nestjs/common";
import PDFDocument from "pdfkit";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";

export interface TicketPassenger {
  name: string;
  age: number | null;
  gender: string | null;
}

export interface TicketPackage {
  bookingReference: string;
  pnr: string;
  passengers: TicketPassenger[];
  flightSegments: Array<{
    airline: string;
    flightNumber: string;
    departure: { city: string; datetime: string };
    arrival: { city: string; datetime: string };
    cabin: string;
  }>;
  ticketNumbers: string[];
  baggage: string;
  fareRules: string;
  cancellationTerms: string;
  emergencyContact: string;
  generatedAt: string;
  pdfUrl: string;
}

@Injectable()
export class TicketGeneratorService {
  private readonly logger = new Logger(TicketGeneratorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async generateTicketPackage(bookingId: string, organizationId: string): Promise<TicketPackage> {
    const booking = await this.prisma.travelBooking.findFirst({
      where: { id: bookingId, organizationId },
    });
    if (!booking) throw new Error(`Booking ${bookingId} not found`);

    const ticketNumbers = Array.isArray(booking.ticketNumbersJson)
      ? (booking.ticketNumbersJson as string[])
      : [];
    const flightDetails = (booking.flightDetailsJson ?? {}) as Record<string, unknown>;
    const segments = Array.isArray(flightDetails.segments)
      ? (flightDetails.segments as Array<Record<string, unknown>>)
      : [];

    const passengerCount = Math.max(1, parseInt(booking.passengers ?? "1", 10) || 1);
    const travellerSummary = (booking.travellerSummaryJson ?? {}) as Record<string, unknown>;
    const recordedPassengers = Array.isArray(travellerSummary.passengers)
      ? (travellerSummary.passengers as Array<Record<string, unknown>>)
      : [];
    // Real names/ages/genders when the booking flow collected them (see travel-package-options.ts's
    // `PassengerDetail`, gated on before a booking can even be confirmed) — "Passenger N" only ever
    // covers an older booking created before that gate existed, never a live one.
    const passengers: TicketPassenger[] =
      recordedPassengers.length > 0
        ? recordedPassengers.slice(0, passengerCount).map((entry, index) => ({
            name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : `Passenger ${index + 1}`,
            age: typeof entry.age === "number" ? entry.age : null,
            gender: typeof entry.gender === "string" ? entry.gender : null,
          }))
        : Array.from({ length: passengerCount }, (_, index) => ({
            name: `Passenger ${index + 1}`,
            age: null,
            gender: null,
          }));

    const pkg: TicketPackage = {
      bookingReference: booking.providerBookingRef ?? booking.id.slice(0, 8).toUpperCase(),
      pnr: booking.providerPnr ?? "N/A",
      passengers,
      flightSegments: segments.map((seg) => ({
        airline: String(seg.airline ?? "Unknown"),
        flightNumber: String(seg.flightNumber ?? "XX-000"),
        departure: {
          city: String(seg.departureCity ?? "N/A"),
          datetime: String(seg.departureTime ?? "N/A"),
        },
        arrival: {
          city: String(seg.arrivalCity ?? "N/A"),
          datetime: String(seg.arrivalTime ?? "N/A"),
        },
        cabin: String(seg.cabin ?? "Economy"),
      })),
      ticketNumbers,
      baggage: "20 KG Check-in + 7 KG Cabin",
      fareRules: "Non-refundable after 24 hours. Change fee applies.",
      cancellationTerms: booking.cancellationTerms ?? "Standard cancellation policy applies. Penalty varies by fare type.",
      emergencyContact: "+91-XXXXX-XXXXX (24/7 Support)",
      generatedAt: new Date().toISOString(),
      pdfUrl: `/api/v1/travel/bookings/${bookingId}/ticket.pdf`,
    };

    this.logger.log({ event: "TICKET_PACKAGE_GENERATED", bookingId, pnr: pkg.pnr });
    return pkg;
  }

  /** Renders `generateTicketPackage`'s data into an actual PDF (via pdfkit, a pure-Node library with no
   *  browser/native dependency — consistent with this repo's existing minimal-dependency file-handling
   *  style, see pdf-parse/mammoth/jszip). Replaces the previous placeholder that returned plain text with
   *  an `application/pdf` header — real bytes a PDF reader can actually open. */
  async generatePdfContent(bookingId: string, organizationId: string): Promise<Buffer> {
    const pkg = await this.generateTicketPackage(bookingId, organizationId);

    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const section = (title: string) => {
        doc.moveDown(0.75);
        doc.fontSize(12).fillColor("#1a1a1a").font("Helvetica-Bold").text(title.toUpperCase());
        doc.moveTo(doc.x, doc.y + 2).lineTo(545, doc.y + 2).strokeColor("#cccccc").stroke();
        doc.moveDown(0.5);
        doc.font("Helvetica").fontSize(10).fillColor("#1a1a1a");
      };

      doc.fontSize(18).font("Helvetica-Bold").text("Krevia.ai — Simulated E-Ticket", { align: "center" });
      doc.moveDown(0.3);
      doc
        .fontSize(10)
        .font("Helvetica")
        .fillColor("#555555")
        .text("This is a simulated ticket generated by the DummyBookingAdapter — not a real booking.", {
          align: "center",
        });
      doc.fillColor("#1a1a1a");

      section("Booking Details");
      doc.text(`Booking Reference: ${pkg.bookingReference}`);
      doc.text(`PNR: ${pkg.pnr}`);
      doc.text(`Issued: ${pkg.generatedAt.slice(0, 10)}`);

      section("Passengers");
      pkg.passengers.forEach((passenger, i) => {
        const details = [
          passenger.age !== null ? `Age: ${passenger.age}` : null,
          passenger.gender ? `Gender: ${passenger.gender}` : null
        ]
          .filter(Boolean)
          .join(", ");
        doc.text(
          `${i + 1}. ${passenger.name}${details ? ` (${details})` : ""} — Ticket: ${pkg.ticketNumbers[i] ?? "N/A"}`
        );
      });

      section("Flight Segments");
      pkg.flightSegments.forEach((seg, i) => {
        doc.font("Helvetica-Bold").text(`Segment ${i + 1}: ${seg.airline} ${seg.flightNumber} (${seg.cabin})`);
        doc.font("Helvetica").text(`  ${seg.departure.city} -> ${seg.arrival.city}`);
        doc.text(`  Departure: ${seg.departure.datetime}`);
        doc.text(`  Arrival: ${seg.arrival.datetime}`);
        doc.moveDown(0.3);
      });

      section("Baggage Allowance");
      doc.text(pkg.baggage);

      section("Fare Rules");
      doc.text(pkg.fareRules);

      section("Cancellation Terms");
      doc.text(pkg.cancellationTerms);

      section("Emergency Contact");
      doc.text(pkg.emergencyContact);

      doc.moveDown(1.5);
      doc
        .fontSize(9)
        .fillColor("#888888")
        .text("THIS IS A SIMULATED TICKET — NOT A REAL BOOKING. Generated by Krevia.ai DummyBookingAdapter.", {
          align: "center",
        });

      doc.end();
    });
  }
}
