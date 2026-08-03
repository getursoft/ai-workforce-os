import { Injectable, Optional } from "@nestjs/common";
import {
  ConversationStatus,
  Prisma,
  WorkflowStatus as PrismaWorkflowStatus,
  type WorkflowExecution
} from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { ObservabilityService } from "../observability/observability.service";
import { TraceContextStore } from "../observability/trace-context.store";
import type { WorkflowExecutionScope } from "./workflow-runtime.contracts";

const ACTIVE_STATUSES: readonly PrismaWorkflowStatus[] = [
  PrismaWorkflowStatus.ACTIVE,
  PrismaWorkflowStatus.WAITING_FOR_INPUT,
  PrismaWorkflowStatus.WAITING_FOR_APPROVAL
];
const MAX_PROCESSED_TURNS = 100;

export interface WorkflowExecutionMutationResult {
  execution: WorkflowExecution;
  applied: boolean;
  idempotentReplay: boolean;
}

export class WorkflowExecutionRevisionConflictError extends Error {
  constructor() {
    super("WORKFLOW_EXECUTION_REVISION_CONFLICT");
  }
}

/**
 * Generic, workflow-type-agnostic persistence for the Pending Workflow Runtime — mirrors
 * SkillExecutionService's optimistic-locking/idempotency/active-key conventions exactly (Stage 8).
 * Contact Capture (and any future workflow type) builds on this without its own persistence code.
 */
