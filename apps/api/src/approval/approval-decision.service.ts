import { Injectable } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";

export interface ApprovalDecisionRecord {
  id: string;
  approvalRequestId: string;
  assignmentId: string | null;
  decision: string;
  actorType: string;
  actorUserId: string | null;
  actorExternalId: string | null;
  comment: string | null;
  channel: string;
  createdAt: string;
}

@Injectable()
export class ApprovalDecisionService {
  constructor(private readonly prisma: PrismaService) {}

  async listForRequest(approvalRequestId: string): Promise<ApprovalDecisionRecord[]> {
    const records = await this.prisma.approvalDecision.findMany({
      where: { approvalRequestId },
      orderBy: { createdAt: "desc" },
    });
    return records.map(this.toData);
  }

  private toData(r: {
    id: string;
    approvalRequestId: string;
    assignmentId: string | null;
    decision: string;
    actorType: string;
    actorUserId: string | null;
    actorExternalId: string | null;
    comment: string | null;
    channel: string;
    createdAt: Date;
  }): ApprovalDecisionRecord {
    return {
      id: r.id,
      approvalRequestId: r.approvalRequestId,
      assignmentId: r.assignmentId,
      decision: r.decision,
      actorType: r.actorType,
      actorUserId: r.actorUserId,
      actorExternalId: r.actorExternalId,
      comment: r.comment,
      channel: r.channel,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
