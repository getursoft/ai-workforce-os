/**
 * Stage 9C: BOOKING_HANDOFF — the second workflow built on the Pending Workflow Runtime, proving
 * WorkflowExecutionService is genuinely workflow-type-agnostic (Stage 9B built only CONTACT_CAPTURE).
 *
 * Scaffolding only: this workflow preserves the traveler's booking *intent* and honestly explains that
 * automated booking is not yet available. It never performs a reservation, a payment, a CRM booking
 * record, or a human-approval handoff — those are explicitly out of scope for this stage.
 *
 * Deliberately holds only a trip reference and the canonical SkillExecution id — never payment details,
 * never a duplicate of the full travel state (see ContactCaptureState for the same convention).
 */

export type BookingHandoffPendingInput = "BOOKING_CONFIRMATION" | "NONE";

/** Step-level sub-state layered on top of the generic WorkflowStatus (see WorkflowExecution.currentStep),
 *  matching the states suggested for this stage. WAITING_FOR_CONFIRMATION maps to the generic
 *  WAITING_FOR_INPUT status; READY_FOR_FUTURE_WORKFLOW maps to COMPLETED once confirmed. */
export type BookingHandoffStep =
  | "WAITING_FOR_CONFIRMATION"
  | "WAITING_FOR_APPROVAL"
  | "READY_FOR_FUTURE_WORKFLOW"
  | "CANCELLED"
  | "FAILED";

export interface BookingHandoffState {
  originCity: string | null;
  destinationCity: string | null;
  travelDates: string | null;
  /** The canonical Plan Trip SkillExecution this booking intent is associated with, if any — reference
   *  only, never a copy of its full state. */
  skillExecutionId: string | null;
  journeyId: string | null;
  confirmed: boolean;
  readyForFutureWorkflow: boolean;
  approvalRequestId: string | null;
}

export function emptyBookingHandoffState(): BookingHandoffState {
  return {
    originCity: null,
    destinationCity: null,
    travelDates: null,
    skillExecutionId: null,
    journeyId: null,
    confirmed: false,
    readyForFutureWorkflow: false,
    approvalRequestId: null
  };
}

export const BOOKING_HANDOFF_STEP_WAITING_FOR_CONFIRMATION = "WAITING_FOR_CONFIRMATION" as const;
export const BOOKING_HANDOFF_STEP_WAITING_FOR_APPROVAL = "WAITING_FOR_APPROVAL" as const;
export const BOOKING_HANDOFF_STEP_READY_FOR_FUTURE_WORKFLOW = "READY_FOR_FUTURE_WORKFLOW" as const;

/** Read-only trip reference used to build the confirmation question/response text — never persisted
 *  beyond the origin/destination/dates already captured in BookingHandoffState. */
export interface BookingHandoffTripContext {
  originCity: string | null;
  destinationCity: string | null;
  travelDates: string | null;
  skillExecutionId: string | null;
  journeyId: string | null;
}
