import type { ApiClient } from "../../lib/api-client";

export type ChannelConnectionStatus = "DRAFT" | "ACTIVE" | "DISABLED";

export interface ChannelConnection {
  id: string;
  name: string;
  provider: "TWILIO";
  channelType: "WHATSAPP";
  status: ChannelConnectionStatus;
  agentId: string;
  agent: { id: string; displayName: string; status: string };
  configuration: { accountSid?: string; fromNumber?: string };
  hasAuthToken: boolean;
  webhookUrl: string;
  lastTestedAt: string | null;
  lastTestStatus: string | null;
  lastErrorCode: string | null;
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

export function createChannelApi(client: ApiClient) {
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
      provider: "TWILIO";
      channelType: "WHATSAPP";
      agentId: string;
      configuration: ChannelConfigurationInput;
    }) =>
      client.request<ChannelConnection>("/channels", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    update: (
      id: string,
      body: { name?: string; agentId?: string; configuration?: ChannelConfigurationInput }
    ) =>
      client.request<ChannelConnection>(`/channels/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body)
      }),
    remove: (id: string) => client.request<unknown>(`/channels/${id}`, { method: "DELETE" }),
    test: (id: string) =>
      client.request<{ success: boolean }>(`/channels/${id}/test`, { method: "POST" }),
    enable: (id: string) =>
      client.request<ChannelConnection>(`/channels/${id}/enable`, { method: "POST" }),
    disable: (id: string) =>
      client.request<ChannelConnection>(`/channels/${id}/disable`, { method: "POST" }),
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
