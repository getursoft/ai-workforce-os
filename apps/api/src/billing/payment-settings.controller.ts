import { Body, Controller, Get, Put, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PlatformOwnerGuard } from "../identity/infrastructure/security/platform-owner.guard";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { PaymentSettingsService } from "./payment-settings.service";
import { UpdatePaymentSettingsDto } from "./payment-settings.dto";

/** Platform-owner-only: even an organization's own Owner cannot see or rotate its Razorpay keys.
 *  Only the single universal platform owner (SecurityConfig.platformOwnerEmail) manages payment
 *  gateway credentials, for any organization it has switched into. */
@ApiTags("Billing")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PlatformOwnerGuard)
@Controller("billing/payment-settings")
export class PaymentSettingsController {
  constructor(private readonly settings: PaymentSettingsService) {}

  @Get() get(@CurrentPrincipal() p: AuthenticatedPrincipal) {
    return this.settings.get(p.organizationId.toString());
  }

  @Put() update(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() dto: UpdatePaymentSettingsDto
  ) {
    return this.settings.update(p.organizationId.toString(), p.userId.toString(), dto);
  }
}