@Injectable()
export class WorkflowExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly observability?: ObservabilityService,
    @Optional() private readonly traceContextStore?: TraceContextStore
  ) {}

  /**
   * Sprint 4.7A Phase 3: every workflow status transition funnels through this one class (createWorkflow /
   * updateWorkflowState / markTerminal), so instrumenting it here — rather than WorkflowCoordinator or any
   * of the per-workflow-type services (ContactCapture/BookingHandoff/TripSubmission), none of which this
   * pass may modify — covers booking, HR leave, cancellation, refund, expense, and approval workflows alike
   * with a single, low-risk choke point. The ambient TraceContext comes from TraceContextStore (set by
   * ObservabilityService.withSpan around AgentService's root span), so no method signature here changes and
   * no caller needs to pass anything new. When there's no ambient trace (e.g. a unit test constructing this
   * service directly) or no ObservabilityService, this degrades to a plain passthrough — `fn()` runs exactly
   * as it always did.
   */
  private async traceTransition<T>(name: string, inputSummary: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const context = this.traceContextStore?.get();
    if (!context || !this.observability) return fn();
    return this.observability.withSpan(context, { name, spanType: "WORKFLOW_STEP", component: "WorkflowExecutionService", inputSummary }, () => fn());
  }

  async findActiveWorkflow(scope: WorkflowExecutionScope): Promise<WorkflowExecution | null> {
    return this.prisma.workflowExecution.findFirst({
      where: {
        ...scope,
        conversation: { status: ConversationStatus.ACTIVE, deletedAt: null },
        status: { in: [...ACTIVE_STATUSES] },
        activeKey: { not: null }
      },
      orderBy: { updatedAt: "desc" }
    });
  }

  async loadWorkflow(organizationId: string, id: string): Promise<WorkflowExecution | null> {
    return this.prisma.workflowExecution.findFirst({ where: { id, organizationId } });
  }

  /**
   * Stage 9C: all active workflows for a conversation, regardless of type — `activeKey` uniqueness is
   * scoped per workflowType, so two different workflow types can each have one active row at once. Turn
   * dispatch (WorkflowCoordinator) uses this to apply cross-type priority/conflict rules generically.
   */
  async findActiveWorkflowsForConversation(
    organizationId: string,
    pluginInstallationId: string,
    conversationId: string
  ): Promise<WorkflowExecution[]> {
    return this.prisma.workflowExecution.findMany({
      where: {
        organizationId,
        pluginInstallationId,
        conversationId,
        conversation: { status: ConversationStatus.ACTIVE, deletedAt: null },
        status: { in: [...ACTIVE_STATUSES] },
        activeKey: { not: null }
      },
      orderBy: { updatedAt: "desc" }
    });
  }

  async createWorkflow(input: {
    scope: WorkflowExecutionScope;
    currentStep: string;
    pendingInput: string | null;
    state: Record<string, unknown>;
    turnId: string;
  }): Promise<WorkflowExecutionMutationResult> {
    return this.traceTransition(
      `WORKFLOW_STEP:${input.scope.workflowType}:CREATE:${input.currentStep}`,
      { workflowType: input.scope.workflowType, toStep: input.currentStep, toStatus: statusForPendingInput(input.pendingInput) },
      async () => {
        const activeKey = this.activeKey(input.scope);
        const context = this.traceContextStore?.get();
        const data = {
          organizationId: input.scope.organizationId,
          pluginInstallationId: input.scope.pluginInstallationId,
          conversationId: input.scope.conversationId,
          workflowType: input.scope.workflowType,
          status: statusForPendingInput(input.pendingInput),
          currentStep: input.currentStep,
          pendingInput: input.pendingInput,
          state: input.state as Prisma.InputJsonValue,
          revision: 0,
          processedTurnIds: [input.turnId],
          activeKey,
          ...(context?.sampled ? { traceId: context.traceId } : {})
        };
        try {
          const execution = await this.prisma.workflowExecution.create({ data });
          if (context) await this.observability?.linkTrace(context, { workflowExecutionId: execution.id });
          return { execution, applied: true, idempotentReplay: false };
        } catch (error) {
          if (isUniqueConflict(error)) {
            const winner = await this.findActiveWorkflow(input.scope);
            if (winner)
              return {
                execution: winner,
                applied: false,
                idempotentReplay: hasTurn(winner, input.turnId)
              };
          }
          throw error;
        }
      }
    );
  }

  async updateWorkflowState(input: {
    organizationId: string;
    id: string;
    expectedRevision: number;
    currentStep: string;
    pendingInput: string | null;
    state: Record<string, unknown>;
    turnId: string;
    /** Overrides the auto-derived status (WAITING_FOR_INPUT when pendingInput is set, else ACTIVE) —
     *  needed for a state like WAITING_FOR_APPROVAL, which `statusForPendingInput` has no way to express
     *  (it only ever distinguishes "waiting on the user" from "not"). Without this, a workflow paused for
     *  approval was silently persisted as ACTIVE, which WorkflowCoordinator.dispatchTurn's WAITING_FOR_INPUT/
     *  WAITING_FOR_APPROVAL gate would then never recognize as needing to resume on the next turn. */
    status?: PrismaWorkflowStatus;
  }): Promise<WorkflowExecutionMutationResult> {
    const existing = await this.loadWorkflow(input.organizationId, input.id);
    if (!existing) throw new WorkflowExecutionRevisionConflictError();
    if (hasTurn(existing, input.turnId))
      return { execution: existing, applied: false, idempotentReplay: true };
    return this.traceTransition(
      `WORKFLOW_STEP:${existing.workflowType}:${existing.currentStep}->${input.currentStep}`,
      {
        workflowType: existing.workflowType,
        fromStep: existing.currentStep,
        toStep: input.currentStep,
        fromStatus: existing.status,
        toStatus: input.status ?? statusForPendingInput(input.pendingInput)
      },
      async () => {
        const processedTurnIds = [...readTurnIds(existing), input.turnId].slice(-MAX_PROCESSED_TURNS);
        const result = await this.prisma.workflowExecution.updateMany({
          where: {
            id: input.id,
            organizationId: input.organizationId,
            revision: input.expectedRevision,
            activeKey: { not: null },
            status: { in: [...ACTIVE_STATUSES] }
          },
          data: {
            currentStep: input.currentStep,
            pendingInput: input.pendingInput,
            status: input.status ?? statusForPendingInput(input.pendingInput),
            state: input.state as Prisma.InputJsonValue,
            revision: { increment: 1 },
            processedTurnIds
          }
        });
        if (result.count !== 1) throw new WorkflowExecutionRevisionConflictError();
        const execution = await this.loadWorkflow(input.organizationId, input.id);
        if (!execution) throw new WorkflowExecutionRevisionConflictError();
        return { execution, applied: true, idempotentReplay: false };
      }
    );
  }

  markCompleted(input: TerminalInput): Promise<WorkflowExecution> {
    return this.markTerminal(input, PrismaWorkflowStatus.COMPLETED);
  }

  markFailed(input: TerminalInput): Promise<WorkflowExecution> {
    return this.markTerminal(input, PrismaWorkflowStatus.FAILED);
  }

  markCancelled(input: TerminalInput): Promise<WorkflowExecution> {
    return this.markTerminal(input, PrismaWorkflowStatus.CANCELLED);
  }

  private async markTerminal(
    input: TerminalInput,
    status: PrismaWorkflowStatus
  ): Promise<WorkflowExecution> {
    return this.traceTransition(`WORKFLOW_STEP:TERMINAL:${status}`, { toStatus: status, toStep: input.currentStep }, async () => {
      const result = await this.prisma.workflowExecution.updateMany({
        where: {
          id: input.id,
          organizationId: input.organizationId,
          revision: input.expectedRevision,
          activeKey: { not: null }
        },
        data: {
          status,
          activeKey: null,
          completedAt: new Date(),
          state: input.state as Prisma.InputJsonValue,
          revision: { increment: 1 },
          ...(input.currentStep !== undefined ? { currentStep: input.currentStep } : {})
        }
      });
      if (result.count !== 1) throw new WorkflowExecutionRevisionConflictError();
      const execution = await this.loadWorkflow(input.organizationId, input.id);
      if (!execution) throw new WorkflowExecutionRevisionConflictError();
      return execution;
    });
  }

  private activeKey(scope: WorkflowExecutionScope): string {
    return `${scope.organizationId}:${scope.pluginInstallationId}:${scope.conversationId}:${scope.workflowType}`;
  }
}

interface TerminalInput {
  organizationId: string;
  id: string;
  expectedRevision: number;
  state: Record<string, unknown>;
  currentStep?: string;
}

function statusForPendingInput(pendingInput: string | null): PrismaWorkflowStatus {
  return pendingInput ? PrismaWorkflowStatus.WAITING_FOR_INPUT : PrismaWorkflowStatus.ACTIVE;
}

function readTurnIds(execution: WorkflowExecution): string[] {
  return Array.isArray(execution.processedTurnIds)
    ? execution.processedTurnIds.filter((value): value is string => typeof value === "string")
    : [];
}

function hasTurn(execution: WorkflowExecution, turnId: string): boolean {
  return readTurnIds(execution).includes(turnId);
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
