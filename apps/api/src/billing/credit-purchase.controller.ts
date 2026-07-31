import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { CreditPurchaseService } from "./credit-purchase.service";
import { CreateCreditPurchaseOrderDto, VerifyCreditPurchaseOrderDto } from "./credit-purchase.dto";

@ApiTags("Billing")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("billing/credit-purchase")
export class CreditPurchaseController {
  constructor(private readonly purchases: CreditPurchaseService) {}

  @Get("packages")
  @RequirePermission("usage.read")
  packages(@CurrentPrincipal() p: AuthenticatedPrincipal) {
    return this.purchases.listPackages(p.organizationId.toString());
  }

  @Post("orders")
  @RequirePermission("billing.manage")
  createOrder(@CurrentPrincipal() p: AuthenticatedPrincipal, @Body() dto: CreateCreditPurchaseOrderDto) {
    return this.purchases.createOrder(p.organizationId.toString(), p.userId.toString(), dto.credits);
  }

  @Post("orders/:id/verify")
  @RequirePermission("billing.manage")
  verify(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: VerifyCreditPurchaseOrderDto
  ) {
    return this.purchases.verifyPayment(p.organizationId.toString(), id, dto);
  }
}
