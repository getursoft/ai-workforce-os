/**
 * Sprint 5.0 — PostgreSQL-backed durable queue adapter (Phase 4).
 *
 * Claims are atomic conditional UPDATEs (QUEUED/RETRYING → CLAIMED guarded by availableAt), so concurrent
 * workers can never claim the same message twice. A claimed message gets a visibility lease (`availableAt`
 * pushed forward by visibilityMs); if a worker crashes, `recover()` returns those messages to QUEUED.
 * Enqueue is idempotent via the unique `dedupeKey`. Failures follow an exponential-backoff ladder
 * (`retryDelayMs * 2^(attempt-1)`) and park on DEAD_LETTERED after maxAttempts.
 */

import { Injectable, Logger } from "@nestjs/common";
import { Prisma, QueueCategory, QueueMessageStatus } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import type {
  BackgroundQueue,
  QueueClaimInput,
  QueueClaimResult,
  QueueFailInput,
  QueueHealth,
  QueueMessageView,
  QueuePublishInput
} from "./queue.types";

const MAX_LOOKBACK_MS = 60 * 60 * 1000;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

@Injectable()
export class PostgresQueueAdapter implements BackgroundQueue {
  private readonly logger = new Logger(PostgresQueueAdapter.name);

  constructor(private readonly prisma: PrismaService) {}

  async publish(input: QueuePublishInput): Promise<QueueMessageView | null> {
    const now = new Date();
    const availableAt = new Date(now.getTime() + (input.delayMs ?? 0));
    const data = {
      organizationId: input.organizationId,
      category: input.category,
      refType: input.refType.slice(0, 80),
      refId: input.refId.slice(0, 200),
      employeeId: input.employeeId ?? null,
      priority: input.priority ?? 0,
      status: "QUEUED" as const,
      payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      availableAt,
      maxAttempts: input.maxAttempts ?? 5,
      visibilityMs: input.visibilityMs ?? 60_000,
      traceId: input.traceId ?? null,
      dedupeKey: input.dedupeKey ?? null
    };
    if (input.dedupeKey) {
      const existing = await this.prisma.queueMessage.findUnique({ where: { dedupeKey: input.dedupeKey } });
      if (existing) return this.toView(existing);
    }
    try {
      const row = await this.prisma.queueMessage.create({ data });
      return this.toView(row);
    } catch (error) {
      if (isUniqueViolation(error) && input.dedupeKey) {
        const existing = await this.prisma.queueMessage.findUnique({ where: { dedupeKey: input.dedupeKey } });
        return existing ? this.toView(existing) : null;
      }
      throw error;
    }
  }

