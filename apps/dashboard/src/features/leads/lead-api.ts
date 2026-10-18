import type { ApiClient } from "../../lib/api-client";

export type LeadSource = "WEB_CHAT" | "WHATSAPP" | "VOICE" | "MANUAL" | "API" | "OTHER";
export type LeadStatus = "NEW" | "CONTACTED" | "QUALIFIED" | "FOLLOW_UP" | "CONVERTED" | "LOST";
export type LeadPriority = "LOW" | "MEDIUM" | "HIGH";
export type LeadActivityType =
  | "CREATED"
  | "UPDATED"
  | "STATUS_CHANGED"
  | "ASSIGNED"
  | "NOTE_ADDED"
  | "CONTACTED"
  | "CONVERTED"
  | "LOST";

export interface Lead {
  id: string;
  organizationId: string;
  leadReferenceId: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: LeadSource;
  agentId: string | null;
  conversationId: string | null;
  interactionId: string | null;
  voiceSessionId: string | null;
  requirement: string | null;
  status: LeadStatus;
  priority: LeadPriority;
  assignedToUserId: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  convertedAt: string | null;
  lostAt: string | null;
}

export interface LeadActivity {
  id: string;
  leadId: string;
  type: LeadActivityType;
  note: string | null;
  metadata: Record<string, unknown>;
  actorUserId: string | null;
  createdAt: string;
}

export interface LeadSummary {
  total: number;
  new: number;
  contacted: number;
  qualified: number;
  followUp: number;
  converted: number;
  lost: number;
}

export interface LeadPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ListLeadsQuery {
  page?: number;
  pageSize?: number;
  status?: LeadStatus;
  source?: LeadSource;
  agentId?: string;
  assignedToUserId?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
}

function toQuery(query: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams(
    Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => [key, String(value)])
  );
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function createLeadApi(client: ApiClient) {
  return {
    summary: () => client.request<LeadSummary>("/leads/summary"),
    list: (query: ListLeadsQuery = {}) =>
      client.request<LeadPage<Lead>>(`/leads${toQuery({ ...query })}`),
    get: (id: string) => client.request<Lead>(`/leads/${id}`),
    getByReference: (referenceId: string) =>
      client.request<Lead>(`/leads/reference/${encodeURIComponent(referenceId)}`),
    activity: (id: string) => client.request<LeadActivity[]>(`/leads/${id}/activity`),
    create: (input: {
      name?: string;
      phone?: string;
      email?: string;
      requirement?: string;
      priority?: LeadPriority;
      assignedToUserId?: string;
    }) => client.request<Lead>("/leads", { method: "POST", body: JSON.stringify(input) }),
    update: (
      id: string,
      input: Partial<{
        name: string;
        phone: string;
        email: string;
        requirement: string;
        status: LeadStatus;
        priority: LeadPriority;
      }>
    ) => client.request<Lead>(`/leads/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
    addNote: (id: string, note: string) =>
      client.request<void>(`/leads/${id}/notes`, { method: "POST", body: JSON.stringify({ note }) }),
    assign: (id: string, assignedToUserId: string | null) =>
      client.request<Lead>(`/leads/${id}/assign`, {
        method: "POST",
        body: JSON.stringify({ assignedToUserId })
      })
  };
}
