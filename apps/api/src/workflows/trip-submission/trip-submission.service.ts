import { Injectable, Logger } from "@nestjs/common";
import type { TravelLead, WorkflowExecution } from "@prisma/client";
import {
  buildContactRequestMessage,
  buildFarewellMessage,
  buildInvalidPhoneMessage,
  buildLeadCapturedMessage,
  buildPendingContactAcknowledgement,
  buildStandaloneContactConfirmation,
  extractContactValue,
  isBookingConfirmation,
  resolveTravelInput
} from "../../travel/travel.runtime";
import { TravelLeadService } from "../../travel/travel-lead.service";
import {
  WorkflowExecutionRevisionConflictError,
  WorkflowExecutionService
} from "../workflow-execution.service";
import type { WorkflowExecutionScope, WorkflowTurnResult } from "../workflow-runtime.contracts";
import {
  TRAVEL_RUNTIME_OWNED_PENDING_ACTIONS,
  TRIP_SUBMISSION_STEP_AWAITING_CONTACT,
  TRIP_SUBMISSION_STEP_COMPLETED,
  TRIP_SUBMISSION_STEP_CONFIRM_CONTACT_USE,
  emptyTripSubmissionState,
  type TripSubmissionStartSignals,
  type TripSubmissionStartTrigger,
  type TripSubmissionState,
  type TripSubmissionTripContext
} from "./trip-submission.types";

const SAFE_RETRY_MESSAGE =
  "Something went wrong saving your travel request just now. Please try again in a moment — you don't need to repeat your trip details.";

type WorkflowStatusLiteral = WorkflowTurnResult<TripSubmissionState>["status"];

export interface TripSubmissionResumeResult extends WorkflowTurnResult<TripSubmissionState> {
  /** Non-null only the turn the internal lead was actually (freshly) created. */
  leadCreated: TravelLead | null;
}

/**
 * TripSubmissionWorkflowService: Stage 9D's third Pending Workflow Runtime workflow.
 *
 * Reuses Travel Runtime's existing, already-tested contact-arbitration function (`resolveTravelInput`)
 * and localized message builders exactly as the legacy engines did — it never re-implements phone/email
 * validation, decline detection, or message copy. What changes is WHO owns the resulting state
 * transition and lead creation: this service (via WorkflowExecutionService), not Travel Runtime's private
 * `pendingInputAction`/`completionStage` fields.
 */
@Injectable()
export class TripSubmissionWorkflowService {
  private readonly logger = new Logger(TripSubmissionWorkflowService.name);

  constructor(
    private readonly workflows: WorkflowExecutionService,
    private readonly travelLeadService: TravelLeadService
  ) {}

  /**
   * Whether this turn should start TRIP_SUBMISSION, and via which of the two migrated legacy triggers.
   * Never starts while the legacy engine already has its OWN pending contact question in flight for a
   * trigger this stage does not migrate (e.g. the BELOW_MINIMUM-budget contact ask) — that turn is left
   * entirely to Travel Runtime, unchanged.
   */
  shouldStart(text: string, signals: TripSubmissionStartSignals): TripSubmissionStartTrigger {
    if (
      signals.legacyPendingInputAction === "AWAITING_LEAD_CONTACT" ||
      signals.legacyPendingInputAction === "CONFIRM_STANDALONE_CONTACT_USE" ||
      signals.legacyCompletionStage === "AWAITING_CONTACT" ||
      // A lead was already captured for this conversation (by either the legacy engine or a prior
      // TRIP_SUBMISSION completion) — a repeated/international-format phone number re-confirms the SAME
      // reference, it must never start a second confirm-and-submit ask.
      signals.legacyCompletionStage === "CAPTURED" ||
      // Travel Runtime's own booking-options/ticket-contact/resend-ticket flow already owns this turn —
      // see `legacyPendingAction`'s doc comment for why an email/phone reply here must never be read as a
      // standalone volunteered contact.
      (signals.legacyPendingAction !== null && TRAVEL_RUNTIME_OWNED_PENDING_ACTIONS.has(signals.legacyPendingAction))
    )
      return "NONE";
    if (signals.itineraryPresented && isBookingConfirmation(text)) return "CONFIRM_SUBMISSION";
    if (signals.hasActiveTripContext) {
      const resolved = resolveTravelInput(text, { pendingInputAction: null, tripState: signals.tripState });
      if (resolved.kind === "STANDALONE_CONTACT") return "STANDALONE_CONTACT";
    }
    return "NONE";
  }

