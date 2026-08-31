import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { WorkflowExecution } from "@prisma/client";
import { BookingHandoffWorkflowService } from "./booking-handoff/booking-handoff.service";
import type { BookingHandoffTripContext } from "./booking-handoff/booking-handoff.types";
import { ContactCaptureWorkflowService } from "./contact-capture/contact-capture.service";
import { TripSubmissionWorkflowService } from "./trip-submission/trip-submission.service";
import { WorkflowExecutionService } from "./workflow-execution.service";
import type {
  WorkflowDispatchOutcome,
  WorkflowDispatchSignals,
  WorkflowExecutionScope,
  WorkflowType
} from "./workflow-runtime.contracts";
import {
  buildDefaultWorkflowSignalProviders,
  buildWorkflowSignalRegistry,
  WORKFLOW_SIGNAL_PROVIDERS,
  type WorkflowSignalProvider,
  type WorkflowSignalRegistry
} from "./workflow-signal-registry";
import { WorkflowSignalEngine } from "./workflow-signal-engine";
import type { WorkflowSignal } from "./workflow-signal.contracts";
import { ApprovalService, type ApprovalRequestData } from "../approval/approval.service";

/**
 * Stage 9C/9E/9E.1: WorkflowCoordinator — the single place that decides which (if any) durable workflow
 * owns the current turn, applies the cross-type priority/conflict rules, and detects cancellation. It
 * never validates or persists workflow-specific business data itself (no phone validation, no lead
 * creation, no booking-confirmation wording) — those responsibilities stay in
 * ContactCaptureWorkflowService / BookingHandoffWorkflowService / TripSubmissionWorkflowService exactly as
 * before; this class only routes.
 *
 * Stage 9E: this class also no longer evaluates "should a new workflow start from this turn's free text"
 * itself — that evaluation moved to `WorkflowSignalEngine`. This class only ever resolves an already-typed
 * `WorkflowSignal` against `WorkflowSignalRegistry` and dispatches it (`dispatchSignal`), which is now the
 * single workflow-start entry point for every workflow type, including `BOOKING_HANDOFF` (previously its
 * own bespoke `startBookingHandoff` code path) and the BELOW_MINIMUM-budget `TRIP_SUBMISSION` trigger
 * (previously a private Travel Runtime `pendingInputAction` transition). Adding a workflow type's start
 * trigger means changing `WorkflowSignalEngine`/`workflow-signal-registry.ts`, never this file.
 *
 * Stage 9E.1: the START-time registry is now DI-pluggable — an optional `WORKFLOW_SIGNAL_PROVIDERS`
 * injection supplies the `WorkflowSignalProvider[]` this class builds its registry from, so a future
 * module can contribute a signal handler without this file importing its service. When nothing is
 * injected (every existing test that constructs this class directly with 4 args), it falls back to
 * building the same default registry as before — this class's own imports of the three concrete workflow
 * services remain only for RESUME/CANCEL dispatch (a distinct, still per-type-coupled concern — see
 * `resume()` below and `ARCHITECTURE.md`), not for starting workflows.
 *
 * Priority model for a turn where at least one workflow already exists for the conversation:
 *   1. A workflow WAITING_FOR_INPUT owns the turn — it is never bypassed to start a different workflow.
 *   2. Within that owned turn, an explicit cancellation phrase takes precedence over resuming normally.
 *   3. Otherwise the owning workflow's own resume() decides (which may complete it, or DEFER it — see
 *      `dispatchResumeResult`).
 *   4. Only when nothing is active/waiting can a new workflow start, via a signal.
 * This guarantees two workflows are never processed for the same turn, and an active workflow's state is
 * never silently overwritten.
 */
const CANCELLATION_PATTERN = /^\s*(?:cancel|stop|never\s*mind|nevermind)\s*[.!]?\s*$/i;
const DO_NOT_CONTACT_PATTERN = /\bdon'?t\s+contact\s+me\b|\bdo\s+not\s+contact\s+me\b/i;

