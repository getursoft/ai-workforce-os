/**
 * Sprint 4.8 — built-in JobHandler implementations (Phase 7/12/13).
 *
 * Every handler reuses existing platform engines rather than duplicating them:
 *  - SEND_REMINDER  → ReminderComposer (memory) + SchedulerDeliveryService (channels/email)
 *  - START_WORKFLOW → WorkflowExecutionService (the existing Workflow Engine's persistence)
 *  - REQUEST_APPROVAL / ESCALATE_APPROVAL → ApprovalService + ApprovalAuditService
 *  - PENDING_APPROVAL_SCAN → Phase 13: scans pending approvals and schedules reminders
 *  - RUN_AGENT → AgentService.execute (the existing agent pipeline)
 *  - PUBLISH_EVENT → the scheduler event bus (job chaining)
 */

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { WorkflowExecutionService } from "../workflows/workflow-execution.service";
import { ApprovalService } from "../approval/approval.service";
import { ApprovalAuditService } from "../approval/approval-audit.service";
import { AgentService } from "../agents/agent.service";
import { ReminderComposer } from "./reminder-composer";
import { SchedulerDeliveryService } from "./scheduler-delivery.service";
import { SchedulerEventBus } from "./scheduler-event-bus";
import type { JobHandler, JobRunContext, JobRunResult } from "./scheduler.types";
import { randomUUID } from "node:crypto";

@Injectable()
export class SchedulerHandlers {
  private readonly logger = new Logger(SchedulerHandlers.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly composer: ReminderComposer,
    private readonly delivery: SchedulerDeliveryService,
    private readonly workflows: WorkflowExecutionService,
    private readonly approvals: ApprovalService,
    private readonly approvalAudit: ApprovalAuditService,
    private readonly agents: AgentService,
    private readonly events: SchedulerEventBus
  ) {}

  async execute(handlerType: string, context: JobRunContext): Promise<JobRunResult> {
    switch (handlerType) {
      case "SEND_REMINDER":
        return this.sendReminder(context);
      case "START_WORKFLOW":
        return this.startWorkflow(context);
      case "REQUEST_APPROVAL":
        return this.requestApproval(context);
      case "ESCALATE_APPROVAL":
        return this.escalateApproval(context);
      case "PENDING_APPROVAL_SCAN":
        return this.pendingApprovalScan(context);
      case "RUN_AGENT":
        return this.runAgent(context);
      case "PUBLISH_EVENT":
        return this.publishEvent(context);
      default:
        return {
          success: false,
          errorCode: "UNKNOWN_HANDLER",
          errorMessage: `No handler registered for ${handlerType}`
        };
    }
  }

  /** Builds the registry entries mapping definitionKey → this service's dispatcher. */
  buildRegistry(
    definitions: Array<{ key: string; handlerType: string }>
  ): Record<string, JobHandler> {
    const registry: Record<string, JobHandler> = {};
    for (const definition of definitions) {
      registry[definition.key] = {
        key: definition.key,
        handlerType: definition.handlerType as JobHandler["handlerType"],
        execute: (context) => this.execute(definition.handlerType, context)
      };
    }
    return registry;
  }

  // ---------------------------------------------------------------------
  // SEND_REMINDER — Phase 7 autonomous follow-ups
  // ---------------------------------------------------------------------