  /** Starts a new TRIP_SUBMISSION workflow for the given trigger. */
  async start(
    scope: WorkflowExecutionScope,
    turnId: string,
    tripContext: TripSubmissionTripContext,
    trigger: Exclude<TripSubmissionStartTrigger, "NONE">,
    triggeringText: string
  ): Promise<TripSubmissionResumeResult> {
    const baseState: TripSubmissionState = {
      ...emptyTripSubmissionState(),
      originCity: tripContext.entities.originCity,
      destinationCity: tripContext.entities.destinationCity,
      customerName: tripContext.customerName,
      journeyId: tripContext.journeyId,
      triggerReason: trigger
    };

    if (trigger === "STANDALONE_CONTACT") {
      const contact = extractContactValue(triggeringText);
      const state: TripSubmissionState = { ...baseState, contactValue: contact };
      const mutation = await this.workflows.createWorkflow({
        scope,
        currentStep: TRIP_SUBMISSION_STEP_CONFIRM_CONTACT_USE,
        pendingInput: "CONFIRM_CONTACT_USE",
        state: state as unknown as Record<string, unknown>,
        turnId
      });
      return {
        decision: "ASK_FOR_INPUT",
        responseText: buildStandaloneContactConfirmation(tripContext.entities, tripContext.responseLanguage),
        status: mutation.execution.status as WorkflowStatusLiteral,
        currentStep: mutation.execution.currentStep,
        pendingInput: mutation.execution.pendingInput,
        state: mutation.execution.state as unknown as TripSubmissionState,
        leadCreated: null
      };
    }

    // CONFIRM_SUBMISSION: mirrors the legacy `beginOrResumeLeadCapture` shortcut — if the confirming
    // message itself already contains a contact value, submit immediately instead of asking again.
    const immediateContact = extractContactValue(triggeringText);
    if (immediateContact) {
      const created = await this.workflows.createWorkflow({
        scope,
        currentStep: TRIP_SUBMISSION_STEP_AWAITING_CONTACT,
        pendingInput: null,
        state: baseState as unknown as Record<string, unknown>,
        turnId
      });
      return this.finalizeLead(created.execution, immediateContact, tripContext);
    }

    const mutation = await this.workflows.createWorkflow({
      scope,
      currentStep: TRIP_SUBMISSION_STEP_AWAITING_CONTACT,
      pendingInput: "MOBILE_NUMBER",
      state: baseState as unknown as Record<string, unknown>,
      turnId
    });
    return {
      decision: "ASK_FOR_INPUT",
      responseText: buildContactRequestMessage(tripContext.responseLanguage),
      status: mutation.execution.status as WorkflowStatusLiteral,
      currentStep: mutation.execution.currentStep,
      pendingInput: mutation.execution.pendingInput,
      state: mutation.execution.state as unknown as TripSubmissionState,
      leadCreated: null
    };
  }

  /**
   * Stage 9E historical state translation: silently creates a TRIP_SUBMISSION workflow that mirrors a
   * conversation's already-persisted legacy `pendingInputAction`, without asking anything again (the
   * legacy engine's own last response already asked the right question) — used only for a conversation
   * that reached its pending-contact state before the Workflow Signal Engine existed. Never generates a
   * response; the caller resumes the returned execution with the current turn's text immediately after,
   * using its OWN turnId (this method's `turnId` is deliberately distinct — see
   * `WorkflowCoordinator.migrateHistoricalContactState` — so the create step and the immediate resume step
   * are never mistaken for the same idempotent turn). Idempotent/restart-safe via the same `activeKey`
   * uniqueness every workflow start already uses: a second concurrent migration attempt reuses the winner.
   */
  async migrateFromLegacyState(
    scope: WorkflowExecutionScope,
    migrationTurnId: string,
    legacyPendingInputAction: "AWAITING_LEAD_CONTACT" | "CONFIRM_STANDALONE_CONTACT_USE",
    tripContext: TripSubmissionTripContext,
    legacyPendingContactValue: string | null = null
  ): Promise<WorkflowExecution> {
    const isStandaloneConfirm = legacyPendingInputAction === "CONFIRM_STANDALONE_CONTACT_USE";
    const baseState: TripSubmissionState = {
      ...emptyTripSubmissionState(),
      originCity: tripContext.entities.originCity,
      destinationCity: tripContext.entities.destinationCity,
      customerName: tripContext.customerName,
      journeyId: tripContext.journeyId,
      // The volunteered-but-unconfirmed contact value must carry forward, or "yes, use it" has nothing to
      // confirm and would otherwise (correctly, but unhelpfully) defer instead of completing the workflow.
      contactValue: isStandaloneConfirm ? legacyPendingContactValue : null
    };
    const mutation = await this.workflows.createWorkflow({
      scope,
      currentStep: isStandaloneConfirm
        ? TRIP_SUBMISSION_STEP_CONFIRM_CONTACT_USE
        : TRIP_SUBMISSION_STEP_AWAITING_CONTACT,
      pendingInput: isStandaloneConfirm ? "CONFIRM_CONTACT_USE" : "MOBILE_NUMBER",
      state: baseState as unknown as Record<string, unknown>,
      turnId: migrationTurnId
    });
    return mutation.execution;
  }

