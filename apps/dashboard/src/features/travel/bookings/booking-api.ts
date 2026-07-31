import type { ApiClient } from "../../../lib/api-client";

export interface TravelBooking {
  id: string;
  organizationId: string;
  pluginInstallationId: string;
  conversationId: string;
  status: string;
  originCity: string | null;
  destinationCity: string | null;
  travelDates: string | null;
  passengers: string | null;
  cabinClass: string | null;
  budgetAmount: number | null;
  budgetCurrency: string | null;
  quotedAmount: number | null;
  quotedCurrency: string | null;
  providerBookingRef: string | null;
  providerPnr: string | null;
  providerStatus: string | null;
  ticketNumbersJson: string[];
  emailDeliveryStatus: string | null;
  mobileDeliveryStatus: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface BookingTimelineEntry {
  status: string;
  timestamp: string;
  actor?: string;
  detail?: string;
}

export function createBookingApi(client: ApiClient, orgId: string) {
  return {
    list: (params?: { status?: string; limit?: number; offset?: number }) => {
      const q = new URLSearchParams({ organizationId: orgId });
      if (params?.status) q.set("status", params.status);
      if (params?.limit) q.set("limit", String(params.limit));
      if (params?.offset) q.set("offset", String(params.offset));
      return client.request<{ items: TravelBooking[]; total: number }>(
        `/travel/bookings?${q.toString()}`
      );
    },

    get: (id: string) => {
      const q = new URLSearchParams({ organizationId: orgId });
      return client.request<TravelBooking>(`/travel/bookings/${id}?${q.toString()}`);
    },

    timeline: (id: string) => {
      const q = new URLSearchParams({ organizationId: orgId });
      return client.request<BookingTimelineEntry[]>(`/travel/bookings/${id}/timeline?${q.toString()}`);
    },

    downloadTicket: (id: string) => client.requestBlob(`/travel/bookings/${id}/ticket.pdf`),

    submitToProvider: (id: string) =>
      client.request<{ submitted: boolean }>(`/travel/bookings/${id}/submit-to-provider`, {
        method: "POST",
        body: JSON.stringify({ organizationId: orgId }),
      }),

    requestCancellation: (id: string, reason?: string) =>
      client.request<{ id: string; status: string }>(`/travel/bookings/${id}/request-cancellation`, {
        method: "POST",
        body: JSON.stringify({ organizationId: orgId, reason }),
      }),

    approveCancellation: (cancellationId: string, userId: string) =>
      client.request<unknown>(`/travel/cancellations/${cancellationId}/approve`, {
        method: "POST",
        body: JSON.stringify({ organizationId: orgId, userId }),
      }),

    rejectCancellation: (cancellationId: string, userId: string) =>
      client.request<unknown>(`/travel/cancellations/${cancellationId}/reject`, {
        method: "POST",
        body: JSON.stringify({ organizationId: orgId, userId }),
      }),
  };
}