  async claim(input: QueueClaimInput): Promise<QueueClaimResult> {
    const now = input.now ?? new Date();
    const limit = Math.min(input.limit ?? 10, 50);
    const candidates = await this.prisma.queueMessage.findMany({
      where: {
        status: { in: ["QUEUED", "RETRYING"] },
        availableAt: { lte: now },
        ...(input.categories && input.categories.length > 0 ? { category: { in: input.categories } } : {}),
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }]
      },
      orderBy: [{ priority: "desc" }, { availableAt: "asc" }],
      take: limit * 3
    });
    const claimed: QueueMessageView[] = [];
    for (const candidate of candidates) {
      if (claimed.length >= limit) break;
      const leaseUntil = new Date(now.getTime() + candidate.visibilityMs);
      const result = await this.prisma.queueMessage.updateMany({
        where: {
          id: candidate.id,
          status: { in: ["QUEUED", "RETRYING"] },
          availableAt: { lte: now }
        },
        data: {
          status: "CLAIMED",
          workerId: input.workerId,
          availableAt: leaseUntil,
          attemptCount: { increment: 1 },
          nextAttemptAt: null,
          errorCode: null,
          errorMessage: null
        }
      });
      if (result.count === 1) {
        const row = await this.prisma.queueMessage.findUnique({ where: { id: candidate.id } });
        if (row) claimed.push(this.toView(row));
      }
    }
    return { claimed };
  }

  async complete(messageId: string, workerId: string): Promise<boolean> {
    // workerId ownership guard: a worker that crashed mid-task and had its claim reclaimed by recover()
    // must not be able to complete/fail/dead-letter a message another worker has since picked up.
    const result = await this.prisma.queueMessage.updateMany({
      where: { id: messageId, status: "CLAIMED", workerId },
      data: { status: "COMPLETED", completedAt: new Date() }
    });
    return result.count === 1;
  }

  async fail(messageId: string, workerId: string, input: QueueFailInput): Promise<boolean> {
    const row = await this.prisma.queueMessage.findUnique({ where: { id: messageId } });
    if (!row || row.status !== "CLAIMED" || row.workerId !== workerId) return false;
    const now = input.now ?? new Date();
    // row.attemptCount already reflects the attempt that just failed (incremented by claim()). Retry iff
    // that count hasn't yet reached maxAttempts — off-by-one here previously meant maxAttempts:5 only
    // actually allowed 4 real attempts before dead-lettering (caught by the Phase 4 integration test).
    if (row.attemptCount < row.maxAttempts) {
      const backoff = input.retryDelayMs * Math.pow(2, Math.max(row.attemptCount - 1, 0));
      await this.prisma.queueMessage.updateMany({
        where: { id: messageId, status: "CLAIMED", workerId },
        data: {
          status: "RETRYING",
          workerId: null,
          nextAttemptAt: new Date(now.getTime() + Math.min(backoff, 86_400_000)),
          availableAt: new Date(now.getTime() + Math.min(backoff, 86_400_000)),
          errorCode: input.errorCode.slice(0, 100),
          errorMessage: input.errorMessage.slice(0, 1000)
        }
      });
      return true;
    }
    await this.prisma.queueMessage.updateMany({
      where: { id: messageId, status: "CLAIMED" },
      data: {
        status: "DEAD_LETTERED",
        workerId: null,
        errorCode: input.errorCode.slice(0, 100),
        errorMessage: input.errorMessage.slice(0, 1000)
      }
    });
    return true;
  }

  async ack(messageId: string, workerId: string): Promise<boolean> {
    return this.complete(messageId, workerId);
  }

  async deadLetter(messageId: string, workerId: string, errorCode: string, errorMessage: string): Promise<boolean> {
    const result = await this.prisma.queueMessage.updateMany({
      where: { id: messageId, status: "CLAIMED", workerId },
      data: { status: "DEAD_LETTERED", workerId: null, errorCode: errorCode.slice(0, 100), errorMessage: errorMessage.slice(0, 1000) }
    });
    return result.count === 1;
  }

  /** Crash recovery: CLAIMED messages whose visibility lease elapsed go back to QUEUED. */
  async recover(now = new Date()): Promise<number> {
    const result = await this.prisma.queueMessage.updateMany({
      where: { status: "CLAIMED", availableAt: { lt: now } },
      data: { status: "QUEUED", workerId: null, availableAt: now, errorCode: null, errorMessage: null }
    });
    if (result.count > 0) this.logger.warn({ event: "QUEUE_STALE_CLAIMS_RECOVERED", count: result.count });
    return result.count;
  }

  async health(now = new Date()): Promise<QueueHealth> {
    const [queued, claimed, completed, failed, retrying, deadLettered, staleClaims, oldest] = await Promise.all([
      this.prisma.queueMessage.count({ where: { status: "QUEUED" } }),
      this.prisma.queueMessage.count({ where: { status: "CLAIMED" } }),
      this.prisma.queueMessage.count({ where: { status: "COMPLETED" } }),
      this.prisma.queueMessage.count({ where: { status: "FAILED" } }),
      this.prisma.queueMessage.count({ where: { status: "RETRYING" } }),
      this.prisma.queueMessage.count({ where: { status: "DEAD_LETTERED" } }),
      this.prisma.queueMessage.count({ where: { status: "CLAIMED", availableAt: { lt: now } } }),
      this.prisma.queueMessage.findFirst({ where: { status: "QUEUED" }, orderBy: { availableAt: "asc" }, select: { availableAt: true } })
    ]);
    const oldestQueuedMs = oldest ? now.getTime() - oldest.availableAt.getTime() : null;
    const queueLatencyMs = oldestQueuedMs !== null && oldestQueuedMs >= 0 ? oldestQueuedMs : null;
    return { queued, claimed, completed, failed, retrying, deadLettered, staleClaims, oldestQueuedMs, queueLatencyMs };
  }

  async list(
    organizationId: string,
    filters: { status?: QueueMessageStatus; category?: QueueCategory; limit?: number } = {}
  ): Promise<QueueMessageView[]> {
    const rows = await this.prisma.queueMessage.findMany({
      where: {
        organizationId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.category ? { category: filters.category } : {})
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(filters.limit ?? 50, 200)
    });
    return rows.map((row) => this.toView(row));
  }

  private toView(row: {
    id: string;
    organizationId: string;
    category: QueueCategory;
    refType: string;
    refId: string;
    employeeId: string | null;
    priority: number;
    status: QueueMessageStatus;
    payload: Prisma.JsonValue;
    availableAt: Date;
    attemptCount: number;
    maxAttempts: number;
    nextAttemptAt: Date | null;
    workerId: string | null;
    traceId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: Date;
  }): QueueMessageView {
    return {
      id: row.id,
      organizationId: row.organizationId,
      category: row.category,
      refType: row.refType,
      refId: row.refId,
      employeeId: row.employeeId,
      priority: row.priority,
      status: row.status,
      payload: row.payload,
      availableAt: row.availableAt,
      attemptCount: row.attemptCount,
      maxAttempts: row.maxAttempts,
      nextAttemptAt: row.nextAttemptAt,
      workerId: row.workerId,
      traceId: row.traceId,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt
    };
  }
}

export { MAX_LOOKBACK_MS };