export function detectWorkflowCancellationPhrase(text: string): boolean {
  return CANCELLATION_PATTERN.test(text.trim()) || DO_NOT_CONTACT_PATTERN.test(text);
}

export type { WorkflowDispatchOutcome, WorkflowDispatchSignals };

const NOT_HANDLED: WorkflowDispatchOutcome = {
  handled: false,
  workflowType: null,
  decision: "NOT_APPLICABLE",
  responseText: null,
  leadCreated: null
};

const LEGACY_CONTACT_PENDING_ACTIONS = new Set(["AWAITING_LEAD_CONTACT", "CONFIRM_STANDALONE_CONTACT_USE"]);

@Injectable()
export class WorkflowCoordinator {
  private readonly logger = new Logger(WorkflowCoordinator.name);
  private readonly signalEngine: WorkflowSignalEngine;
  private readonly signalRegistry: WorkflowSignalRegistry;

  constructor(
    private readonly workflows: WorkflowExecutionService,
    private readonly contactCapture: ContactCaptureWorkflowService,
    private readonly bookingHandoff: BookingHandoffWorkflowService,
    private readonly tripSubmission: TripSubmissionWorkflowService,
    @Optional() private readonly approvalService?: ApprovalService,
    @Optional() @Inject(WORKFLOW_SIGNAL_PROVIDERS) signalProviders?: readonly WorkflowSignalProvider[]
  ) {
    this.signalEngine = new WorkflowSignalEngine(contactCapture, tripSubmission);
    this.signalRegistry = buildWorkflowSignalRegistry(
      signalProviders ?? buildDefaultWorkflowSignalProviders(contactCapture, bookingHandoff, tripSubmission)
    );
  }

  /**
   * Per-turn dispatch. Must be called before intent classification/RAG/live-search/capability selection
   * for every Travel Employee turn (see AgentService.execute). Returns `handled: false` when no workflow
   * owns this turn and nothing started — the caller falls through to the legacy pipeline unchanged.
   */
  async dispatchTurn(
    scope: Omit<WorkflowExecutionScope, "workflowType">,
    text: string,
    turnId: string,
    signals: WorkflowDispatchSignals
  ): Promise<WorkflowDispatchOutcome> {
    const active = await this.workflows.findActiveWorkflowsForConversation(
      scope.organizationId,
      scope.pluginInstallationId,
      scope.conversationId
    );
    // WAITING_FOR_APPROVAL is included alongside WAITING_FOR_INPUT: BookingHandoffWorkflowService.resume()
    // already has an explicit branch for it (`handleApprovalResume`, which polls ApprovalService on each
    // turn — the pull-based approval-resume design) but it was unreachable without this, since a workflow
    // sitting at WAITING_FOR_APPROVAL (set only by BookingHandoffWorkflowService.confirmAndRequestApproval
    // today — CONTACT_CAPTURE/TRIP_SUBMISSION never reach this status, see WorkflowCoordinator.
    // requestApproval's own dead-code note) would otherwise never be picked up here: `active.length > 0`
    // would return NOT_HANDLED before resume() — and thus handleApprovalResume — was ever called, silently
    // stranding every approved booking without ever executing it.
    let waiting =
      active.find(
        (execution) => execution.status === "WAITING_FOR_INPUT" || execution.status === "WAITING_FOR_APPROVAL"
      ) ?? null;

    // Stage 9E historical state translation: a conversation that reached its pending-contact state before
    // the Workflow Signal Engine existed has no WorkflowExecution row yet, only legacy persisted memory.
    // Translate it into one now, deterministically and idempotently, before deciding who owns this turn.
    if (!waiting && active.length === 0) {
      waiting = await this.migrateHistoricalContactState(scope, turnId, signals);
    }

    // Fix (Travel Booking UAT correction pass): a TRIP_SUBMISSION workflow left WAITING_FOR_INPUT (e.g. a
    // BELOW_MINIMUM-budget lead-capture offer the customer never answered) must never keep absolute
    // per-turn priority once Travel Runtime's own booking flow has moved past it — otherwise a reply meant
    // for Travel Runtime's newer pending question (an option number, passenger details, "skip" answering
    // its own ticket-delivery ask) gets misread as an answer to this stale one. See
    // TripSubmissionWorkflowService.supersedeIfOwnedByTravelRuntime.
    if (waiting && waiting.workflowType === "TRIP_SUBMISSION") {
      const superseded = await this.tripSubmission.supersedeIfOwnedByTravelRuntime(
        waiting,
        signals.tripSubmission.legacyPendingAction
      );
      if (superseded) waiting = null;
    }

    if (waiting) {
      if (detectWorkflowCancellationPhrase(text)) return this.cancel(waiting);
      return this.resume(waiting, text, turnId, signals);
    }

    if (active.length > 0) return NOT_HANDLED;

    // Nothing is waiting for input — safe to consider starting a new workflow from this turn's text.
    const signal = this.signalEngine.deriveSignal(text, signals, turnId);
    const outcome = await this.dispatchSignal(scope, signal, turnId, signals, text);
    return outcome ?? NOT_HANDLED;
  }

