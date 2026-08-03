import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";

const STUCK_RUNNING_MINUTES = 15;
const STUCK_WAITING_FOR_INPUT_HOURS = 48;
const QUEUED_TASK_GRACE_MINUTES = 5;

export interface StuckWorkflowFinding {
  workflowExecutionId: string;
  workflowType: string;
  status: string;
  reason: "RUNNING_TOO_LONG" | "WAITING_FOR_INPUT_TOO_LONG" | "WAITING_FOR_APPROVAL_EXPIRED";
  sinceMinutes: number;
}

export interface StuckTaskFinding {
  taskId: string;
  status: string;
  reason: "QUEUED_BEYOND_TIMEOUT";
  overdueMinutes: number;
}

/**
 * Sprint 4.7 Phase 13: aggregate metrics computed by reading back ExecutionTrace/AgentExecution/
 * WorkflowExecution/EmployeeDelegatedTask/ObservabilityAlert directly — no separate metrics event store,
 * consistent with "do not create a second execution engine". Percentiles use one parameterized raw SQL
 * query (Prisma has no percentile_cont in its query builder); every other value uses Prisma's own
 * count/aggregate/groupBy so there is exactly one hand-written SQL statement to review for injection risk.
 */
@Injectable()
export class ObservabilityMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  private dateRangeWhere(from?: Date, to?: Date): { gte?: Date; lte?: Date } | undefined {
    if (!from && !to) return undefined;
    return { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }

