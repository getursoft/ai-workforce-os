import { Body, Controller, Get, Put, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { PaymentSettingsService } from "./payment-settings.service";
import { UpdatePaymentSettingsDto } from "./payment-settings.dto";

/** Owner-only: every route here requires `billing.payment_settings.manage`, which the seed data grants
 *  to the Owner system role alone — Admins and Members can spend credits (billing.manage) but never see
 *  or rotate the organization's Razorpay keys. */
@ApiTags("Billing")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("billing/payment-settings")
export class PaymentSettingsController {
  constructor(private readonly settings: PaymentSettingsService) {}

  @Get() @RequirePermission("billing.payment_settings.manage") get(
    @CurrentPrincipal() p: AuthenticatedPrincipal
  ) {
    return this.settings.get(p.organizationId.toString());
  }

  @Put() @RequirePermission("billing.payment_settings.manage") update(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() dto: UpdatePaymentSettingsDto
  ) {
    return this.settings.update(p.organizationId.toString(), p.userId.toString(), dto);
  }
}
