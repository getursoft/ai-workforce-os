import type { ApiClient } from "../../lib/api-client";

export type InteractionStatus = "OPEN" | "ACTIVE" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type InteractionChannel = "WEB_CHAT" | "WHATSAPP" | "VOICE";

export interface InteractionSummary {
  id: string;
  referenceId: string;
  channel: InteractionChannel;
  transport: string | null;
  status: InteractionStatus;
  conversationId: string | null;
  voiceSessionId: string | null;
  channelConnectionId: string | null;
  entryAgentId: string | null;
  currentAgentId: string | null;
  phoneNumber: string | null;
  email: string | null;
  startedAt: string;
  lastActivityAt: string;
  completedAt: string | null;
  resolutionSummary: string | null;
  referenceCommunicatedAt: string | null;
}

export interface InteractionNotification {
  id: string;
  type: "EMAIL" | "SMS" | "WHATSAPP";
  destinationMasked: string;
  provider: string;
  status: "PENDING" | "SENT" | "DELIVERED" | "FAILED" | "SKIPPED";
  providerMessageId: string | null;
  failureReason: string | null;
  requestedAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
}

export interface InteractionPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export function createInteractionApi(client: ApiClient) {
  return {
    list: (
      query: {
        page?: number;
        pageSize?: number;
        status?: InteractionStatus;
        channel?: InteractionChannel;
        agentId?: string;
        dateFrom?: string;
        dateTo?: string;
      } = {}
    ) =>
      client.request<InteractionPage<InteractionSummary>>(
        `/interactions?${new URLSearchParams(
          Object.entries(query)
            .filter(([, value]) => value !== undefined && value !== "")
            .map(([key, value]) => [key, String(value)])
        )}`
      ),
    get: (id: string) => client.request<InteractionSummary>(`/interactions/${id}`),
    getByReference: (referenceId: string) =>
      client.request<InteractionSummary>(`/interactions/reference/${encodeURIComponent(referenceId)}`),
    notifications: (id: string) => client.request<InteractionNotification[]>(`/interactions/${id}/notifications`)
  };
}
