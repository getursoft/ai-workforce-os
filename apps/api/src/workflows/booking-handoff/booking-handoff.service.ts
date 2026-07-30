import { Injectable, Logger } from "@nestjs/common";
import type { WorkflowExecution } from "@prisma/client";
import {
  WorkflowExecutionRevisionConflictError,
  WorkflowExecutionService
} from "../workflow-execution.service";
import type { WorkflowExecutionScope, WorkflowTurnResult } from "../workflow-runtime.contracts";
import {
  BOOKING_HANDOFF_STEP_READY_FOR_FUTURE_WORKFLOW,
  BOOKING_HANDOFF_STEP_WAITING_FOR_APPROVAL,
  BOOKING_HANDOFF_STEP_WAITING_FOR_CONFIRMATION,
  emptyBookingHandoffState,
  type BookingHandoffState,
  type BookingHandoffTripContext
} from "./booking-handoff.types";
import { isExplicitBookingConfirmation } from "./booking-confirmation";
import { ApprovalService } from "../approval/approval.service";

const SAFE_RETRY_MESSAGE =
  "Something went wrong saving your booking request just now. Please try again in a moment — you don't need to repeat your trip details.";

const APPROVAL_REQUESTED_MESSAGE =
  "Your booking request has been received and is waiting for approval. You'll be notified once a decision is made.";

type WorkflowStatusLiteral = WorkflowTurnResult<BookingHandoffState>["status"];

@Injectable()
export class BookingHandoffWorkflowService {
  private readonly logger = new Logger(BookingHandoffWorkflowService.name);

  constructor(
    private readonly workflows: WorkflowExecutionService,
    private readonly approvalService?: ApprovalService
  ) {}

  async start(
    scope: WorkflowExecutionScope,
    turnId: string,
    tripContext: BookingHandoffTripContext
  ): Promise<WorkflowTurnResult<BookingHandoffState>> {
    const state: BookingHandoffState = {
      ...emptyBookingHandoffState(),
      originCity: tripContext.originCity,
      destinationCity: tripContext.destinationCity,
      travelDates: tripContext.travelDates,
      skillExecutionId: tripContext.skillExecutionId,
      journeyId: tripContext.journeyId
    };
    const mutation = await this.workflows.createWorkflow({
      scope,
      currentStep: BOOKING_HANDOFF_STEP_WAITING_FOR_CONFIRMATION,
      pendingInput: "BOOKING_CONFIRMATION",
      state: state as unknown as Record<string, unknown>,
      turnId
    });
    const resultState = mutation.execution.state as unknown as BookingHandoffState;
    return {
      decision: "ASK_FOR_INPUT",
      responseText: confirmationQuestion(tripContext),
      status: mutation.execution.status as WorkflowStatusLiteral,
      currentStep: mutation.execution.currentStep,
      pendingInput: mutation.execution.pendingInput,
      state: resultState
    };
  }

  async resume(
    execution: WorkflowExecution,
    text: string,
    turnId: string,
    tripContext: BookingHandoffTripContext
  ): Promise<WorkflowTurnResult<BookingHandoffState>> {
    const state = execution.state as unknown as BookingHandoffState;

    if (execution.status === "WAITING_FOR_APPROVAL" || execution.pendingInput === "APPROVED") {
      return this.handleApprovalResume(execution, state, tripContext);
    }

    if (execution.pendingInput !== "BOOKING_CONFIRMATION") {
      return {
        decision: "NOT_APPLICABLE",
        responseText: null,
        status: execution.status as WorkflowStatusLiteral,
        currentStep: execution.currentStep,
        pendingInput: execution.pendingInput,
        state
      };
    }

    if (!isExplicitBookingConfirmation(text)) {
      return {
        decision: "ASK_FOR_INPUT",
        responseText: confirmationQuestion(tripContext),
        status: "WAITING_FOR_INPUT",
        currentStep: execution.currentStep,
        pendingInput: "BOOKING_CONFIRMATION",
        state
      };
    }

    try {
      return await this.confirmAndRequestApproval(execution, turnId, tripContext);
    } catch (error) {
      if (error instanceof WorkflowExecutionRevisionConflictError) {
        this.logger.warn({ event: "BOOKING_HANDOFF_REVISION_CONFLICT", workflowId: execution.id });
      } else {
        this.logger.error({
          event: "BOOKING_HANDOFF_PERSISTENCE_FAILED",
          workflowId: execution.id,
          error: error instanceof Error ? error.message : "unknown"
        });
      }
      return {
        decision: "FAIL",
        responseText: SAFE_RETRY_MESSAGE,
        status: "WAITING_FOR_INPUT",
        currentStep: execution.currentStep,
        pendingInput: "BOOKING_CONFIRMATION",
        state
      };
    }
  }