  private async sendReminder(context: JobRunContext): Promise<JobRunResult> {
    const payload = context.payload ?? {};
    const kind = (payload.kind as string) ?? context.definitionKey;
    const entityId =
      (payload.entityId as string | null) ?? (context.context.entityId as string | null) ?? null;
    const entityStatus = (payload.entityStatus as string | null) ?? null;
    const conversationId = (context.context.conversationId as string | null) ?? null;
    const userId = (context.context.userId as string | null) ?? null;
    const recipientName = (payload.recipientName as string | null) ?? null;

    const decision = await this.composer.decide({
      organizationId: context.organizationId,
      employeeId: context.employeeId,
      definitionKey: context.definitionKey,
      kind,
      entityId,
      entityStatus,
      businessHours: (payload.businessHours as ReminderComposerDecide["businessHours"]) ?? null,
      recipientName,
      userId,
      conversationId,
      payload
    });

    if (!decision.shouldSend || !decision.message) {
      return {
        success: true,
        result: { outcome: "skipped", reason: decision.reason, dedupeKey: decision.dedupeKey }
      };
    }

    const target = await this.resolveDeliveryTarget(context, payload);
    const delivery = await this.delivery.deliver({
      organizationId: context.organizationId,
      employeeId: context.employeeId,
      definitionKey: context.definitionKey,
      executionId: context.executionId,
      message: {
        subject: decision.subject ?? purposeSubject(context.definitionKey),
        body: decision.message
      },
      target,
      traceId: context.traceId
    });

    if (entityId) {
      await this.composer.markSent(
        {
          organizationId: context.organizationId,
          employeeId: context.employeeId,
          definitionKey: context.definitionKey,
          kind,
          entityId,
          userId,
          conversationId,
          payload
        },
        decision.dedupeKey
      );
    }

    return {
      success: true,
      result: {
        outcome: "sent",
        reason: decision.reason,
        dedupeKey: decision.dedupeKey,
        delivered: delivery.delivered,
        detail: delivery.detail,
        contextFacts: decision.contextFacts.length
      }
    };
  }

  /** Resolves where to deliver based on payload/context — phone+channel for WhatsApp, email address. */
  private async resolveDeliveryTarget(
    context: JobRunContext,
    payload: Record<string, unknown>
  ): Promise<DeliveryTargetInput> {
    const contextData = context.context ?? {};
    const channelConnectionId = (payload.channelConnectionId as string | null) ?? null;
    const toAddress =
      (payload.toAddress as string | null) ??
      (payload.phone as string | null) ??
      (contextData.phone as string | null) ??
      null;
    const email =
      (payload.email as string | null) ?? (contextData.customerEmail as string | null) ?? null;
    return {
      organizationId: context.organizationId,
      employeeId: context.employeeId,
      channelConnectionId,
      toAddress,
      email
    };
  }

  // ---------------------------------------------------------------------
  // START_WORKFLOW — Phase 12: use the existing Workflow Engine (persistence)
  // ---------------------------------------------------------------------

  private async startWorkflow(context: JobRunContext): Promise<JobRunResult> {
    const payload = context.payload ?? {};
    const contextData = context.context ?? {};
    const employeeId = context.employeeId ?? (contextData.employeeId as string | null) ?? null;
    const conversationId = (contextData.conversationId as string | null) ?? null;
    if (!employeeId || !conversationId) {
      // No conversation to attach a durable workflow to — fall back to a plain reminder delivery.
      return this.sendReminder(context);
    }

    const turnId = `${context.executionId}:start`;
    const created = await this.workflows.createWorkflow({
      scope: {
        organizationId: context.organizationId,
        pluginInstallationId: employeeId,
        conversationId,
        workflowType: "AUTONOMOUS_REMINDER" as never
      },
      currentStep: "REMINDER_STARTED",
      pendingInput: null,
      state: {
        definitionKey: context.definitionKey,
        jobId: context.jobId,
        executionId: context.executionId,
        payload
      },
      turnId
    });

    let workflow = created.execution;
    // Run the reminder body inside the tracked workflow, then close it via the engine.
    const reminderResult = await this.sendReminder(context);
    const state = {
      ...(workflow.state as Record<string, unknown>),
      reminderResult: reminderResult.result ?? {}
    };
    workflow = await this.workflows
      .updateWorkflowState({
        organizationId: context.organizationId,
        id: workflow.id,
        expectedRevision: workflow.revision,
        currentStep: "REMINDER_SENT",
        pendingInput: null,
        state,
        turnId: `${context.executionId}:sent`
      })
      .then((result) => result.execution);
    await this.workflows.markCompleted({
      organizationId: context.organizationId,
      id: workflow.id,
      expectedRevision: workflow.revision,
      state: { ...(workflow.state as Record<string, unknown>), completedBy: "scheduler" },
      currentStep: "CLOSED"
    });
    return {
      success: reminderResult.success,
      result: { workflowExecutionId: workflow.id, ...reminderResult.result }
    };
  }

