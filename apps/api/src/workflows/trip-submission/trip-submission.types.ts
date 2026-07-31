import type { TravelEntities, TravelResponseLanguage } from "../../travel/travel.runtime";

/**
 * Stage 9D: TRIP_SUBMISSION — the third workflow built on the Pending Workflow Runtime, retiring the
 * legacy Travel Runtime state machine that used to drive:
 *  - "confirm_booking_lead_capture": the traveler confirms a presented itinerary/recommendation and the
 *    trip request should be submitted.
 *  - "CONFIRM_STANDALONE_CONTACT_USE": the traveler volunteers a phone/email unprompted, and is asked
 *    whether it may be used to submit the trip request.
 *
 * Deliberately holds only a trip reference and the volunteered/collected contact value — never a
 * duplicate of the full travel state (matches ContactCaptureState's convention).
 */

export type TripSubmissionPendingInput = "MOBILE_NUMBER" | "CONFIRM_CONTACT_USE" | "NONE";

export interface TripSubmissionState {
  originCity: string | null;
  destinationCity: string | null;
  customerName: string | null;
  /** The phone/email volunteered or collected — normalized however Travel Runtime's own
   *  `extractContactValue`/`extractPhoneNumber` already normalizes it (never re-validated here). */
  contactValue: string | null;
  journeyId: string | null;
  leadId: string | null;
  leadReference: string | null;
  /** Stage 9F: which trigger started this workflow, so a later domain-level re-evaluation (see
   *  `WorkflowCoordinator.reevaluateBelowMinimumTrigger`) can tell whether a budget correction should
   *  invalidate it. Only ever `"BELOW_MINIMUM_BUDGET"` workflows are eligible for that automatic
   *  cancellation — an explicit `CONFIRM_SUBMISSION`/`STANDALONE_CONTACT` request represents genuine
   *  user intent to submit and must never be silently cancelled by an unrelated budget change. `null`
   *  for a historically-migrated conversation (`migrateFromLegacyState`) whose original trigger is
   *  unknown — the safe default is to never auto-cancel an unknown-provenance workflow. */
  triggerReason: TripSubmissionStartTrigger | null;
}

export function emptyTripSubmissionState(): TripSubmissionState {
  return {
    originCity: null,
    destinationCity: null,
    customerName: null,
    contactValue: null,
    journeyId: null,
    leadId: null,
    leadReference: null,
    triggerReason: null
  };
}

export const TRIP_SUBMISSION_STEP_AWAITING_CONTACT = "AWAITING_CONTACT" as const;
export const TRIP_SUBMISSION_STEP_CONFIRM_CONTACT_USE = "CONFIRM_CONTACT_USE" as const;
export const TRIP_SUBMISSION_STEP_COMPLETED = "COMPLETED" as const;
export const TRIP_SUBMISSION_STEP_DECLINED = "DECLINED" as const;

/** What triggered this workflow to start — mirrors the (now-migrated) legacy trigger sites.
 *  `BELOW_MINIMUM_BUDGET` (Stage 9E) is emitted directly by Travel Runtime as a typed `WorkflowSignal`
 *  (see `travel.runtime.ts`'s `TravelRuntimeExecutionMode`), never derived from free text here. */
export type TripSubmissionStartTrigger =
  | "CONFIRM_SUBMISSION"
  | "STANDALONE_CONTACT"
  | "BELOW_MINIMUM_BUDGET"
  | "NONE";

/**
 * Typed signals `TripSubmissionWorkflowService.shouldStart` reads — all reused from state Travel Runtime
 * (or the caller) already computed this turn, never re-derived business logic:
 *  - `legacyPendingInputAction`/`legacyCompletionStage`: guards against starting a NEW workflow while the
 *    legacy engine already has its OWN pending contact question in flight for a trigger this stage does
 *    not migrate (e.g. the BELOW_MINIMUM-budget contact ask) — see the Stage 9D report's scope notes.
 *  - `itineraryPresented`: an itinerary/recommendation has been generated this conversation.
 *  - `hasActiveTripContext`: a destination is already known (narrows the standalone-contact trigger so a
 *    stray phone-shaped string elsewhere in the conversation never misfires it).
 *  - `tripState`: passed straight through to `resolveTravelInput` for its own contact/date/budget/
 *    passenger classification — never re-implemented here.
 */
export interface TripSubmissionStartSignals {
  legacyPendingInputAction: string | null;
  legacyCompletionStage: string | null;
  itineraryPresented: boolean;
  hasActiveTripContext: boolean;
  tripState: TravelEntities;
  /** Stage 9E.1: the legacy engine's own volunteered-but-unconfirmed contact value, when
   *  `legacyPendingInputAction === "CONFIRM_STANDALONE_CONTACT_USE"` — carried forward by
   *  `WorkflowCoordinator.migrateHistoricalContactState`/`TripSubmissionWorkflowService.migrateFromLegacyState`
   *  so a migrated conversation can still resolve "yes, use it" without re-asking for the number. Null for
   *  every other legacy pending-input action (nothing to carry forward). */
  legacyPendingContactValue: string | null;
  /** Travel Runtime's own `TravelConversationMemory.pendingAction` (the booking-options/passenger-
   *  details/ticket-contact/resend-ticket flow — see travel.runtime.ts) — when this names one of those
   *  states, this turn's text is understood to be an answer to that flow's own question (an option
   *  number, a passenger list, or literally an email/phone volunteered for ticket delivery), never a
   *  standalone contact volunteered out of the blue. Without this, `shouldStart` misread every such email/
   *  phone reply as `STANDALONE_CONTACT` and hijacked the turn into a TRIP_SUBMISSION workflow before
   *  Travel Runtime's own routing ever ran. */
  legacyPendingAction: string | null;
}

/** Read-only trip reference used to build submission text and the internal lead. */
export interface TripSubmissionTripContext {
  entities: TravelEntities;
  responseLanguage: TravelResponseLanguage;
  travelDates: string | null;
  passengers: string | null;
  tripPurpose: string | null;
  budgetAmount: number | null;
  budgetCurrency: string | null;
  displayCurrency: string | null;
  journeyId: string | null;
  customerName: string | null;
}
