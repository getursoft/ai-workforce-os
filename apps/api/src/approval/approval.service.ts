import { Injectable, NotFoundException, BadRequestException, ConflictException, Optional } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { ApprovalPolicyEngine, type PolicyResolutionInput } from "./engine/approval-policy-engine";
import { ApprovalAuditService } from "./approval-audit.service";
import { WorkforceEventBus } from "../workforce/workforce-event-bus";
import type { ApprovalRequest, ApproverType as PrismaApproverType } from "@prisma/client";

export type ApprovalRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CHANGES_REQUESTED" | "EXPIRED" | "CANCELLED" | "SUPERSEDED";

const VALID_TRANSITIONS: Record<string, ApprovalRequestStatus[]> = {
  PENDING: ["APPROVED", "REJECTED", "CHANGES_REQUESTED", "EXPIRED", "CANCELLED", "SUPERSEDED"],
  APPROVED: [],
  REJECTED: [],
  CHANGES_REQUESTED: ["PENDING"],
  EXPIRED: [],
  CANCELLED: [],
  SUPERSEDED: [],
};

export interface CreateApprovalRequestInput {
  organizationId: string;
  workflowExecutionId: string;
  agentId: string;
  actionType: string;
  subjectType?: string;
  subjectId?: string;
  requesterType?: string;
  requesterUserId?: string;
  requesterExternalId?: string;
  requestedBy: string;
  title: string;
  description: string;
  payload?: Record<string, unknown>;
  policyResolution?: PolicyResolutionInput;
  idempotencyKey?: string;
}

