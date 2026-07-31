import type { ApiClient } from "../../lib/api-client";
export interface AgentEmployee {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  version: string;
  status: string;
  lastHealthStatus: string | null;
  grantedPermissions: string[];
  runtimeReady: boolean;
}
export interface AgentRunResult {
  conversationId: string;
  executionId: string;
  messageId: string;
  response: string;
  status: "COMPLETED" | "FAILED";
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCost: number | null;
  };
  sources: Array<{
    documentId: string;
    title: string;
    pageNumber: number | null;
    chunkIndex: number;
    score: number;
  }>;
  attachments?: Array<{
    type: "PDF_TICKET";
    bookingId: string;
    url: string;
    filename: string;
  }>;
}
export interface Conversation {
  id: string;
  title: string;
  status: "ACTIVE" | "ARCHIVED";
  updatedAt: string;
  pluginInstallation: { displayName: string };
  createdBy: { firstName: string; lastName: string | null };
  _count: { messages: number };
}
export interface ConversationMessage {
  id: string;
  role: "SYSTEM" | "USER" | "ASSISTANT" | "TOOL";
  content: string;
  createdAt: string;
  toolExecutionId: string | null;
}
export interface Execution {
  id: string;
  status: string;
  modelProvider: string | null;
  model: string | null;
  totalTokens: number;
  latencyMs: number | null;
  estimatedCost: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  conversationId: string;
  pluginInstallation: { displayName: string };
  user: { firstName: string; lastName: string | null };
  _count?: { toolExecutions: number };
  toolExecutions?: Array<{
    id: string;
    toolName: string;
    status: string;
    latencyMs: number | null;
  }>;
}
export interface ConversationAttachment {
  id: string;
  organizationId: string;
  pluginInstallationId: string;
  conversationId: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  extractedText: string;
  createdAt: string;
}

type Page<T> = { items: T[]; pagination: { page: number; pages: number; total: number } };
export function createAgentApi(client: ApiClient) {
  return {
    employees: () => client.request<AgentEmployee[]>("/agents"),
    run: (body: {
      pluginInstallationId: string;
      conversationId?: string;
      message: string;
      attachmentIds?: string[];
    }) => client.request<AgentRunResult>("/agents/run", { method: "POST", body: JSON.stringify(body) }),
    uploadAttachment: (conversationId: string, file: File) => {
      const form = new FormData();
      form.append("file", file);
      return client.request<ConversationAttachment>(
        `/conversations/${conversationId}/attachments`,
        { method: "POST", body: form }
      );
    },
    attachments: (conversationId: string) =>
      client.request<ConversationAttachment[]>(`/conversations/${conversationId}/attachments`),
    conversations: (page = 1) =>
      client.request<Page<Conversation>>(`/conversations?page=${page}&pageSize=20`),
    conversation: (id: string) => client.request<Conversation>(`/conversations/${id}`),
    messages: (id: string) =>
      client.request<ConversationMessage[]>(`/conversations/${id}/messages`),
    executions: (page = 1) =>
      client.request<Page<Execution>>(`/executions?page=${page}&pageSize=20`),
    execution: (id: string) => client.request<Execution>(`/executions/${id}`)
  };
}
