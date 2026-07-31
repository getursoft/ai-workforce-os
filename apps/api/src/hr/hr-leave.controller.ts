import {
  Controller, Get, Post, Param, Body, Query, NotFoundException,
  ParseUUIDPipe,
} from "@nestjs/common";
import { HrLeaveService } from "./hr-leave.service";
import { PrismaService } from "../infrastructure/prisma/prisma.service";

@Controller("hr/leave-requests")
export class HrLeaveController {
  constructor(
    private readonly leaveService: HrLeaveService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  async create(
    @Body() body: {
      organizationId: string;
      employeeUserId: string;
      managerUserId?: string;
      leaveType: string;
      startDate: string;
      endDate: string;
      durationDays: number;
      reason: string;
      handoverDetails?: string;
      supportingDocUrl?: string;
      idempotencyKey?: string;
    },
  ) {
    return this.leaveService.create({
      organizationId: body.organizationId,
      employeeUserId: body.employeeUserId,
      managerUserId: body.managerUserId ?? null,
      leaveType: body.leaveType,
      startDate: body.startDate,
      endDate: body.endDate,
      durationDays: body.durationDays,
      reason: body.reason,
      handoverDetails: body.handoverDetails ?? null,
      supportingDocUrl: body.supportingDocUrl ?? null,
      idempotencyKey: body.idempotencyKey ?? null,
    });
  }

  @Post(":id/submit")
  async submit(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { organizationId: string; idempotencyKey?: string },
  ) {
    return this.leaveService.submitForApproval(id, body.organizationId, body.idempotencyKey);
  }

  @Post(":id/approve")
  async approve(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { organizationId: string; userId: string; comment?: string },
  ) {
    return this.leaveService.recordManagerDecision(id, body.organizationId, "APPROVE", {
      actorUserId: body.userId,
      comment: body.comment ?? null,
    });
  }

  @Post(":id/reject")
  async reject(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { organizationId: string; userId: string; comment?: string },
  ) {
    return this.leaveService.recordManagerDecision(id, body.organizationId, "REJECT", {
      actorUserId: body.userId,
      comment: body.comment ?? null,
    });
  }

  @Post(":id/request-changes")
  async requestChanges(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { organizationId: string; userId: string; comment?: string },
  ) {
    return this.leaveService.recordManagerDecision(id, body.organizationId, "REQUEST_CHANGES", {
      actorUserId: body.userId,
      comment: body.comment ?? null,
    });
  }

  @Get()
  async list(
    @Query("organizationId") organizationId: string,
    @Query("status") status?: string,
  ) {
    const where: Record<string, unknown> = { organizationId };
    if (status) where.status = status;
    return this.prisma.hrLeaveRequest.findMany({
      where: where as never,
      orderBy: { createdAt: "desc" },
    });
  }

  @Get(":id")
  async get(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("organizationId") organizationId: string,
  ) {
    const record = await this.prisma.hrLeaveRequest.findFirst({
      where: { id, organizationId },
    });
    if (!record) throw new NotFoundException("Leave request not found");
    return record;
  }
}
