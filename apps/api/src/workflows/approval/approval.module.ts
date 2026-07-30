import { Module, Global } from "@nestjs/common";
import { ApprovalController } from "./approval.controller";
import { ApprovalService } from "./approval.service";

@Global()
@Module({
  controllers: [ApprovalController],
  providers: [ApprovalService],
  exports: [ApprovalService]
})
export class ApprovalModule {}
