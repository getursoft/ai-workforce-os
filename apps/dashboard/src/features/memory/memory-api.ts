import type { ApiClient } from "../../lib/api-client";

export type MemoryScope = "USER" | "EMPLOYEE" | "ORGANIZATION" | "CONVERSATION" | "GLOBAL";
export type MemoryImportance = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type MemorySource =
  | "CONVERSATION"
  | "DASHBOARD"
  | "TOOL"
  | "SYSTEM"
  | "RULE_EXTRACTION"
  | "LLM_EXTRACTION"
  | "IMPORT";

export interface MemoryRecord {
  id: string;
  organizationId: string;
  employeeId: string | null;
  userId: string | null;
  conversationId: string | null;
  scope: MemoryScope;
  category: string;
  key: string;
  value: Record<string, unknown>;
  searchableText: string | null;
  confidence: number;
  importance: MemoryImportance;
  source: MemorySource;
  metadata: Record<string, unknown>;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface MemorySearchHit extends MemoryRecord {
  score: number;
  semanticScore: number;
  keywordScore: number;
}

export interface MemoryListFilters {
  scope?: MemoryScope;
  category?: string;
  key?: string;
  employeeId?: string;
  conversationId?: string;
  importance?: MemoryImportance;
  source?: MemorySource;
  search?: string;
}

export interface MemoryAuditEvent {
  id: string;
  actorId: string | null;
  memoryId: string;
  action: string;
  scope: MemoryScope;
  key: string;
  category: string;
  changeSummary: string | null;
  createdAt: string;
}

type Page<T> = { items: T[]; total: number };

export function createMemoryApi(client: ApiClient) {
  return {
    list: (filters: MemoryListFilters, page = 1, pageSize = 20) => {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      if (filters.scope) params.set("scope", filters.scope);
      if (filters.category) params.set("category", filters.category);
      if (filters.key) params.set("key", filters.key);
      if (filters.employeeId) params.set("employeeId", filters.employeeId);
      if (filters.conversationId) params.set("conversationId", filters.conversationId);
      if (filters.importance) params.set("importance", filters.importance);
      if (filters.source) params.set("source", filters.source);
      if (filters.search) params.set("search", filters.search);
      return client.request<Page<MemoryRecord>>(`/memory?${params.toString()}`);
    },
    create: (body: {
      scope: MemoryScope;
      key: string;
      value: Record<string, unknown>;
      category?: string;
      employeeId?: string;
      conversationId?: string;
      confidence?: number;
      importance?: MemoryImportance;
      source?: MemorySource;
      searchableText?: string;
      expiresAt?: string;
    }) => client.request<MemoryRecord>("/memory", { method: "POST", body: JSON.stringify(body) }),
    update: (id: string, body: {
      value?: Record<string, unknown>;
      searchableText?: string;
      metadata?: Record<string, unknown>;
      confidence?: number;
      importance?: MemoryImportance;
      category?: string;
      key?: string;
      expiresAt?: string | null;
    }) =>
      client.request<MemoryRecord>(`/memory/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    remove: (id: string) => client.request<undefined>(`/memory/${id}`, { method: "DELETE" }),
    search: (body: {
      query: string;
      employeeId?: string;
      conversationId?: string;
      scope?: MemoryScope;
      limit?: number;
      minScore?: number;
      semantic?: boolean;
    }) =>
      client.request<MemorySearchHit[]>("/memory/search", { method: "POST", body: JSON.stringify(body) }),
    recall: (body: { employeeId?: string; conversationId?: string }) =>
      client.request<{
        organization: MemoryRecord[];
        employee: MemoryRecord[];
        user: MemoryRecord[];
        conversationSummary: string | null;
      }>("/memory/recall", { method: "POST", body: JSON.stringify(body) }),
    summarize: (conversationId: string) =>
      client.request<{ summary: string; version: number; summarizedMessageCount: number }>(
        "/memory/summarize",
        { method: "POST", body: JSON.stringify({ conversationId }) }
      ),
    forget: (body: { scope?: MemoryScope; category?: string; key?: string; employeeId?: string; conversationId?: string }) =>
      client.request<{ count: number; ids: string[] }>("/memory/forget", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    merge: (ids: string[]) =>
      client.request<{ survivor: MemoryRecord; merged: number }>("/memory/merge", {
        method: "POST",
        body: JSON.stringify({ ids })
      }),
    expire: (scope?: MemoryScope) =>
      client.request<{ expired: number }>("/memory/expire", {
        method: "POST",
        body: JSON.stringify(scope ? { scope } : {})
      }),
    audit: (page = 1) => client.request<Page<MemoryAuditEvent>>(`/memory/audit?page=${page}&pageSize=50`)
  };
}
