import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { WorkforceOrchestratorService } from "./workforce-orchestrator.service";
import { APP_CONFIG, type AppConfig } from "../config/config.tokens";

/**
 * Sprint 4.6 (continued) — Phase 1's real out-of-request execution. There is no message broker/job queue
 * in this codebase, so "outside the initiating HTTP request" is implemented as an independent polling tick
 * running on Node's own event loop: `delegate()` for an ASYNCHRONOUS task persists QUEUED and returns to
 * the HTTP caller immediately; this processor's own, later `setInterval` callback — a completely separate
 * call stack, invoked well after the response has already been sent — is what actually calls dispatch().
 * Also sweeps QUEUED/RUNNING tasks whose timeoutAt has passed, so a stuck target can never wedge a task
 * forever.
 */
@Injectable()
export class WorkforceTaskProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkforceTaskProcessor.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: WorkforceOrchestratorService,
    @Optional() @Inject(APP_CONFIG) private readonly config?: AppConfig
  ) {}

  onModuleInit(): void {
    if (this.config && !this.config.runs("workforce-worker")) return; // Phase 3: role separation
    this.timer = setInterval(() => void this.tick(), WorkforceTaskProcessor.POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  static readonly POLL_INTERVAL_MS = 300;

  /** Exposed directly so tests (and an operator debugging a stuck queue) can force one processing pass
   *  without waiting on the timer. */
  async tick(): Promise<void> {
    if (this.ticking) return; // never run two ticks concurrently against the same process
    this.ticking = true;
    try {
      await this.dispatchQueued();
      await this.sweepTimeouts();
    } catch (error) {
      this.logger.error({ event: "WorkforceTaskProcessorTickFailed", error: String(error) });
    } finally {
      this.ticking = false;
    }
  }

  private async dispatchQueued(): Promise<void> {
    const due = await this.prisma.employeeDelegatedTask.findMany({
      where: { status: "QUEUED", mode: "ASYNCHRONOUS" },
      orderBy: { createdAt: "asc" },
      take: 10
    });
    for (const task of due) {
      await this.orchestrator.dispatch(task.id).catch((error) => {
        this.logger.error({ event: "WorkforceAsyncDispatchFailed", taskId: task.id, error: String(error) });
      });
    }
  }

  private async sweepTimeouts(): Promise<void> {
    const overdue = await this.prisma.employeeDelegatedTask.findMany({
      where: { status: { in: ["QUEUED", "RUNNING"] }, timeoutAt: { lt: new Date() } },
      take: 25
    });
    for (const task of overdue) {
      await this.orchestrator
        .failTask(task.id, "TASK_TIMED_OUT", "The delegated task exceeded its configured timeout.")
        .catch((error) => {
          this.logger.error({ event: "WorkforceTimeoutSweepFailed", taskId: task.id, error: String(error) });
        });
    }
  }
}
