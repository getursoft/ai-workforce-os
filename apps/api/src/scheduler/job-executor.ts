/**
 * Sprint 4.8 — Job Executor (Phase 1): runs QUEUED/RETRYING executions through their registered handler.
 *
 * Each run is wrapped in a Sprint 4.7 trace (BACKGROUND_TASK span) so the Trace Viewer shows the whole
 * job lifecycle — Job Started → Worker Picked → handler internals (workflow/approval/notification) →
 * Completed / Retry / Failure. The retry engine (Phase 5) drives failed or timed-out runs onto the
 * exponential-backoff ladder; runs that exhaust it land on the dead letter queue.
 */

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { JobHistoryService, type ClaimedExecution } from "./job-history.service";
import { JobRegistry } from "./job-registry";
import { decideRetry } from "./job-retry.service";
import { SchedulerWorkerHealth } from "./scheduler-worker.health";
import { ObservabilityService } from "../observability/observability.service";
import { rootedContext } from "../observability/trace-context";
import type { JobRunContext, JobRunResult } from "./scheduler.types";

@Injectable()
export class JobExecutor {
  private readonly logger = new Logger(JobExecutor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly history: JobHistoryService,
    private readonly registry: JobRegistry,
    private readonly health: SchedulerWorkerHealth,
    private readonly observability: ObservabilityService
  ) {}

  /** Processes up to `limit` queued/running executions for this worker. */
  async processQueue(workerId: string, limit = 5): Promise<number> {
    let processed = 0;
    const first = await this.history.claimNextExecution(workerId);
    if (first) {
      await this.run(workerId, first);
      processed += 1;
    }
    if (processed < limit) {
      const retries = await this.history.claimDueRetries(workerId);
      for (const execution of retries) {
        if (processed >= limit) break;
        await this.run(workerId, execution);
        processed += 1;
      }
    }
    return processed;
  }

  private async run(workerId: string, execution: ClaimedExecution): Promise<void> {
    this.health.incrementRunning();
    const startedAtMs = Date.now();
    const definition = await this.registry.resolve(execution.definitionKey);

    try {
      const result = await this.executeTraced(workerId, execution, definition?.timeoutMs ?? 30_000);
      if (result.traceId) {
        await this.prisma.scheduledExecution.updateMany({
          where: { id: execution.id },
          data: { traceId: result.traceId }
        });
      }
      if (result.outcome === "COMPLETED") {
        await this.history.markCompleted(execution.id, {
          durationMs: Date.now() - startedAtMs,
          result: result.result ?? {},
          tokens: result.tokens ?? 0,
          credits: result.credits ?? 0
        });
        await this.bumpJobCounter(execution, "completed");
        this.health.incrementCompleted();
        return;
      }
      if (result.outcome === "TIMEOUT") {
        await this.history.markTimeout(execution.id, {
          durationMs: Date.now() - startedAtMs,
          errorMessage: "Job exceeded its configured timeout."
        });
        this.health.incrementFailed();
      } else {
        await this.history.markFailed(execution.id, {
          durationMs: Date.now() - startedAtMs,
          errorCode: result.errorCode ?? "JOB_FAILED",
          errorMessage: result.errorMessage ?? "The job failed."
        });
      }
      await this.applyRetryPolicy(
        workerId,
        execution,
        definition?.retryPolicy ?? "5_MIN",
        definition?.maxRetry ?? 5,
        result.errorCode ?? "JOB_FAILED"
      );
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "HANDLER_CRASHED";
      this.logger.error({
        event: "SchedulerExecutionCrashed",
        executionId: execution.id,
        error: String(error)
      });
      await this.history.markFailed(execution.id, {
        durationMs: Date.now() - startedAtMs,
        errorCode: code,
        errorMessage: String(error).slice(0, 1000)
      });
      await this.applyRetryPolicy(
        workerId,
        execution,
        definition?.retryPolicy ?? "5_MIN",
        definition?.maxRetry ?? 5,
        code
      );
    } finally {
      this.health.decrementRunning();
    }
  }

