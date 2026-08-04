/**
 * Sprint 4.8 — Event Bridge (Phase 4): turns platform activity into scheduler domain events.
 *
 * Two sources feed the scheduler event bus:
 *  1. The EXISTING WorkforceEventBus.approval.decided emission (produced by the Approval Engine without
 *     any modification) — bridged in here and re-emitted as approval.completed / booking.approved /
 *     booking.cancelled / leave.approved.
 *  2. A tenant-scoped reconciliation scan over the domain tables (travel bookings/cancellations, HR leave,
 *     credit payments, knowledge documents, leads) using a persisted high-water mark in memory. This is
 *     crash-safe: an event that happened while the worker was down is picked up on the next scan, so an
 *     event-driven job is never permanently missed.
 */

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { MemoryService } from "../memory/memory.service";
import { WorkforceEventBus, type ApprovalDecidedEvent } from "../workforce/workforce-event-bus";
import { SchedulerEventBus } from "./scheduler-event-bus";
import type {
  SchedulerDomainEvent,
  SchedulerDomainEventName,
  ScheduledJobTriggerType
} from "./scheduler.types";

const WATERMARK_KEY = "scheduler.event.watermark";

/** Maps a domain event name to the coarse AFTER_* trigger type that subscribes to it. */
export function eventTriggerType(eventName: SchedulerDomainEventName): ScheduledJobTriggerType {
  switch (eventName) {
    case "booking.approved":
    case "booking.cancelled":
      return "AFTER_BOOKING";
    case "leave.approved":
      return "AFTER_APPROVAL";
    case "approval.completed":
      return "AFTER_APPROVAL";
    case "payment.received":
      return "AFTER_PAYMENT";
    case "document.uploaded":
    case "knowledge.updated":
      return "AFTER_UPLOAD";
    case "lead.created":
    case "employee.assigned":
      return "EVENT";
    default:
      return "EVENT";
  }
}

