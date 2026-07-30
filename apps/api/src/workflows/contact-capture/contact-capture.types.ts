import type { ConversationCompletionStage } from "../../conversation/conversation-completion";
import type { ProviderFailureRecord } from "../../travel/travel.runtime";

/**
 * Stage 9B: Contact Capture — the first workflow built on the Pending Workflow Runtime.
 *
 * Deliberately holds only the structured fields this workflow needs, never the full travel state (trip
 * details are read from the conversation's existing persisted state / SkillExecution when needed, e.g.
 * to build the completion confirmation — see ContactCaptureWorkflowService).
 */

export type ContactCapturePendingInput = "MOBILE_NUMBER" | "EMAIL" | "FULL_NAME" | "NONE";

/** Outcome of the best-effort external CRM mirror for this contact — purely observational, mirrors
 *  TravelLeadCrmSyncStatus plus a typed "no CRM, but the request is safely saved" outcome. */
export type ContactCaptureCrmOutcome =
  | "NOT_ATTEMPTED"
  | "SYNCED"
  | "FAILED"
  | "SKIPPED"
  | "CALLBACK_REQUEST_PENDING";

export interface ContactCaptureState {
  fullName: string | null;
  /** Normalized (digits-only, country-code stripped) representation — see validateIndianMobileNumber. */
  mobileNumber: string | null;
  email: string | null;
  preferredContactMethod: "PHONE" | "EMAIL" | null;
  /** The active multi-city Journey.id this contact request relates to, if any — reference only. */
  journeyId: string | null;
  /** The internal TravelLead this workflow created, once persisted — reference only. */
  leadId: string | null;
  leadReference: string | null;
  /** True once the traveler has affirmatively provided contact details in response to being asked. */
  consentGiven: boolean;
  crmOutcome: ContactCaptureCrmOutcome;
}

export function emptyContactCaptureState(): ContactCaptureState {
  return {
    fullName: null,
    mobileNumber: null,
    email: null,
    preferredContactMethod: null,
    journeyId: null,
    leadId: null,
    leadReference: null,
    consentGiven: false,
    crmOutcome: "NOT_ATTEMPTED"
  };
}

export const CONTACT_CAPTURE_WORKFLOW_TYPE = "CONTACT_CAPTURE" as const;
export const CONTACT_CAPTURE_STEP_COLLECT_MOBILE_NUMBER = "COLLECT_MOBILE_NUMBER" as const;
export const CONTACT_CAPTURE_STEP_COMPLETED = "COMPLETED" as const;

/** Fields this deployment currently requires before contact capture can complete — matches today's
 *  actual product behaviour (only a mobile number is ever asked for). Extending this list is the only
 *  change needed to require more fields later; the turn-processing logic loops over it generically. */
export const CONTACT_CAPTURE_REQUIRED_FIELDS: readonly ContactCapturePendingInput[] = ["MOBILE_NUMBER"];

/** Determine the next field Contact Capture still needs, or "NONE" once every required field is present. */
export function nextContactCaptureField(state: ContactCaptureState): ContactCapturePendingInput {
  for (const field of CONTACT_CAPTURE_REQUIRED_FIELDS) {
    if (field === "MOBILE_NUMBER" && !state.mobileNumber) return "MOBILE_NUMBER";
    if (field === "EMAIL" && !state.email) return "EMAIL";
    if (field === "FULL_NAME" && !state.fullName) return "FULL_NAME";
  }
  return "NONE";
}

/**
 * Read-only trip context Contact Capture references (never copies into its own persisted state) to
 * build the internal lead and the completion confirmation text — e.g. "your Delhi to Dubai trip".
 */
export interface ContactCaptureTripContext {
  originCity: string | null;
  destinationCity: string | null;
  travelDates: string | null;
  passengers: string | null;
  tripPurpose: string | null;
  budgetAmount: number | null;
  budgetCurrency: string | null;
  displayCurrency: string | null;
  journeyId: string | null;
  customerName: string | null;
  /** Provider-verified phone number from a channel adapter (e.g. WhatsApp sender number). When set,
   *  the contact capture workflow uses this number directly without asking the user. */
  verifiedPhoneNumber?: string;
}

/**
 * Stage 9C: the typed signals `ContactCaptureWorkflowService.shouldStart` reads to decide whether this
 * turn should start Contact Capture — both come straight off the persisted TravelConversationMemory the
 * caller already loaded this turn (never re-derived/duplicated business logic). See `shouldStart`'s doc
 * comment for exactly which legacy triggers these do (and deliberately do not) cover.
 */
export interface ContactCaptureStartSignals {
  providerFailure: ProviderFailureRecord | null;
  completionStage: ConversationCompletionStage | null;
}
