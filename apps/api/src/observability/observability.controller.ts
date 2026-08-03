import { Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import { ObservabilityService } from "./observability.service";
import { ObservabilityMetricsService } from "./observability-metrics.service";
import { ObservabilityAlertsService } from "./observability-alerts.service";
import { ObservabilityOperationsService } from "./observability-operations.service";
import { ObservabilityHealthService } from "./observability-health.service";
import { ListAlertsQueryDto, ListTracesQueryDto, ObservabilityDateRangeQueryDto } from "./observability.dto";

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

@ApiTags("Observability")
@ApiBearerAuth()
@Controller("observability")
@UseGuards(JwtAccessGuard, PermissionGuard)
export class ObservabilityController {
  constructor(
    private readonly observability: ObservabilityService,
    private readonly metrics: ObservabilityMetricsService,
    private readonly alerts: ObservabilityAlertsService,
    private readonly operations: ObservabilityOperationsService,
    private readonly health: ObservabilityHealthService
  ) {}

  @Get("health") @RequirePermission("observability.read")
  getHealth(@CurrentPrincipal() p: AuthenticatedPrincipal) {
    return this.health.checkAll(p.organizationId.toString());
  }

  @Get("overview") @RequirePermission("observability.read")
  async overview(@CurrentPrincipal() p: AuthenticatedPrincipal, @Query() query: ObservabilityDateRangeQueryDto) {
    const organizationId = p.organizationId.toString();
    await this.alerts.sync(organizationId);
    return this.metrics.overview(organizationId, parseDate(query.from), parseDate(query.to));
  }

  @Get("traces") @RequirePermission("observability.trace.read")
  listTraces(@CurrentPrincipal() p: AuthenticatedPrincipal, @Query() query: ListTracesQueryDto) {
    const dateFrom = parseDate(query.from);
    const dateTo = parseDate(query.to);
    return this.observability.listTraces(
      p.organizationId.toString(),
      {
        ...(query.status ? { status: query.status } : {}),
        ...(query.channelConnectionId ? { channelConnectionId: query.channelConnectionId } : {}),
        ...(query.errorCode ? { errorCode: query.errorCode } : {}),
        ...(dateFrom ? { dateFrom } : {}),
        ...(dateTo ? { dateTo } : {})
      },
      { page: query.page, pageSize: query.pageSize }
    );
  }

  @Get("traces/:traceId") @RequirePermission("observability.trace.read")
  async getTrace(@CurrentPrincipal() p: AuthenticatedPrincipal, @Param("traceId") traceId: string) {
    const trace = await this.observability.getTrace(p.organizationId.toString(), traceId);
    if (!trace) throw new NotFoundException("OBSERVABILITY_TRACE_NOT_FOUND");
    return trace;
  }

  @Get("traces/:traceId/tree") @RequirePermission("observability.trace.read")
  async getTraceTree(@CurrentPrincipal() p: AuthenticatedPrincipal, @Param("traceId") traceId: string) {
    const tree = await this.observability.getTraceTree(p.organizationId.toString(), traceId);
    if (!tree) throw new NotFoundException("OBSERVABILITY_TRACE_NOT_FOUND");
    return tree;
  }

  @Get("metrics") @RequirePermission("observability.metrics.read")
  async metricsSummary(@CurrentPrincipal() p: AuthenticatedPrincipal, @Query() query: ObservabilityDateRangeQueryDto) {
    const organizationId = p.organizationId.toString();
    const from = parseDate(query.from);
    const to = parseDate(query.to);
    const [overview, executionsOverTime, failuresByEmployee, failuresByWorkflowType, approvalWait] = await Promise.all([
      this.metrics.overview(organizationId, from, to),
      this.metrics.executionsOverTime(organizationId),
      this.metrics.failuresByEmployee(organizationId, from, to),
      this.metrics.failuresByWorkflowType(organizationId),
      this.metrics.approvalWaitStats(organizationId)
    ]);
    return { overview, executionsOverTime, failuresByEmployee, failuresByWorkflowType, approvalWait };
  }

  @Get("errors") @RequirePermission("observability.trace.read")
  errors(@CurrentPrincipal() p: AuthenticatedPrincipal, @Query() query: ObservabilityDateRangeQueryDto) {
    return this.metrics.errorFingerprints(p.organizationId.toString(), parseDate(query.from), parseDate(query.to));
  }

  @Get("alerts") @RequirePermission("observability.alert.read")
  async listAlerts(@CurrentPrincipal() p: AuthenticatedPrincipal, @Query() query: ListAlertsQueryDto) {
    const organizationId = p.organizationId.toString();
    await this.alerts.sync(organizationId);
    return this.alerts.list(organizationId, { ...(query.status ? { status: query.status } : {}) });
  }

  @Post("alerts/:id/acknowledge") @RequirePermission("observability.alert.manage")
  acknowledgeAlert(@CurrentPrincipal() p: AuthenticatedPrincipal, @Param("id") id: string) {
    return this.operations.acknowledgeAlert(p.organizationId.toString(), id, p.userId.toString());
  }

  @Post("tasks/:id/retry") @RequirePermission("observability.operation.execute")
  retryTask(@CurrentPrincipal() p: AuthenticatedPrincipal, @Param("id") id: string) {
    return this.operations.retryDelegatedTask(p.organizationId.toString(), id, p.userId.toString());
  }

  @Post("workflows/:id/resume") @RequirePermission("observability.operation.execute")
  resumeWorkflow(@CurrentPrincipal() p: AuthenticatedPrincipal, @Param("id") id: string) {
    return this.operations.resumeWorkflow(p.organizationId.toString(), id, p.userId.toString());
  }
}