  // ---------------------------------------------------------------------
  // REQUEST_APPROVAL — Phase 13: reuse the existing Approval Engine
  // ---------------------------------------------------------------------

  private async requestApproval(context: JobRunContext): Promise<JobRunResult> {
    const payload = context.payload ?? {};
    const contextData = context.context ?? {};
    const employeeId = context.employeeId ?? (contextData.employeeId as string | null) ?? null;
    if (!employeeId) {
      return {
        success: false,
        errorCode: "EMPLOYEE_REQUIRED",
        errorMessage: "REQUEST_APPROVAL requires an employeeId"
      };
    }
    const conversationId = (contextData.conversationId as string | null) ?? null;
    const workflow = conversationId
      ? await this.workflows
          .createWorkflow({
            scope: {
              organizationId: context.organizationId,
              pluginInstallationId: employeeId,
              conversationId,
              workflowType: "AUTONOMOUS_REMINDER" as never
            },
            currentStep: "APPROVAL_REQUESTED",
            pendingInput: null,
            state: { definitionKey: context.definitionKey },
            turnId: `${context.executionId}:approval`
          })
          .then((result) => result.execution)
      : null;

    const approval = await this.approvals.create({
      organizationId: context.organizationId,
      workflowExecutionId:
        workflow?.id ?? (context.context.workflowId as string | null) ?? randomUUID(),
      agentId: employeeId,
      actionType: (payload.actionType as string) ?? `SCHEDULER_${context.definitionKey}`,
      subjectType: (payload.subjectType as string | null) ?? "SCHEDULED_JOB",
      subjectId: (payload.subjectId as string | null) ?? context.jobId,
      requesterType: "SYSTEM",
      requestedBy: (payload.requestedBy as string | null) ?? "AI Scheduler",
      title: (payload.title as string) ?? `Approval requested by scheduler`,
      description: String(payload.description ?? context.definitionKey).slice(0, 1900),
      payload: ((payload.payload ?? {}) as Record<string, unknown>) ?? {}
    });

    return {
      success: true,
      result: { approvalRequestId: approval.id, workflowExecutionId: workflow?.id ?? null }
    };
  }

  // ---------------------------------------------------------------------
  // ESCALATE_APPROVAL — Phase 13: remind approvers / escalate stale approvals
  // ---------------------------------------------------------------------

