import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { PluginModule } from "../plugins/plugin.module";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { BillingEnforcementService } from "./billing-enforcement.service";
import { CreditPurchaseController } from "./credit-purchase.controller";
import { CreditPurchaseService } from "./credit-purchase.service";
import { PaymentSettingsController } from "./payment-settings.controller";
import { PaymentSettingsService } from "./payment-settings.service";
import { RazorpayService } from "./razorpay.service";

@Module({
  imports: [IdentityModule, PrismaModule, PluginModule],
  controllers: [BillingController, CreditPurchaseController, PaymentSettingsController],
  providers: [BillingService, BillingEnforcementService, CreditPurchaseService, PaymentSettingsService, RazorpayService],
  exports: [BillingService, BillingEnforcementService, CreditPurchaseService, PaymentSettingsService]
})
export class BillingModule {}