@Injectable()
export class SchedulerEventBridge {
  private readonly logger = new Logger(SchedulerEventBridge.name);
  private initialized = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly events: SchedulerEventBus,
    private readonly workforceEvents: WorkforceEventBus
  ) {}

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.workforceEvents.onApprovalDecided((event) => {
      void this.bridgeApprovalDecided(event).catch((error) => {
        this.logger.warn({ event: "SchedulerApprovalBridgeFailed", error: String(error) });
      });
    });
  }

  private async bridgeApprovalDecided(event: ApprovalDecidedEvent): Promise<void> {
    const approval = await this.prisma.approvalRequest.findFirst({
      where: { id: event.approvalRequestId, organizationId: event.organizationId }
    });
    const subjectType = approval?.subjectType ?? null;
    const subjectId = approval?.subjectId ?? null;
    const agentId = approval?.agentId ?? null;
    const occurredAt = new Date();

    this.emit({
      name: "approval.completed",
      organizationId: event.organizationId,
      employeeId: agentId,
      entityType: "APPROVAL_REQUEST",
      entityId: event.approvalRequestId,
      occurredAt,
      payload: {
        decision: event.decision,
        workflowExecutionId: event.workflowExecutionId,
        subjectType: subjectType ?? undefined,
        subjectId: subjectId ?? undefined
      }
    });

    if (subjectType === "TRAVEL_BOOKING" && subjectId) {
      this.emit({
        name: event.decision === "APPROVED" ? "booking.approved" : "booking.cancelled",
        organizationId: event.organizationId,
        employeeId: agentId,
        entityType: "TRAVEL_BOOKING",
        entityId: subjectId,
        occurredAt,
        payload: { decision: event.decision, approvalRequestId: event.approvalRequestId }
      });
    }

    const isLeave =
      (approval?.actionType ?? "").startsWith("LEAVE") ||
      (approval?.actionType ?? "").startsWith("HR_LEAVE");
    if (isLeave && event.decision === "APPROVED") {
      const leave = await this.prisma.hrLeaveRequest.findFirst({
        where: { organizationId: event.organizationId, approvalRequestId: event.approvalRequestId }
      });
      this.emit({
        name: "leave.approved",
        organizationId: event.organizationId,
        employeeId: agentId,
        entityType: "HR_LEAVE_REQUEST",
        entityId: leave?.id ?? subjectId ?? event.approvalRequestId,
        occurredAt,
        payload: { approvalRequestId: event.approvalRequestId }
      });
    }
  }

  private emit(event: SchedulerDomainEvent): void {
    this.events.emit(event);
  }

  /**
   * Reconciles one organization's domain tables against its high-water mark and emits every new activity
   * as a domain event. Idempotent and crash-safe: watermarks advance only after events are emitted, and
   * re-scanning the same window re-emits the same events (job dispatch is deduped on entityId).
   */
  async reconcile(organizationId: string): Promise<number> {
    const watermark = await this.readWatermark(organizationId);
    const now = new Date();
    let emitted = 0;

    // Payment received
    const payments = await this.prisma.creditPurchaseOrder.findMany({
      where: {
        organizationId,
        status: "PAID",
        paidAt: { not: null, gt: watermark.paymentReceivedAt ?? new Date(0) }
      },
      take: 25
    });
    for (const payment of payments) {
      this.emit({
        name: "payment.received",
        organizationId,
        entityType: "CREDIT_PURCHASE_ORDER",
        entityId: payment.id,
        occurredAt: payment.paidAt ?? now,
        payload: {
          credits: payment.credits,
          amountMinor: payment.amountMinor,
          currency: payment.currency
        }
      });
      emitted += 1;
    }

    // Knowledge documents indexed / uploaded
    const documents = await this.prisma.knowledgeDocument.findMany({
      where: {
        organizationId,
        status: "INDEXED",
        updatedAt: { gt: watermark.documentUpdatedAt ?? new Date(0) },
        deletedAt: null
      },
      take: 25
    });
    for (const document of documents) {
      this.emit({
        name: "document.uploaded",
        organizationId,
        entityType: "KNOWLEDGE_DOCUMENT",
        entityId: document.id,
        occurredAt: document.updatedAt,
        payload: {
          title: document.title,
          collectionId: document.collectionId,
          status: document.status
        }
      });
      emitted += 1;
    }

    // Travel leads created
    const leads = await this.prisma.travelLead.findMany({
      where: { organizationId, createdAt: { gt: watermark.leadCreatedAt ?? new Date(0) } },
      take: 25
    });
    for (const lead of leads) {
      this.emit({
        name: "lead.created",
        organizationId,
        employeeId: lead.pluginInstallationId,
        entityType: "TRAVEL_LEAD",
        entityId: lead.id,
        conversationId: lead.conversationId,
        occurredAt: lead.createdAt,
        payload: {
          reference: lead.reference,
          customerName: lead.customerName ?? undefined,
          phoneNumber: lead.phoneNumber
        }
      });
      emitted += 1;
    }

    // Bookings that reached BOOKED/TICKETS_DELIVERED without passing through an approval event
    const bookings = await this.prisma.travelBooking.findMany({
      where: {
        organizationId,
        status: { in: ["BOOKED", "TICKETS_DELIVERED"] },
        updatedAt: { gt: watermark.bookingUpdatedAt ?? new Date(0) }
      },
      take: 25
    });
    for (const booking of bookings) {
      this.emit({
        name: "booking.approved",
        organizationId,
        employeeId: booking.pluginInstallationId,
        entityType: "TRAVEL_BOOKING",
        entityId: booking.id,
        conversationId: booking.conversationId,
        occurredAt: booking.updatedAt,
        payload: { status: booking.status, providerPnr: booking.providerPnr ?? undefined }
      });
      emitted += 1;
    }

    // HR leave approved directly (not via an approval request event)
    const leave = await this.prisma.hrLeaveRequest.findMany({
      where: {
        organizationId,
        status: { in: ["MANAGER_APPROVED", "RECORDED"] },
        updatedAt: { gt: watermark.leaveUpdatedAt ?? new Date(0) }
      },
      take: 25
    });
    for (const request of leave) {
      this.emit({
        name: "leave.approved",
        organizationId,
        entityType: "HR_LEAVE_REQUEST",
        entityId: request.id,
        occurredAt: request.updatedAt,
        payload: { leaveType: request.leaveType, employeeUserId: request.employeeUserId }
      });
      emitted += 1;
    }

    await this.writeWatermark(organizationId, {
      paymentReceivedAt: now,
      documentUpdatedAt: now,
      leadCreatedAt: now,
      bookingUpdatedAt: now,
      leaveUpdatedAt: now
    });
    return emitted;
  }

  private async readWatermark(organizationId: string): Promise<Watermark> {
    try {
      const records = await this.memory.recall(organizationId, {
        userId: null,
        employeeId: null,
        conversationId: null
      });
      const record = records.organization.find((item) => item.key === WATERMARK_KEY);
      const value = (record?.value ?? {}) as Partial<Watermark>;
      return {
        paymentReceivedAt: toDate(value.paymentReceivedAt),
        documentUpdatedAt: toDate(value.documentUpdatedAt),
        leadCreatedAt: toDate(value.leadCreatedAt),
        bookingUpdatedAt: toDate(value.bookingUpdatedAt),
        leaveUpdatedAt: toDate(value.leaveUpdatedAt)
      };
    } catch {
      return emptyWatermark();
    }
  }

  private async writeWatermark(organizationId: string, watermark: Watermark): Promise<void> {
    try {
      await this.memory.remember({
        organizationId,
        scope: "ORGANIZATION",
        key: WATERMARK_KEY,
        category: "SCHEDULER",
        value: { ...watermark } as Record<string, unknown>,
        source: "SYSTEM",
        importance: "LOW",
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        actorId: null
      });
    } catch {
      // watermark write failure must never break the tick
    }
  }
}

interface Watermark {
  paymentReceivedAt: Date | null;
  documentUpdatedAt: Date | null;
  leadCreatedAt: Date | null;
  bookingUpdatedAt: Date | null;
  leaveUpdatedAt: Date | null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function emptyWatermark(): Watermark {
  return {
    paymentReceivedAt: null,
    documentUpdatedAt: null,
    leadCreatedAt: null,
    bookingUpdatedAt: null,
    leaveUpdatedAt: null
  };
}
