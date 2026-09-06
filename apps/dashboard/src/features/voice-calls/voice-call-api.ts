import type { ApiClient } from "../../lib/api-client";

export type VoiceSessionStatus = "CREATED" | "RINGING" | "CONNECTING" | "ACTIVE" | "INTERRUPTED" | "ENDING" | "ENDED" | "FAILED";
export type VoiceTransport = "WHATSAPP" | "PSTN" | "WEBRTC" | "SIMULATOR";
export type VoiceDirection = "INBOUND" | "OUTBOUND";

export interface VoiceSessionSummary {
  id: string;
  channelConnectionId: string;
  receptionistConversationId: string | null;
  activeHandoffId: string | null;
  provider: string;
  providerCallId: string;
  providerStreamId: string | null;
  callerId: string | null;
  transport: VoiceTransport;
  direction: VoiceDirection;
  status: VoiceSessionStatus;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  lastActivityAt: string | null;
  durationSeconds: number | null;
  terminationReason: string | null;
  speechEndToAckMs: number | null;
  routingMs: number | null;
  specialistFirstResponseMs: number | null;
  totalTurnMs: number | null;
}

export interface VoiceHandoff {
  id: string;
  status: string;
  targetEmployeeInstallationId: string;
  targetConversationId: string | null;
  routingIntent: string | null;
  routingCapability: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface VoiceSessionDetail extends VoiceSessionSummary {
  handoffs: VoiceHandoff[];
}

export interface VoiceTranscriptSegment {
  id: string;
  speaker: "USER" | "AGENT" | "SYSTEM";
  text: string;
  isFinal: boolean;
  startedAt: string | null;
  endedAt: string | null;
  confidence: number | null;
  sequenceNumber: number;
  createdAt: string;
}

export interface VoicePage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export function createVoiceCallApi(client: ApiClient) {
  return {
    list: (
      query: {
        page?: number;
        pageSize?: number;
        status?: VoiceSessionStatus;
        transport?: VoiceTransport;
        channelConnectionId?: string;
        agentId?: string;
        dateFrom?: string;
        dateTo?: string;
      } = {}
    ) =>
      client.request<VoicePage<VoiceSessionSummary>>(
        `/voice/sessions?${new URLSearchParams(
          Object.entries(query)
            .filter(([, value]) => value !== undefined && value !== "")
            .map(([key, value]) => [key, String(value)])
        )}`
      ),
    get: (id: string) => client.request<VoiceSessionDetail>(`/voice/sessions/${id}`),
    transcript: (id: string, page = 1) =>
      client.request<VoicePage<VoiceTranscriptSegment>>(`/voice/sessions/${id}/transcript?page=${page}&pageSize=50`)
  };
}
