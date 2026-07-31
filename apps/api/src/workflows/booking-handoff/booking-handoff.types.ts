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
  /** The TravelBooking id created when the user confirms — used to submit the booking to the provider
   *  once customer approval completes. */
  bookingId: string | null;
  /** True only once the provider booking actually succeeded and a real ticket/PNR exists (see
   *  `handleApprovalResume`'s `bookingSummary.pnr !== null` check) — lets `WorkflowCoordinator` know a
   *  ticket PDF is genuinely downloadable before surfacing a chat attachment link for it. Never true for
   *  a booking that failed at the provider or is still pending. */
  ticketReady: boolean;
  /** The selected package snapshot (see BookingHandoffTripContext.selectedOption) carried from `start()`
   *  into `confirmAndRequestApproval()`, so the created TravelBooking's flight/hotel/price snapshot
   *  reflects the SPECIFIC option the traveler picked and confirmed — never re-derived or re-generated. */
  selectedOption: Record<string, unknown> | null;
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
    approvalRequestId: null,
    bookingId: null,
    ticketReady: false,
    selectedOption: null
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
  /**
   * The simulated flight+hotel package the traveler already selected and confirmed BEFORE this workflow
   * started (see travel-package-options.ts's `SimulatedPackageOption` — kept as a loosely-typed snapshot
   * here so this workflows-layer file never depends on a travel-domain-specific type). Null when a caller
   * starts this workflow without going through the option-selection flow (e.g. an older/simpler
   * integration) — `start()` falls back to its plain confirmation question in that case.
   */
  selectedOption?: Record<string, unknown> | null;
  /** Adult/child/infant traveller count, when known — used only for a richer confirmation summary. */
  travellerCount?: number | null;
  /** True when the traveler's stated preferences include a vegetarian food preference. */
  vegetarianPreference?: boolean;
  /** Every traveller's name/age/gender, collected before the booking summary was ever shown (see
   *  travel-package-options.ts's `PassengerDetail`) — kept as a loosely-typed snapshot here for the same
   *  one-way-dependency reason as `selectedOption`. Persisted onto the booking's `travellerSummaryJson` so
   *  the generated ticket names real passengers instead of "Passenger 1"/"Passenger 2" placeholders. */
  passengerDetails?: ReadonlyArray<Record<string, unknown>> | null;
  /** Where to actually send the confirmed ticket (see travel.runtime.ts's `AWAITING_TICKET_CONTACT` stage)
   *  — persisted onto the created TravelBooking's customerEmail/customerPhone so the delivery step has
   *  somewhere real to send the PDF. Both null when the traveler explicitly skipped this step. */
  customerEmail?: string | null;
  customerPhone?: string | null;
}
