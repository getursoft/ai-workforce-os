/**
 * Sprint 5.0 — durable queue contracts (Phase 4).
 *
 * The platform keeps the database as the authoritative state for all background work. This adapter layer
 * gives the three existing pollers (scheduler, workforce processor, channel processor) — and any new
 * background work — a uniform, durable queue contract with delayed jobs, retries with backoff,
 * dead-lettering, idempotent enqueue, visibility timeouts, worker heartbeats and trace propagation.
 *
 * A Redis/BullMQ provider can be swapped in at deploy time via QUEUE_PROVIDER=redis without changing
 * callers; every message references business rows by id rather than duplicating payloads.
 */

import type { Prisma } from "@prisma/client";
import type { QueueCategory, QueueMessageStatus } from "@prisma/client";

export type QueueStatus = QueueMessageStatus;

export interface QueueMessageView {
  id: string;
  organizationId: string;
  category: QueueCategory;
  refType: string;
  refId: string;
  employeeId: string | null;
  priority: number;
  status: QueueStatus;
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
}

export interface QueuePublishInput {
  organizationId: string;
  category: QueueCategory;
  refType: string;
  refId: string;
  employeeId?: string | null;
  priority?: number;
  /** Delay before the message becomes available (future `availableAt`). */
  delayMs?: number;
  traceId?: string | null;
  dedupeKey?: string | null;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  visibilityMs?: number;
}

export interface QueueClaimInput {
  workerId: string;
  categories?: QueueCategory[];
  limit?: number;
  now?: Date;
}

export interface QueueClaimResult {
  /** Messages now held by this worker under the visibility window. */
  claimed: QueueMessageView[];
}

export interface QueueFailInput {
  errorCode: string;
  errorMessage: string;
  /** Backoff delay before the next attempt (exponential by default). */
  retryDelayMs: number;
  now?: Date;
}

export interface QueueHealth {
  queued: number;
  claimed: number;
  completed: number;
  failed: number;
  retrying: number;
  deadLettered: number;
  staleClaims: number;
  oldestQueuedMs: number | null;
  queueLatencyMs: number | null;
}

/** Durable queue port. */
export interface BackgroundQueue {
  publish(input: QueuePublishInput): Promise<QueueMessageView | null>;
  claim(input: QueueClaimInput): Promise<QueueClaimResult>;
  complete(messageId: string, workerId: string): Promise<boolean>;
  fail(messageId: string, workerId: string, input: QueueFailInput): Promise<boolean>;
  ack(messageId: string, workerId: string): Promise<boolean>;
  /** Re-queues CLAIMED messages whose visibility window elapsed (crash recovery). */
  recover(now?: Date): Promise<number>;
  deadLetter(messageId: string, workerId: string, errorCode: string, errorMessage: string): Promise<boolean>;
  health(now?: Date): Promise<QueueHealth>;
  list(organizationId: string, filters: { status?: QueueStatus; category?: QueueCategory; limit?: number }): Promise<QueueMessageView[]>;
}

export interface QueueConsumer {
  consume(workerId: string, categories: QueueCategory[], handler: (message: QueueMessageView) => Promise<boolean>): Promise<number>;
}

/** A handler that processes one claimed message; returns true when fully processed. */
export type QueueMessageHandler = (message: QueueMessageView) => Promise<boolean>;

export interface QueueHandlerRegistry {
  register(category: QueueCategory, handler: QueueMessageHandler): void;
  resolve(category: QueueCategory): QueueMessageHandler | null;
}
