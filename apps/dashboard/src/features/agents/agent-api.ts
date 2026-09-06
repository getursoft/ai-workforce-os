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
  receptionist?: ReceptionistResult;
}
export interface ReceptionistResult {
  routeType: string;
  decisionSource: string;
  confidence: number;
  reasonCode: string;
  handoff: {
    id: string;
    status: string;
    targetEmployeeInstallationId: string;
    targetDisplayName: string;
    displayMode: "TRANSPARENT_HANDOFF" | "RECEPTIONIST_PROXY";
  } | null;
}
export interface ReceptionistFrontDoor {
  enabled: boolean;
  reasonCode:
    "RECEPTIONIST_NOT_INSTALLED" | "RECEPTIONIST_DISABLED" | "RECEPTIONIST_NOT_CONFIGURED" | null;
  installationId: string | null;
  pluginInstallationId: string | null;
  employeeKey: string | null;
  displayName: string;
  description: string;
}
export interface Conversation {
  id: string;
  title: string;
  status: "ACTIVE" | "ARCHIVED";
  updatedAt: string;
  pluginInstallation: { displayName: string };
  createdBy: { firstName: string; lastName: string | null } | null;
  _count: { messages: number };
}
export interface ConversationMessage {
  id: string;
  role: "SYSTEM" | "USER" | "ASSISTANT" | "TOOL";
  content: string;
  createdAt: string;
  toolExecutionId: string | null;
  contentJson?: {
    receptionist?: ReceptionistResult;
    attachments?: Array<
      | { type: "PDF_TICKET"; bookingId: string; url: string; filename: string }
      | { type: "CONVERSATION_LINK"; employeeInstallationId: string; conversationId: string; label: string }
    >;
  } | null;
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
    receptionistFrontDoor: () => client.request<ReceptionistFrontDoor>("/receptionist/front-door"),
    run: (body: {
      pluginInstallationId: string;
      conversationId?: string;
      message: string;
      attachmentIds?: string[];
    }) =>
      client.request<AgentRunResult>("/agents/run", { method: "POST", body: JSON.stringify(body) }),
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