  private async escalateApproval(context: JobRunContext): Promise<JobRunResult> {
    const payload = context.payload ?? {};
    const approvalId = (payload.approvalRequestId as string | null) ?? null;
    if (!approvalId) {
      return {
        success: false,
        errorCode: "APPROVAL_REQUIRED",
        errorMessage: "ESCALATE_APPROVAL requires approvalRequestId"
      };
    }
    const approval = await this.prisma.approvalRequest.findFirst({
      where: { id: approvalId, organizationId: context.organizationId }
    });
    if (!approval) return { success: true, result: { outcome: "approval_not_found" } };
    if (approval.status !== "PENDING")
      return { success: true, result: { outcome: "already_resolved", status: approval.status } };

    await this.approvalAudit.record({
      organizationId: context.organizationId,
      approvalRequestId: approval.id,
      workflowExecutionId: approval.workflowExecutionId ?? null,
      eventType: "SCHEDULER_ESCALATION",
      actorType: "SYSTEM",
      actorId: context.executionId,
      metadata: {
        definitionKey: context.definitionKey,
        reason: payload.reason ?? "pending beyond expected window"
      }
    });

    const reminder = await this.composer.decide({
      organizationId: context.organizationId,
      employeeId: context.employeeId,
      definitionKey: context.definitionKey,
      kind: (payload.kind as string) ?? `${context.definitionKey}:escalate`,
      entityId: approval.id,
      entityStatus: null,
      businessHours: null,
      recipientName: null,
      userId: null,
      conversationId: null,
      payload: { title: approval.title, ...(payload as object) }
    });
    if (reminder.shouldSend && reminder.message) {
      await this.delivery.deliver({
        organizationId: context.organizationId,
        employeeId: context.employeeId,
        definitionKey: context.definitionKey,
        executionId: context.executionId,
        message: { subject: reminder.subject ?? "Approval escalation", body: reminder.message },
        target: {
          organizationId: context.organizationId,
          employeeId: context.employeeId,
          email: (payload.escalationEmail as string | null) ?? null
        },
        traceId: context.traceId
      });
      await this.composer.markSent(
        {
          organizationId: context.organizationId,
          employeeId: context.employeeId,
          definitionKey: context.definitionKey,
          kind: (payload.kind as string) ?? `${context.definitionKey}:escalate`,
          entityId: approval.id,
          payload
        },
        reminder.dedupeKey
      );
    }

    return { success: true, result: { outcome: "escalated", approvalRequestId: approval.id } };
  }

  // ---------------------------------------------------------------------
  // PENDING_APPROVAL_SCAN — Phase 13: pending approvals → reminders
  // ---------------------------------------------------------------------

  private async pendingApprovalScan(context: JobRunContext): Promise<JobRunResult> {
    const payload = context.payload ?? {};
    const reminderDefinitionKey =
      (payload.reminderDefinitionKey as string | null) ?? context.definitionKey;
    const sinceMs = Number(payload.sinceMinutes ?? 0) * 60_000;
    const approvals = await this.prisma.approvalRequest.findMany({
      where: {
        organizationId: context.organizationId,
        status: "PENDING",
        ...(context.employeeId ? { agentId: context.employeeId } : {}),
        ...(sinceMs > 0 ? { createdAt: { lte: new Date(Date.now() - sinceMs) } } : {})
      },
      take: 50
    });
    let scheduled = 0;
    for (const approval of approvals) {
      const dedupeKey = `scheduler:approval-reminder:${approval.id}`;
      const existing = await this.prisma.scheduledJob.findUnique({ where: { dedupeKey } });
      if (existing) continue;
      await this.prisma.scheduledJob.create({
        data: {
          organizationId: context.organizationId,
          employeeId: context.employeeId,
          definitionKey: reminderDefinitionKey,
          triggerType: "ONE_TIME",
          timezone: context.timezone,
          status: "ACTIVE",
          priority: context.priority,
          nextRun: new Date(),
          maxRetry: 2,
          timeoutMs: 30_000,
          payload: {
            kind: "approval_pending",
            entityId: approval.id,
            entityStatus: approval.status,
            title: approval.title,
            ...(approval.requesterUserId ? { requesterUserId: approval.requesterUserId } : {})
          },
          context: { approvalRequestId: approval.id, entityId: approval.id },
          dedupeKey,
          createdBy: null
        }
      });
      scheduled += 1;
    }
    return { success: true, result: { scanned: approvals.length, scheduled } };
  }

  // ---------------------------------------------------------------------
  // RUN_AGENT — Phase 17: let the employee itself decide/follow up
  // ---------------------------------------------------------------------

