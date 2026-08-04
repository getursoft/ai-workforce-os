/**
 * Sprint 4.8 — Autonomous Scheduler & Background Execution Engine: shared contracts.
 *
 * The scheduler runs jobs in the background on Node's event loop (the same pattern as
 * WorkforceTaskProcessor), coordinated with durable rows so multiple API instances can never run the
 * same job twice. Every job handler below is registered in the JobRegistry by `key`; ScheduledJob rows
 * reference definitions by `definitionKey`.
 */

export type ScheduledJobStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED" | "FAILED";

export type ScheduledJobTriggerType =
  | "ONE_TIME"
  | "CRON"
  | "INTERVAL"
  | "DAILY"
  | "WEEKLY"
  | "MONTHLY"
  | "EVENT"
  | "DATE"
  | "AFTER_APPROVAL"
  | "AFTER_BOOKING"
  | "AFTER_WORKFLOW"
  | "AFTER_PAYMENT"
  | "AFTER_UPLOAD";

export type ScheduledJobPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT" | "CRITICAL";

export type ScheduledExecutionStatus =
  | "QUEUED"
  | "RUNNING"
  | "FAILED"
  | "RETRYING"
  | "COMPLETED"
  | "CANCELLED"
  | "TIMEOUT"
  | "DEAD_LETTERED";

/** Ordered priority index — higher wins when the executor claims QUEUED work. */
export const PRIORITY_ORDER: readonly ScheduledJobPriority[] = [
  "LOW",
  "NORMAL",
  "HIGH",
  "URGENT",
  "CRITICAL"
] as const;

export function priorityIndex(priority: ScheduledJobPriority): number {
  return PRIORITY_ORDER.indexOf(priority);
}

export type JobHandlerType =
  | "SEND_REMINDER"
  | "START_WORKFLOW"
  | "REQUEST_APPROVAL"
  | "PUBLISH_EVENT"
  | "RUN_AGENT"
  | "ESCALATE_APPROVAL"
  | "PENDING_APPROVAL_SCAN"
  | "DEAD_LETTER";

/** Everything a handler needs to do its work for one execution. */
export interface JobRunContext {
  organizationId: string;
  jobId: string;
  executionId: string;
  definitionKey: string;
  triggerType: ScheduledJobTriggerType;
  priority: ScheduledJobPriority;
  /** The AI Employee (Plugin installation) the job belongs to, when set. */
  employeeId: string | null;
  /** Opaque, typed payload the schedule was created with. */
  payload: Record<string, unknown>;
  /** Opaque entity context (bookingId, approvalRequestId, conversationId, workflowId, ...). */
  context: Record<string, unknown>;
  timezone: string;
  /** Sprint 4.7 traceId this run belongs to (may be null when sampling opted out). */
  traceId: string | null;
  attemptCount: number;
}

export interface JobRunResult {
  success: boolean;
  /** Structured outcome stored on the execution row. */
  result?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  tokens?: number;
  credits?: number;
}

/** A registered executable job handler. */
export interface JobHandler {
  key: string;
  handlerType: JobHandlerType;
  /** Optional filter: only schedule this handler for employees in these categories. */
  categories?: string[];
  execute(context: JobRunContext): Promise<JobRunResult>;
}

/** Result of creating/updating a schedule — the DTO-safe view the REST API returns. */
export interface ScheduledJobView {
  id: string;
  organizationId: string;
  employeeId: string | null;
  workflowId: string | null;
  definitionKey: string;
  triggerType: ScheduledJobTriggerType;
  cronExpression: string | null;
  intervalMs: number | null;
  timezone: string;
  status: ScheduledJobStatus;
  priority: ScheduledJobPriority;
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

export interface ScheduledExecutionView {
  id: string;
  organizationId: string;
  jobId: string;
  employeeId: string | null;
  definitionKey: string;
  triggerType: ScheduledJobTriggerType;
  priority: ScheduledJobPriority;
  status: ScheduledExecutionStatus;
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

/** Metrics snapshot returned by the monitoring endpoints. */
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
  worker: WorkerHealthView;
  recentExecutions: ScheduledExecutionView[];
  upcomingJobs: Array<{
    id: string;
    definitionKey: string;
    nextRun: string;
    priority: ScheduledJobPriority;
  }>;
}

export interface WorkerHealthView {
  workerId: string;
  status: "RUNNING" | "IDLE" | "STALE" | "STOPPED";
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

/** Domain events the scheduler can react to (Phase 4). Names match JobDefinition.eventName. */
export type SchedulerDomainEventName =
  | "booking.approved"
  | "booking.cancelled"
  | "leave.approved"
  | "approval.completed"
  | "payment.received"
  | "document.uploaded"
  | "knowledge.updated"
  | "lead.created"
  | "employee.assigned";

export interface SchedulerDomainEvent {
  name: SchedulerDomainEventName;
  organizationId: string;
  /** The AI Employee (Plugin installation) that owns the entity, when known. */
  employeeId?: string | null;
  entityType: string;
  entityId: string;
  /** Optional: the conversation/user the entity belongs to (for targeting reminders). */
  conversationId?: string | null;
  userId?: string | null;
  occurredAt: Date;
  payload?: Record<string, unknown>;
}