  /**
   * Stage 9E: the single generic entry point for starting a workflow from an already-typed `WorkflowSignal`
   * — used both by `dispatchTurn`'s free-text signal derivation above and by any caller that already knows
   * a workflow should start from typed data it computed itself (a READY_FOR_BOOKING capability decision, or
   * Travel Runtime's own BELOW_MINIMUM-budget business result — see `startBookingHandoff` and
   * `AgentService`'s post-turn signal check). Returns null (defer to the caller's existing fallback) when
   * the signal is `NONE`, no handler is registered for it, or a workflow already exists for this
   * conversation — never silently overwriting an active/waiting workflow. `dispatchSignals` is null for
   * signal types whose handler needs no per-turn Travel context (e.g. START_BOOKING_HANDOFF, which carries
   * everything it needs in the signal's own payload).
   */
  async dispatchSignal(
    scope: Omit<WorkflowExecutionScope, "workflowType">,
    signal: WorkflowSignal,
    turnId: string,
    dispatchSignals: WorkflowDispatchSignals | null = null,
    text = ""
  ): Promise<WorkflowDispatchOutcome | null> {
    if (signal.signalType === "NONE") return null;
    const active = await this.workflows.findActiveWorkflowsForConversation(
      scope.organizationId,
      scope.pluginInstallationId,
      scope.conversationId
    );
    if (active.length > 0) return null;

    const handler = this.signalRegistry.resolve(signal.signalType);
    if (!handler) {
      // Stage 9E.1: a real signal fired but nothing is registered to handle it — a configuration bug
      // (missing provider registration), never treated as "no signal". Logged loudly rather than silently
      // falling through to the normal pipeline/LLM as if this signal had never fired.
      this.logger.warn({
        event: "WORKFLOW_SIGNAL_HANDLER_MISSING",
        conversationId: scope.conversationId,
        signalType: signal.signalType
      });
      return null;
    }

    const outcome = await handler(scope, signal, turnId, dispatchSignals, text);
    this.logger.log({
      event: "WORKFLOW_STARTED",
      conversationId: scope.conversationId,
      workflowType: signal.workflowType,
      sourceCapability: signal.source
    });
    return outcome;
  }