  /** Runs the handler inside an observability span (creating/continuing the job's trace). */
  private async executeTraced(
    workerId: string,
    execution: ClaimedExecution,
    timeoutMs: number
  ): Promise<{
    outcome: "COMPLETED" | "FAILED" | "TIMEOUT";
    result?: Record<string, unknown>;
    tokens?: number;
    credits?: number;
    errorCode?: string;
    errorMessage?: string;
    traceId?: string | null;
  }> {
    const handler = this.registry.getHandler(execution.definitionKey);
    if (!handler) {
      return {
        outcome: "FAILED",
        errorCode: "UNKNOWN_DEFINITION",
        errorMessage: `No handler registered for ${execution.definitionKey}`
      };
    }
    const contextForTrace = execution.traceId
      ? rootedContext(execution.organizationId, execution.traceId, true, {})
      : undefined;

    let captured: {
      outcome: "COMPLETED" | "FAILED" | "TIMEOUT";
      result?: Record<string, unknown>;
      tokens?: number;
      credits?: number;
      errorCode?: string;
      errorMessage?: string;
      traceId?: string | null;
    } = { outcome: "FAILED", errorCode: "INTERNAL_ERROR", errorMessage: "Unreachable" };

    await this.observability.withSpan(
      contextForTrace,
      {
        name: "SCHEDULED_JOB_RUN",
        spanType: "BACKGROUND_TASK",
        component: "JobExecutor",
        organizationId: execution.organizationId,
        actorType: "SYSTEM",
        actorId: workerId,
        employeeInstallationId: execution.employeeId,
        traceMetadata: {
          scheduler: {
            jobId: execution.jobId,
            executionId: execution.id,
            definitionKey: execution.definitionKey,
            attemptCount: execution.attemptCount,
            workerId
          }
        },
        inputSummary: {
          definitionKey: execution.definitionKey,
          triggerType: execution.triggerType,
          priority: execution.priority
        }
      },
      async (span) => {
        const runContext: JobRunContext = {
          organizationId: execution.organizationId,
          jobId: execution.jobId,
          executionId: execution.id,
          definitionKey: execution.definitionKey,
          triggerType: execution.triggerType as JobRunContext["triggerType"],
          priority: execution.priority as JobRunContext["priority"],
          employeeId: execution.employeeId,
          payload: execution.payload,
          context: execution.context,
          timezone: execution.timezone,
          traceId: span.sampled ? span.traceId : null,
          attemptCount: execution.attemptCount
        };
        captured = { ...captured, traceId: span.sampled ? span.traceId : null };
        if (span.sampled) {
          await this.observability.addEvent(span, "job.started", {
            jobId: execution.jobId,
            workerId
          });
        }
        try {
          const result: JobRunResult = await withTimeout(handler.execute(runContext), timeoutMs);
          if (span.sampled) {
            await this.observability.addEvent(
              span,
              result.success ? "job.completed" : "job.failed",
              {
                success: result.success,
                errorCode: result.errorCode ?? null
              }
            );
          }
          captured = {
            ...captured,
            ...(result.success
              ? {
                  outcome: "COMPLETED" as const,
                  result: result.result ?? {},
                  tokens: result.tokens ?? 0,
                  credits: result.credits ?? 0
                }
              : {
                  outcome: "FAILED" as const,
                  errorCode: result.errorCode ?? "JOB_FAILED",
                  errorMessage: result.errorMessage ?? "Job handler returned failure."
                })
          };
        } catch {
          if (span.sampled)
            await this.observability.addEvent(span, "job.timed_out", { errorCode: "JOB_TIMEOUT" });
          captured = {
            ...captured,
            outcome: "TIMEOUT",
            errorCode: "JOB_TIMEOUT",
            errorMessage: `Job exceeded ${timeoutMs}ms timeout.`
          };
        }
      }
    );
    return captured;
  }

  /** Applies the Phase 5 retry policy after a failed/timed-out run. */
  private async applyRetryPolicy(
    workerId: string,
    execution: ClaimedExecution,
    policy: string,
    maxRetry: number,
    errorCode: string
  ): Promise<void> {
    const decision = decideRetry({ policy, attemptCount: execution.attemptCount, maxRetry });
    if (decision.shouldRetry) {
      const nextAttemptAt = new Date(Date.now() + decision.delayMs);
      await this.history.scheduleRetry(execution.id, {
        attemptCount: execution.attemptCount + 1,
        nextAttemptAt,
        workerId
      });
      await this.bumpJobCounter(execution, "retry");
      this.health.incrementRetried();
      this.logger.log({
        event: "SchedulerExecutionRetryScheduled",
        executionId: execution.id,
        attemptCount: execution.attemptCount + 1,
        delayMs: decision.delayMs,
        policy: decision.policy
      });
      return;
    }
    const errorMessage =
      errorCode === "JOB_TIMEOUT"
        ? "Job exceeded its configured timeout after exhausting retries."
        : "Job failed after exhausting retries.";
    await this.history.deadLetter(execution.id, { durationMs: 0, errorCode, errorMessage });
    await this.bumpJobCounter(execution, "failed");
    this.health.incrementFailed();
  }

  /** Tracks consecutive failures on the job row; a job that fails maxRetry times is parked as FAILED. */
  private async bumpJobCounter(
    execution: ClaimedExecution,
    kind: "completed" | "failed" | "retry"
  ): Promise<void> {
    const job = await this.prisma.scheduledJob.findUnique({ where: { id: execution.jobId } });
    if (!job) return;
    if (kind === "completed") {
      await this.prisma.scheduledJob.updateMany({
        where: { id: job.id },
        data: { retryCount: 0 }
      });
      return;
    }
    const retryCount = job.retryCount + 1;
    const exhausted = retryCount >= job.maxRetry;
    await this.prisma.scheduledJob.updateMany({
      where: { id: job.id },
      data: { retryCount, ...(exhausted ? { status: "FAILED" as const } : {}) }
    });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("JOB_TIMEOUT")), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
