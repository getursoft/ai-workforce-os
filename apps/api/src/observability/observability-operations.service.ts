import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import { WorkforceOrchestratorService } from "../workforce/workforce-orchestrator.service";
import { ObservabilityAlertsService } from "./observability-alerts.service";

/**
 * Sprint 4.7 Phase 17: safe operational actions, every one of which delegates to an EXISTING, already
 * audited business method (WorkforceOrchestratorService.retryTask/cancelTask, or a plain status reset that
 * the existing ChannelMessageProcessor's own polling picks up) — this file adds no new execution engine,
 * and never touches billing, audit history, or another tenant's data. Every action is audited again here
 * under an OBSERVABILITY_OPERATION_* event specifically so "who triggered this from the observability
 * surface" is distinguishable from a normal user-facing retry/cancel call.
 */
@Injectable()
export class ObservabilityOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: WorkforceOrchestratorService,
    private readonly alerts: ObservabilityAlertsService,
    private readonly audit: AuditEventLogger
  ) {}

  async retryDelegatedTask(organizationId: string, taskId: string, userId: string) {
    const view = await this.orchestrator.retryTask(organizationId, taskId);
    this.audit.record("OBSERVABILITY_OPERATION_TASK_RETRIED", taskId, { organizationId, userId, targetId: taskId });
    return view;
  }

  async cancelDelegatedTask(organizationId: string, taskId: string, userId: string) {
    const view = await this.orchestrator.cancelTask(organizationId, taskId);
    this.audit.record("OBSERVABILITY_OPERATION_TASK_CANCELLED", taskId, { organizationId, userId, targetId: taskId });
    return view;
  }

  /** Scoped to EMPLOYEE_DELEGATION workflows only — "resume" for any other workflow type would require
   *  re-entering WorkflowCoordinator's chat-turn dispatch, which needs a real inbound turn to resume
   *  against and is not something an observability operator action can safely synthesize. */
  async resumeWorkflow(organizationId: string, workflowExecutionId: string, userId: string) {
    const workflow = await this.prisma.workflowExecution.findFirst({ where: { id: workflowExecutionId, organizationId } });
    if (!workflow) throw new NotFoundException("WORKFLOW_NOT_FOUND");
    if (workflow.workflowType !== "EMPLOYEE_DELEGATION") {
      throw new ForbiddenException("OBSERVABILITY_RESUME_NOT_SUPPORTED_FOR_WORKFLOW_TYPE");
    }
    const task = await this.prisma.employeeDelegatedTask.findFirst({ where: { organizationId, parentWorkflowExecutionId: workflowExecutionId } });
    if (!task) throw new NotFoundException("DELEGATED_TASK_NOT_FOUND_FOR_WORKFLOW");
    const view = await this.orchestrator.retryTask(organizationId, task.id);
    this.audit.record("OBSERVABILITY_OPERATION_WORKFLOW_RESUMED", workflowExecutionId, { organizationId, userId, targetId: workflowExecutionId, delegatedTaskId: task.id });
    return view;
  }

  /** Resets a permanently-failed INBOUND channel message back to a pickup-eligible state — the existing
   *  ChannelMessageProcessor's own polling tick does the actual reprocessing, nothing new runs it. */
  async reprocessChannelMessage(organizationId: string, channelMessageId: string, userId: string) {
    const message = await this.prisma.channelMessage.findFirst({ where: { id: channelMessageId, organizationId } });
    if (!message) throw new NotFoundException("CHANNEL_MESSAGE_NOT_FOUND");
    if (message.direction !== "INBOUND" || message.status !== "FAILED") {
      throw new ForbiddenException("OBSERVABILITY_REPROCESS_ONLY_SUPPORTS_FAILED_INBOUND_MESSAGES");
    }
    const updated = await this.prisma.channelMessage.update({
      where: { id: channelMessageId },
      data: { status: "RECEIVED", nextAttemptAt: new Date(), errorCode: null, errorMessage: null }
    });
    this.audit.record("OBSERVABILITY_OPERATION_CHANNEL_MESSAGE_REPROCESSED", channelMessageId, { organizationId, userId, targetId: channelMessageId });
    return updated;
  }

  async acknowledgeAlert(organizationId: string, alertId: string, userId: string) {
    const alert = await this.alerts.acknowledge(organizationId, alertId, userId);
    if (!alert) throw new NotFoundException("ALERT_NOT_FOUND");
    return alert;
  }
}
