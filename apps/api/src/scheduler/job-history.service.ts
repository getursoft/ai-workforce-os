/**
 * Sprint 4.8 — Job History (Phase 1/9): every execution of every scheduled job is durably recorded on a
 * ScheduledExecution row. This service owns the write path (create → claim → finalize) and the read path
 * used by the monitoring dashboard and REST API.
 */

import { Injectable } from "@nestjs/common";
import { Prisma, ScheduledExecutionStatus, type ScheduledJob } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { JobLockService } from "./job-lock.service";
import {
  priorityIndex,
  type ScheduledExecutionStatus as Status,
  type ScheduledExecutionView
} from "./scheduler.types";

export interface CreateExecutionInput {
  organizationId: string;
  jobId: string;
  employeeId: string | null;
  definitionKey: string;
  triggerType: ScheduledJob["triggerType"];
  priority: ScheduledJob["priority"];
  scheduledFor: Date;
  attemptCount: number;
  createdBy?: string | null;
  dedupeKey?: string;
}

export interface ClaimedExecution {
  id: string;
  organizationId: string;
  jobId: string;
  employeeId: string | null;
  definitionKey: string;
  triggerType: string;
  priority: string;
  status: string;
  scheduledFor: Date;
  attemptCount: number;
  payload: Record<string, unknown>;
  context: Record<string, unknown>;
  timezone: string;
  timeoutMs: number;
  maxRetry: number;
  traceId: string | null;
}

