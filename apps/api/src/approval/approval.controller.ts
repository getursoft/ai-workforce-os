import {
  Controller, Get, Post, Param, Body, Query, NotFoundException,
  ParseUUIDPipe,
} from "@nestjs/common";
import { ApprovalService, type ApprovalRequestStatus } from "./approval.service";
import { ApprovalDecisionService } from "./approval-decision.service";
import { ApprovalAuditService } from "./approval-audit.service";

@Controller("approvals")
export class ApprovalController {
  constructor(
    private readonly approvalService: ApprovalService,
    private readonly decisionService: ApprovalDecisionService,
    private readonly auditService: ApprovalAuditService,
  ) {}

  @Get()
  async list(
    @Query("organizationId") organizationId: string,
    @Query("status") status?: string,
    @Query("actionType") actionType?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const filter: {
      status?: ApprovalRequestStatus;
      actionType?: string;
      limit?: number;
      offset?: number;
    } = {};
    if (status) filter.status = status as ApprovalRequestStatus;
    if (actionType) filter.actionType = actionType;
    filter.limit = limit ? parseInt(limit, 10) : 50;
    filter.offset = offset ? parseInt(offset, 10) : 0;
    return this.approvalService.list(organizationId, filter);
  }

  @Get("my-pending")
  async myPending(
    @Query("organizationId") organizationId: string,
    @Query("userId") userId: string,
  ) {
    return this.approvalService.pendingForUser(organizationId, userId);
  }

  @Get(":id")
  async get(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("organizationId") organizationId: string,
  ) {
    const record = await this.approvalService.findById(id, organizationId);
    if (!record) throw new NotFoundException("Approval request not found");
    return record;
  }

  @Get(":id/decisions")
  async decisions(
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.decisionService.listForRequest(id);
  }

  @Get(":id/audit")
  async audit(
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.auditService.listForRequest(id);
  }

  @Post(":id/approve")
  async approve(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { organizationId: string; userId: string; comment?: string },
  ) {
    return this.approvalService.recordDecision(id, body.organizationId, "APPROVE", {
      actorType: "USER",
      actorUserId: body.userId,
      comment: body.comment ?? null,
      channel: "internal",
    });
  }

  @Post(":id/reject")
  async reject(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { organizationId: string; userId: string; comment?: string },
  ) {
    return this.approvalService.recordDecision(id, body.organizationId, "REJECT", {
      actorType: "USER",
      actorUserId: body.userId,
      comment: body.comment ?? null,
      channel: "internal",
    });
  }

  @Post(":id/request-changes")
  async requestChanges(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { organizationId: string; userId: string; comment?: string },
  ) {
    return this.approvalService.recordDecision(id, body.organizationId, "REQUEST_CHANGES", {
      actorType: "USER",
      actorUserId: body.userId,
      comment: body.comment ?? null,
      channel: "internal",
    });
  }
}