  /**
   * Stage 9F: cancels an active, still-`WAITING_FOR_INPUT` TRIP_SUBMISSION workflow whose trigger
   * condition no longer holds — specifically, one started by `BELOW_MINIMUM_BUDGET` where a subsequent
   * budget correction (deferred to Travel Runtime, see `resume()`'s `DEFER` branch) resolved the
   * feasibility gap. Never touches a workflow started by an explicit `CONFIRM_SUBMISSION`/
   * `STANDALONE_CONTACT` trigger (a genuine user request to submit, which a budget change must never
   * silently invalidate), never touches one already `COMPLETED`/`CANCELLED`/`FAILED`, and never creates a
   * lead. Best-effort: a revision conflict (a concurrent turn already resolved it) is swallowed, not
   * retried — the caller only cares whether IT needs to keep tracking this workflow as stale.
   */
  async cancelIfBelowMinimumTriggerResolved(execution: WorkflowExecution): Promise<boolean> {
    if (execution.status !== "WAITING_FOR_INPUT") return false;
    const state = execution.state as unknown as TripSubmissionState;
    if (state.triggerReason !== "BELOW_MINIMUM_BUDGET") return false;
    try {
      await this.workflows.markCancelled({
        organizationId: execution.organizationId,
        id: execution.id,
        expectedRevision: execution.revision,
        state: state as unknown as Record<string, unknown>,
        currentStep: "SUPERSEDED_BUDGET_CORRECTED"
      });
      this.logger.log({
        event: "TRIP_SUBMISSION_SUPERSEDED_BY_CORRECTION",
        workflowId: execution.id
      });
      return true;
    } catch (error) {
      if (error instanceof WorkflowExecutionRevisionConflictError) return false;
      this.logger.warn({
        event: "TRIP_SUBMISSION_SUPERSEDE_FAILED",
        workflowId: execution.id,
        error: error instanceof Error ? error.message : "unknown"
      });
      return false;
    }
  }

  /**
   * Fix (Travel Booking UAT correction pass): supersedes an active, still-`WAITING_FOR_INPUT`
   * TRIP_SUBMISSION workflow the instant Travel Runtime's own booking flow (option selection, passenger
   * details, ticket-contact, booking confirmation, resend-ticket) has taken over the conversation —
   * regardless of what originally triggered this workflow. `shouldStart` already refuses to START a new
   * TRIP_SUBMISSION while Travel Runtime owns the turn (see `TRAVEL_RUNTIME_OWNED_PENDING_ACTIONS`); this
   * is the matching guard for one that is ALREADY active. Without this, `WorkflowCoordinator.dispatchTurn`
   * gives a `WAITING_FOR_INPUT` workflow absolute per-turn priority, so a reply meant for Travel Runtime's
   * own newer pending question (e.g. "skip" answering "reply skip to download from chat instead") would
   * instead be consumed by THIS workflow's stale contact question via `resume()`'s `resolveTravelInput`
   * call — "skip" matches the shared negative-response vocabulary, producing a false decline and an
   * unwanted farewell/cancellation. Never creates a lead. Best-effort: a revision conflict from a
   * concurrent turn is swallowed, not retried.
   */
  async supersedeIfOwnedByTravelRuntime(
    execution: WorkflowExecution,
    legacyPendingAction: string | null
  ): Promise<boolean> {
    if (execution.status !== "WAITING_FOR_INPUT") return false;
    if (legacyPendingAction === null || !TRAVEL_RUNTIME_OWNED_PENDING_ACTIONS.has(legacyPendingAction))
      return false;
    const state = execution.state as unknown as TripSubmissionState;
    try {
      await this.workflows.markCancelled({
        organizationId: execution.organizationId,
        id: execution.id,
        expectedRevision: execution.revision,
        state: state as unknown as Record<string, unknown>,
        currentStep: "SUPERSEDED_BOOKING_PROGRESSED"
      });
      this.logger.log({
        event: "TRIP_SUBMISSION_SUPERSEDED_BY_BOOKING_PROGRESS",
        workflowId: execution.id
      });
      return true;
    } catch (error) {
      if (error instanceof WorkflowExecutionRevisionConflictError) return false;
      this.logger.warn({
        event: "TRIP_SUBMISSION_SUPERSEDE_FAILED",
        workflowId: execution.id,
        error: error instanceof Error ? error.message : "unknown"
      });
      return false;
    }
  }