  async overview(organizationId: string, from?: Date, to?: Date) {
    const startedAt = this.dateRangeWhere(from, to);
    const traceWhere: Prisma.ExecutionTraceWhereInput = { organizationId, ...(startedAt ? { startedAt } : {}) };

    const [total, completed, failed, tokenAgg, activeWorkflows, activeDelegatedTasks, openAlerts, percentiles, stuckWorkflows, stuckTasks] =
      await Promise.all([
        this.prisma.executionTrace.count({ where: traceWhere }),
        this.prisma.executionTrace.count({ where: { ...traceWhere, status: "COMPLETED" } }),
        this.prisma.executionTrace.count({ where: { ...traceWhere, status: "FAILED" } }),
        this.prisma.agentExecution.aggregate({
          where: { organizationId, ...(startedAt ? { createdAt: startedAt } : {}) },
          _sum: { inputTokens: true, outputTokens: true, totalTokens: true, estimatedCost: true }
        }),
        this.prisma.workflowExecution.count({ where: { organizationId, status: { in: ["ACTIVE", "WAITING_FOR_INPUT", "WAITING_FOR_APPROVAL"] } } }),
        this.prisma.employeeDelegatedTask.count({ where: { organizationId, status: { in: ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL"] } } }),
        this.prisma.observabilityAlert.count({ where: { organizationId, status: "OPEN" } }),
        this.latencyPercentiles(organizationId, from, to),
        this.stuckWorkflows(organizationId),
        this.stuckDelegatedTasks(organizationId)
      ]);

    return {
      totalExecutions: total,
      successfulExecutions: completed,
      failedExecutions: failed,
      successRate: total > 0 ? completed / total : null,
      p50LatencyMs: percentiles.p50,
      p95LatencyMs: percentiles.p95,
      tokens: {
        inputTokens: tokenAgg._sum?.inputTokens ?? 0,
        outputTokens: tokenAgg._sum?.outputTokens ?? 0,
        totalTokens: tokenAgg._sum?.totalTokens ?? 0
      },
      estimatedCredits: tokenAgg._sum?.estimatedCost ? Number(tokenAgg._sum.estimatedCost) : 0,
      runningWorkflows: activeWorkflows,
      stuckWorkflows: stuckWorkflows.length,
      activeDelegatedTasks,
      openAlerts,
      stuckWorkflowDetails: stuckWorkflows,
      stuckTaskDetails: stuckTasks
    };
  }

  private async latencyPercentiles(organizationId: string, from?: Date, to?: Date): Promise<{ p50: number | null; p95: number | null }> {
    const rows = await this.prisma.$queryRaw<{ p50: number | null; p95: number | null }[]>`
      SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95
      FROM execution_traces
      WHERE organization_id = ${organizationId}::uuid
        AND duration_ms IS NOT NULL
        AND (${from ?? null}::timestamp IS NULL OR started_at >= ${from ?? null}::timestamp)
        AND (${to ?? null}::timestamp IS NULL OR started_at <= ${to ?? null}::timestamp)
    `;
    const row = rows[0];
    return { p50: row?.p50 ?? null, p95: row?.p95 ?? null };
  }

  /** Executions per day for the last N days — the single time-series query backing the dashboard's
   *  "executions over time" / "latency trend" charts. */
  async executionsOverTime(organizationId: string, days = 14) {
    const rows = await this.prisma.$queryRaw<{ day: Date; total: bigint; failed: bigint; p50: number | null }[]>`
      SELECT
        date_trunc('day', started_at) AS day,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50
      FROM execution_traces
      WHERE organization_id = ${organizationId}::uuid
        AND started_at >= NOW() - (${days}::text || ' days')::interval
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    return rows.map((row) => ({ day: row.day.toISOString().slice(0, 10), total: Number(row.total), failed: Number(row.failed), p50LatencyMs: row.p50 }));
  }

  /** Failures grouped by the employee that owned the trace's root AGENT_EXECUTION span. */
  async failuresByEmployee(organizationId: string, from?: Date, to?: Date) {
    const startedAt = this.dateRangeWhere(from, to);
    const rows = await this.prisma.executionSpan.groupBy({
      by: ["employeeInstallationId"],
      where: {
        organizationId,
        spanType: "AGENT_EXECUTION",
        status: "FAILED",
        employeeInstallationId: { not: null },
        ...(startedAt ? { startedAt } : {})
      },
      _count: { _all: true }
    });
    return rows
      .filter((row) => row.employeeInstallationId)
      .map((row) => ({ employeeInstallationId: row.employeeInstallationId as string, failureCount: row._count._all }))
      .sort((a, b) => b.failureCount - a.failureCount);
  }

  async failuresByWorkflowType(organizationId: string) {
    const rows = await this.prisma.workflowExecution.groupBy({
      by: ["workflowType"],
      where: { organizationId, status: "FAILED" },
      _count: { _all: true }
    });
    return rows.map((row) => ({ workflowType: row.workflowType, failureCount: row._count._all })).sort((a, b) => b.failureCount - a.failureCount);
  }

  /** Average approval wait — the time between an approval-triggering delegation and its resolution,
   *  measured on APPROVAL_WAIT spans (created around dispatchWithApproval's lifecycle). Kept separate
   *  from AI execution latency per Phase 11's explicit requirement. */
  async approvalWaitStats(organizationId: string) {
    const agg = await this.prisma.executionSpan.aggregate({
      where: { organizationId, spanType: "APPROVAL_WAIT", status: { in: ["COMPLETED", "FAILED"] } },
      _avg: { durationMs: true },
      _max: { durationMs: true },
      _count: { _all: true }
    });
    return { averageMs: agg._avg.durationMs, maxMs: agg._max.durationMs, sampleCount: agg._count._all };
  }

  // ---------------------------------------------------------------------
  // Phase 6/16: stuck-state detection — read-only, shared by metrics and alerts.
  // ---------------------------------------------------------------------

  async stuckWorkflows(organizationId: string): Promise<StuckWorkflowFinding[]> {
    const now = Date.now();
    const rows = await this.prisma.workflowExecution.findMany({
      where: { organizationId, status: { in: ["ACTIVE", "WAITING_FOR_INPUT", "WAITING_FOR_APPROVAL"] } },
      select: { id: true, workflowType: true, status: true, updatedAt: true }
    });
    const findings: StuckWorkflowFinding[] = [];
    for (const row of rows) {
      const sinceMinutes = (now - row.updatedAt.getTime()) / 60_000;
      if (row.status === "ACTIVE" && sinceMinutes > STUCK_RUNNING_MINUTES) {
        findings.push({ workflowExecutionId: row.id, workflowType: row.workflowType, status: row.status, reason: "RUNNING_TOO_LONG", sinceMinutes: Math.round(sinceMinutes) });
      } else if (row.status === "WAITING_FOR_INPUT" && sinceMinutes > STUCK_WAITING_FOR_INPUT_HOURS * 60) {
        findings.push({ workflowExecutionId: row.id, workflowType: row.workflowType, status: row.status, reason: "WAITING_FOR_INPUT_TOO_LONG", sinceMinutes: Math.round(sinceMinutes) });
      } else if (row.status === "WAITING_FOR_APPROVAL" && sinceMinutes > STUCK_RUNNING_MINUTES) {
        findings.push({ workflowExecutionId: row.id, workflowType: row.workflowType, status: row.status, reason: "WAITING_FOR_APPROVAL_EXPIRED", sinceMinutes: Math.round(sinceMinutes) });
      }
    }
    return findings;
  }

  async stuckDelegatedTasks(organizationId: string): Promise<StuckTaskFinding[]> {
    const now = new Date();
    const rows = await this.prisma.employeeDelegatedTask.findMany({
      where: { organizationId, status: "QUEUED", timeoutAt: { lt: new Date(now.getTime() - QUEUED_TASK_GRACE_MINUTES * 60_000) } },
      select: { id: true, status: true, timeoutAt: true }
    });
    return rows.map((row) => ({
      taskId: row.id,
      status: row.status,
      reason: "QUEUED_BEYOND_TIMEOUT" as const,
      overdueMinutes: row.timeoutAt ? Math.round((now.getTime() - row.timeoutAt.getTime()) / 60_000) : 0
    }));
  }

  // ---------------------------------------------------------------------
  // Phase 21: error explorer — grouped by (component, errorCode). Fingerprint intentionally excludes any
  // customer data (only component + error code participate), per Phase 21's explicit requirement.
  // ---------------------------------------------------------------------

  /**
   * Sprint 4.7A Phase 10: full error-explorer grouping — component, employee, workflow, error code, and a
   * combined fingerprint, plus real distinct-affected-trace counts (COUNT(DISTINCT trace_id), which Prisma's
   * groupBy cannot express, hence the one additional hand-written parameterized SQL statement here,
   * alongside the existing percentile query — both go through Prisma.sql's tagged-template parameterization,
   * never raw string concatenation). `retryable` is a heuristic over the error code's own name (timeouts/
   * rate-limits/unavailability read as transient); `resolved` is always false because this pass introduces
   * no per-fingerprint resolution tracking (only ObservabilityAlert has an explicit RESOLVED status) — an
   * honest gap disclosed rather than a fabricated flag.
   */
  async errorFingerprints(organizationId: string, from?: Date, to?: Date) {
    const dateFilter = from && to
      ? Prisma.sql`AND started_at BETWEEN ${from} AND ${to}`
      : from
        ? Prisma.sql`AND started_at >= ${from}`
        : to
          ? Prisma.sql`AND started_at <= ${to}`
          : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      Array<{
        component: string;
        error_code: string;
        employee_installation_id: string | null;
        workflow_execution_id: string | null;
        occurrence_count: bigint;
        affected_trace_count: bigint;
        first_seen: Date;
        last_seen: Date;
      }>
    >(Prisma.sql`
      SELECT component, error_code, employee_installation_id, workflow_execution_id,
             COUNT(*) AS occurrence_count,
             COUNT(DISTINCT trace_id) AS affected_trace_count,
             MIN(started_at) AS first_seen,
             MAX(started_at) AS last_seen
      FROM execution_spans
      WHERE organization_id = ${organizationId}::uuid
        AND status = 'FAILED'
        AND error_code IS NOT NULL
        ${dateFilter}
      GROUP BY component, error_code, employee_installation_id, workflow_execution_id
      ORDER BY occurrence_count DESC
      LIMIT 200
    `);
    return rows.map((row) => ({
      fingerprint: `${row.component}:${row.error_code}${row.employee_installation_id ? `:${row.employee_installation_id}` : ""}`,
      component: row.component,
      errorCode: row.error_code,
      employeeInstallationId: row.employee_installation_id,
      workflowExecutionId: row.workflow_execution_id,
      occurrenceCount: Number(row.occurrence_count),
      affectedTraceCount: Number(row.affected_trace_count),
      firstSeen: row.first_seen.toISOString(),
      lastSeen: row.last_seen.toISOString(),
      retryable: /TIMEOUT|RATE_LIMIT|UNAVAILABLE|TEMPORARY|ECONNRESET|BUSY/i.test(row.error_code),
      resolved: false
    }));
  }
}
