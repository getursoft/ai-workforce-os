export interface BookingRequest {
  organizationId: string;
  bookingId: string;
  originCity: string | null;
  destinationCity: string | null;
  travelDates: string | null;
  passengers: string | null;
  cabinClass: string | null;
  budgetAmount: number | null;
  budgetCurrency: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  selectedOptions: Record<string, unknown>[];
  flightDetails: Record<string, unknown>;
  hotelDetails: Record<string, unknown>;
  itinerary: Record<string, unknown>;
  travellerSummary: Record<string, unknown>;
}

export interface BookingResult {
  success: boolean;
  providerBookingRef: string | null;
  providerPnr: string | null;
  ticketNumbers: string[];
  providerStatus: string;
  providerResponse: Record<string, unknown>;
  errorMessage: string | null;
}

export interface CancellationRequest {
  organizationId: string;
  cancellationId: string;
  bookingId: string;
  providerBookingRef: string | null;
  providerPnr: string | null;
  reason: string | null;
}

export interface CancellationResult {
  success: boolean;
  providerCancellationRef: string | null;
  providerRefundRef: string | null;
  refundAmount: number;
  refundCurrency: string;
  refundStatus: string;
  providerResponse: Record<string, unknown>;
  errorMessage: string | null;
}

export abstract class BookingProviderAdapter {
  abstract readonly providerName: string;
  abstract book(request: BookingRequest): Promise<BookingResult>;
  abstract cancel(request: CancellationRequest): Promise<CancellationResult>;
  abstract checkHealth(): Promise<{ ok: boolean; message: string }>;
}