  /** Resumes an active TRIP_SUBMISSION workflow with the current turn's text. Never throws. */
  async resume(
    execution: WorkflowExecution,
    text: string,
    turnId: string,
    tripContext: TripSubmissionTripContext
  ): Promise<TripSubmissionResumeResult> {
    const state = execution.state as unknown as TripSubmissionState;
    const legacyPendingInputAction =
      execution.pendingInput === "CONFIRM_CONTACT_USE" ? "CONFIRM_STANDALONE_CONTACT_USE" : "AWAITING_LEAD_CONTACT";

    try {
      const resolved = resolveTravelInput(text, {
        pendingInputAction: legacyPendingInputAction,
        pendingContactValue: state.contactValue,
        tripState: tripContext.entities
      });

      switch (resolved.kind) {
        case "PENDING_CONTACT":
        case "STANDALONE_CONTACT_CONFIRMED":
          return this.finalizeLead(execution, resolved.contact, tripContext, turnId);

        case "INVALID_CONTACT_ATTEMPT":
          return this.askAgain(execution, buildInvalidPhoneMessage(tripContext.responseLanguage), state);

        case "PENDING_CONTACT_NON_CONTACT":
          return this.askAgain(execution, buildPendingContactAcknowledgement(tripContext.responseLanguage), state);

        case "PENDING_CONTACT_PAUSED":
        case "STANDALONE_CONTACT_DECLINED":
          return this.decline(execution, tripContext);

        default:
          // Stage 9E.1: anything else (a date/passenger/budget correction, an unrelated semantic
          // question) does not answer the pending contact question, but it is not necessarily nonsense
          // either — defer it to the normal agent pipeline for this turn only (never silently drop the
          // workflow, never misroute it as a contact reply). The workflow makes no state change and stays
          // exactly WAITING_FOR_INPUT; the next turn that actually answers the pending question resumes
          // it normally. See WorkflowCoordinator.resume for how a DEFER decision is dispatched.
          return this.defer(execution, state);
      }
    } catch (error) {
      if (error instanceof WorkflowExecutionRevisionConflictError) {
        this.logger.warn({ event: "TRIP_SUBMISSION_REVISION_CONFLICT", workflowId: execution.id });
      } else {
        this.logger.error({
          event: "TRIP_SUBMISSION_PERSISTENCE_FAILED",
          workflowId: execution.id,
          error: error instanceof Error ? error.message : "unknown"
        });
      }
      return {
        decision: "FAIL",
        responseText: SAFE_RETRY_MESSAGE,
        status: "WAITING_FOR_INPUT",
        currentStep: execution.currentStep,
        pendingInput: execution.pendingInput,
        state,
        leadCreated: null
      };
    }
  }

  private askAgain(
    execution: WorkflowExecution,
    responseText: string,
    state: TripSubmissionState
  ): TripSubmissionResumeResult {
    return {
      decision: "ASK_FOR_INPUT",
      responseText,
      status: "WAITING_FOR_INPUT",
      currentStep: execution.currentStep,
      pendingInput: execution.pendingInput,
      state,
      leadCreated: null
    };
  }

  /** Stage 9E.1: makes no persistence call and no state change at all — the workflow stays exactly as it
   *  was, `WorkflowCoordinator.resume` translates this into "not handled" for this turn only. */
  private defer(execution: WorkflowExecution, state: TripSubmissionState): TripSubmissionResumeResult {
    return {
      decision: "DEFER",
      responseText: null,
      status: "WAITING_FOR_INPUT",
      currentStep: execution.currentStep,
      pendingInput: execution.pendingInput,
      state,
      leadCreated: null
    };
  }

