import {
  Controller, Get, Post, Param, Body, Query, NotFoundException
} from "@nestjs/common";
import { ApprovalService } from "./approval.service";
import type { ApprovalRequestData } from "./approval.types";

@Controller("approvals")
export class ApprovalController {
  constructor(
    private readonly approvalService: ApprovalService
  ) {}

  @Get()
  async list(
    @Query("organizationId") organizationId: string,
    @Query("status") status?: string
  ): Promise<ApprovalRequestData[]> {
    return this.approvalService.findMany(organizationId, status);
  }

  @Get(":id")
  async get(
    @Param("id") id: string,
    @Query("organizationId") organizationId: string
  ): Promise<ApprovalRequestData> {
    const record = await this.approvalService.findById(id, organizationId);
    if (!record) throw new NotFoundException("Approval request not found");
    return record;
  }

  @Post()
  async create(
    @Body() body: {
      organizationId: string;
      workflowExecutionId: string;
      agentId: string;
      requestedBy: string;
      title: string;
      description: string;
      payload?: Record<string, unknown>;
    }
  ): Promise<ApprovalRequestData> {
    return this.approvalService.create(body);
  }

  @Post(":id/approve")
  async approve(
    @Param("id") id: string,
    @Body() body: { organizationId: string; approvedBy: string; comment?: string }
  ): Promise<ApprovalRequestData> {
    return this.approvalService.approve({ approvalRequestId: id, ...body });
  }

  @Post(":id/reject")
  async reject(
    @Param("id") id: string,
    @Body() body: { organizationId: string; rejectedBy: string; comment?: string }
  ): Promise<ApprovalRequestData> {
    return this.approvalService.reject({ approvalRequestId: id, ...body });
  }
}
