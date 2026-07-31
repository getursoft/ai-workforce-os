import { Injectable, Logger, NotFoundException, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";
import { ApprovalService } from "../../approval/approval.service";
import { ApprovalAuditService } from "../../approval/approval-audit.service";
import { BookingProviderAdapter } from "../provider/booking-provider-adapter";

export type TravelCancellationStatus =
  | "CANCELLATION_REQUESTED_BY_CUSTOMER" | "CANCELLATION_QUOTE_PREPARED"
  | "WAITING_FOR_MANAGER_APPROVAL" | "MANAGER_APPROVED"
  | "CANCELLATION_IN_PROGRESS" | "CANCELLED" | "REFUND_IN_PROGRESS" | "REFUNDED"
  | "MANAGER_REJECTED" | "CUSTOMER_WITHDREW_REQUEST"
  | "CANCELLATION_FAILED" | "PARTIALLY_REFUNDED" | "NON_REFUNDABLE" | "REFUND_FAILED";

const VALID_TRANSITIONS: Record<string, TravelCancellationStatus[]> = {
  CANCELLATION_REQUESTED_BY_CUSTOMER: ["CANCELLATION_QUOTE_PREPARED", "CUSTOMER_WITHDREW_REQUEST"],
  CANCELLATION_QUOTE_PREPARED: ["WAITING_FOR_MANAGER_APPROVAL", "CUSTOMER_WITHDREW_REQUEST"],
  WAITING_FOR_MANAGER_APPROVAL: ["MANAGER_APPROVED", "MANAGER_REJECTED", "CUSTOMER_WITHDREW_REQUEST"],
  MANAGER_APPROVED: ["CANCELLATION_IN_PROGRESS", "CANCELLATION_FAILED"],
  CANCELLATION_IN_PROGRESS: ["CANCELLED", "CANCELLATION_FAILED"],
  CANCELLED: ["REFUND_IN_PROGRESS", "NON_REFUNDABLE"],
  REFUND_IN_PROGRESS: ["REFUNDED", "PARTIALLY_REFUNDED", "REFUND_FAILED"],
  REFUNDED: [],
  MANAGER_REJECTED: [],
  CUSTOMER_WITHDREW_REQUEST: [],
  CANCELLATION_FAILED: ["CANCELLATION_QUOTE_PREPARED"],
  PARTIALLY_REFUNDED: [],
  NON_REFUNDABLE: [],
  REFUND_FAILED: ["REFUND_IN_PROGRESS"],
};

@Injectable()
export class TravelCancellationService {
  private readonly logger = new Logger(TravelCancellationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly approvalService: ApprovalService,
    private readonly auditService: ApprovalAuditService,
    private readonly provider: BookingProviderAdapter,
  ) {}

  async requestCancellation(
    bookingId: string,
    organizationId: string,
    input: {
      requestedByUserId?: string;
      requestedByExternalId?: string;
      reason: string | null;
      idempotencyKey: string | null;
    }
  ): Promise<{ id: string; status: string }> {
    if (input.idempotencyKey) {
      const existing = await this.prisma.travelCancellation.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) return { id: existing.id, status: existing.status };
    }

    const booking = await this.prisma.travelBooking.findFirst({
      where: { id: bookingId, organizationId },
    });
    if (!booking) throw new NotFoundException("Booking not found");

    const record = await this.prisma.travelCancellation.create({
      data: {
        organizationId,
        bookingId,
        status: "CANCELLATION_REQUESTED_BY_CUSTOMER",
        requestedByUserId: input.requestedByUserId ?? null,
        requestedByExternalId: input.requestedByExternalId ?? null,
        reason: input.reason ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });

    return { id: record.id, status: record.status };
  }

  async prepareCancellationQuote(
    cancellationId: string,
    organizationId: string,
    financialImpact: Record<string, unknown>
  ): Promise<void> {
    await this.transitionTo(cancellationId, organizationId, "CANCELLATION_QUOTE_PREPARED", {
      cancellationQuoteJson: financialImpact as object,
      financialImpactJson: financialImpact as object,
    });
  }

  async requestManagerApproval(
    cancellationId: string,
    organizationId: string,
    managerUserId: string
  ): Promise<{ approvalRequestId: string }> {
    const cancellation = await this.prisma.travelCancellation.findFirst({
      where: { id: cancellationId, organizationId },
      include: { booking: true },
    });
    if (!cancellation) throw new NotFoundException("Cancellation not found");

    await this.transitionTo(cancellationId, organizationId, "WAITING_FOR_MANAGER_APPROVAL");

    const approval = await this.approvalService.create({
      organizationId,
      workflowExecutionId: cancellation.workflowExecutionId ?? cancellationId,
      agentId: cancellation.booking.pluginInstallationId,
      actionType: "CANCELLATION",
      subjectType: "TRAVEL_CANCELLATION",
      subjectId: cancellationId,
      requestedBy: cancellation.requestedByUserId ?? cancellation.requestedByExternalId ?? "customer",
      title: `Cancellation approval for booking`,
      description: `A customer has requested cancellation. Financial impact requires manager review.`,
      payload: { cancellationId, bookingId: cancellation.bookingId },
      policyResolution: {
        organizationId,
        workflowType: "TRAVEL",
        actionType: "CANCELLATION",
        metadata: { managerUserId },
      },
    });

    await this.prisma.travelCancellation.update({
      where: { id: cancellationId },
      data: { approvalRequestId: approval.id },
    });

    return { approvalRequestId: approval.id };
  }

  async recordManagerDecision(
    cancellationId: string,
    organizationId: string,
    decision: "APPROVE" | "REJECT",
    actorInfo: { actorUserId: string | null; comment: string | null }
  ): Promise<void> {
    const cancellation = await this.prisma.travelCancellation.findFirst({
      where: { id: cancellationId, organizationId },
    });
    if (!cancellation) throw new NotFoundException("Cancellation not found");
    if (cancellation.status !== "WAITING_FOR_MANAGER_APPROVAL") {
      throw new BadRequestException(`Cancellation is not awaiting manager approval (status: ${cancellation.status})`);
    }

    await this.approvalService.recordDecision(cancellation.approvalRequestId!, organizationId, decision as never, {
      actorType: "MANAGER",
      actorUserId: actorInfo.actorUserId,
      comment: actorInfo.comment,
      channel: "internal",
    });

    if (decision === "APPROVE") {
      await this.transitionTo(cancellationId, organizationId, "MANAGER_APPROVED");
      await this.executeProviderCancellation(cancellationId, organizationId);
    } else {
      await this.transitionTo(cancellationId, organizationId, "MANAGER_REJECTED");
    }
  }

  async executeProviderCancellation(cancellationId: string, organizationId: string): Promise<void> {
    const cancellation = await this.prisma.travelCancellation.findFirst({
      where: { id: cancellationId, organizationId },
      include: { booking: true },
    });
    if (!cancellation || cancellation.status !== "MANAGER_APPROVED") return;

    await this.transitionTo(cancellationId, organizationId, "CANCELLATION_IN_PROGRESS");

    try {
      const result = await this.provider.cancel({
        organizationId,
        cancellationId,
        bookingId: cancellation.bookingId,
        providerBookingRef: cancellation.booking?.providerBookingRef ?? null,
        providerPnr: cancellation.booking?.providerPnr ?? null,
        reason: cancellation.reason,
      });

      if (result.success) {
        await this.transitionTo(cancellationId, organizationId, "CANCELLED", {
          providerResponseJson: result.providerResponse as object,
          providerRefundRef: result.providerRefundRef ?? null,
        });

        await this.transitionTo(cancellationId, organizationId, "REFUND_IN_PROGRESS");

        const refundInput: {
          status: "REFUNDED" | "PARTIALLY_REFUNDED" | "NON_REFUNDABLE" | "REFUND_FAILED" | "REFUND_IN_PROGRESS";
          refundAmount?: number;
          refundCurrency?: string;
          providerRefundRef?: string;
        } = {
          status: result.refundStatus === "REFUNDED" ? "REFUNDED" : "REFUND_IN_PROGRESS",
          refundAmount: result.refundAmount,
          refundCurrency: result.refundCurrency,
        };
        if (result.providerRefundRef) refundInput.providerRefundRef = result.providerRefundRef;
        await this.recordRefundResult(cancellationId, organizationId, refundInput);
      } else {
        await this.transitionTo(cancellationId, organizationId, "CANCELLATION_FAILED", {
          providerResponseJson: result.providerResponse as object,
        });
      }
    } catch (error) {
      this.logger.error({ event: "PROVIDER_CANCELLATION_EXCEPTION", cancellationId, error: error instanceof Error ? error.message : "unknown" });
      await this.transitionTo(cancellationId, organizationId, "CANCELLATION_FAILED");
    }
  }

  async recordRefundResult(
    cancellationId: string,
    organizationId: string,
    result: {
      status: "REFUNDED" | "PARTIALLY_REFUNDED" | "NON_REFUNDABLE" | "REFUND_FAILED" | "REFUND_IN_PROGRESS";
      refundAmount?: number;
      refundCurrency?: string;
      providerRefundRef?: string;
    }
  ): Promise<void> {
    const terminalRefundStatuses = new Set(["REFUNDED", "PARTIALLY_REFUNDED", "NON_REFUNDABLE", "REFUND_FAILED"] as const);
    const targetStatus = terminalRefundStatuses.has(result.status as never) ? result.status : "REFUND_IN_PROGRESS";

    await this.transitionTo(cancellationId, organizationId, targetStatus, {
      refundAmount: result.refundAmount ?? null,
      refundCurrency: result.refundCurrency ?? null,
      providerRefundRef: result.providerRefundRef ?? null,
      refundStatus: result.status,
      resolvedAt: terminalRefundStatuses.has(result.status as never) ? new Date() : null,
    });
  }

  private async transitionTo(
    cancellationId: string,
    organizationId: string,
    targetStatus: TravelCancellationStatus,
    extraData?: Record<string, unknown>
  ): Promise<void> {
    const cancellation = await this.prisma.travelCancellation.findFirst({
      where: { id: cancellationId, organizationId },
    });
    if (!cancellation) throw new NotFoundException("Cancellation not found");

    const allowed = VALID_TRANSITIONS[cancellation.status];
    if (!allowed?.includes(targetStatus)) {
      throw new BadRequestException(`Cannot transition cancellation from ${cancellation.status} to ${targetStatus}`);
    }

    await this.prisma.travelCancellation.update({
      where: { id: cancellationId },
      data: { status: targetStatus, ...(extraData ?? {}) } as never,
    });

    await this.auditService.record({
      organizationId,
      workflowExecutionId: cancellation.workflowExecutionId ?? null,
      eventType: `CANCELLATION_${targetStatus}`,
      actorType: "SYSTEM",
      metadata: { cancellationId, previousStatus: cancellation.status, targetStatus },
    });
  }
}