  private async runAgent(context: JobRunContext): Promise<JobRunResult> {
    const payload = context.payload ?? {};
    const contextData = context.context ?? {};
    const employeeId = context.employeeId ?? (contextData.employeeId as string | null) ?? null;
    const conversationId = (contextData.conversationId as string | null) ?? null;
    if (!employeeId || !conversationId) {
      return {
        success: false,
        errorCode: "EMPLOYEE_OR_CONVERSATION_REQUIRED",
        errorMessage: "RUN_AGENT requires employeeId + conversationId"
      };
    }
    const instruction =
      (payload.instruction as string | null) ??
      `[Internal autonomous task] Objective: ${payload.objective ?? "follow up with the customer based on your memory"}. Input: ${JSON.stringify(payload ?? {})}. Reply with a short, warm, professional message.`;
    try {
      const result = await this.agents.execute({
        organizationId: context.organizationId,
        agentId: employeeId,
        conversationId,
        actor: {
          type: "SYSTEM",
          sourceEmployeeInstallationId: employeeId,
          delegatedTaskId: `scheduler-${context.executionId}`
        },
        text: instruction,
        source: { type: "DASHBOARD" },
        requestId: `scheduler-${context.executionId}`,
        metadata: { scheduledJobId: context.jobId, executionId: context.executionId },
        ...(context.traceId
          ? { traceContext: rootedFrom(context.organizationId, context.traceId, true) }
          : {})
      });
      const usage = result.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
      return {
        success: true,
        result: { response: result.response.slice(0, 500), tokens, executionId: result.executionId }
      };
    } catch (error) {
      this.logger.warn({
        event: "SCHEDULER_RUN_AGENT_FAILED",
        executionId: context.executionId,
        error: String(error)
      });
      return {
        success: false,
        errorCode: "RUN_AGENT_FAILED",
        errorMessage: String(error).slice(0, 500)
      };
    }
  }

  // ---------------------------------------------------------------------
  // PUBLISH_EVENT — job chaining
  // ---------------------------------------------------------------------

  private async publishEvent(context: JobRunContext): Promise<JobRunResult> {
    const payload = context.payload ?? {};
    const name = (payload.eventName as string) ?? "scheduler.job.completed";
    this.events.emit({
      name: name as never,
      organizationId: context.organizationId,
      employeeId: context.employeeId,
      entityType: "SCHEDULED_JOB",
      entityId: context.jobId,
      occurredAt: new Date(),
      payload: {
        definitionKey: context.definitionKey,
        executionId: context.executionId,
        ...payload
      }
    });
    return { success: true, result: { eventName: name } };
  }
}

/** Minimal re-root of a persisted traceId for a background span — mirrors trace-context.rootedContext. */
import { rootedContext as rootedFrom } from "../observability/trace-context";

interface ReminderComposerDecide {
  businessHours?: { timezone?: string | null; start?: string | null; end?: string | null } | null;
}

type DeliveryTargetInput = {
  organizationId: string;
  employeeId: string | null;
  channelConnectionId?: string | null;
  toAddress?: string | null;
  email?: string | null;
};

function purposeSubject(definitionKey: string): string {
  const subjects: Record<string, string> = {
    "travel.reminder.pre_travel": "Upcoming travel reminder",
    "travel.reminder.visa_expiry": "Visa expiry reminder",
    "travel.reminder.passport_expiry": "Passport expiry reminder",
    "travel.reminder.quotation_followup": "Quotation follow-up",
    "travel.reminder.booking_reminder": "Travel booking reminder",
    "travel.reminder.approval_pending": "Booking approval reminder",
    "hr.reminder.manager_approval": "Leave approval reminder",
    "hr.reminder.leave_before": "Leave reminder",
    "hr.reminder.joining": "Joining reminder",
    "hr.reminder.probation": "Probation reminder",
    "finance.reminder.invoice": "Invoice reminder",
    "finance.reminder.payment": "Payment reminder",
    "finance.reminder.reimbursement": "Reimbursement reminder",
    "legal.reminder.contract": "Contract renewal reminder",
    "legal.reminder.court": "Court hearing reminder",
    "sales.reminder.lead_followup": "Lead follow-up",
    "sales.reminder.proposal": "Proposal reminder"
  };
  return subjects[definitionKey] ?? "AI Employee reminder";
}
