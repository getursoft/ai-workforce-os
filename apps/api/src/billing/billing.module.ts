import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { CreditPurchaseController } from "./credit-purchase.controller";
import { CreditPurchaseService } from "./credit-purchase.service";
import { RazorpayService } from "./razorpay.service";

@Module({
  imports: [IdentityModule, PrismaModule],
  controllers: [BillingController, CreditPurchaseController],
  providers: [BillingService, CreditPurchaseService, RazorpayService],
  exports: [BillingService, CreditPurchaseService]
})
export class BillingModule {}
