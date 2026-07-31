import { Injectable, Logger } from "@nestjs/common";
import { ApprovalAuditService } from "../approval-audit.service";

export interface NotificationEvent {
  organizationId: string;
  approvalRequestId: string;
  workflowExecutionId?: string;
  eventType: string;
  recipientType: string;
  recipientUserId?: string;
  recipientExternalId?: string;
  recipientChannel: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class ApprovalNotificationService {
  private readonly logger = new Logger(ApprovalNotificationService.name);

  constructor(
    private readonly auditService: ApprovalAuditService
  ) {}

  async notify(event: NotificationEvent): Promise<void> {
    this.logger.log({
      event: "NOTIFICATION_SENT",
      type: event.eventType,
      channel: event.recipientChannel,
      recipientType: event.recipientType,
      approvalRequestId: event.approvalRequestId,
    });

    await this.auditService.record({
      organizationId: event.organizationId,
      approvalRequestId: event.approvalRequestId,
      workflowExecutionId: event.workflowExecutionId ?? null,
      eventType: `NOTIFICATION_${event.eventType}`,
      actorType: "SYSTEM",
      metadata: {
        channel: event.recipientChannel,
        recipientType: event.recipientType,
        title: event.title,
      },
    });
  }

  async notifyApprovalRequested(
    organizationId: string,
    approvalRequestId: string,
    workflowExecutionId: string,
    approverUserIds: string[]
  ): Promise<void> {
    for (const userId of approverUserIds) {
      await this.notify({
        organizationId,
        approvalRequestId,
        workflowExecutionId,
        eventType: "APPROVAL_REQUESTED",
        recipientType: "USER",
        recipientUserId: userId,
        recipientChannel: "in-app",
        title: "Approval Request",
        body: "A new approval request requires your review.",
      });
    }
  }

  async notifyApprovalResolved(
    organizationId: string,
    approvalRequestId: string,
    requesterUserId: string | null,
    _requesterExternalId: string | null,
    status: string
  ): Promise<void> {
    const eventType = status === "APPROVED" ? "APPROVAL_APPROVED" : "APPROVAL_REJECTED";
    const title = status === "APPROVED" ? "Request Approved" : "Request Rejected";
    const body = status === "APPROVED"
      ? "Your approval request has been approved."
      : "Your approval request has been reviewed.";

    if (requesterUserId) {
      await this.notify({
        organizationId,
        approvalRequestId,
        eventType,
        recipientType: "USER",
        recipientUserId: requesterUserId,
        recipientChannel: "in-app",
        title,
        body,
      });
    }
  }
}