  /**
   * Typed entry point for starting BOOKING_HANDOFF from a READY_FOR_BOOKING capability decision — never
   * derived by parsing response text. Thin wrapper over `dispatchSignal`, kept for AgentService's existing
   * call site; the actual dispatch mechanism is now the same one every workflow type uses.
   */
  async startBookingHandoff(
    scope: Omit<WorkflowExecutionScope, "workflowType">,
    turnId: string,
    tripContext: BookingHandoffTripContext
  ): Promise<WorkflowDispatchOutcome | null> {
    const signal: WorkflowSignal = {
      signalType: "START_BOOKING_HANDOFF",
      workflowType: "BOOKING_HANDOFF",
      source: "BOOKING_READY_CAPABILITY",
      sourceTurnId: turnId,
      sourceSkillExecutionId: tripContext.skillExecutionId,
      payload: { tripContext },
      confidence: 1
    };
    return this.dispatchSignal(scope, signal, turnId, null);
  }

  /**
   * Stage 9F: the smallest domain-level integration point for "Workflow Trigger Re-evaluation" — called
   * by `AgentService` once per turn where Travel Runtime recomputed budget feasibility (deferred
   * corrections included). If an active `TRIP_SUBMISSION` workflow exists for this conversation and its
   * OWN recorded trigger was `BELOW_MINIMUM_BUDGET` (never one started by an explicit confirm/standalone-
   * contact request), and this turn's feasibility is no longer `BELOW_MINIMUM`, the workflow is cancelled
   * (`SUPERSEDED_BUDGET_CORRECTED`) rather than left demanding contact for a condition that no longer
   * holds. Returns whether a workflow was actually cancelled. Never creates a duplicate workflow, never
   * touches a workflow of any other type or trigger.
   */
  async reevaluateBelowMinimumTrigger(
    scope: Omit<WorkflowExecutionScope, "workflowType">,
    stillBelowMinimum: boolean
  ): Promise<boolean> {
    if (stillBelowMinimum) return false;
    const active = await this.workflows.findActiveWorkflowsForConversation(
      scope.organizationId,
      scope.pluginInstallationId,
      scope.conversationId
    );
    const tripSubmissionExecution = active.find((execution) => execution.workflowType === "TRIP_SUBMISSION");
    if (!tripSubmissionExecution) return false;
    return this.tripSubmission.cancelIfBelowMinimumTriggerResolved(tripSubmissionExecution);
  }

  /**
   * Sprint 4.4: pauses an active workflow for human approval. Creates an ApprovalRequest record and
   * transitions the workflow to WAITING_FOR_APPROVAL. The workflow stays in this state until an
   * approver approves or rejects via the API. Returns the created ApprovalRequest data.
   */
  async requestApproval(
    scope: Omit<WorkflowExecutionScope, "workflowType">,
    execution: WorkflowExecution,
    input: {
      agentId: string;
      requestedBy: string;
      title: string;
      description: string;
      payload?: Record<string, unknown>;
    }
  ): Promise<ApprovalRequestData> {
    if (!this.approvalService) throw new Error("ApprovalService not available");
    const approval = await this.approvalService.create({
      organizationId: scope.organizationId,
      workflowExecutionId: execution.id,
      agentId: input.agentId,
      actionType: execution.workflowType,
      requestedBy: input.requestedBy,
      title: input.title,
      description: input.description,
      payload: input.payload ?? {}
    });
    await this.workflows.updateWorkflowState({
      organizationId: scope.organizationId,
      id: execution.id,
      expectedRevision: execution.revision,
      currentStep: (execution as unknown as Record<string, unknown>).currentStep as string ?? "AWAITING_APPROVAL",
      pendingInput: null,
      state: { ...(execution.state as Record<string, unknown>), approvalRequestId: approval.id },
      turnId: `${execution.id}:approval:${approval.id}`
    });
    this.logger.log({
      event: "WORKFLOW_PAUSED_FOR_APPROVAL",
      workflowId: execution.id,
      approvalId: approval.id
    });
    return approval;
  }

