import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import { SchedulerService } from "./scheduler.service";
import { JobHistoryService } from "./job-history.service";
import { JobRegistry } from "./job-registry";
import {
  CreateOneShotScheduleDto,
  CreateScheduleDto,
  InstantiateTemplateDto,
  ListExecutionsQueryDto,
  ListJobsQueryDto
} from "./scheduler.dto";

@ApiTags("Scheduler")
@ApiBearerAuth()
@Controller("scheduler")
@UseGuards(JwtAccessGuard, PermissionGuard)
export class SchedulerController {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly history: JobHistoryService,
    private readonly registry: JobRegistry
  ) {}

  // ------------------------------------------------------------------ Overview / monitoring
  @Get("overview")
  @RequirePermission("scheduler.read")
  overview(@CurrentPrincipal() p: AuthenticatedPrincipal) {
    return this.scheduler.overview(p.organizationId.toString());
  }

  @Get("worker/health")
  @RequirePermission("scheduler.worker.read")
  workerHealth() {
    return this.scheduler.getWorkerHealth();
  }

  @Get("definitions")
  @RequirePermission("scheduler.read")
  definitions() {
    return this.registry.list();
  }

  @Get("templates")
  @RequirePermission("scheduler.template.read")
  templates(@CurrentPrincipal() p: AuthenticatedPrincipal) {
    return this.scheduler.listTemplates(p.organizationId.toString());
  }

  @Get("upcoming")
  @RequirePermission("scheduler.read")
  upcoming(@CurrentPrincipal() p: AuthenticatedPrincipal) {
    return this.scheduler.upcomingJobs(p.organizationId.toString());
  }

  // ------------------------------------------------------------------ Jobs
  @Get("jobs")
  @RequirePermission("scheduler.read")
  listJobs(@CurrentPrincipal() p: AuthenticatedPrincipal, @Query() query: ListJobsQueryDto) {
    return this.scheduler.listJobs(p.organizationId.toString(), {
      ...(query.status ? { status: query.status } : {}),
      ...(query.triggerType ? { triggerType: query.triggerType } : {}),
      ...(query.definitionKey ? { definitionKey: query.definitionKey } : {}),
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {})
    });
  }

  @Get("jobs/:id")
  @RequirePermission("scheduler.read")
  async getJob(@CurrentPrincipal() p: AuthenticatedPrincipal, @Param("id") id: string) {
    const job = await this.scheduler.getJob(p.organizationId.toString(), id);
    if (!job) throw new NotFoundException("SCHEDULER_JOB_NOT_FOUND");
    return job;
  }

  @Post("jobs")
  @RequirePermission("scheduler.write")
  createJob(@CurrentPrincipal() p: AuthenticatedPrincipal, @Body() body: CreateScheduleDto) {
    return this.scheduler.createSchedule({
      organizationId: p.organizationId.toString(),
      employeeId: body.employeeId ?? null,
      workflowId: body.workflowId ?? null,
      definitionKey: body.definitionKey,
      triggerType: body.triggerType,
      cronExpression: body.cronExpression ?? null,
      intervalMs: body.intervalMs ?? null,
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.maxRetry !== undefined ? { maxRetry: body.maxRetry } : {}),
      ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
      ...(body.nextRun ? { nextRun: new Date(body.nextRun) } : {}),
      ...(body.payload !== undefined ? { payload: body.payload } : {}),
      ...(body.context !== undefined ? { context: body.context } : {}),
      ...(body.dedupeKey !== undefined ? { dedupeKey: body.dedupeKey } : {}),
      createdBy: p.userId.toString()
    });
  }

  @Post("jobs/one-shot")
  @RequirePermission("scheduler.write")
  createOneShot(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() body: CreateOneShotScheduleDto
  ) {
    return this.scheduler.createOneShot({
      organizationId: p.organizationId.toString(),
      employeeId: body.employeeId ?? null,
      definitionKey: body.definitionKey,
      triggerType: body.triggerType,
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.maxRetry !== undefined ? { maxRetry: body.maxRetry } : {}),
      ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
      ...(body.nextRun ? { nextRun: new Date(body.nextRun) } : { nextRun: new Date() }),
      ...(body.payload !== undefined ? { payload: body.payload } : {}),
      ...(body.context !== undefined ? { context: body.context } : {}),
      ...(body.dedupeKey !== undefined ? { dedupeKey: body.dedupeKey } : {}),
      createdBy: p.userId.toString()
    });
  }

  @Post("jobs/:id/pause")
  @RequirePermission("scheduler.write")
  pauseJob(@CurrentPrincipal() p: AuthenticatedPrincipal, @Param("id") id: string) {
    return this.scheduler.pauseJob(p.organizationId.toString(), id, p.userId.toString());
  }

  @Post("jobs/:id/resume")
  @RequirePermission("scheduler.write")
  resumeJob(@CurrentPrincipal() p: AuthenticatedPrincipal, @Param("id") id: string) {
    return this.scheduler.resumeJob(p.organizationId.toString(), id);
  }

  @Post("jobs/:id/cancel")
  @RequirePermission("scheduler.write")
  cancelJob(@CurrentPrincipal() p: AuthenticatedPrincipal, @Param("id") id: string) {
    return this.scheduler.cancelJob(p.organizationId.toString(), id, p.userId.toString());
  }

  @Post("templates/:id/instantiate")
  @RequirePermission("scheduler.template.write")
  instantiateTemplate(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id") id: string,
    @Body() body: InstantiateTemplateDto
  ) {
    return this.scheduler.instantiateTemplate(p.organizationId.toString(), id, {
      employeeId: body.employeeId ?? null,
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.payload !== undefined ? { payload: body.payload } : {}),
      createdBy: p.userId.toString()
    });
  }

  // ------------------------------------------------------------------ Executions
  @Get("executions")
  @RequirePermission("scheduler.read")
  listExecutions(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query() query: ListExecutionsQueryDto
  ) {
    return this.history.listExecutions(p.organizationId.toString(), {
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.jobId ? { jobId: query.jobId } : {}),
      ...(query.definitionKey ? { definitionKey: query.definitionKey } : {}),
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {})
    });
  }

  @Get("executions/:id")
  @RequirePermission("scheduler.read")
  async getExecution(@CurrentPrincipal() p: AuthenticatedPrincipal, @Param("id") id: string) {
    const execution = await this.history.getExecution(p.organizationId.toString(), id);
    if (!execution) throw new NotFoundException("SCHEDULER_EXECUTION_NOT_FOUND");
    return execution;
  }

  @Post("executions/:id/retry")
  @RequirePermission("scheduler.retry")
  retryExecution(@CurrentPrincipal() p: AuthenticatedPrincipal, @Param("id") id: string) {
    return this.scheduler.retryExecution(p.organizationId.toString(), id);
  }
}