  private async handleApprovalResume(
    execution: WorkflowExecution,
    state: BookingHandoffState,
    tripContext: BookingHandoffTripContext
  ): Promise<WorkflowTurnResult<BookingHandoffState>> {
    if (state.approvalRequestId) {
      const approval = await this.approvalService?.findById(state.approvalRequestId, execution.organizationId);
      if (approval?.status === "APPROVED") {
        const confirmedState: BookingHandoffState = { ...state, confirmed: true, readyForFutureWorkflow: true };
        const mutation = await this.workflows.updateWorkflowState({
          organizationId: execution.organizationId,
          id: execution.id,
          expectedRevision: execution.revision,
          currentStep: BOOKING_HANDOFF_STEP_READY_FOR_FUTURE_WORKFLOW,
          pendingInput: null,
          state: confirmedState as unknown as Record<string, unknown>,
          turnId: `${execution.id}:approval-resume`
        });
        const completed = await this.workflows.markCompleted({
          organizationId: execution.organizationId,
          id: mutation.execution.id,
          expectedRevision: mutation.execution.revision,
          state: confirmedState as unknown as Record<string, unknown>
        });
        return {
          decision: "COMPLETE",
          responseText: buildHandoffConfirmation(tripContext),
          status: completed.status as WorkflowStatusLiteral,
          currentStep: completed.currentStep,
          pendingInput: completed.pendingInput,
          state: confirmedState
        };
      }
      if (approval?.status === "REJECTED") {
        await this.workflows.markCancelled({
          organizationId: execution.organizationId,
          id: execution.id,
          expectedRevision: execution.revision,
          state: execution.state as Record<string, unknown>,
          currentStep: "CANCELLED"
        });
        return {
          decision: "CANCELLED",
          responseText: "Your booking request was not approved.",
          status: "CANCELLED",
          currentStep: "CANCELLED",
          pendingInput: null,
          state
        };
      }
    }
    return {
      decision: "ASK_FOR_INPUT",
      responseText: APPROVAL_REQUESTED_MESSAGE,
      status: "WAITING_FOR_APPROVAL",
      currentStep: BOOKING_HANDOFF_STEP_WAITING_FOR_APPROVAL,
      pendingInput: null,
      state
    };
  }