  /**
   * Sprint 4.4: handles an approval decision — finds the workflow by approval request ID embedded in its
   * state and resumes (on APPROVED) or cancels (on REJECTED). The workflow's own resume() handles the
   * actual state transition; this method is the external trigger that sets the approval outcome.
   */
  /**
   * Sprint 4.4: handles an external approval decision on a paused workflow. On APPROVED, the workflow
   * transitions back to WAITING_FOR_INPUT so the next turn's dispatch picks it up via resume() — the
   * booking handoff's own resume() checks the pendingInput "APPROVED" and completes the workflow. On
   * REJECTED, the workflow is cancelled permanently.
   */
  async handleApprovalDecision(
    organizationId: string,
    workflowExecutionId: string,
    decision: "APPROVED" | "REJECTED"
  ): Promise<void> {
    const workflow = await this.workflows.loadWorkflow(organizationId, workflowExecutionId);
    if (!workflow) {
      this.logger.warn({ event: "APPROVAL_WORKFLOW_NOT_FOUND", workflowExecutionId, organizationId });
      return;
    }
    if (decision === "APPROVED") {
      await this.workflows.updateWorkflowState({
        organizationId,
        id: workflow.id,
        expectedRevision: workflow.revision,
        currentStep: workflow.currentStep,
        pendingInput: "APPROVED",
        state: workflow.state as Record<string, unknown>,
        turnId: `${workflow.id}:approval-approved`
      });
      this.logger.log({ event: "WORKFLOW_RESUMED_AFTER_APPROVAL", workflowId: workflow.id });
    } else {
      await this.workflows.markCancelled({
        organizationId,
        id: workflow.id,
        expectedRevision: workflow.revision,
        state: workflow.state as Record<string, unknown>,
        currentStep: "REJECTED_AFTER_APPROVAL"
      });
      this.logger.log({ event: "WORKFLOW_CANCELLED_AFTER_APPROVAL_REJECTION", workflowId: workflow.id });
    }
  }

  /**
   * Stage 9E: translates a conversation's already-persisted legacy `pendingInputAction` contact state
   * (`AWAITING_LEAD_CONTACT` / `CONFIRM_STANDALONE_CONTACT_USE`) into a real TRIP_SUBMISSION
   * `WorkflowExecution`, silently — no response text, since the legacy engine's own last turn already
   * asked the right question. Deterministic (driven only by already-persisted memory, never by
   * conversation history re-parsing), idempotent, and restart-safe: `TripSubmissionWorkflowService`'s
   * `createWorkflow` call underneath uses the same `activeKey` uniqueness as every workflow start, so a
   * second concurrent migration attempt reuses the winner instead of creating a duplicate. Uses a
   * migration-specific turnId (never the caller's own `turnId`) so the immediate `resume()` this returns
   * into is never mistaken for an idempotent replay of the create step.
   */
  private async migrateHistoricalContactState(
    scope: Omit<WorkflowExecutionScope, "workflowType">,
    turnId: string,
    signals: WorkflowDispatchSignals
  ): Promise<WorkflowExecution | null> {
    const legacyPendingInputAction = signals.tripSubmission.legacyPendingInputAction;
    const needsMigration =
      (legacyPendingInputAction !== null && LEGACY_CONTACT_PENDING_ACTIONS.has(legacyPendingInputAction)) ||
      signals.tripSubmission.legacyCompletionStage === "AWAITING_CONTACT";
    if (!needsMigration) return null;

    const tripSubmissionScope: WorkflowExecutionScope = { ...scope, workflowType: "TRIP_SUBMISSION" };
    const resolvedTrigger =
      legacyPendingInputAction === "CONFIRM_STANDALONE_CONTACT_USE"
        ? "CONFIRM_STANDALONE_CONTACT_USE"
        : "AWAITING_LEAD_CONTACT";
    try {
      const migrated = await this.tripSubmission.migrateFromLegacyState(
        tripSubmissionScope,
        `${turnId}:historical-migration`,
        resolvedTrigger,
        signals.tripSubmissionTripContext,
        signals.tripSubmission.legacyPendingContactValue
      );
      this.logger.log({
        event: "WORKFLOW_HISTORICAL_STATE_MIGRATED",
        conversationId: scope.conversationId,
        workflowType: "TRIP_SUBMISSION",
        legacyPendingInputAction
      });
      return migrated;
    } catch (error) {
      this.logger.warn({
        event: "WORKFLOW_HISTORICAL_MIGRATION_FAILED",
        conversationId: scope.conversationId,
        error: error instanceof Error ? error.message : "unknown"
      });
      return null;
    }
  }

