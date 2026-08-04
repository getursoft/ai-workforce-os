/**
 * Sprint 4.8 — SchedulerService: the heart of the Autonomous Scheduler.
 *
 * Responsibilities:
 *  - Seed the job definition catalog + global templates at startup (idempotent).
 *  - Register the built-in handlers and subscribe to the scheduler event bus.
 *  - Run the background worker: every tick it marks its health, publishes due jobs, executes queued work,
 *    reconciles event sources, and recovers abandoned runs (crash recovery).
 *  - Expose the schedule/template/monitoring API consumed by SchedulerController.
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit
} from "@nestjs/common";
import { Prisma, type ScheduledJob } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { SchedulerHandlers } from "./scheduler-handlers";
import { JobRegistry } from "./job-registry";
import { JobDispatcher } from "./job-dispatcher";
import { JobExecutor } from "./job-executor";
import { JobHistoryService } from "./job-history.service";
import { JobLockService } from "./job-lock.service";
import { SchedulerWorkerHealth } from "./scheduler-worker.health";
import { SchedulerEventBridge, eventTriggerType } from "./scheduler-event-bridge";
import { SchedulerEventBus } from "./scheduler-event-bus";
import { computeScheduleNextRun, parseDuration } from "./cron/schedule-time";
import { JOB_TEMPLATE_SEEDS } from "./autonomous-job-definitions";
import type {
  ScheduledJobPriority,
  ScheduledJobTriggerType,
  ScheduledJobView,
  ScheduledExecutionView,
  SchedulerDomainEvent,
  SchedulerDomainEventName,
  SchedulerOverview,
  WorkerHealthView
} from "./scheduler.types";

const POLL_INTERVAL_MS = 5_000;
const RECONCILE_EVERY_TICKS = 6; // reconcile event sources every ~30s

export interface CreateScheduleInput {
  organizationId: string;
  employeeId?: string | null;
  workflowId?: string | null;
  definitionKey: string;
  triggerType: ScheduledJobTriggerType;
  cronExpression?: string | null;
  intervalMs?: number | null;
  timezone?: string;
  priority?: ScheduledJobPriority;
  maxRetry?: number;
  timeoutMs?: number;
  nextRun?: Date | null;
  payload?: Record<string, unknown>;
  context?: Record<string, unknown>;
  dedupeKey?: string | null;
  createdBy?: string | null;
}

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private tickCount = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobRegistry,
    private readonly handlers: SchedulerHandlers,
    private readonly dispatcher: JobDispatcher,
    private readonly executor: JobExecutor,
    private readonly history: JobHistoryService,
    private readonly locks: JobLockService,
    private readonly health: SchedulerWorkerHealth,
    private readonly bridge: SchedulerEventBridge,
    private readonly events: SchedulerEventBus
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.initialize();
    } catch (error) {
      this.logger.error({ event: "SchedulerInitFailed", error: String(error) });
    }
  }

  private async initialize(): Promise<void> {
    await this.registry.ensureDefinitions();
    const definitions = await this.registry.list();
    this.registry.register(
      this.handlers.buildRegistry(definitions as Array<{ key: string; handlerType: string }>)
    );
    await this.seedTemplates();
    this.events.onAny((event) => {
      void this.handleDomainEvent(event).catch((error) => {
        this.logger.warn({ event: "SchedulerEventDispatchFailed", error: String(error) });
      });
    });
    this.health.markStarted(POLL_INTERVAL_MS);
    this.startWorker();
    this.logger.log({ event: "SchedulerStarted", workerId: this.health.workerId });
  }

  private startWorker(): void {
    if (this.timer) return;
    if (process.env.NODE_ENV === "test") return; // tests drive tick() directly
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.health.markStopped();
    if (this.timer) clearInterval(this.timer);
  }

  getWorkerHealth(): WorkerHealthView {
    return this.health.snapshot();
  }

  /** One full worker pass. Exposed so tests (and operators) can force a pass synchronously. */
  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.health.markPoll();
      this.bridge.initialize();
      const workerId = this.health.workerId;
      this.tickCount += 1;
      if (this.tickCount % RECONCILE_EVERY_TICKS === 0) {
        await this.reconcileEventSources();
      }
      await this.dispatcher.publishDueJobs(workerId, now);
      await this.executor.processQueue(workerId);
      await this.history.recoverAbandonedRuns(now);
    } catch (error) {
      this.logger.error({ event: "SchedulerTickFailed", error: String(error) });
    } finally {
      this.ticking = false;
    }
  }

  /** Reconciles domain tables into events for every organization that has an event-triggered schedule. */
  private async reconcileEventSources(): Promise<void> {
    const eventJobs = await this.prisma.scheduledJob.findMany({
      where: {
        status: "ACTIVE",
        triggerType: {
          in: [
            "EVENT",
            "AFTER_APPROVAL",
            "AFTER_BOOKING",
            "AFTER_WORKFLOW",
            "AFTER_PAYMENT",
            "AFTER_UPLOAD"
          ]
        }
      },
      select: { organizationId: true },
      distinct: ["organizationId"]
    });
    for (const row of eventJobs) {
      await this.bridge.reconcile(row.organizationId).catch((error) => {
        this.logger.warn({
          event: "SchedulerReconcileFailed",
          organizationId: row.organizationId,
          error: String(error)
        });
      });
    }
  }

  // ---------------------------------------------------------------------
  // Event-driven scheduling (Phase 4)
  // ---------------------------------------------------------------------

  private async handleDomainEvent(event: SchedulerDomainEvent): Promise<void> {
    const triggerType = eventTriggerType(event.name as SchedulerDomainEventName);
    const jobs = await this.prisma.scheduledJob.findMany({
      where: { organizationId: event.organizationId, status: "ACTIVE", triggerType }
    });
    for (const job of jobs) {
      if (await this.eventNameMatches(job, event.name)) {
        await this.dispatcher.publishEventJob(
          job,
          { name: event.name, entityId: event.entityId },
          this.health.workerId
        );
      }
    }
  }

  private async eventNameMatches(job: ScheduledJob, eventName: string): Promise<boolean> {
    const payload = (job.payload ?? {}) as Record<string, unknown>;
    const declared = (payload.eventName as string | null) ?? null;
    if (declared && declared !== eventName) return false;
    const definition = await this.registry.resolve(job.definitionKey);
    if (definition?.eventName && definition.eventName !== eventName) return false;
    return true;
  }

  /** Direct entry point so tests and the bridge can fire a domain event and watch it dispatch. */
  emitEvent(event: SchedulerDomainEvent): void {
    this.events.emit(event);
  }

  // ---------------------------------------------------------------------
  // Schedule lifecycle API
  // ---------------------------------------------------------------------

  async createSchedule(input: CreateScheduleInput): Promise<ScheduledJobView> {
    const definition = await this.registry.resolve(input.definitionKey);
    if (!definition)
      throw new NotFoundException(`SCHEDULER_DEFINITION_NOT_FOUND: ${input.definitionKey}`);
    const timezone = input.timezone?.trim() || "UTC";
    const nextRun =
      input.nextRun ??
      this.computeNextRun(input.triggerType, {
        cronExpression: input.cronExpression ?? null,
        intervalMs: input.intervalMs ?? null,
        timezone,
        payload: input.payload ?? {}
      });
    const row = await this.prisma.scheduledJob.create({
      data: {
        organizationId: input.organizationId,
        employeeId: input.employeeId ?? null,
        workflowId: input.workflowId ?? null,
        definitionKey: input.definitionKey,
        triggerType: input.triggerType,
        cronExpression: input.cronExpression ?? null,
        intervalMs: input.intervalMs ?? null,
        timezone,
        status: "ACTIVE",
        priority: input.priority ?? "NORMAL",
        nextRun,
        maxRetry: input.maxRetry ?? definition.maxRetry,
        timeoutMs: input.timeoutMs ?? definition.timeoutMs,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
        context: (input.context ?? {}) as Prisma.InputJsonValue,
        dedupeKey: input.dedupeKey ?? null,
        createdBy: input.createdBy ?? null
      }
    });
    return toJobView(row);
  }

  /** Idempotent one-shot schedule (event-created reminders). Returns the existing job when dedupeKey matches. */
  async createOneShot(input: CreateScheduleInput): Promise<ScheduledJobView> {
    if (input.dedupeKey) {
      const existing = await this.prisma.scheduledJob.findUnique({
        where: { dedupeKey: input.dedupeKey }
      });
      if (existing) return toJobView(existing);
    }
    return this.createSchedule({
      ...input,
      triggerType: "ONE_TIME",
      nextRun: input.nextRun ?? new Date()
    });
  }

  async pauseJob(organizationId: string, id: string, userId: string): Promise<ScheduledJobView> {
    const job = await this.requireJob(organizationId, id);
    if (job.status === "CANCELLED" || job.status === "COMPLETED")
      throw new NotFoundException("SCHEDULER_JOB_NOT_PAUSABLE");
    const updated = await this.prisma.scheduledJob.updateMany({
      where: { id, organizationId, status: { notIn: ["CANCELLED", "COMPLETED"] } },
      data: { status: "PAUSED", pausedAt: new Date(), pausedBy: userId }
    });
    if (updated.count !== 1) throw new NotFoundException("SCHEDULER_JOB_NOT_FOUND");
    await this.locks.delete(id);
    return toJobView(await this.requireJob(organizationId, id));
  }

  async resumeJob(organizationId: string, id: string): Promise<ScheduledJobView> {
    const job = await this.requireJob(organizationId, id);
    if (job.status !== "PAUSED") throw new NotFoundException("SCHEDULER_JOB_NOT_PAUSED");
    const nextRun = this.computeNextRun(job.triggerType, {
      cronExpression: job.cronExpression,
      intervalMs: job.intervalMs,
      timezone: job.timezone,
      payload: (job.payload ?? {}) as Record<string, unknown>,
      from: new Date()
    });
    await this.prisma.scheduledJob.updateMany({
      where: { id, organizationId, status: "PAUSED" },
      data: { status: "ACTIVE", nextRun, pausedAt: null, pausedBy: null }
    });
    return toJobView(await this.requireJob(organizationId, id));
  }

  async cancelJob(organizationId: string, id: string, userId: string): Promise<ScheduledJobView> {
    const job = await this.requireJob(organizationId, id);
    if (job.status === "CANCELLED") return toJobView(job);
    await this.prisma.scheduledJob.updateMany({
      where: { id, organizationId, status: { not: "CANCELLED" } },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: userId, nextRun: null }
    });
    await this.locks.delete(id);
    await this.prisma.scheduledExecution.updateMany({
      where: { jobId: id, status: { in: ["QUEUED", "RETRYING"] } },
      data: { status: "CANCELLED", completedAt: new Date() }
    });
    return toJobView(await this.requireJob(organizationId, id));
  }

  /** Re-queues a FAILED/DEAD_LETTERED execution for a fresh attempt (Phase 9 monitoring action). */
  async retryExecution(
    organizationId: string,
    executionId: string
  ): Promise<ScheduledExecutionView> {
    const execution = await this.history.getExecution(organizationId, executionId);
    if (!execution) throw new NotFoundException("SCHEDULER_EXECUTION_NOT_FOUND");
    if (
      execution.status !== "FAILED" &&
      execution.status !== "DEAD_LETTERED" &&
      execution.status !== "TIMEOUT"
    ) {
      throw new NotFoundException("SCHEDULER_EXECUTION_NOT_RETRYABLE");
    }
    const job = await this.prisma.scheduledJob.findFirst({
      where: { id: execution.jobId, organizationId }
    });
    if (!job) throw new NotFoundException("SCHEDULER_JOB_NOT_FOUND");
    const nextAttemptAt = new Date();
    await this.prisma.scheduledExecution.updateMany({
      where: { id: executionId, organizationId },
      data: {
        status: "RETRYING",
        nextAttemptAt,
        attemptCount: execution.attemptCount + 1,
        errorCode: null,
        errorMessage: null
      }
    });
    await this.prisma.scheduledJob.updateMany({
      where: { id: job.id },
      data: { status: "ACTIVE", retryCount: 0 }
    });
    const refreshed = await this.history.getExecution(organizationId, executionId);
    if (!refreshed) throw new NotFoundException("SCHEDULER_EXECUTION_NOT_FOUND");
    return refreshed;
  }

  // ---------------------------------------------------------------------
  // Templates (Phase 18/19)
  // ---------------------------------------------------------------------

  private async seedTemplates(): Promise<void> {
    for (const seed of JOB_TEMPLATE_SEEDS) {
      const existing = await this.prisma.jobTemplate.findFirst({
        where: { organizationId: null, name: seed.name }
      });
      if (existing) continue;
      await this.prisma.jobTemplate.create({
        data: {
          organizationId: null,
          name: seed.name,
          description: seed.description,
          definitionKey: seed.definitionKey,
          triggerType: seed.triggerType,
          cronExpression:
            seed.triggerType === "DAILY" && seed.atTime
              ? `${minuteOf(seed.atTime)} ${hourOf(seed.atTime)} * * *`
              : null,
          intervalMs:
            seed.triggerType === "INTERVAL" && seed.interval ? parseDuration(seed.interval) : null,
          timezone: "UTC",
          priority: "NORMAL",
          maxRetry: 5,
          timeoutMs: 30_000,
          payload: {
            ...(seed.atTime ? { atTime: seed.atTime } : {}),
            ...(seed.dayOfMonth ? { dayOfMonth: seed.dayOfMonth } : {}),
            ...(seed.eventName ? { eventName: seed.eventName } : {}),
            ...(seed.payload ?? {})
          },
          createdBy: null
        }
      });
    }
  }

  async listTemplates(organizationId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.jobTemplate.findMany({
      where: { OR: [{ organizationId: null }, { organizationId }] },
      orderBy: [{ organizationId: "asc" }, { name: "asc" }]
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      definitionKey: row.definitionKey,
      triggerType: row.triggerType,
      cronExpression: row.cronExpression,
      intervalMs: row.intervalMs,
      timezone: row.timezone,
      priority: row.priority,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      global: row.organizationId === null
    }));
  }

  /** Instantiates a template into an ACTIVE schedule for the organization. */
  async instantiateTemplate(
    organizationId: string,
    templateId: string,
    input: {
      employeeId?: string | null;
      timezone?: string;
      priority?: ScheduledJobPriority;
      payload?: Record<string, unknown>;
      createdBy?: string | null;
    }
  ): Promise<ScheduledJobView> {
    const template = await this.prisma.jobTemplate.findFirst({
      where: {
        OR: [
          { id: templateId, organizationId: null },
          { id: templateId, organizationId }
        ]
      }
    });
    if (!template) throw new NotFoundException("SCHEDULER_TEMPLATE_NOT_FOUND");
    const payload = {
      ...((template.payload ?? {}) as Record<string, unknown>),
      ...(input.payload ?? {})
    };
    const timezone = input.timezone ?? template.timezone;
    const triggerType = template.triggerType as ScheduledJobTriggerType;
    const nextRun = this.computeNextRun(triggerType, {
      cronExpression: template.cronExpression,
      intervalMs: template.intervalMs,
      timezone,
      payload
    });
    const row = await this.prisma.scheduledJob.create({
      data: {
        organizationId,
        employeeId: input.employeeId ?? null,
        definitionKey: template.definitionKey,
        triggerType,
        cronExpression: template.cronExpression,
        intervalMs: template.intervalMs,
        timezone,
        status: "ACTIVE",
        priority: input.priority ?? template.priority,
        nextRun,
        maxRetry: template.maxRetry,
        timeoutMs: template.timeoutMs,
        payload: payload as Prisma.InputJsonValue,
        createdBy: input.createdBy ?? null
      }
    });
    return toJobView(row);
  }

  // ---------------------------------------------------------------------
  // Reads (monitoring)
  // ---------------------------------------------------------------------

  async listJobs(
    organizationId: string,
    filters: {
      status?: string;
      triggerType?: string;
      definitionKey?: string;
      page?: number;
      pageSize?: number;
    } = {}
  ): Promise<{ items: ScheduledJobView[]; total: number }> {
    const page = filters.page ?? 1;
    const pageSize = Math.min(filters.pageSize ?? 25, 100);
    const where = {
      organizationId,
      ...(filters.status ? { status: filters.status as never } : {}),
      ...(filters.triggerType ? { triggerType: filters.triggerType as never } : {}),
      ...(filters.definitionKey ? { definitionKey: filters.definitionKey } : {})
    };
    const [rows, total] = await Promise.all([
      this.prisma.scheduledJob.findMany({
        where,
        orderBy: [{ priority: "desc" }, { nextRun: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      this.prisma.scheduledJob.count({ where })
    ]);
    return { items: rows.map((row) => toJobView(row)), total };
  }

  async getJob(organizationId: string, id: string): Promise<ScheduledJobView | null> {
    const job = await this.prisma.scheduledJob.findFirst({ where: { id, organizationId } });
    return job ? toJobView(job) : null;
  }

  async upcomingJobs(
    organizationId: string,
    limit = 20
  ): Promise<
    Array<{ id: string; definitionKey: string; nextRun: string; priority: ScheduledJobPriority }>
  > {
    const rows = await this.prisma.scheduledJob.findMany({
      where: { organizationId, status: "ACTIVE", nextRun: { not: null } },
      orderBy: { nextRun: "asc" },
      take: limit
    });
    return rows.map((row) => ({
      id: row.id,
      definitionKey: row.definitionKey,
      nextRun: row.nextRun?.toISOString() ?? "",
      priority: row.priority
    }));
  }

  async overview(organizationId: string): Promise<SchedulerOverview> {
    const [stats, jobStats, recent, upcoming] = await Promise.all([
      this.history.overview(organizationId),
      this.prisma.scheduledJob.groupBy({ by: ["status"], where: { organizationId }, _count: true }),
      this.history.listExecutions(organizationId, { page: 1, pageSize: 10 }),
      this.upcomingJobs(organizationId, 20)
    ]);
    const byStatus = Object.fromEntries(jobStats.map((row) => [row.status, row._count]));
    return {
      ...stats,
      queueSize: stats.queued,
      totalJobs: jobStats.reduce((sum, row) => sum + row._count, 0),
      activeJobs: byStatus.ACTIVE ?? 0,
      pausedJobs: byStatus.PAUSED ?? 0,
      worker: this.health.snapshot(),
      recentExecutions: recent.items,
      upcomingJobs: upcoming
    };
  }

  // ---------------------------------------------------------------------
  // Next-run computation
  // ---------------------------------------------------------------------

  private computeNextRun(
    triggerType: ScheduledJobTriggerType,
    opts: {
      cronExpression?: string | null;
      intervalMs?: number | null;
      timezone?: string;
      payload?: Record<string, unknown>;
      from?: Date;
    }
  ): Date | null {
    const from = opts.from ?? new Date();
    const payload = opts.payload ?? {};
    const timeZone = opts.timezone;
    const withTz = timeZone !== undefined ? { timeZone } : {};
    switch (triggerType) {
      case "ONE_TIME":
      case "DATE":
        return from;
      case "INTERVAL":
        if (!opts.intervalMs) return null;
        return new Date(from.getTime() + opts.intervalMs);
      case "DAILY": {
        const atTime = (payload.atTime as string) ?? "09:00";
        return computeScheduleNextRun({ triggerType: "DAILY", atTime, ...withTz }, from);
      }
      case "WEEKLY": {
        const days = Array.isArray(payload.daysOfWeek)
          ? (payload.daysOfWeek as number[])
          : [1, 2, 3, 4, 5];
        const atTime = (payload.atTime as string) ?? "09:00";
        return computeScheduleNextRun(
          { triggerType: "WEEKLY", atTime, daysOfWeek: days, ...withTz },
          from
        );
      }
      case "MONTHLY": {
        const dayOfMonth = Number(payload.dayOfMonth ?? 1);
        const atTime = (payload.atTime as string) ?? "09:00";
        return computeScheduleNextRun(
          { triggerType: "MONTHLY", atTime, dayOfMonth, ...withTz },
          from
        );
      }
      case "CRON":
        return computeScheduleNextRun(
          { triggerType: "CRON", cronExpression: opts.cronExpression ?? null, ...withTz },
          from
        );
      case "EVENT":
      case "AFTER_APPROVAL":
      case "AFTER_BOOKING":
      case "AFTER_WORKFLOW":
      case "AFTER_PAYMENT":
      case "AFTER_UPLOAD":
        return null;
      default:
        return null;
    }
  }

  private async requireJob(organizationId: string, id: string): Promise<ScheduledJob> {
    const job = await this.prisma.scheduledJob.findFirst({ where: { id, organizationId } });
    if (!job) throw new NotFoundException("SCHEDULER_JOB_NOT_FOUND");
    return job;
  }
}

function toJobView(row: ScheduledJob): ScheduledJobView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    employeeId: row.employeeId,
    workflowId: row.workflowId,
    definitionKey: row.definitionKey,
    triggerType: row.triggerType,
    cronExpression: row.cronExpression,
    intervalMs: row.intervalMs,
    timezone: row.timezone,
    status: row.status,
    priority: row.priority,
    nextRun: row.nextRun?.toISOString() ?? null,
    lastRun: row.lastRun?.toISOString() ?? null,
    retryCount: row.retryCount,
    maxRetry: row.maxRetry,
    timeoutMs: row.timeoutMs,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    context: (row.context ?? {}) as Record<string, unknown>,
    dedupeKey: row.dedupeKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function minuteOf(atTime: string): string {
  const [, minute] = atTime.split(":");
  return minute ?? "00";
}

function hourOf(atTime: string): string {
  const [hour] = atTime.split(":");
  return hour ?? "9";
}
