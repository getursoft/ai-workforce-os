import type { ApiClient } from "../../lib/api-client";

export interface ObservabilityOverview {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  successRate: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  tokens: { inputTokens: number; outputTokens: number; totalTokens: number };
  estimatedCredits: number;
  runningWorkflows: number;
  stuckWorkflows: number;
  activeDelegatedTasks: number;
  openAlerts: number;
  stuckWorkflowDetails: Array<{ workflowExecutionId: string; workflowType: string; status: string; reason: string; sinceMinutes: number }>;
  stuckTaskDetails: Array<{ taskId: string; status: string; reason: string; overdueMinutes: number }>;
}

export interface TraceListItem {
  id: string;
  traceId: string;
  conversationId: string | null;
  agentExecutionId: string | null;
  workflowExecutionId: string | null;
  delegatedTaskId: string | null;
  channelConnectionId: string | null;
  actorType: string;
  actorId: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
}

export interface TracePage {
  items: TraceListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SpanNode {
  id: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  spanType: string;
  component: string;
  employeeInstallationId: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
  attributes: Record<string, unknown> | null;
  children: SpanNode[];
}

export interface TraceTree {
  trace: TraceListItem;
  root: SpanNode | null;
  orphanSpans: SpanNode[];
}

export interface ObservabilityMetrics {
  overview: ObservabilityOverview;
  executionsOverTime: Array<{ day: string; total: number; failed: number; p50LatencyMs: number | null }>;
  failuresByEmployee: Array<{ employeeInstallationId: string; failureCount: number }>;
  failuresByWorkflowType: Array<{ workflowType: string; failureCount: number }>;
  approvalWait: { averageMs: number | null; maxMs: number | null; sampleCount: number };
}

export interface ObservabilityAlert {
  id: string;
  ruleCode: string;
  severity: string;
  status: string;
  title: string;
  detailsJson: Record<string, unknown>;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type HealthStatus = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";

export interface ComponentHealth {
  component: string;
  status: HealthStatus;
  detail: string;
  latencyMs: number | null;
  checkedAt: string;
}

export interface ErrorFingerprint {
  fingerprint: string;
  component: string;
  errorCode: string;
  employeeInstallationId: string | null;
  workflowExecutionId: string | null;
  occurrenceCount: number;
  affectedTraceCount: number;
  firstSeen: string;
  lastSeen: string;
  retryable: boolean;
  resolved: boolean;
}

function qs(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
  const value = query.toString();
  return value ? `?${value}` : "";
}

export function createObservabilityApi(client: ApiClient) {
  return {
    overview: () => client.request<ObservabilityOverview>("/observability/overview"),
    health: () => client.request<ComponentHealth[]>("/observability/health"),
    listTraces: (filters: { status?: string; page?: number; pageSize?: number } = {}) =>
      client.request<TracePage>(`/observability/traces${qs(filters)}`),
    getTraceTree: (traceId: string) => client.request<TraceTree>(`/observability/traces/${traceId}/tree`),
    metrics: () => client.request<ObservabilityMetrics>("/observability/metrics"),
    errors: () => client.request<ErrorFingerprint[]>("/observability/errors"),
    listAlerts: (status?: string) => client.request<ObservabilityAlert[]>(`/observability/alerts${qs({ status })}`),
    acknowledgeAlert: (id: string) => client.request<ObservabilityAlert>(`/observability/alerts/${id}/acknowledge`, { method: "POST" }),
    retryTask: (id: string) => client.request(`/observability/tasks/${id}/retry`, { method: "POST" }),
    resumeWorkflow: (id: string) => client.request(`/observability/workflows/${id}/resume`, { method: "POST" })
  };
}
