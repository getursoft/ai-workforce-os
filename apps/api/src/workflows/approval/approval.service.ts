import { Injectable, Logger, NotFoundException, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";
import type { ApprovalRequest } from "@prisma/client";
import type { ApprovalRequestData, CreateApprovalRequestInput, ApproveInput, RejectInput } from "./approval.types";

const VALID_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["APPROVED", "REJECTED", "EXPIRED"],
  APPROVED: [],
  REJECTED: [],
  EXPIRED: []
};

export type ApprovalDecisionHandler = (
  organizationId: string,
  workflowExecutionId: string,
  decision: "APPROVED" | "REJECTED"
) => Promise<void>;

@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);
  private decisionHandler: ApprovalDecisionHandler | null = null;

  constructor(
    private readonly prisma: PrismaService
  ) {}

  setDecisionHandler(handler: ApprovalDecisionHandler): void {
    this.decisionHandler = handler;
  }

  async create(input: CreateApprovalRequestInput): Promise<ApprovalRequestData> {
    const record = await this.prisma.approvalRequest.create({
      data: {
        organizationId: input.organizationId,
        workflowExecutionId: input.workflowExecutionId,
        agentId: input.agentId,
        requestedBy: input.requestedBy,
        status: "PENDING",
        title: input.title,
        description: input.description,
        payload: (input.payload ?? {}) as object,
        comments: []
      }
    });
    this.logger.log({ event: "APPROVAL_REQUESTED", id: record.id, organizationId: input.organizationId });
    return this.toData(record);
  }

  async findById(id: string, organizationId: string): Promise<ApprovalRequestData | null> {
    const record = await this.prisma.approvalRequest.findFirst({
      where: { id, organizationId }
    });
    return record ? this.toData(record) : null;
  }

  async findMany(organizationId: string, status?: string): Promise<ApprovalRequestData[]> {
    const records = status
      ? await this.prisma.approvalRequest.findMany({
          where: { organizationId, status: status as "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" },
          orderBy: { createdAt: "desc" }
        })
      : await this.prisma.approvalRequest.findMany({
          where: { organizationId },
          orderBy: { createdAt: "desc" }
        });
    return records.map((r) => this.toData(r));
  }

  async approve(input: ApproveInput): Promise<ApprovalRequestData> {
    const record = await this.prisma.approvalRequest.findFirst({
      where: { id: input.approvalRequestId, organizationId: input.organizationId }
    });
    if (!record) throw new NotFoundException("Approval request not found");
    this.validateTransition(record.status, "APPROVED");
    const existingComments = Array.isArray(record.comments) ? record.comments : [];
    const updatedComments = input.comment
      ? [...existingComments, { author: input.approvedBy, text: input.comment, createdAt: new Date().toISOString() }]
      : existingComments;
    const updated = await this.prisma.approvalRequest.update({
      where: { id: input.approvalRequestId },
      data: {
        status: "APPROVED",
        approvedAt: new Date(),
        approvedBy: input.approvedBy,
        comments: updatedComments as object[]
      }
    });
    this.logger.log({ event: "APPROVAL_APPROVED", id: updated.id, organizationId: input.organizationId, approvedBy: input.approvedBy });
    await this.decisionHandler?.(input.organizationId, record.workflowExecutionId, "APPROVED");
    return this.toData(updated);
  }

  async reject(input: RejectInput): Promise<ApprovalRequestData> {
    const record = await this.prisma.approvalRequest.findFirst({
      where: { id: input.approvalRequestId, organizationId: input.organizationId }
    });
    if (!record) throw new NotFoundException("Approval request not found");
    this.validateTransition(record.status, "REJECTED");
    const existingComments = Array.isArray(record.comments) ? record.comments : [];
    const updatedComments = input.comment
      ? [...existingComments, { author: input.rejectedBy, text: input.comment, createdAt: new Date().toISOString() }]
      : existingComments;
    const updated = await this.prisma.approvalRequest.update({
      where: { id: input.approvalRequestId },
      data: {
        status: "REJECTED",
        comments: updatedComments as object[]
      }
    });
    this.logger.log({ event: "APPROVAL_REJECTED", id: updated.id, organizationId: input.organizationId, rejectedBy: input.rejectedBy });
    await this.decisionHandler?.(input.organizationId, record.workflowExecutionId, "REJECTED");
    return this.toData(updated);
  }

  async expire(organizationId: string, id: string): Promise<ApprovalRequestData> {
    const record = await this.prisma.approvalRequest.findFirst({
      where: { id, organizationId }
    });
    if (!record) throw new NotFoundException("Approval request not found");
    this.validateTransition(record.status, "EXPIRED");
    const updated = await this.prisma.approvalRequest.update({
      where: { id },
      data: { status: "EXPIRED" }
    });
    return this.toData(updated);
  }

  private validateTransition(current: string, target: string): void {
    const allowed = VALID_TRANSITIONS[current];
    if (!allowed || !allowed.includes(target)) {
      throw new BadRequestException(
        `Cannot transition approval from ${current} to ${target}`
      );
    }
  }

  private toData(record: ApprovalRequest): ApprovalRequestData {
    return {
      id: record.id,
      organizationId: record.organizationId,
      workflowExecutionId: record.workflowExecutionId,
      agentId: record.agentId,
      requestedBy: record.requestedBy,
      status: record.status as ApprovalRequestData["status"],
      title: record.title,
      description: record.description,
      payload: (record.payload ?? {}) as Record<string, unknown>,
      comments: (Array.isArray(record.comments) ? record.comments : []) as unknown as ApprovalRequestData["comments"],
      approvedAt: record.approvedAt?.toISOString() ?? null,
      approvedBy: record.approvedBy,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString()
    };
  }
}
