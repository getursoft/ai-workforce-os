import {
  Controller, Get, Post, Param, Body, NotFoundException,
} from "@nestjs/common";
import { ApprovalService } from "./approval.service";
import { PrismaService } from "../infrastructure/prisma/prisma.service";

@Controller("public/approvals")
export class PublicApprovalController {
  constructor(
    private readonly approvalService: ApprovalService,
    private readonly prisma: PrismaService,
  ) {}

  @Get(":token")
  async getByToken(@Param("token") token: string) {
    const approval = await this.resolveByToken(token);
    return {
      id: approval.id,
      title: approval.title,
      description: approval.description,
      status: approval.status,
      subjectType: approval.subjectType,
      payload: approval.payload,
      expiresAt: approval.expiresAt,
    };
  }

  @Post(":token/approve")
  async approveByToken(
    @Param("token") token: string,
    @Body() body: { comment?: string; channel?: string },
  ) {
    const approval = await this.resolveByToken(token);
    return this.approvalService.recordDecision(approval.id, approval.organizationId, "APPROVE", {
      actorType: body?.channel === "whatsapp" ? "CUSTOMER" : "EXTERNAL_CONTACT",
      actorExternalId: token,
      comment: body?.comment ?? null,
      channel: body?.channel ?? "web",
    });
  }

  @Post(":token/reject")
  async rejectByToken(
    @Param("token") token: string,
    @Body() body: { comment?: string; channel?: string },
  ) {
    const approval = await this.resolveByToken(token);
    return this.approvalService.recordDecision(approval.id, approval.organizationId, "REJECT", {
      actorType: "EXTERNAL_CONTACT",
      actorExternalId: token,
      comment: body?.comment ?? null,
      channel: body?.channel ?? "web",
    });
  }

  @Post(":token/request-changes")
  async requestChangesByToken(
    @Param("token") token: string,
    @Body() body: { comment?: string; channel?: string },
  ) {
    const approval = await this.resolveByToken(token);
    return this.approvalService.recordDecision(approval.id, approval.organizationId, "REQUEST_CHANGES", {
      actorType: "EXTERNAL_CONTACT",
      actorExternalId: token,
      comment: body?.comment ?? null,
      channel: body?.channel ?? "web",
    });
  }

  private async resolveByToken(token: string) {
    const record = await this.prisma.approvalRequest.findFirst({
      where: { idempotencyKey: token },
    });
    if (!record) {
      const fallback = await this.prisma.approvalRequest.findFirst({
        where: { id: token },
      });
      if (!fallback) throw new NotFoundException("Approval request not found");
      return fallback;
    }
    return record;
  }
}
