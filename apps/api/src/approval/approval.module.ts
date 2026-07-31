import { Module, Global } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { ApprovalService } from "./approval.service";
import { ApprovalPolicyEngine } from "./engine/approval-policy-engine";
import { ApprovalDecisionService } from "./approval-decision.service";
import { ApprovalAuditService } from "./approval-audit.service";
import { ApprovalNotificationService } from "./notifications/approval-notification.service";
import { ApprovalController } from "./approval.controller";
import { PublicApprovalController } from "./public-approval.controller";

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [ApprovalController, PublicApprovalController],
  providers: [
    ApprovalService,
    ApprovalPolicyEngine,
    ApprovalDecisionService,
    ApprovalAuditService,
    ApprovalNotificationService,
  ],
  exports: [
    ApprovalService,
    ApprovalPolicyEngine,
    ApprovalDecisionService,
    ApprovalAuditService,
    ApprovalNotificationService,
  ],
})
export class ApprovalModule {}
