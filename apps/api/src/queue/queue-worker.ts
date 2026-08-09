/**
 * Sprint 5.0 — queue consumer worker + health (Phase 4).
 *
 * `QueueConsumerWorker` is the polling consumer for queue_messages: it claims available messages
 * (visibility-leased), hands each to the registered handler for its category, and acknowledges or fails
 * them. It runs only in processes whose PROCESS_ROLE includes background work (`all`,
 * `workforce-worker`, `maintenance`). `QueueHealthService` exposes queue depth/latency for health checks.
 */

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { QueueCategory } from "@prisma/client";
import type {
  BackgroundQueue,
  QueueHandlerRegistry as QueueHandlerRegistryPort,
  QueueHealth,
  QueueMessageHandler,
  QueueMessageView,
  QueueStatus
} from "./queue.types";
import { QUEUE } from "./queue.tokens";
import { APP_CONFIG, type AppConfig } from "../config/config.tokens";

const POLL_INTERVAL_MS = 2_000;

@Injectable()
export class QueueHandlerRegistry implements QueueHandlerRegistryPort {
  private readonly handlers = new Map<QueueCategory, QueueMessageHandler>();
  register(category: QueueCategory, handler: QueueMessageHandler): void {
    this.handlers.set(category, handler);
  }
  resolve(category: QueueCategory): QueueMessageHandler | null {
    return this.handlers.get(category) ?? null;
  }
}

@Injectable()
export class QueueConsumerWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueConsumerWorker.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastPollAt: Date | null = null;

  constructor(
    @Inject(QUEUE) private readonly queue: BackgroundQueue,
    private readonly registry: QueueHandlerRegistry,
    @Optional() @Inject(APP_CONFIG) private readonly config?: AppConfig
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === "test") return;
    const runsWorker =
      !this.config ||
      this.config.processRole === "all" ||
      this.config.processRole === "workforce-worker" ||
      this.config.processRole === "maintenance";
    if (!runsWorker) return; // Phase 3: role separation
    this.timer = setInterval(() => void this.processOnce(), POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  getLastPollAt(): Date | null {
    return this.lastPollAt;
  }

  /** One poll pass: recover stale claims, then claim + process available messages. */
  async processOnce(workerId = `queue-worker-${process.pid}`, limit = 10, now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    this.lastPollAt = now;
    try {
      await this.queue.recover(now);
      const { claimed } = await this.queue.claim({ workerId, limit, now });
      let processed = 0;
      for (const message of claimed) {
        const ok = await this.handle(message);
        processed += 1;
        void ok;
      }
      return processed;
    } catch (error) {
      this.logger.error({ event: "QueueConsumeTickFailed", error: String(error) });
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async handle(message: QueueMessageView): Promise<boolean> {
    const handler = this.registry.resolve(message.category);
    if (!handler) {
      await this.queue.fail(message.id, message.workerId ?? "", {
        errorCode: "NO_HANDLER",
        errorMessage: `No handler registered for queue category ${message.category}`,
        retryDelayMs: 0
      });
      return false;
    }
    try {
      const success = await handler(message);
      if (success) {
        await this.queue.complete(message.id, message.workerId ?? "");
      } else {
        await this.queue.fail(message.id, message.workerId ?? "", {
          errorCode: "HANDLER_REJECTED",
          errorMessage: "Handler reported the message could not be processed.",
          retryDelayMs: 30_000
        });
      }
      return success;
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "HANDLER_CRASHED";
      await this.queue.fail(message.id, message.workerId ?? "", {
        errorCode: code,
        errorMessage: String(error).slice(0, 1000),
        retryDelayMs: 30_000
      });
      return false;
    }
  }
}

@Injectable()
export class QueueHealthService {
  constructor(@Inject(QUEUE) private readonly queue: BackgroundQueue) {}

  async snapshot(now = new Date()): Promise<{ status: string; detail: string; health: QueueHealth }> {
    const health = await this.queue.health(now);
    const inFlight = health.queued + health.claimed + health.retrying;
    const backlogged = health.staleClaims > 0 || (health.oldestQueuedMs !== null && health.oldestQueuedMs > 5 * 60_000);
    return {
      status: backlogged ? "DEGRADED" : "HEALTHY",
      detail: backlogged
        ? `Queue backlog: ${health.queued} queued, ${health.staleClaims} stale claims.`
        : `Queue healthy (${inFlight} in flight).`,
      health
    };
  }

  counts(): Record<QueueStatus, number> {
    return { QUEUED: 0, CLAIMED: 0, COMPLETED: 0, FAILED: 0, RETRYING: 0, DEAD_LETTERED: 0 };
  }
}
