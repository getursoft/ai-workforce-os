import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import { EmployeeRegistry } from "./employee-registry";
import { WorkforceOrchestratorService } from "./workforce-orchestrator.service";
import { WorkforceCollaborationPolicyService } from "./workforce-collaboration-policy.service";
import { DelegateParallelTaskDto, DelegateTaskDto, UpdateCollaborationPolicyDto } from "./workforce.dto";

@ApiTags("Workforce")
@ApiBearerAuth()
@Controller("workforce")
@UseGuards(JwtAccessGuard, PermissionGuard)
export class WorkforceController {
  constructor(
    private readonly registry: EmployeeRegistry,
    private readonly orchestrator: WorkforceOrchestratorService,
    private readonly policyService: WorkforceCollaborationPolicyService
  ) {}

  @Get("employees") @RequirePermission("workforce.read")
  listEmployees(@CurrentPrincipal() p: AuthenticatedPrincipal) {
    return this.registry.listInstalled(p.organizationId.toString());
  }

  @Get("tasks") @RequirePermission("workforce.task.read")
  listTasks(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query("status") status?: string,
    @Query("sourceEmployeeInstallationId") sourceEmployeeInstallationId?: string,
    @Query("targetEmployeeInstallationId") targetEmployeeInstallationId?: string,
    @Query("correlationId") correlationId?: string
  ) {
    return this.orchestrator.listTasks(p.organizationId.toString(), {
      ...(status ? { status } : {}),
      ...(sourceEmployeeInstallationId ? { sourceEmployeeInstallationId } : {}),
      ...(targetEmployeeInstallationId ? { targetEmployeeInstallationId } : {}),
      ...(correlationId ? { correlationId } : {})
    });
  }

  @Get("tasks/:id") @RequirePermission("workforce.task.read")
  async getTask(@CurrentPrincipal() p: AuthenticatedPrincipal, @Param("id", new ParseUUIDPipe()) id: string) {
    const task = await this.orchestrator.getTask(p.organizationId.toString(), id);
    if (!task) throw new NotFoundException("WORKFORCE_TASK_NOT_FOUND");
    return task;
  }

  @Get("tasks/:id/timeline") @RequirePermission("workforce.task.read")
  async getTaskTimeline(@CurrentPrincipal() p: AuthenticatedPrincipal, @Param("id", new ParseUUIDPipe()) id: string) {
    const task = await this.orchestrator.getTask(p.organizationId.toString(), id);
    if (!task) throw new NotFoundException("WORKFORCE_TASK_NOT_FOUND");
    const events: Array<{ step: string; at: string | null }> = [
      { step: "CREATED", at: task.createdAt },
      { step: "STARTED", at: task.startedAt },
      { step: "COMPLETED", at: task.status === "COMPLETED" ? task.completedAt : null },
      { step: "FAILED", at: task.status === "FAILED" || task.status === "TIMED_OUT" ? task.completedAt : null }
    ];
    return { taskId: task.id, status: task.status, events: events.filter((event) => event.at !== null) };
  }

  @Post("tasks") @RequirePermission("workforce.task.manage")
  delegate(@CurrentPrincipal() p: AuthenticatedPrincipal, @Body() dto: DelegateTaskDto) {
    return this.orchestrator.delegate({
      organizationId: p.organizationId.toString(),
      sourceEmployeeInstallationId: dto.sourceEmployeeInstallationId,
      ...(dto.targetEmployeeInstallationId ? { targetEmployeeInstallationId: dto.targetEmployeeInstallationId } : {}),
      requestedByActorType: "USER",
      requestedByActorId: p.userId.toString(),
      contract: {
        taskType: dto.taskType,
        ...(dto.targetCapability ? { targetCapability: dto.targetCapability } : {}),
        objective: dto.objective,
        input: dto.input,
        ...(dto.expectedOutput ? { expectedOutput: dto.expectedOutput } : {}),
        ...(dto.constraints ? { constraints: dto.constraints } : {}),
        ...(dto.requestedMemoryCategories ? { requestedMemoryCategories: dto.requestedMemoryCategories } : {})
      },
      ...(dto.mode ? { mode: dto.mode } : {}),
      ...(dto.idempotencyKey ? { idempotencyKey: dto.idempotencyKey } : {})
    });
  }

  @Post("tasks/parallel") @RequirePermission("workforce.task.manage")
  delegateParallel(@CurrentPrincipal() p: AuthenticatedPrincipal, @Body() dto: DelegateParallelTaskDto) {
    return this.orchestrator.delegateParallel({
      organizationId: p.organizationId.toString(),
      sourceEmployeeInstallationId: dto.sourceEmployeeInstallationId,
      requests: dto.requests.map((request) => ({
        ...(request.targetEmployeeInstallationId ? { targetEmployeeInstallationId: request.targetEmployeeInstallationId } : {}),
        contract: {
          taskType: request.taskType,
          ...(request.targetCapability ? { targetCapability: request.targetCapability } : {}),
          objective: request.objective,
          input: request.input,
          ...(request.expectedOutput ? { expectedOutput: request.expectedOutput } : {}),
          ...(request.constraints ? { constraints: request.constraints } : {}),
          ...(request.requestedMemoryCategories ? { requestedMemoryCategories: request.requestedMemoryCategories } : {})
        }
      })),
      joinPolicy: dto.joinPolicy,
      ...(dto.minimumRequired ? { minimumRequired: dto.minimumRequired } : {}),
      requestedByActorType: "USER",
      requestedByActorId: p.userId.toString(),
      ...(dto.mode ? { mode: dto.mode } : {})
    });
  }

  @Get("joins/:correlationId") @RequirePermission("workforce.task.read")
  async getJoin(@CurrentPrincipal() p: AuthenticatedPrincipal, @Param("correlationId") correlationId: string) {
    const join = await this.orchestrator.getJoin(p.organizationId.toString(), correlationId);
    if (!join) throw new NotFoundException("WORKFORCE_JOIN_NOT_FOUND");
    return join;
  }

  @Post("tasks/:id/cancel") @RequirePermission("workforce.task.manage")
  cancelTask(@CurrentPrincipal() p: AuthenticatedPrincipal, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.orchestrator.cancelTask(p.organizationId.toString(), id);
  }

  @Post("tasks/:id/retry") @RequirePermission("workforce.task.manage")
  retryTask(@CurrentPrincipal() p: AuthenticatedPrincipal, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.orchestrator.retryTask(p.organizationId.toString(), id);
  }

  @Get("policy") @RequirePermission("workforce.read")
  getPolicy(@CurrentPrincipal() p: AuthenticatedPrincipal) {
    return this.policyService.getOrCreate(p.organizationId.toString());
  }

  @Put("policy") @RequirePermission("workforce.collaboration.configure")
  updatePolicy(@CurrentPrincipal() p: AuthenticatedPrincipal, @Body() dto: UpdateCollaborationPolicyDto) {
    return this.policyService.update(p.organizationId.toString(), dto);
  }
}