  private async confirmAndRequestApproval(
    execution: WorkflowExecution,
    turnId: string,
    tripContext: BookingHandoffTripContext
  ): Promise<WorkflowTurnResult<BookingHandoffState>> {
    const state = execution.state as unknown as BookingHandoffState;

    if (!this.approvalService) {
      return this.confirmAndCompleteLegacy(execution, turnId, tripContext, state);
    }

    const mutation = await this.workflows.updateWorkflowState({
      organizationId: execution.organizationId,
      id: execution.id,
      expectedRevision: execution.revision,
      currentStep: BOOKING_HANDOFF_STEP_WAITING_FOR_APPROVAL,
      pendingInput: null,
      state: { ...state, confirmed: true } as unknown as Record<string, unknown>,
      turnId
    });

    if (mutation.idempotentReplay) {
      return {
        decision: "REQUEST_APPROVAL",
        responseText: APPROVAL_REQUESTED_MESSAGE,
        status: "WAITING_FOR_APPROVAL",
        currentStep: mutation.execution.currentStep,
        pendingInput: mutation.execution.pendingInput,
        state: mutation.execution.state as unknown as BookingHandoffState
      };
    }

    const approval = await this.approvalService.create({
      organizationId: execution.organizationId,
      workflowExecutionId: execution.id,
      agentId: execution.pluginInstallationId,
      requestedBy: tripContext.originCity ?? "travel-employee",
      title: `Booking approval for ${routeText(tripContext)}`,
      description: `A booking request for ${routeText(tripContext)} requires approval before proceeding.`,
      payload: {
        originCity: tripContext.originCity,
        destinationCity: tripContext.destinationCity,
        travelDates: tripContext.travelDates
      }
    });

    const approvalState: BookingHandoffState = {
      ...state,
      confirmed: true,
      approvalRequestId: approval.id
    };

    await this.workflows.updateWorkflowState({
      organizationId: execution.organizationId,
      id: mutation.execution.id,
      expectedRevision: mutation.execution.revision,
      currentStep: BOOKING_HANDOFF_STEP_WAITING_FOR_APPROVAL,
      pendingInput: null,
      state: approvalState as unknown as Record<string, unknown>,
      turnId: `${turnId}:approval:${approval.id}`
    });

    this.logger.log({
      event: "BOOKING_HANDOFF_APPROVAL_REQUESTED",
      workflowId: execution.id,
      approvalId: approval.id
    });

    return {
      decision: "REQUEST_APPROVAL",
      responseText: APPROVAL_REQUESTED_MESSAGE,
      status: "WAITING_FOR_APPROVAL",
      currentStep: BOOKING_HANDOFF_STEP_WAITING_FOR_APPROVAL,
      pendingInput: null,
      state: approvalState
    };
  }

  private async confirmAndCompleteLegacy(
    execution: WorkflowExecution,
    turnId: string,
    tripContext: BookingHandoffTripContext,
    state: BookingHandoffState
  ): Promise<WorkflowTurnResult<BookingHandoffState>> {
    const confirmedState: BookingHandoffState = { ...state, confirmed: true, readyForFutureWorkflow: true };
    const mutation = await this.workflows.updateWorkflowState({
      organizationId: execution.organizationId,
      id: execution.id,
      expectedRevision: execution.revision,
      currentStep: BOOKING_HANDOFF_STEP_READY_FOR_FUTURE_WORKFLOW,
      pendingInput: null,
      state: confirmedState as unknown as Record<string, unknown>,
      turnId
    });
    if (mutation.idempotentReplay) {
      return {
        decision: "COMPLETE",
        responseText: buildHandoffConfirmation(tripContext),
        status: mutation.execution.status as WorkflowStatusLiteral,
        currentStep: mutation.execution.currentStep,
        pendingInput: mutation.execution.pendingInput,
        state: mutation.execution.state as unknown as BookingHandoffState
      };
    }
    const completed = await this.workflows.markCompleted({
      organizationId: execution.organizationId,
      id: mutation.execution.id,
      expectedRevision: mutation.execution.revision,
      state: confirmedState as unknown as Record<string, unknown>,
      currentStep: BOOKING_HANDOFF_STEP_READY_FOR_FUTURE_WORKFLOW
    });
    return {
      decision: "COMPLETE",
      responseText: buildHandoffConfirmation(tripContext),
      status: completed.status as WorkflowStatusLiteral,
      currentStep: completed.currentStep,
      pendingInput: completed.pendingInput,
      state: confirmedState
    };
  }
}

function routeText(tripContext: BookingHandoffTripContext): string {
  if (tripContext.originCity && tripContext.destinationCity)
    return `${tripContext.originCity} to ${tripContext.destinationCity} trip`;
  if (tripContext.destinationCity) return `${tripContext.destinationCity} trip`;
  return "trip";
}

function confirmationQuestion(tripContext: BookingHandoffTripContext): string {
  return `Would you like me to save a booking request for your ${routeText(tripContext)}? A manager will need to approve this before we proceed. Shall I send it for approval?`;
}

function buildHandoffConfirmation(tripContext: BookingHandoffTripContext): string {
  return `Your booking request for the ${routeText(tripContext)} has been approved and saved.`;
}