  private async resume(
    execution: WorkflowExecution,
    text: string,
    turnId: string,
    signals: WorkflowDispatchSignals
  ): Promise<WorkflowDispatchOutcome> {
    if (execution.workflowType === "CONTACT_CAPTURE") {
      const result = await this.contactCapture.resume(
        execution,
        text,
        turnId,
        signals.contactCaptureTripContext
      );
      return this.dispatchResumeResult("CONTACT_CAPTURE", result.decision, result.responseText, result.leadCreated);
    }

    if (execution.workflowType === "TRIP_SUBMISSION") {
      const result = await this.tripSubmission.resume(
        execution,
        text,
        turnId,
        signals.tripSubmissionTripContext
      );
      return this.dispatchResumeResult("TRIP_SUBMISSION", result.decision, result.responseText, result.leadCreated);
    }

    const result = await this.bookingHandoff.resume(execution, text, turnId, signals.bookingHandoffTripContext);
    const outcome = this.dispatchResumeResult("BOOKING_HANDOFF", result.decision, result.responseText, null);
    if (outcome.handled && result.state.ticketReady && result.state.bookingId)
      outcome.bookingId = result.state.bookingId;
    return outcome;
  }

  /**
   * Stage 9E.1: a generic translation shared by every workflow type's `resume()` result — `DEFER` means
   * the workflow made no state change and has nothing to say this turn (an unrelated semantic detour); the
   * turn is reported as NOT handled so the caller falls through to the normal agent pipeline for this turn
   * only, while the workflow itself remains untouched (still `WAITING_FOR_INPUT`, ready to resume later).
   * Every other decision is reported as handled, exactly as before this stage.
   */
  private dispatchResumeResult(
    workflowType: WorkflowType,
    decision: WorkflowDispatchOutcome["decision"],
    responseText: string | null,
    leadCreated: WorkflowDispatchOutcome["leadCreated"]
  ): WorkflowDispatchOutcome {
    if (decision === "DEFER") return NOT_HANDLED;
    if (decision === "REQUEST_APPROVAL") {
      return { handled: true, workflowType, decision, responseText, leadCreated };
    }
    return { handled: true, workflowType, decision, responseText, leadCreated };
  }

  private async cancel(execution: WorkflowExecution): Promise<WorkflowDispatchOutcome> {
    try {
      await this.workflows.markCancelled({
        organizationId: execution.organizationId,
        id: execution.id,
        expectedRevision: execution.revision,
        state: execution.state as Record<string, unknown>
      });
    } catch (error) {
      this.logger.warn({
        event: "WORKFLOW_CANCEL_FAILED",
        workflowId: execution.id,
        error: error instanceof Error ? error.message : "unknown"
      });
    }
    const workflowType = execution.workflowType as WorkflowType;
    this.logger.log({ event: "WORKFLOW_CANCELLED", workflowId: execution.id, workflowType });
    return {
      handled: true,
      workflowType,
      decision: "CANCELLED",
      responseText: cancellationConfirmation(workflowType),
      leadCreated: null
    };
  }
}

function cancellationConfirmation(workflowType: WorkflowType): string {
  if (workflowType === "CONTACT_CAPTURE")
    return "No problem — I won't ask for your contact details. Let me know if you'd like help with anything else for your trip.";
  if (workflowType === "TRIP_SUBMISSION")
    return "No problem — I won't submit the travel request. Let me know if you'd like help with anything else for your trip.";
  return "No problem — I won't save a booking request. Let me know if you'd like help with anything else for your trip.";
}
