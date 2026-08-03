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

  @Get("usage/trend-by-employee")
  @RequirePermission("usage.read")
  async trendByEmployee(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query("start") start?: string, @Query("end") end?: string
  ) {
    const period = this.resolvePeriod(p, start, end);
    return this.billing.trendByEmployee(p.organizationId.toString(), period.start, period.end);
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
    if (start && end) return { start: new Date(start), end: endOfDayIfDateOnly(end) };
    return this.billing.billingPeriod();
  }
}

/** A bare "YYYY-MM-DD" `end` query param (what every dashboard date-range picker sends, including
 *  "today") parses to that day's UTC midnight — silently excluding every execution recorded LATER that
 *  same day, which for the default "this month, through today" range means today's own activity (the
 *  usage a user is most likely checking the dashboard to see) never appears. Only a bare date gets pushed
 *  to end-of-day; an already-precise timestamp is left untouched. */
function endOfDayIfDateOnly(value: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T23:59:59.999Z`) : new Date(value);
}
