import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";

export interface AuditEventInput {
  organizationId: string;
  approvalRequestId?: string | null;
  workflowExecutionId?: string | null;
  eventType: string;
  actorType: string;
  actorId?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class ApprovalAuditService {
  private readonly logger = new Logger(ApprovalAuditService.name);
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditEventInput): Promise<void> {
    try {
      await this.prisma.approvalAuditEvent.create({
        data: {
          organizationId: input.organizationId,
          approvalRequestId: input.approvalRequestId ?? null,
          workflowExecutionId: input.workflowExecutionId ?? null,
          eventType: input.eventType,
          actorType: input.actorType,
          actorId: input.actorId ?? null,
          metadataJson: (input.metadata ?? {}) as object,
        },
      });
    } catch (error) {
      this.logger.error({ event: "AUDIT_RECORD_FAILED", error: error instanceof Error ? error.message : "unknown" });
    }
  }

  async listForRequest(approvalRequestId: string, limit = 100): Promise<unknown[]> {
    return this.prisma.approvalAuditEvent.findMany({
      where: { approvalRequestId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }
}
