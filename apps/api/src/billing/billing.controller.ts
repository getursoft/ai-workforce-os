import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { BillingService } from "./billing.service";

@ApiTags("Billing")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("billing")
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get("usage/summary")
  @RequirePermission("usage.read")
  async summary(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query("start") start?: string, @Query("end") end?: string
  ) {
    const { start: s, end: e } = this.resolvePeriod(p, start, end);
    return this.billing.summary(p.organizationId.toString(), s, e);
  }

  @Get("usage/by-employee")
  @RequirePermission("usage.read")
  async byEmployee(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query("start") start?: string, @Query("end") end?: string
  ) {
    const period = this.resolvePeriod(p, start, end);
    return this.billing.byEmployee(p.organizationId.toString(), period.start, period.end);
  }

  @Get("usage/by-capability")
  @RequirePermission("usage.read")
  async byCapability(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query("start") start?: string, @Query("end") end?: string
  ) {
    const period = this.resolvePeriod(p, start, end);
    return this.billing.byCapability(p.organizationId.toString(), period.start, period.end);
  }

  @Get("usage/by-model")
  @RequirePermission("usage.read")
  async byModel(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query("start") start?: string, @Query("end") end?: string
  ) {
    const period = this.resolvePeriod(p, start, end);
    return this.billing.byModel(p.organizationId.toString(), period.start, period.end);
  }

  @Get("usage/trend")
  @RequirePermission("usage.read")
  async trend(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query("start") start?: string, @Query("end") end?: string
  ) {
    const period = this.resolvePeriod(p, start, end);
    return this.billing.trend(p.organizationId.toString(), period.start, period.end);
  }

  @Get("usage/by-user")
  @RequirePermission("usage.read")
  async byUser(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query("start") start?: string, @Query("end") end?: string
  ) {
    const period = this.resolvePeriod(p, start, end);
    return this.billing.byUser(p.organizationId.toString(), period.start, period.end);
  }

  private resolvePeriod(_p: AuthenticatedPrincipal, start?: string, end?: string) {
    if (start && end) return { start: new Date(start), end: new Date(end) };
    return this.billing.billingPeriod();
  }
}
