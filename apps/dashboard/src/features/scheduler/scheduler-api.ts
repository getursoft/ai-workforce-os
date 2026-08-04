import type { ApiClient } from "../../lib/api-client";

export interface SchedulerJob {
  id: string;
  organizationId: string;
  employeeId: string | null;
  workflowId: string | null;
  definitionKey: string;
  triggerType: string;
  cronExpression: string | null;
  intervalMs: number | null;
  timezone: string;
  status: string;
  priority: string;
  nextRun: string | null;
  lastRun: string | null;
  retryCount: number;
  maxRetry: number;
  timeoutMs: number;
  payload: Record<string, unknown>;
  context: Record<string, unknown>;
  dedupeKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulerExecution {
  id: string;
  organizationId: string;
  jobId: string;
  employeeId: string | null;
  definitionKey: string;
  triggerType: string;
  priority: string;
  status: string;
  scheduledFor: string;
  attemptCount: number;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  nextAttemptAt: string | null;
  traceId: string | null;
  workerId: string | null;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  tokens: number;
  credits: number;
  createdAt: string;
}

export interface SchedulerOverview {
  running: number;
  queued: number;
  completed: number;
  failed: number;
  retrying: number;
  cancelled: number;
  timeout: number;
  deadLettered: number;
  averageDurationMs: number | null;
  totalJobs: number;
  activeJobs: number;
  pausedJobs: number;
  queueSize: number;
  worker: WorkerHealth;
  recentExecutions: SchedulerExecution[];
  upcomingJobs: Array<{ id: string; definitionKey: string; nextRun: string; priority: string }>;
}

export interface WorkerHealth {
  workerId: string;
  status: string;
  pid: number;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  lastPollAt: string | null;
  runningJobs: number;
  completedJobs: number;
  failedJobs: number;
  retriedJobs: number;
  cpuTimeMs: number;
  memoryMb: number;
  uptimeSec: number;
  queueLatencyMs: number | null;
  pollIntervalMs: number;
}

export interface JobDefinition {
  id: string;
  key: string;
  name: string;
  description: string;
  category: string;
  handlerType: string;
  retryPolicy: string;
  maxRetry: number;
  timeoutMs: number;
  eventName: string | null;
  enabled: boolean;
}

export interface JobTemplate {
  id: string;
  name: string;
  description: string;
  definitionKey: string;
  triggerType: string;
  cronExpression: string | null;
  intervalMs: number | null;
  timezone: string;
  priority: string;
  payload: Record<string, unknown>;
  global: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
}

function qs(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) query.set(key, String(value));
  const value = query.toString();
  return value ? `?${value}` : "";
}

export function createSchedulerApi(client: ApiClient) {
  return {
    overview: () => client.request<SchedulerOverview>("/scheduler/overview"),
    workerHealth: () => client.request<WorkerHealth>("/scheduler/worker/health"),
    definitions: () => client.request<JobDefinition[]>("/scheduler/definitions"),
    templates: () => client.request<JobTemplate[]>("/scheduler/templates"),
    upcoming: () =>
      client.request<
        Array<{ id: string; definitionKey: string; nextRun: string; priority: string }>
      >("/scheduler/upcoming"),
    listJobs: (
      filters: {
        status?: string;
        triggerType?: string;
        definitionKey?: string;
        page?: number;
        pageSize?: number;
      } = {}
    ) => client.request<Page<SchedulerJob>>(`/scheduler/jobs${qs(filters)}`),
    getJob: (id: string) => client.request<SchedulerJob>(`/scheduler/jobs/${id}`),
    createJob: (body: Record<string, unknown>) =>
      client.request<SchedulerJob>("/scheduler/jobs", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" }
      }),
    createOneShot: (body: Record<string, unknown>) =>
      client.request<SchedulerJob>("/scheduler/jobs/one-shot", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" }
      }),
    pauseJob: (id: string) =>
      client.request<SchedulerJob>(`/scheduler/jobs/${id}/pause`, { method: "POST" }),
    resumeJob: (id: string) =>
      client.request<SchedulerJob>(`/scheduler/jobs/${id}/resume`, { method: "POST" }),
    cancelJob: (id: string) =>
      client.request<SchedulerJob>(`/scheduler/jobs/${id}/cancel`, { method: "POST" }),
    instantiateTemplate: (id: string, body: Record<string, unknown> = {}) =>
      client.request<SchedulerJob>(`/scheduler/templates/${id}/instantiate`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" }
      }),
    listExecutions: (
      filters: { status?: string; jobId?: string; page?: number; pageSize?: number } = {}
    ) => client.request<Page<SchedulerExecution>>(`/scheduler/executions${qs(filters)}`),
    getExecution: (id: string) => client.request<SchedulerExecution>(`/scheduler/executions/${id}`),
    retryExecution: (id: string) =>
      client.request<SchedulerExecution>(`/scheduler/executions/${id}/retry`, { method: "POST" })
  };
}
