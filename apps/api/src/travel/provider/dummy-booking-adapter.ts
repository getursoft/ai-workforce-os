import { Injectable, Logger } from "@nestjs/common";
import type {
  BookingRequest,
  BookingResult,
  CancellationRequest,
  CancellationResult,
} from "./booking-provider-adapter";
import { BookingProviderAdapter } from "./booking-provider-adapter";

const AIRLINES: readonly string[] = ["6E", "AI", "SG", "UK", "9W", "EK", "QR", "EY", "TK", "SQ"];
const CITIES: readonly string[] = ["DEL", "BOM", "BLR", "MAA", "HYD", "CCU", "DXB", "LHR", "JFK", "SIN"];

function pick(arr: readonly string[]): string {
  return arr[Math.floor(Math.random() * arr.length)] ?? arr[0] ?? "";
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateBookingRef(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let ref = "";
  for (let i = 0; i < 6; i++) ref += chars[randomInt(0, chars.length - 1)];
  return ref;
}

function generatePnr(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let pnr = "";
  for (let i = 0; i < 6; i++) pnr += chars[randomInt(0, chars.length - 1)];
  return pnr;
}

function generateTicketNumber(airlineCode: string, index: number): string {
  const base = airlineCode === "6E" ? "806" : airlineCode === "AI" ? "098" : "157";
  const serial = String(randomInt(1000000000, 9999999999)).slice(0, 10);
  return `${base}-${serial}-${String(index + 1).padStart(2, "0")}`;
}

function simulatedProviderResponse(type: string, ref: string): Record<string, unknown> {
  return {
    provider: "DUMMY_AIRLINE_PROVIDER",
    type,
    reference: ref,
    timestamp: new Date().toISOString(),
    simulatorVersion: "1.0.0",
    bookingEngine: "DummyBookingAdapter",
  };
}

@Injectable()
export class DummyBookingAdapter extends BookingProviderAdapter {
  readonly providerName = "DummyBookingSimulator";
  private readonly logger = new Logger(DummyBookingAdapter.name);

  async book(request: BookingRequest): Promise<BookingResult> {
    this.logger.log({ event: "DUMMY_BOOKING_STARTED", bookingId: request.bookingId });
    await this.simulateLatency(800, 2000);

    const airlineCode = pick(AIRLINES);
    const bookingRef = generateBookingRef();
    const pnr = generatePnr();
    const passengerCount = Math.max(1, parseInt(request.passengers ?? "1", 10) || 1);
    const ticketNumbers: string[] = [];

    for (let i = 0; i < passengerCount; i++) {
      ticketNumbers.push(generateTicketNumber(airlineCode, i));
    }

    this.logger.log({ event: "DUMMY_BOOKING_COMPLETED", bookingId: request.bookingId, ref: bookingRef, pnr });
    return {
      success: true,
      providerBookingRef: bookingRef,
      providerPnr: pnr,
      ticketNumbers,
      providerStatus: "CONFIRMED",
      providerResponse: {
        ...simulatedProviderResponse("book", bookingRef),
        airlineCode,
        bookingRef,
        pnr,
        ticketNumbers,
        passengers: passengerCount,
        route: `${request.originCity ?? pick(CITIES)} → ${request.destinationCity ?? pick(CITIES)}`,
        status: "CONFIRMED",
      },
      errorMessage: null,
    };
  }

  async cancel(request: CancellationRequest): Promise<CancellationResult> {
    this.logger.log({ event: "DUMMY_CANCELLATION_STARTED", cancellationId: request.cancellationId });
    await this.simulateLatency(600, 1500);

    const cancellationRef = `CNL-${generateBookingRef()}`;
    const refundRef = `RFN-${generateBookingRef()}`;
    const originalAmount = 15000;
    const penalty = Math.round(originalAmount * (randomInt(15, 35) / 100));
    const refundAmount = originalAmount - penalty;

    this.logger.log({ event: "DUMMY_CANCELLATION_COMPLETED", cancellationId: request.cancellationId, refundRef });
    return {
      success: true,
      providerCancellationRef: cancellationRef,
      providerRefundRef: refundRef,
      refundAmount,
      refundCurrency: "INR",
      refundStatus: "PROCESSING_REFUND",
      providerResponse: {
        ...simulatedProviderResponse("cancel", refundRef),
        cancellationRef,
        originalBookingRef: request.providerBookingRef,
        pnr: request.providerPnr,
        reason: request.reason ?? "Customer requested",
        penalty,
        refundAmount,
        currency: "INR",
        status: "CANCELLED_PENDING_REFUND",
      },
      errorMessage: null,
    };
  }

  async checkHealth(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: "DummyBookingSimulator is always available" };
  }

  private async simulateLatency(minMs: number, maxMs: number): Promise<void> {
    const delay = randomInt(minMs, maxMs);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
