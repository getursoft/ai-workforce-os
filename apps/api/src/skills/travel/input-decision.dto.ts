/**
 * InputDecision: Skill Runtime's authoritative decision about what input is needed.
 *
 * Stage 8 makes Skill Runtime the authority for:
 * - what information is missing
 * - which question to ask next
 * - whether planning is ready
 * - what capabilities are available
 *
 * Travel Runtime receives this decision and executes business logic only.
 * Travel Runtime no longer validates required fields or decides what to ask.
 */

export type InputDecisionType =
  | "ASK_FOR_INPUT" // Missing required field, ask which one
  | "READY_FOR_ITINERARY" // Can generate basic itinerary
  | "READY_FOR_ESTIMATE" // Can estimate budget
  | "READY_FOR_LIVE_SEARCH" // Can search live providers
  | "READY_FOR_BOOKING" // All required data present, ready to book
  | "ERROR_VALIDATION_FAILED" // Input validation failed
  | "ERROR_STATE_LOSS"; // State persistence issue

export type PendingInputCode =
  | "ORIGIN"
  | "DESTINATION"
  | "DEPARTURE_DATE"
  | "TRAVEL_YEAR"
  | "TRAVELLERS"
  | "TRAVELLER_COMPOSITION"
  | "DURATION"
  | null;

export interface ReadinessCapabilities {
  itinerary: boolean;
  estimate: boolean;
  liveSearch: boolean;
  booking: boolean;
}

export interface InputDecision {
  /** What Skill Runtime decided */
  decision: InputDecisionType;

  /** Which field to ask about next (null = no more questions) */
  pendingInput: PendingInputCode;

  /** All fields that are currently missing */
  missingFields: string[];

  /** What capabilities are available given current state */
  readinessCapabilities: ReadinessCapabilities;

  /** Optional warnings (e.g., PURPOSE_NOT_SUPPLIED) */
  policyWarnings: string[];

  /** Why this decision was made (for diagnostics) */
  explanationCode: string;

  /** Skill version that made this decision */
  skillVersion: string;

  /** Policy version used for readiness determination */
  policyVersion: string;

  /** Revision when decision was made */
  stateRevision: number;
}

/**
 * DecisionContext: Information available when making the decision.
 * Used for diagnostics and fallback logic.
 */
export interface DecisionContext {
  /** Reason if Skill Runtime failed */
  skillRuntimeError?: {
    code: string;
    message: string;
  };

  /** Fallback used? */
  usedLegacyFallback: boolean;

  /** Why fallback was used */
  fallbackReason?: string;

  /** Time to make decision (ms) */
  decisionTimeMs: number;
}