  private async decline(
    execution: WorkflowExecution,
    tripContext: TripSubmissionTripContext
  ): Promise<TripSubmissionResumeResult> {
    const state = execution.state as unknown as TripSubmissionState;
    try {
      const cancelled = await this.workflows.markCancelled({
        organizationId: execution.organizationId,
        id: execution.id,
        expectedRevision: execution.revision,
        state: state as unknown as Record<string, unknown>
      });
      return {
        decision: "CANCELLED",
        responseText: buildFarewellMessage(tripContext.customerName, tripContext.responseLanguage),
        status: cancelled.status as WorkflowStatusLiteral,
        currentStep: cancelled.currentStep,
        pendingInput: cancelled.pendingInput,
        state,
        leadCreated: null
      };
    } catch {
      return this.askAgain(execution, SAFE_RETRY_MESSAGE, state);
    }
  }

  /**
   * Creates (or idempotently reuses) the internal lead and completes the workflow. Called either from
   * `resume()` (an existing WAITING_FOR_INPUT execution, turnId-guarded two-phase) or from `start()`'s
   * immediate-contact shortcut (a freshly created, never-yet-completed execution — no turnId dedup
   * needed since it cannot have been completed before this call).
   */
  private async finalizeLead(
    execution: WorkflowExecution,
    contact: string,
    tripContext: TripSubmissionTripContext,
    turnId?: string
  ): Promise<TripSubmissionResumeResult> {
    const state = execution.state as unknown as TripSubmissionState;
    const updatedState: TripSubmissionState = { ...state, contactValue: contact };

    let target = execution;
    if (turnId) {
      const mutation = await this.workflows.updateWorkflowState({
        organizationId: execution.organizationId,
        id: execution.id,
        expectedRevision: execution.revision,
        currentStep: TRIP_SUBMISSION_STEP_COMPLETED,
        pendingInput: null,
        state: updatedState as unknown as Record<string, unknown>,
        turnId
      });
      if (mutation.idempotentReplay) {
        const replayState = mutation.execution.state as unknown as TripSubmissionState;
        return {
          decision: replayState.leadId ? "COMPLETE" : "ASK_FOR_INPUT",
          responseText: replayState.leadId
            ? buildLeadCapturedMessage(
                replayState.customerName,
                replayState.leadReference ?? "",
                tripContext.responseLanguage
              )
            : buildContactRequestMessage(tripContext.responseLanguage),
          status: mutation.execution.status as WorkflowStatusLiteral,
          currentStep: mutation.execution.currentStep,
          pendingInput: mutation.execution.pendingInput,
          state: replayState,
          leadCreated: null
        };
      }
      target = mutation.execution;
    }

    const lead = await this.travelLeadService.createInternalLead({
      organizationId: target.organizationId,
      pluginInstallationId: target.pluginInstallationId,
      conversationId: target.conversationId,
      journeyId: updatedState.journeyId,
      customerName: updatedState.customerName,
      phoneNumber: contact,
      departureCity: tripContext.entities.originCity,
      destination: tripContext.entities.destinationCity,
      travelDates: tripContext.travelDates,
      passengers: tripContext.passengers,
      tripPurpose: tripContext.tripPurpose,
      budgetAmount: tripContext.budgetAmount,
      budgetCurrency: tripContext.budgetCurrency,
      displayCurrency: tripContext.displayCurrency,
      conversationSummary: buildConversationSummary(tripContext)
    });

    const finalState: TripSubmissionState = { ...updatedState, leadId: lead.id, leadReference: lead.reference };
    const completed = await this.workflows.markCompleted({
      organizationId: target.organizationId,
      id: target.id,
      expectedRevision: target.revision,
      state: finalState as unknown as Record<string, unknown>,
      currentStep: TRIP_SUBMISSION_STEP_COMPLETED
    });

    return {
      decision: "COMPLETE",
      responseText: buildLeadCapturedMessage(finalState.customerName, lead.reference, tripContext.responseLanguage),
      status: completed.status as WorkflowStatusLiteral,
      currentStep: completed.currentStep,
      pendingInput: completed.pendingInput,
      state: finalState,
      leadCreated: lead
    };
  }
}

function buildConversationSummary(tripContext: TripSubmissionTripContext): string {
  const { originCity, destinationCity } = tripContext.entities;
  const route = originCity && destinationCity ? `${originCity} to ${destinationCity}` : (destinationCity ?? "their trip");
  return `Travel request submitted for ${route} trip.`;
}
