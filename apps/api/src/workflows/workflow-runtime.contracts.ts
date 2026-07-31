import type { TravelLead } from "@prisma/client";
import type {
  ContactCaptureStartSignals,
  ContactCaptureTripContext
} from "./contact-capture/contact-capture.types";
import type { BookingHandoffTripContext } from "./booking-handoff/booking-handoff.types";
import type {
  TripSubmissionStartSignals,
  TripSubmissionTripContext
} from "./trip-submission/trip-submission.types";

/**
 * Stage 9B: typed contracts for the reusable Pending Workflow Runtime.
 *
 * A "workflow" here is a durable, multi-turn business process (Contact Capture is the first) that must
 * resume before intent classification, RAG routing, live-search routing, or Skill Runtime capability
 * selection — see `WorkflowExecutionService` (persistence) and `AgentService.execute` (routing order).
 *
 * Consistent with the existing SkillExecution architecture (Stage 8): typed status/decision enums, an
 * optimistic-locking `revision`, idempotent `processedTurnIds`, and an `activeKey` uniqueness constraint
 * for "one active workflow per conversation+type".
 */

export type WorkflowType = "CONTACT_CAPTURE" | "BOOKING_HANDOFF" | "TRIP_SUBMISSION";

export type WorkflowStatus = "ACTIVE" | "WAITING_FOR_INPUT" | "WAITING_FOR_APPROVAL" | "COMPLETED" | "FAILED" | "CANCELLED";

/** What a workflow runtime decided to do with the current turn. Never a free-form status string.
 *  Stage 9E.1: `DEFER` means the workflow recognized this turn is NOT an answer to its own pending
 *  question (an unrelated semantic detour, e.g. a policy question asked while awaiting a phone number) —
 *  the workflow makes NO state change and returns no response text; the turn is handed back to the normal
 *  agent pipeline (Skill Runtime / Knowledge / Capability Execution / Travel Runtime) for this turn only,
 *  and the workflow remains exactly as `WAITING_FOR_INPUT` as it was, ready to resume on a later turn that
 *  actually answers its pending question. See `WorkflowCoordinator.resume` for how this is dispatched. */
export type WorkflowResumeDecision =
  | "ASK_FOR_INPUT"
  | "CONTINUE"
  | "COMPLETE"
  | "FAIL"
  | "CANCELLED"
  | "DEFER"
  | "REQUEST_APPROVAL"
  | "NOT_APPLICABLE";

export interface WorkflowExecutionScope {
  organizationId: string;
  pluginInstallationId: string;
  conversationId: string;
  workflowType: WorkflowType;
}

/** The result of processing one turn against a workflow, independent of which workflow type it is. */
export interface WorkflowTurnResult<TState> {
  decision: WorkflowResumeDecision;
  /** The exact text to return to the user, or null when the workflow did not handle this turn. */
  responseText: string | null;
  status: WorkflowStatus;
  currentStep: string;
  pendingInput: string | null;
  state: TState;
}

/**
 * Stage 9C: what triggered a workflow to start, expressed as typed data — never derived by parsing the
 * assistant's generated response text. A callback-menu selection, a natural-language callback phrase, and
 * a READY_FOR_BOOKING capability decision are all distinct, named sources; "starting a workflow" always
 * means constructing one of these and handing it to WorkflowCoordinator.startWorkflow, never inferring
 * intent from response text after the fact.
 */
export type WorkflowStartSource =
  | "CALLBACK_MENU_SELECTION"
  | "CALLBACK_INTENT_PHRASE"
  | "PROVIDER_FAILURE_RECOVERY"
  | "BOOKING_READY_CAPABILITY"
  | "TRIP_SUBMISSION_CONFIRMATION"
  | "STANDALONE_CONTACT_VOLUNTEERED"
  /** Stage 9E: Travel Runtime's own BELOW_MINIMUM budget-feasibility business result, emitted as a typed
   *  signal (see `workflow-signal.contracts.ts`) instead of a private `pendingInputAction` transition. */
  | "BELOW_MINIMUM_BUDGET_FEASIBILITY"
  /** Stage 9E: a conversation that already carried legacy `pendingInputAction`/`completionStage` contact
   *  state before the Workflow Signal Engine existed — translated into a real WorkflowExecution the first
   *  time that conversation resumes, never re-derived business logic, never a duplicate workflow. */
  | "HISTORICAL_STATE_MIGRATION";

export interface WorkflowStartRequest {
  workflowType: WorkflowType;
  scope: WorkflowExecutionScope;
  sourceCapability: WorkflowStartSource;
  /** The canonical SkillExecution this workflow is associated with, when one exists (e.g. the
   *  authoritative Plan Trip skill execution behind a READY_FOR_BOOKING decision). Null when the trigger
   *  came from the legacy/deterministic path, which has no canonical SkillExecution id to reference. */
  sourceSkillExecutionId: string | null;
  requestedByTurnId: string;
  initialState: Record<string, unknown>;
}

/**
 * Stage 9E: moved here (from `workflow-coordinator.ts`) so `WorkflowSignalRegistry`/`WorkflowSignalEngine`
 * can share these shapes with `WorkflowCoordinator` without either importing the other.
 */
export interface WorkflowDispatchSignals {
  contactCapture: ContactCaptureStartSignals;
  contactCaptureTripContext: ContactCaptureTripContext;
  bookingHandoffTripContext: BookingHandoffTripContext;
  tripSubmission: TripSubmissionStartSignals;
  tripSubmissionTripContext: TripSubmissionTripContext;
}

export interface WorkflowDispatchOutcome {
  handled: boolean;
  workflowType: WorkflowType | null;
  decision: WorkflowResumeDecision;
  responseText: string | null;
  /** Non-null only the turn a Contact Capture/Trip Submission lead was actually (freshly) created. */
  leadCreated: TravelLead | null;
  /** Non-null only the turn a BOOKING_HANDOFF workflow completed with a real, ticketed booking (see
   *  BookingHandoffState.ticketReady) — lets AgentService attach a ticket PDF download link to this
   *  turn's chat response. Optional (rather than required-and-usually-null) so CONTACT_CAPTURE/
   *  TRIP_SUBMISSION outcome construction sites never need to know about it. */
  bookingId?: string | null;
}