export interface ApprovalRequestData {
  id: string;
  organizationId: string;
  workflowExecutionId: string;
  policyId: string | null;
  agentId: string;
  actionType: string;
  subjectType: string | null;
  subjectId: string | null;
  requesterType: string;
  requesterUserId: string | null;
  requesterExternalId: string | null;
  requestedBy: string;
  status: ApprovalRequestStatus;
  title: string;
  description: string;
  payload: Record<string, unknown>;
  comments: ApprovalComment[];
  approverType: string;
  expiresAt: string | null;
  resolvedAt: string | null;
  supersededById: string | null;
  idempotencyKey: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalComment {
  author: string;
  text: string;
  createdAt: string;
}

export type ApprovalDecisionType = "APPROVE" | "REJECT" | "REQUEST_CHANGES" | "WITHDRAW" | "CANCEL" | "ESCALATE";

@Injectable()
export class ApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policyEngine: ApprovalPolicyEngine,
    private readonly auditService: ApprovalAuditService,
    @Optional() private readonly events?: WorkforceEventBus,
  ) {}

  async create(input: CreateApprovalRequestInput): Promise<ApprovalRequestData> {
    if (input.idempotencyKey) {
      const existing = await this.prisma.approvalRequest.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) return this.toData(existing);
    }

    const policyResult = input.policyResolution
      ? await this.policyEngine.resolve(input.policyResolution)
      : null;

    const record = await this.prisma.approvalRequest.create({
      data: {
        organizationId: input.organizationId,
        workflowExecutionId: input.workflowExecutionId,
        // "builtin:default" (ApprovalPolicyEngine.defaultPolicy's fallback marker, used whenever the
        // organization has no configured ApprovalPolicy row) is not a UUID — writing it into this
        // @db.Uuid column throws and previously aborted approval-request creation for every org without
        // a custom policy configured (the common case for a freshly registered org).
        policyId: policyResult?.policyId && policyResult.policyId !== "builtin:default" ? policyResult.policyId : null,
        agentId: input.agentId,
        actionType: input.actionType,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        requesterType: input.requesterType ?? "EMPLOYEE",
        requesterUserId: input.requesterUserId ?? null,
        requesterExternalId: input.requesterExternalId ?? null,
        requestedBy: input.requestedBy,
        status: "PENDING",
        title: input.title,
        description: input.description,
        payload: (input.payload ?? {}) as object,
        payloadSnapshotJson: (input.payload ?? {}) as object,
        comments: [],
        approverType: (policyResult?.approverType ?? "MANAGER") as PrismaApproverType,
        expiresAt: policyResult?.expiresAt ?? this.defaultExpiry(),
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });

    if (policyResult) {
      await this.createAssignments(record.id, policyResult);
    }

    await this.auditService.record({
      organizationId: input.organizationId,
      approvalRequestId: record.id,
      workflowExecutionId: input.workflowExecutionId,
      eventType: "APPROVAL_CREATED",
      actorType: "SYSTEM",
      actorId: input.requestedBy,
      metadata: { actionType: input.actionType, approverType: policyResult?.approverType ?? "MANAGER" },
    });

    return this.toData(record);
  }

  async findById(id: string, organizationId: string): Promise<ApprovalRequestData | null> {
    const record = await this.prisma.approvalRequest.findFirst({
      where: { id, organizationId },
    });
    return record ? this.toData(record) : null;
  }

  async list(organizationId: string, filter?: {
    status?: ApprovalRequestStatus;
    actionType?: string;
    requesterUserId?: string;
    approverUserId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: ApprovalRequestData[]; total: number }> {
    const where: Record<string, unknown> = { organizationId };
    if (filter?.status) where.status = filter.status;
    if (filter?.actionType) where.actionType = filter.actionType;
    if (filter?.requesterUserId) where.requesterUserId = filter.requesterUserId;

    const [items, total] = await Promise.all([
      this.prisma.approvalRequest.findMany({
        where: where as never,
        orderBy: { createdAt: "desc" },
        take: filter?.limit ?? 50,
        skip: filter?.offset ?? 0,
      }),
      this.prisma.approvalRequest.count({ where: where as never }),
    ]);

    return {
      items: items.map((r) => this.toData(r)),
      total,
    };
  }

  async pendingForUser(organizationId: string, userId: string): Promise<ApprovalRequestData[]> {
    const records = await this.prisma.approvalRequest.findMany({
      where: {
        organizationId,
        status: "PENDING",
        assignments: { some: { approverUserId: userId, status: "PENDING" } },
      } as never,
      orderBy: { createdAt: "desc" },
    });
    return records.map((r) => this.toData(r));
  }

  async recordDecision(
    approvalRequestId: string,
    organizationId: string,
    decision: ApprovalDecisionType,
    actorInfo: {
      actorType: string;
      actorUserId?: string | null;
      actorExternalId?: string | null;
      comment?: string | null;
      channel?: string;
    }
  ): Promise<ApprovalRequestData> {
    const result = await this.prisma.$transaction(async (tx) => {
      const record = await tx.approvalRequest.findFirst({
        where: { id: approvalRequestId, organizationId },
      });

      if (!record) throw new NotFoundException("Approval request not found");
      if (record.status === "APPROVED" || record.status === "REJECTED") {
        throw new ConflictException(`Approval request is already ${record.status.toLowerCase()}`);
      }
      if (record.status === "EXPIRED") throw new BadRequestException("Approval request has expired");
      if (record.status === "CANCELLED") throw new BadRequestException("Approval request was cancelled");
      if (record.status === "SUPERSEDED") throw new BadRequestException("Approval request was superseded");

      const targetStatus = this.decisionToStatus(decision);
      if (!VALID_TRANSITIONS[record.status]?.includes(targetStatus)) {
        throw new BadRequestException(
          `Cannot transition from ${record.status} to ${targetStatus}`
        );
      }

      await tx.approvalDecision.create({
        data: {
          approvalRequestId: record.id,
          decision: decision as never,
          actorType: actorInfo.actorType,
          actorUserId: actorInfo.actorUserId ?? null,
          actorExternalId: actorInfo.actorExternalId ?? null,
          comment: actorInfo.comment ?? null,
          channel: actorInfo.channel ?? "internal",
        },
      });

      const updateData: Record<string, unknown> = {
        status: targetStatus,
        resolvedAt: new Date(),
      };
      if (targetStatus === "APPROVED") {
        updateData.approvedAt = new Date();
        updateData.approvedBy = actorInfo.actorUserId ?? actorInfo.actorExternalId ?? "unknown";
      }

      const existingComments = Array.isArray(record.comments) ? (record.comments as unknown as ApprovalComment[]) : [];
      if (actorInfo.comment) {
        updateData.comments = [
          ...existingComments,
          { author: actorInfo.actorUserId ?? actorInfo.actorExternalId ?? "unknown", text: actorInfo.comment, createdAt: new Date().toISOString() },
        ] as unknown as object[];
      }

      const updated = await tx.approvalRequest.update({
        where: { id: record.id },
        data: updateData as never,
      });

      await tx.approvalAuditEvent.create({
        data: {
          organizationId,
          approvalRequestId: record.id,
          workflowExecutionId: record.workflowExecutionId,
          eventType: `APPROVAL_${targetStatus}`,
          actorType: actorInfo.actorType,
          actorId: actorInfo.actorUserId ?? actorInfo.actorExternalId ?? null,
          metadataJson: { decision, comment: actorInfo.comment } as object,
        },
      });

      return { data: this.toData(updated), targetStatus, workflowExecutionId: record.workflowExecutionId };
    });
    // Emitted after the transaction commits (never inside it) so a listener reading the DB always sees the
    // decision already persisted. This is the "approval decision emits a workflow signal/event" push
    // mechanism — WorkforceOrchestratorService subscribes to resume a delegated task immediately, without
    // waiting for the next getTask() poll.
    this.events?.emitApprovalDecided({
      approvalRequestId,
      organizationId,
      workflowExecutionId: result.workflowExecutionId,
      decision: result.targetStatus as ApprovalRequestStatus,
    });
    return result.data;
  }

  async expire(organizationId: string, id: string): Promise<ApprovalRequestData> {
    return this.recordDecision(id, organizationId, "CANCEL", {
      actorType: "SYSTEM",
      channel: "system",
      comment: "Approval request expired",
    });
  }

  async supersede(
    organizationId: string,
    id: string,
    newApprovalRequestId: string
  ): Promise<ApprovalRequestData> {
    const record = await this.prisma.approvalRequest.findFirst({
      where: { id, organizationId },
    });
    if (!record) throw new NotFoundException("Approval request not found");

    const updated = await this.prisma.approvalRequest.update({
      where: { id },
      data: { status: "SUPERSEDED", supersededById: newApprovalRequestId, resolvedAt: new Date() },
    });

    return this.toData(updated);
  }

  private async createAssignments(
    approvalRequestId: string,
    policyResult: Awaited<ReturnType<ApprovalPolicyEngine["resolve"]>>
  ): Promise<void> {
    const data: Array<{
      approvalRequestId: string;
      approverType: PrismaApproverType;
      approverUserId: string | null;
      approverRoleKey: string | null;
      externalContactId: string | null;
      sequence: number;
      required: boolean;
    }> = [];

    if (policyResult.approverIds.length) {
      for (const userId of policyResult.approverIds) {
        data.push({
          approvalRequestId,
          approverType: policyResult.approverType as PrismaApproverType,
          approverUserId: userId,
          approverRoleKey: null,
          externalContactId: null,
          sequence: 0,
          required: true,
        });
      }
    }
    if (policyResult.approverRoleKeys.length) {
      for (const roleKey of policyResult.approverRoleKeys) {
        data.push({
          approvalRequestId,
          approverType: policyResult.approverType as PrismaApproverType,
          approverUserId: null,
          approverRoleKey: roleKey,
          externalContactId: null,
          sequence: 0,
          required: true,
        });
      }
    }

    if (data.length === 0 && policyResult.approverType === "CUSTOMER") {
      data.push({
        approvalRequestId,
        approverType: "CUSTOMER" as PrismaApproverType,
        approverUserId: null,
        approverRoleKey: null,
        externalContactId: null,
        sequence: 0,
        required: true,
      });
    }

    if (data.length === 0) return;
    await this.prisma.approvalAssignment.createMany({ data });
  }

  private decisionToStatus(decision: ApprovalDecisionType): ApprovalRequestStatus {
    switch (decision) {
      case "APPROVE": return "APPROVED";
      case "REJECT": return "REJECTED";
      case "REQUEST_CHANGES": return "CHANGES_REQUESTED";
      case "WITHDRAW":
      case "CANCEL": return "CANCELLED";
      case "ESCALATE": return "PENDING";
    }
  }

  private defaultExpiry(): Date {
    const d = new Date();
    d.setHours(d.getHours() + 48);
    return d;
  }

  private toData(record: ApprovalRequest): ApprovalRequestData {
    return {
      id: record.id,
      organizationId: record.organizationId,
      workflowExecutionId: record.workflowExecutionId,
      policyId: record.policyId,
      agentId: record.agentId,
      actionType: record.actionType,
      subjectType: record.subjectType,
      subjectId: record.subjectId,
      requesterType: record.requesterType,
      requesterUserId: record.requesterUserId,
      requesterExternalId: record.requesterExternalId,
      requestedBy: record.requestedBy,
      status: record.status as ApprovalRequestStatus,
      title: record.title,
      description: record.description,
      payload: (record.payload ?? {}) as Record<string, unknown>,
      comments: (Array.isArray(record.comments) ? (record.comments as unknown as ApprovalComment[]) : []) as ApprovalComment[],
      approverType: record.approverType,
      expiresAt: record.expiresAt?.toISOString() ?? null,
      resolvedAt: record.resolvedAt?.toISOString() ?? null,
      supersededById: record.supersededById,
      idempotencyKey: record.idempotencyKey,
      approvedAt: record.approvedAt?.toISOString() ?? null,
      approvedBy: record.approvedBy,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }
}
