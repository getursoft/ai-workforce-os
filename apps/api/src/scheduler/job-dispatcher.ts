/**
 * Sprint 4.8 — Job Dispatcher (Phase 1): turns due schedules into QUEUED executions.
 *
 * Runs on every worker tick. Finds ACTIVE jobs whose nextRun has arrived, claims them through the
 * JobLockService (exactly-once across instances), creates a QUEUED execution, and advances the schedule
 * (recurring jobs compute their next run; one-shot jobs complete). Event-driven jobs (triggerType
 * EVENT/AFTER_*) are dispatched by the SchedulerService in response to domain events, not here.
 */

import { Injectable, Logger } from "@nestjs/common";
import type { ScheduledJob, ScheduledJobTriggerType } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { JobLockService } from "./job-lock.service";
import { JobHistoryService } from "./job-history.service";
import { computeScheduleNextRun } from "./cron/schedule-time";

const ONE_SHOT_TRIGGERS = new Set(["ONE_TIME", "DATE"]);
const EVENT_TRIGGERS: ScheduledJobTriggerType[] = [
  "EVENT",
  "AFTER_APPROVAL",
  "AFTER_BOOKING",
  "AFTER_WORKFLOW",
  "AFTER_PAYMENT",
  "AFTER_UPLOAD"
];

@Injectable()
export class JobDispatcher {
  private readonly logger = new Logger(JobDispatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: JobLockService,
    private readonly history: JobHistoryService
  ) {}

  /** Publishes every due, ACTIVE, time-based job to the queue. Returns how many executions were created. */
  async publishDueJobs(workerId: string, now = new Date(), limit = 25): Promise<number> {
    const due = await this.prisma.scheduledJob.findMany({
      where: {
        status: "ACTIVE",
        nextRun: { lte: now },
        triggerType: { notIn: [...EVENT_TRIGGERS] }
      },
      orderBy: [{ priority: "desc" }, { nextRun: "asc" }],
      take: limit
    });
    let published = 0;
    for (const job of due) {
      if (job.nextRun === null) continue;
      const acquired = await this.locks.acquire(
        job.id,
        job.organizationId,
        workerId,
        DISPATCH_LEASE_MS
      );
      if (!acquired) continue;
      try {
        const fresh = await this.prisma.scheduledJob.findUnique({ where: { id: job.id } });
        if (
          !fresh ||
          fresh.status !== "ACTIVE" ||
          !fresh.nextRun ||
          fresh.nextRun.getTime() > now.getTime()
        )
          continue;
        const scheduledFor = fresh.nextRun;
        const executionId = await this.history.createExecution({
          organizationId: fresh.organizationId,
          jobId: fresh.id,
          employeeId: fresh.employeeId,
          definitionKey: fresh.definitionKey,
          triggerType: fresh.triggerType,
          priority: fresh.priority,
          scheduledFor,
          attemptCount: 1,
          createdBy: fresh.createdBy,
          dedupeKey: `${fresh.id}:${scheduledFor.getTime()}`
        });
        if (executionId === null) continue; // a concurrent worker already published this run
        await this.advanceSchedule(fresh, now);
        published += 1;
      } finally {
        await this.locks.release(job.id, workerId);
      }
    }
    if (published > 0) {
      this.logger.log({ event: "SchedulerJobsPublished", workerId, published });
    }
    return published;
  }

  /** Creates a QUEUED execution for an event-driven job, deduped by (job, entity). Returns execution id. */
  async publishEventJob(
    job: ScheduledJob,
    event: { name: string; entityId: string },
    workerId: string
  ): Promise<string | null> {
    const acquired = await this.locks.acquire(
      job.id,
      job.organizationId,
      workerId,
      DISPATCH_LEASE_MS
    );
    if (!acquired) return null;
    try {
      const fresh = await this.prisma.scheduledJob.findUnique({ where: { id: job.id } });
      if (!fresh || fresh.status !== "ACTIVE") return null;
      const scheduledFor = new Date();
      const dedupeKey = `${fresh.id}:${event.name}:${event.entityId}`;
      const executionId = await this.history.createExecution({
        organizationId: fresh.organizationId,
        jobId: fresh.id,
        employeeId: fresh.employeeId,
        definitionKey: fresh.definitionKey,
        triggerType: fresh.triggerType,
        priority: fresh.priority,
        scheduledFor,
        attemptCount: 1,
        createdBy: fresh.createdBy,
        dedupeKey
      });
      if (executionId === null) return null;
      await this.prisma.scheduledJob.updateMany({
        where: { id: fresh.id, status: "ACTIVE" },
        data: { lastRun: new Date() }
      });
      return executionId;
    } finally {
      await this.locks.release(job.id, workerId);
    }
  }

  private async advanceSchedule(job: ScheduledJob, now: Date): Promise<void> {
    const isOneShot = ONE_SHOT_TRIGGERS.has(job.triggerType);
    if (isOneShot) {
      await this.prisma.scheduledJob.updateMany({
        where: { id: job.id, status: "ACTIVE" },
        data: { status: "COMPLETED", lastRun: now, nextRun: null, retryCount: 0 }
      });
      await this.locks.delete(job.id);
      return;
    }
    const nextRun = computeScheduleNextRun(
      {
        triggerType: job.triggerType as "CRON" | "INTERVAL" | "DAILY" | "WEEKLY" | "MONTHLY",
        cronExpression: job.cronExpression,
        intervalMs: job.intervalMs,
        timeZone: job.timezone
      },
      now
    );
    await this.prisma.scheduledJob.updateMany({
      where: { id: job.id, status: "ACTIVE" },
      data: {
        lastRun: now,
        nextRun,
        ...(nextRun === null ? { status: "FAILED" as const } : { retryCount: 0 })
      }
    });
  }
}

export const DISPATCH_LEASE_MS = 10_000;
