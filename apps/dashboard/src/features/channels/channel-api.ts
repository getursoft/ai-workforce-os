import type { ApiClient } from "../../lib/api-client";

export type ChannelConnectionStatus = "DRAFT" | "CONNECTING" | "CONNECTED" | "ACTIVE" | "DEGRADED" | "FAILED" | "DISABLED";

export interface ChannelConnection {
  id: string;
  name: string;
  provider: "TWILIO" | "META_CLOUD_API";
  channelType: "WHATSAPP";
  status: ChannelConnectionStatus;
  agentId: string;
  agent: { id: string; displayName: string; status: string };
  configuration: {
    accountSid?: string;
    fromNumber?: string;
    metaAppId?: string;
    apiVersion?: string;
  };
  whatsappBusinessAccountId?: string;
  phoneNumberId?: string;
  displayPhoneNumber?: string;
  assignedAgentId?: string;
  onboardingMode?: string;
  hasAuthToken: boolean;
  webhookUrl: string;
  routingMode?: string;
  defaultEmployeeId?: string;
  allowedEmployeeIds?: string[];
  receptionistGreeting?: string;
  intentQuestion?: string;
  outOfScopeMessage?: string;
  ambiguousIntentMessage?: string;
  lastTestedAt: string | null;
  lastTestStatus: string | null;
  lastErrorCode: string | null;
  lastWebhookReceivedAt: string | null;
  lastErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelConversation {
  id: string;
  externalUserId: string | null;
  status: "ACTIVE" | "ARCHIVED";
  title: string;
  createdAt: string;
  updatedAt: string;
  _count: { messages: number };
}

export interface ChannelMessage {
  id: string;
  conversationId: string | null;
  direction: "INBOUND" | "OUTBOUND";
  status: "RECEIVED" | "PROCESSING" | "SENT" | "FAILED";
  fromAddress: string;
  toAddress: string;
  body: string | null;
  mediaMetadata: Array<{ url: string; contentType: string }>;
  errorCode: string | null;
  createdAt: string;
  receivedAt: string | null;
  sentAt: string | null;
}

export interface ChannelPage<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
}

export interface ChannelConfigurationInput {
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
}

export interface MetaChannelConfigurationInput {
  metaAppId?: string;
  metaAppSecret?: string;
  whatsappBusinessAccountId?: string;
  phoneNumberId?: string;
  displayPhoneNumber?: string;
  accessToken?: string;
  webhookVerifyToken?: string;
  apiVersion?: string;
}

export function createChannelApi(client: ApiClient) {
  const base = (path: string) => client.request<unknown>(`/channels${path}`);
  return {
    list: (query: { page?: number; pageSize?: number; search?: string; status?: string } = {}) =>
      client.request<ChannelPage<ChannelConnection>>(
        `/channels?${new URLSearchParams(
          Object.entries(query)
            .filter(([, value]) => value !== undefined && value !== "")
            .map(([key, value]) => [key, String(value)])
        )}`
      ),
    get: (id: string) => client.request<ChannelConnection>(`/channels/${id}`),
    create: (body: {
      name: string;
      provider: "TWILIO" | "META_CLOUD_API";
      channelType: "WHATSAPP";
      agentId: string;
      configuration: ChannelConfigurationInput | MetaChannelConfigurationInput;
    }) =>
      client.request<ChannelConnection>("/channels", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    update: (
      id: string,
      body: {
        name?: string;
        agentId?: string;
        configuration?: ChannelConfigurationInput | MetaChannelConfigurationInput;
      }
    ) =>
      client.request<ChannelConnection>(`/channels/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body)
      }),
    updateRouting: (id: string, body: {
      routingMode?: string;
      defaultEmployeeId?: string;
      allowedEmployeeIds?: string[];
      receptionistGreeting?: string;
      intentQuestion?: string;
      outOfScopeMessage?: string;
      ambiguousIntentMessage?: string;
    }) => client.request<ChannelConnection>(`/channels/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body)
    }),
    remove: (id: string) => base(`/${id}`) as Promise<unknown>,
    test: (id: string) =>
      client.request<{ status: string }>(`/channels/${id}/test`, { method: "POST" }),
    enable: (id: string) => base(`/${id}/enable`),
    disable: (id: string) => base(`/${id}/disable`),
    conversations: (id: string, page = 1) =>
      client.request<ChannelPage<ChannelConversation>>(
        `/channels/${id}/conversations?page=${page}&pageSize=20`
      ),
    messages: (id: string, conversationId?: string, page = 1) =>
      client.request<ChannelPage<ChannelMessage>>(
        `/channels/${id}/messages?page=${page}&pageSize=50${
          conversationId ? `&conversationId=${conversationId}` : ""
        }`
      )
  };
}