@Injectable()
export class JobHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: JobLockService
  ) {}

  /**
   * Creates a QUEUED execution for a dispatch attempt. The unique dedupeKey makes this exactly-once per
   * (job, attempt, scheduledFor) even if two workers both think the job is due.
   */
  async createExecution(input: CreateExecutionInput): Promise<string | null> {
    try {
      const row = await this.prisma.scheduledExecution.create({
        data: {
          organizationId: input.organizationId,
          jobId: input.jobId,
          employeeId: input.employeeId,
          definitionKey: input.definitionKey,
          triggerType: input.triggerType,
          priority: input.priority,
          status: "QUEUED",
          scheduledFor: input.scheduledFor,
          attemptCount: input.attemptCount,
          createdBy: input.createdBy ?? null,
          dedupeKey: input.dedupeKey ?? null
        }
      });
      return row.id;
    } catch {
      return null; // unique violation → another worker already created this attempt
    }
  }

  /** Atomically claims the highest-priority QUEUED execution for this worker (if any). */
  async claimNextExecution(workerId: string): Promise<ClaimedExecution | null> {
    const queued = await this.prisma.scheduledExecution.findMany({
      where: { status: "QUEUED" },
      orderBy: [{ priority: "desc" }, { scheduledFor: "asc" }, { createdAt: "asc" }],
      take: 10
    });
    for (const execution of queued) {
      const job = await this.prisma.scheduledJob.findFirst({
        where: { id: execution.jobId, organizationId: execution.organizationId }
      });
      if (!job) continue;
      const claimed = await this.prisma.scheduledExecution.updateMany({
        where: {
          id: execution.id,
          organizationId: execution.organizationId,
          status: "QUEUED"
        },
        data: { status: "RUNNING", startedAt: new Date(), workerId }
      });
      if (claimed.count !== 1) continue;
      return {
        id: execution.id,
        organizationId: execution.organizationId,
        jobId: execution.jobId,
        employeeId: execution.employeeId,
        definitionKey: execution.definitionKey,
        triggerType: execution.triggerType,
        priority: execution.priority,
        status: "RUNNING",
        scheduledFor: execution.scheduledFor,
        attemptCount: execution.attemptCount,
        payload: (job.payload ?? {}) as Record<string, unknown>,
        context: (job.context ?? {}) as Record<string, unknown>,
        timezone: job.timezone,
        timeoutMs: job.timeoutMs,
        maxRetry: job.maxRetry,
        traceId: execution.traceId
      };
    }
    return null;
  }

  /** Marks the execution RUNNING with a traceId attached (called after the trace is created). */
  async markRunning(executionId: string, traceId: string | null): Promise<void> {
    await this.prisma.scheduledExecution.updateMany({
      where: { id: executionId },
      data: { status: "RUNNING", startedAt: new Date(), ...(traceId ? { traceId } : {}) }
    });
  }

  async markCompleted(
    executionId: string,
    input: {
      durationMs: number;
      result?: Record<string, unknown>;
      tokens?: number;
      credits?: number;
    }
  ): Promise<void> {
    await this.prisma.scheduledExecution.updateMany({
      where: { id: executionId, status: "RUNNING" },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        durationMs: input.durationMs,
        result: (input.result ?? {}) as Prisma.InputJsonValue,
        tokens: input.tokens ?? 0,
        credits: input.credits ?? 0
      }
    });
  }

  async markFailed(
    executionId: string,
    input: { durationMs: number; errorCode: string; errorMessage: string }
  ): Promise<void> {
    await this.prisma.scheduledExecution.updateMany({
      where: { id: executionId },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        durationMs: input.durationMs,
        errorCode: input.errorCode.slice(0, 100),
        errorMessage: input.errorMessage.slice(0, 1000)
      }
    });
  }

  /** Schedules a retry attempt for a failed execution with the exponential-backoff delay. */
  async scheduleRetry(
    executionId: string,
    input: { attemptCount: number; nextAttemptAt: Date; workerId: string | null }
  ): Promise<void> {
    await this.prisma.scheduledExecution.updateMany({
      where: { id: executionId },
      data: {
        status: "RETRYING",
        attemptCount: input.attemptCount,
        nextAttemptAt: input.nextAttemptAt,
        workerId: input.workerId ?? null
      }
    });
  }

  /** Parks an execution on the dead letter queue after its retry budget is exhausted. */
  async deadLetter(
    executionId: string,
    input: { durationMs: number; errorCode: string; errorMessage: string }
  ): Promise<void> {
    await this.prisma.scheduledExecution.updateMany({
      where: { id: executionId },
      data: {
        status: "DEAD_LETTERED",
        completedAt: new Date(),
        durationMs: input.durationMs,
        errorCode: input.errorCode.slice(0, 100),
        errorMessage: input.errorMessage.slice(0, 1000)
      }
    });
  }

  async markTimeout(
    executionId: string,
    input: { durationMs: number; errorMessage: string }
  ): Promise<void> {
    await this.prisma.scheduledExecution.updateMany({
      where: { id: executionId },
      data: {
        status: "TIMEOUT",
        completedAt: new Date(),
        durationMs: input.durationMs,
        errorCode: "JOB_TIMEOUT",
        errorMessage: input.errorMessage.slice(0, 1000)
      }
    });
  }

  async markCancelled(executionId: string): Promise<void> {
    await this.prisma.scheduledExecution.updateMany({
      where: { id: executionId, status: { in: ["QUEUED", "RETRYING"] } },
      data: { status: "CANCELLED", completedAt: new Date() }
    });
  }

  /** Claims RETRYING executions whose nextAttemptAt has passed, back to RUNNING for a fresh attempt. */
  async claimDueRetries(workerId: string): Promise<ClaimedExecution[]> {
    const due = await this.prisma.scheduledExecution.findMany({
      where: { status: "RETRYING", nextAttemptAt: { lte: new Date() } },
      orderBy: [{ priority: "desc" }, { nextAttemptAt: "asc" }],
      take: 25
    });
    const claimed: ClaimedExecution[] = [];
    for (const execution of due) {
      const job = await this.prisma.scheduledJob.findFirst({
        where: { id: execution.jobId, organizationId: execution.organizationId }
      });
      if (!job) continue;
      const result = await this.prisma.scheduledExecution.updateMany({
        where: { id: execution.id, status: "RETRYING" },
        data: { status: "RUNNING", startedAt: new Date(), workerId, nextAttemptAt: null }
      });
      if (result.count !== 1) continue;
      claimed.push({
        id: execution.id,
        organizationId: execution.organizationId,
        jobId: execution.jobId,
        employeeId: execution.employeeId,
        definitionKey: execution.definitionKey,
        triggerType: execution.triggerType,
        priority: execution.priority,
        status: "RUNNING",
        scheduledFor: execution.scheduledFor,
        attemptCount: execution.attemptCount,
        payload: (job.payload ?? {}) as Record<string, unknown>,
        context: (job.context ?? {}) as Record<string, unknown>,
        timezone: job.timezone,
        timeoutMs: job.timeoutMs,
        maxRetry: job.maxRetry,
        traceId: execution.traceId
      });
    }
    return claimed;
  }

  /** Finds RUNNING executions whose worker lock has expired (worker crashed mid-run) and fails them so
   *  the job's retry policy can re-drive them. */
  async recoverAbandonedRuns(now = new Date()): Promise<number> {
    const abandoned = await this.prisma.scheduledExecution.findMany({
      where: { status: "RUNNING", startedAt: { lt: new Date(now.getTime() - 2 * 60_000) } },
      take: 50
    });
    let recovered = 0;
    for (const execution of abandoned) {
      const lock = await this.locks.get(execution.jobId);
      if (lock && lock.leaseExpiresAt.getTime() >= now.getTime()) continue; // still actively leased
      await this.prisma.scheduledExecution.updateMany({
        where: { id: execution.id, status: "RUNNING" },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          errorCode: "WORKER_CRASH",
          errorMessage: "Worker stopped while running; recovered by the scheduler."
        }
      });
      recovered += 1;
    }
    return recovered;
  }

  // ---------------------------------------------------------------------
  // Reads (monitoring / dashboard / API)
  // ---------------------------------------------------------------------

  async listExecutions(
    organizationId: string,
    filters: {
      status?: Status;
      jobId?: string;
      definitionKey?: string;
      page?: number;
      pageSize?: number;
    } = {}
  ): Promise<{ items: ScheduledExecutionView[]; total: number }> {
    const page = filters.page ?? 1;
    const pageSize = Math.min(filters.pageSize ?? 25, 100);
    const where = {
      organizationId,
      ...(filters.status ? { status: filters.status as ScheduledExecutionStatus } : {}),
      ...(filters.jobId ? { jobId: filters.jobId } : {}),
      ...(filters.definitionKey ? { definitionKey: filters.definitionKey } : {})
    };
    const [rows, total] = await Promise.all([
      this.prisma.scheduledExecution.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      this.prisma.scheduledExecution.count({ where })
    ]);
    return { items: rows.map(toExecutionView), total };
  }

  async overview(organizationId: string): Promise<{
    running: number;
    queued: number;
    completed: number;
    failed: number;
    retrying: number;
    cancelled: number;
    timeout: number;
    deadLettered: number;
    averageDurationMs: number | null;
  }> {
    const [running, queued, completed, failed, retrying, cancelled, timeout, deadLettered] =
      await Promise.all([
        this.prisma.scheduledExecution.count({ where: { organizationId, status: "RUNNING" } }),
        this.prisma.scheduledExecution.count({ where: { organizationId, status: "QUEUED" } }),
        this.prisma.scheduledExecution.count({ where: { organizationId, status: "COMPLETED" } }),
        this.prisma.scheduledExecution.count({ where: { organizationId, status: "FAILED" } }),
        this.prisma.scheduledExecution.count({ where: { organizationId, status: "RETRYING" } }),
        this.prisma.scheduledExecution.count({ where: { organizationId, status: "CANCELLED" } }),
        this.prisma.scheduledExecution.count({ where: { organizationId, status: "TIMEOUT" } }),
        this.prisma.scheduledExecution.count({ where: { organizationId, status: "DEAD_LETTERED" } })
      ]);
    const completedRows = await this.prisma.scheduledExecution.findMany({
      where: { organizationId, status: "COMPLETED", durationMs: { not: null } },
      select: { durationMs: true },
      take: 1000
    });
    const durations = completedRows.map((row) => row.durationMs as number);
    const averageDurationMs = durations.length
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : null;
    return {
      running,
      queued,
      completed,
      failed,
      retrying,
      cancelled,
      timeout,
      deadLettered,
      averageDurationMs
    };
  }

  async getExecution(organizationId: string, id: string): Promise<ScheduledExecutionView | null> {
    const row = await this.prisma.scheduledExecution.findFirst({ where: { id, organizationId } });
    return row ? toExecutionView(row) : null;
  }
}

function toExecutionView(row: {
  id: string;
  organizationId: string;
  jobId: string;
  employeeId: string | null;
  definitionKey: string;
  triggerType: string;
  priority: string;
  status: string;
  scheduledFor: Date;
  attemptCount: number;
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
  nextAttemptAt: Date | null;
  traceId: string | null;
  workerId: string | null;
  result: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  tokens: number;
  credits: number;
  createdAt: Date;
}): ScheduledExecutionView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    jobId: row.jobId,
    employeeId: row.employeeId,
    definitionKey: row.definitionKey,
    triggerType: row.triggerType as ScheduledExecutionView["triggerType"],
    priority: row.priority as ScheduledExecutionView["priority"],
    status: row.status as ScheduledExecutionView["status"],
    scheduledFor: row.scheduledFor.toISOString(),
    attemptCount: row.attemptCount,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    traceId: row.traceId,
    workerId: row.workerId,
    result: (row.result ?? null) as Record<string, unknown> | null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    tokens: row.tokens,
    credits: row.credits,
    createdAt: row.createdAt.toISOString()
  };
}

export { priorityIndex };
