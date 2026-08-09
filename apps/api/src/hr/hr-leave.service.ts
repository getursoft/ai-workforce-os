import { Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { ApprovalService } from "../approval/approval.service";
import { ApprovalAuditService } from "../approval/approval-audit.service";

export type HrLeaveStatus =
  | "DRAFT" | "SUBMITTED_BY_EMPLOYEE" | "WAITING_FOR_MANAGER_APPROVAL"
  | "MANAGER_APPROVED" | "SUBMITTED_TO_HR_SYSTEM" | "RECORDED"
  | "MANAGER_REJECTED" | "MANAGER_REQUESTED_CHANGES"
  | "EMPLOYEE_WITHDREW" | "HR_SUBMISSION_FAILED" | "CANCELLED";

const VALID_TRANSITIONS: Record<string, HrLeaveStatus[]> = {
  DRAFT: ["SUBMITTED_BY_EMPLOYEE", "CANCELLED"],
  SUBMITTED_BY_EMPLOYEE: ["WAITING_FOR_MANAGER_APPROVAL", "EMPLOYEE_WITHDREW"],
  WAITING_FOR_MANAGER_APPROVAL: ["MANAGER_APPROVED", "MANAGER_REJECTED", "MANAGER_REQUESTED_CHANGES", "EMPLOYEE_WITHDREW"],
  MANAGER_APPROVED: ["SUBMITTED_TO_HR_SYSTEM", "HR_SUBMISSION_FAILED"],
  SUBMITTED_TO_HR_SYSTEM: ["RECORDED"],
  RECORDED: [],
  MANAGER_REJECTED: [],
  MANAGER_REQUESTED_CHANGES: ["SUBMITTED_BY_EMPLOYEE", "CANCELLED"],
  EMPLOYEE_WITHDREW: [],
  HR_SUBMISSION_FAILED: ["SUBMITTED_TO_HR_SYSTEM", "CANCELLED"],
  CANCELLED: [],
};

export interface CreateLeaveInput {
  organizationId: string;
  employeeUserId: string;
  managerUserId: string | null;
  leaveType: string;
  startDate: string;
  endDate: string;
  durationDays: number;
  reason: string;
  handoverDetails: string | null;
  supportingDocUrl: string | null;
  idempotencyKey: string | null;
}

@Injectable()
export class HrLeaveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvalService: ApprovalService,
    private readonly auditService: ApprovalAuditService,
  ) {}

  async create(input: CreateLeaveInput): Promise<{ id: string; status: string }> {
    if (input.idempotencyKey) {
      const existing = await this.prisma.hrLeaveRequest.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) return { id: existing.id, status: existing.status };
    }

    const record = await this.prisma.hrLeaveRequest.create({
      data: {
        organizationId: input.organizationId,
        employeeUserId: input.employeeUserId,
        managerUserId: input.managerUserId ?? null,
        status: "DRAFT",
        leaveType: input.leaveType,
        startDate: new Date(input.startDate),
        endDate: new Date(input.endDate),
        durationDays: input.durationDays,
        reason: input.reason,
        handoverDetails: input.handoverDetails ?? null,
        supportingDocUrl: input.supportingDocUrl ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });

    return { id: record.id, status: record.status };
  }

  async submitForApproval(
    leaveRequestId: string,
    organizationId: string,
    idempotencyKey?: string
  ): Promise<{ approvalRequestId: string }> {
    const leave = await this.prisma.hrLeaveRequest.findFirst({
      where: { id: leaveRequestId, organizationId },
    });
    if (!leave) throw new NotFoundException("Leave request not found");
    if (leave.status !== "DRAFT" && leave.status !== "MANAGER_REQUESTED_CHANGES") {
      throw new BadRequestException(`Cannot submit leave request in status ${leave.status}`);
    }

    await this.transitionTo(leaveRequestId, organizationId, "SUBMITTED_BY_EMPLOYEE");

    const approval = await this.approvalService.create({
      organizationId,
      workflowExecutionId: leave.workflowExecutionId ?? leaveRequestId,
      agentId: "hr-employee",
      actionType: "LEAVE_REQUEST",
      subjectType: "HR_LEAVE",
      subjectId: leaveRequestId,
      requesterType: "EMPLOYEE",
      requesterUserId: leave.employeeUserId,
      requestedBy: leave.employeeUserId,
      title: `Leave request: ${leave.leaveType}`,
      description: `${leave.leaveType} leave from ${leave.startDate.toISOString().slice(0, 10)} to ${leave.endDate.toISOString().slice(0, 10)} (${leave.durationDays} days). Reason: ${leave.reason}`,
      payload: {
        leaveRequestId,
        leaveType: leave.leaveType,
        startDate: leave.startDate.toISOString(),
        endDate: leave.endDate.toISOString(),
        durationDays: leave.durationDays,
        reason: leave.reason,
      },
      policyResolution: {
        organizationId,
        workflowType: "HR",
        actionType: "LEAVE_REQUEST",
        metadata: leave.managerUserId ? { managerUserId: leave.managerUserId } : null,
      },
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    await this.transitionTo(leaveRequestId, organizationId, "WAITING_FOR_MANAGER_APPROVAL", {
      approvalRequestId: approval.id,
    });

    return { approvalRequestId: approval.id };
  }

  async recordManagerDecision(
    leaveRequestId: string,
    organizationId: string,
    decision: "APPROVE" | "REJECT" | "REQUEST_CHANGES",
    actorInfo: { actorUserId: string | null; comment: string | null }
  ): Promise<void> {
    const leave = await this.prisma.hrLeaveRequest.findFirst({
      where: { id: leaveRequestId, organizationId },
    });
    if (!leave) throw new NotFoundException("Leave request not found");
    if (leave.status !== "WAITING_FOR_MANAGER_APPROVAL") {
      throw new BadRequestException(`Leave request is not awaiting manager approval`);
    }
    if (!leave.approvalRequestId) throw new BadRequestException("Leave request has no associated approval request");

    await this.approvalService.recordDecision(leave.approvalRequestId, organizationId, decision as never, {
      actorType: "MANAGER",
      actorUserId: actorInfo.actorUserId ?? null,
      comment: actorInfo.comment ?? null,
      channel: "internal",
    });

    if (decision === "APPROVE") {
      await this.transitionTo(leaveRequestId, organizationId, "MANAGER_APPROVED");
      await this.submitToHrSystem(leaveRequestId, organizationId);
    } else if (decision === "REJECT") {
      await this.transitionTo(leaveRequestId, organizationId, "MANAGER_REJECTED");
    } else {
      await this.transitionTo(leaveRequestId, organizationId, "MANAGER_REQUESTED_CHANGES");
    }
  }

  async submitToHrSystem(leaveRequestId: string, organizationId: string): Promise<void> {
    const leave = await this.prisma.hrLeaveRequest.findFirst({
      where: { id: leaveRequestId, organizationId, status: "MANAGER_APPROVED" },
    });
    if (!leave) return;

    await this.transitionTo(leaveRequestId, organizationId, "SUBMITTED_TO_HR_SYSTEM", {
      hrSystemReference: `HR-${leaveRequestId.slice(0, 8).toUpperCase()}`,
    });

    await this.transitionTo(leaveRequestId, organizationId, "RECORDED", {
      resolvedAt: new Date(),
    });
  }

  async withdraw(leaveRequestId: string, organizationId: string): Promise<void> {
    const leave = await this.prisma.hrLeaveRequest.findFirst({
      where: { id: leaveRequestId, organizationId },
    });
    if (!leave) throw new NotFoundException("Leave request not found");

    const withdrawableStatuses = new Set(["DRAFT", "SUBMITTED_BY_EMPLOYEE", "WAITING_FOR_MANAGER_APPROVAL", "MANAGER_REQUESTED_CHANGES"]);
    if (!withdrawableStatuses.has(leave.status)) {
      throw new BadRequestException(`Cannot withdraw leave request in status ${leave.status}`);
    }

    await this.transitionTo(leaveRequestId, organizationId, "EMPLOYEE_WITHDREW", { resolvedAt: new Date() });
  }

  private async transitionTo(
    leaveRequestId: string,
    organizationId: string,
    targetStatus: HrLeaveStatus,
    extraData?: Record<string, unknown>
  ): Promise<void> {
    const leave = await this.prisma.hrLeaveRequest.findFirst({
      where: { id: leaveRequestId, organizationId },
    });
    if (!leave) throw new NotFoundException("Leave request not found");

    const allowed = VALID_TRANSITIONS[leave.status];
    if (!allowed?.includes(targetStatus)) {
      throw new BadRequestException(`Cannot transition leave from ${leave.status} to ${targetStatus}`);
    }

    await this.prisma.hrLeaveRequest.update({
      where: { id: leaveRequestId },
      data: { status: targetStatus, ...(extraData ?? {}) } as never,
    });

    await this.auditService.record({
      organizationId,
      workflowExecutionId: leave.workflowExecutionId ?? null,
      eventType: `LEAVE_${targetStatus}`,
      actorType: "SYSTEM",
      metadata: { leaveRequestId, previousStatus: leave.status, targetStatus },
    });
  }
}
