import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import { ObservabilityMetricsService } from "./observability-metrics.service";
import { sanitizeForTrace } from "./observability-sanitizer";

export interface AlertCandidate {
  ruleCode: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  title: string;
  details: Record<string, unknown>;
  relatedEntityType?: string;
  relatedEntityId?: string;
  relatedTraceId?: string;
}

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const QUEUE_BACKLOG_THRESHOLD = 20;
const EMPLOYEE_FAILURE_RATE_THRESHOLD = 0.5;
const EMPLOYEE_FAILURE_MIN_SAMPLES = 5;

/**
 * Sprint 4.7 Phase 16: in-app operational alerts, computed on read from existing trace/workflow/task/
 * approval/channel state (no external PagerDuty/Slack integration, no background cron in this pass —
 * `sync()` is called by the observability overview/alerts read paths and is safe to call redundantly).
 * Deduplicated per (organizationId, ruleCode, relatedEntityType, relatedEntityId): a repeatedly-detected
 * condition updates one OPEN row's detailsJson/updatedAt instead of spawning duplicates.
 */
@Injectable()
export class ObservabilityAlertsService {
  private readonly logger = new Logger(ObservabilityAlertsService.name);
  // Sprint 4.7A fix: the dashboard calls both GET /overview and GET /alerts in parallel, and each calls
  // sync() independently. upsertOpenAlert()'s findFirst-then-create isn't atomic, so two concurrent sync()
  // calls for the same org could both see "no existing alert" and both insert — a real, observed duplicate
  // (confirmed in the dev DB: two WORKFLOW_STUCK rows for the same workflowExecutionId, identical
  // millisecond timestamp). Rather than a schema migration for a unique constraint, concurrent callers for
  // the same organization now share one in-flight sync() promise, which removes the race entirely.
  private readonly inFlightSync = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: ObservabilityMetricsService,
    private readonly audit: AuditEventLogger
  ) {}

  async sync(organizationId: string): Promise<void> {
    const existing = this.inFlightSync.get(organizationId);
    if (existing) return existing;
    const run = this.syncNow(organizationId).finally(() => this.inFlightSync.delete(organizationId));
    this.inFlightSync.set(organizationId, run);
    return run;
  }

  private async syncNow(organizationId: string): Promise<void> {
    try {
      const candidates = await this.evaluate(organizationId);
      for (const candidate of candidates) await this.upsertOpenAlert(organizationId, candidate);
    } catch (error) {
      this.logger.warn({ event: "ObservabilityAlertSyncFailed", organizationId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async evaluate(organizationId: string): Promise<AlertCandidate[]> {
    const candidates: AlertCandidate[] = [];
    const since = new Date(Date.now() - RECENT_WINDOW_MS);

    const stuckWorkflows = await this.metrics.stuckWorkflows(organizationId);
    for (const finding of stuckWorkflows) {
      candidates.push({
        ruleCode: "WORKFLOW_STUCK",
        severity: "WARNING",
        title: `Workflow ${finding.workflowType} appears stuck (${finding.reason})`,
        details: { ...finding },
        relatedEntityType: "WorkflowExecution",
        relatedEntityId: finding.workflowExecutionId
      });
    }

    const stuckTasks = await this.metrics.stuckDelegatedTasks(organizationId);
    for (const finding of stuckTasks) {
      candidates.push({
        ruleCode: "DELEGATED_TASK_TIMEOUT",
        severity: "WARNING",
        title: "A delegated task is overdue and still queued",
        details: { ...finding },
        relatedEntityType: "EmployeeDelegatedTask",
        relatedEntityId: finding.taskId
      });
    }

    const expiredApprovals = await this.prisma.approvalRequest.count({
      where: { organizationId, status: "EXPIRED", updatedAt: { gte: since } }
    });
    if (expiredApprovals > 0) {
      candidates.push({
        ruleCode: "APPROVAL_EXPIRED",
        severity: "WARNING",
        title: `${expiredApprovals} approval request(s) expired in the last 24 hours`,
        details: { count: expiredApprovals, windowHours: 24 },
        relatedEntityType: "OrganizationWide"
      });
    }

    const failedChannelMessages = await this.prisma.channelMessage.count({
      where: { organizationId, status: "FAILED", direction: "OUTBOUND", createdAt: { gte: since } }
    });
    if (failedChannelMessages > 0) {
      candidates.push({
        ruleCode: "CHANNEL_DELIVERY_FAILURE",
        severity: "WARNING",
        title: `${failedChannelMessages} outbound channel message(s) failed to deliver in the last 24 hours`,
        details: { count: failedChannelMessages, windowHours: 24 },
        relatedEntityType: "OrganizationWide"
      });
    }

    const queuedBacklog = await this.prisma.employeeDelegatedTask.count({ where: { organizationId, status: "QUEUED" } });
    if (queuedBacklog > QUEUE_BACKLOG_THRESHOLD) {
      candidates.push({
        ruleCode: "QUEUE_BACKLOG",
        severity: "WARNING",
        title: `${queuedBacklog} delegated tasks are queued, above the ${QUEUE_BACKLOG_THRESHOLD} backlog threshold`,
        details: { queuedBacklog, threshold: QUEUE_BACKLOG_THRESHOLD },
        relatedEntityType: "OrganizationWide"
      });
    }

    const repeatedToolFailures = await this.prisma.agentToolExecution.groupBy({
      by: ["toolName"],
      where: { organizationId, status: "FAILED", startedAt: { gte: since } },
      _count: { _all: true }
    });
    for (const row of repeatedToolFailures) {
      if (row._count._all < 3) continue;
      candidates.push({
        ruleCode: "REPEATED_TOOL_FAILURE",
        severity: "WARNING",
        title: `Tool "${row.toolName}" failed ${row._count._all} times in the last 24 hours`,
        details: { toolName: row.toolName, failureCount: row._count._all, windowHours: 24 },
        relatedEntityType: "Tool",
        relatedEntityId: row.toolName
      });
    }

    const failuresByEmployee = await this.metrics.failuresByEmployee(organizationId, since);
    for (const row of failuresByEmployee) {
      const totalForEmployee = await this.prisma.executionSpan.count({
        where: { organizationId, spanType: "AGENT_EXECUTION", employeeInstallationId: row.employeeInstallationId, startedAt: { gte: since } }
      });
      if (totalForEmployee < EMPLOYEE_FAILURE_MIN_SAMPLES) continue;
      const rate = row.failureCount / totalForEmployee;
      if (rate <= EMPLOYEE_FAILURE_RATE_THRESHOLD) continue;
      candidates.push({
        ruleCode: "EMPLOYEE_FAILURE_RATE",
        severity: "CRITICAL",
        title: `An installed employee is failing ${Math.round(rate * 100)}% of executions`,
        details: { employeeInstallationId: row.employeeInstallationId, failureCount: row.failureCount, totalExecutions: totalForEmployee, rate },
        relatedEntityType: "Plugin",
        relatedEntityId: row.employeeInstallationId
      });
    }

    return candidates;
  }

  private async upsertOpenAlert(organizationId: string, candidate: AlertCandidate): Promise<void> {
    const existing = await this.prisma.observabilityAlert.findFirst({
      where: {
        organizationId,
        ruleCode: candidate.ruleCode,
        relatedEntityType: candidate.relatedEntityType ?? null,
        relatedEntityId: candidate.relatedEntityId ?? null,
        status: { in: ["OPEN", "ACKNOWLEDGED"] }
      }
    });
    if (existing) {
      await this.prisma.observabilityAlert.update({
        where: { id: existing.id },
        data: { detailsJson: sanitizeForTrace(candidate.details) as never, title: candidate.title }
      });
      return;
    }
    await this.prisma.observabilityAlert.create({
      data: {
        organizationId,
        ruleCode: candidate.ruleCode,
        severity: candidate.severity,
        status: "OPEN",
        title: candidate.title,
        detailsJson: sanitizeForTrace(candidate.details) as never,
        relatedTraceId: candidate.relatedTraceId ?? null,
        relatedEntityType: candidate.relatedEntityType ?? null,
        relatedEntityId: candidate.relatedEntityId ?? null
      }
    });
  }

  async list(organizationId: string, filters: { status?: string } = {}) {
    return this.prisma.observabilityAlert.findMany({
      where: { organizationId, ...(filters.status ? { status: filters.status } : {}) },
      orderBy: { createdAt: "desc" },
      take: 200
    });
  }

  async acknowledge(organizationId: string, id: string, userId: string) {
    const alert = await this.prisma.observabilityAlert.findFirst({ where: { id, organizationId } });
    if (!alert) return null;
    const updated = await this.prisma.observabilityAlert.update({
      where: { id },
      data: { status: alert.status === "OPEN" ? "ACKNOWLEDGED" : alert.status, acknowledgedAt: new Date(), acknowledgedByUserId: userId }
    });
    this.audit.record("OBSERVABILITY_ALERT_ACKNOWLEDGED", id, { organizationId, userId, targetId: id, ruleCode: alert.ruleCode });
    return updated;
  }

  async resolve(organizationId: string, id: string, userId: string) {
    const alert = await this.prisma.observabilityAlert.findFirst({ where: { id, organizationId } });
    if (!alert) return null;
    const updated = await this.prisma.observabilityAlert.update({
      where: { id },
      data: { status: "RESOLVED", resolvedAt: new Date() }
    });
    this.audit.record("OBSERVABILITY_ALERT_RESOLVED", id, { organizationId, userId, targetId: id, ruleCode: alert.ruleCode });
    return updated;
  }
}
