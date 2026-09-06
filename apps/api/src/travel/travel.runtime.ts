import { randomUUID } from "node:crypto";
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiMessage,
  AiProvider,
  AiToolDefinition
} from "@ai-workforce-os/plugin-sdk";
import {
  CurrencyService,
  isSupportedCurrency,
  SUPPORTED_CURRENCIES,
  type CurrencyCode,
  type CurrencyPreference
} from "./currency.service";
import {
  extractPhoneNumber,
  formatSuggestedActions,
  generateLeadReference,
  isAffirmativeResponse,
  isNegativeResponse,
  type ConversationCompletionStage,
  type SuggestedAction
} from "../conversation/conversation-completion";
import { classifyIdentityCandidate } from "../conversation/identity-capture";
import { classifyUserInput } from "../conversation/input-semantics";
import {
  mergeEntitiesWithPriorState,
  detectSprintIntent,
  determineMissingFields,
  type ConversationPhase
} from "./sprint-4.4b-integration";
// travel-package-options.ts also imports FROM this file (addDays/estimateBudgetRange) — a circular
// module reference, but a safe one: every value below is only ever called from inside a method body
// (never evaluated at module top-level on either side), so both modules finish initializing before either
// value is actually invoked.
import {
  generateSimulatedPackageOptions,
  formatPackageOptionsMessage,
  detectOptionSelection,
  isOptionSetExpired,
  buildBookingConfirmationSummary,
  buildPassengerDetailsRequestMessage,
  parsePassengerDetailsReply,
  isChangeOptionRequest,
  isExplicitBookingConfirmationReply,
  packageOptionSeed,
  type SimulatedPackageOption,
  type PassengerDetail
} from "./travel-package-options";
import {
  buildAttachmentReadMessage,
  buildOutOfScopeRoutingMessage,
  detectOutOfScopeEmployee,
  detectRoutingConfirmation,
  parseAttachmentBlocks,
  type EmployeeDomainSpec,
  type RoutingHandoffSignal
} from "../employees/employee-runtime";

export const TRAVEL_EMPLOYEE_PLUGIN_SLUG = "travel-employee";
export const TRAVEL_TRIP_STATE_MEMORY_KEY = "travel.trip_state";

/** Minimal domain spec for the Travel Employee, used only so the shared attachment-read helper can decide
 *  whether an attached document belongs to Travel or to a different employee. */
const TRAVEL_ATTACHMENT_SPEC: EmployeeDomainSpec = {
  slug: TRAVEL_EMPLOYEE_PLUGIN_SLUG,
  memoryKey: TRAVEL_TRIP_STATE_MEMORY_KEY,
  providerName: "travel-employee",
  modelName: "travel-employee-v1",
  referencePrefix: "TRV",
  artifactNoun: "trip",
  artifactToolName: "travel.create_lead",
  escalationContact: "support@ai-workforce-os.example",
  fields: [],
  buildRecommendation: () => "",
  buildSummary: () => ""
};

export type TravelStage =
  | "GREETING"
  | "COLLECT_NAME"
  | "DISCOVER_INTENT"
  | "COLLECT_DESTINATION"
  | "COLLECT_DATES"
  | "ASK_TRAVEL_YEAR"
  | "COLLECT_PASSENGERS"
  | "COLLECT_BUDGET"
  | "ASK_MISSING_INFO"
  | "RECOMMEND_OPTIONS"
  | "ITINERARY_SUMMARY"
  | "CONFIRM_BOOKING"
  | "BOOKING_CONFIRMED"
  | "OFFER_TRAVEL_REQUEST"
  | "AWAITING_CONTACT"
  | "ESCALATED";

export interface TravelSlots {
  destination: string | null;
  travelMonth: string | null;
  durationDays: number | null;
  passengers: number | null;
  budgetAmount: number | null;
  budgetCurrency: string | null;
}

export interface TravelState extends TravelSlots {
  /** The traveler's own name, captured during onboarding — see `extractCustomerName`. Never guessed. */
  customerName: string | null;
  /** True once `customerName` is known — onboarding (the COLLECT_NAME gate) is done and normal trip-slot collection may proceed. */
  onboardingCompleted: boolean;
  /** True once the proactive greeting has been shown for this conversation (always true once any state is derived — the greeting always precedes the first derived turn). */
  greetingSent: boolean;
  /** The user's local time for timezone-aware greetings. */
  userLocalTime?: Date;
  /** The detected intent from the user's latest message. */
  currentIntent?: string | null;
  stage: TravelStage;
  missingFields: string[];
}

/**
 * Extended trip entity schema captured via LLM-based extraction (see {@link TravelEmployeeLlmOrchestrator}).
 * Superset of {@link TravelSlots} so a single stored state document stays readable by both engines.
 */
export interface TravelEntities {
  /** The traveler's own name, captured during onboarding — see `extractCustomerName`/the `customerName` extraction rule. Never guessed from a city, month, or other trip detail. */
  customerName: string | null;
  originCity: string | null;
  destinationCity: string | null;
  departureDate: string | null;
  travelMonth: string | null;
  returnDate: string | null;
  days: number | null;
  nights: number | null;
  /**
   * Total headcount from an ambiguous statement ("5 log", "family of 5", "5 people") that does not itself
   * specify adults/children/infants. Deliberately a separate field from `adults` — a raw total must never
   * be assumed to mean "N adults"; see {@link computePassengerState}.
   */
  totalTravellers: number | null;
  adults: number | null;
  children: number | null;
  infants: number | null;
  budget: number | null;
  budgetCurrency: string | null;
  cabinClass: string | null;
  tripType: string | null;
  hotelStars: number | null;
  /** True once a visa need has actually been mentioned/confirmed either way — never inferred purely from
   * origin/destination being international, since that's a generic caveat (see `buildVisaInsuranceCaveat`),
   * not a fact about this specific traveler's actual visa situation. */
  visaRequired: boolean | null;
  /** Free-text passport status as the traveler stated it (e.g. "valid", "expired", "renewing", "none yet") —
   * deliberately a string, not an enum: travelers describe this in many ways and the exact wording matters
   * for a human agent following up, more than forcing it into a fixed category would. */
  passportStatus: string | null;
  /** Leisure vs. business — asked once, alongside the Intent Discovery menu (see
   * `buildIntentDiscoveryMessage`), purely to personalize the conversation ("how's the conference going to
   * go" vs. "hope you have a great holiday"); never required, never blocks any other flow. */
  tripPurpose: "LEISURE" | "BUSINESS" | null;
  preferences: string[];
}

export const EMPTY_TRAVEL_ENTITIES: TravelEntities = {
  customerName: null,
  originCity: null,
  destinationCity: null,
  departureDate: null,
  travelMonth: null,
  returnDate: null,
  days: null,
  nights: null,
  totalTravellers: null,
  adults: null,
  children: null,
  infants: null,
  budget: null,
  budgetCurrency: null,
  cabinClass: null,
  tripType: null,
  hotelStars: null,
  visaRequired: null,
  passportStatus: null,
  tripPurpose: null,
  preferences: []
};

/** Classifies what the user is actually doing on a given turn, independent of slot extraction. */
export type TravelIntent =
  | "provide_trip_details"
  | "ask_budget_guidance"
  | "ask_recommendation"
  | "request_plan"
  | "modify_trip"
  | "confirm_plan"
  | "reject_plan"
  | "ask_question"
  | "request_human"
  | "start_new_trip"
  | "casual_conversation";

const ALL_TRAVEL_INTENTS: readonly TravelIntent[] = [
  "provide_trip_details",
  "ask_budget_guidance",
  "ask_recommendation",
  "request_plan",
  "modify_trip",
  "confirm_plan",
  "reject_plan",
  "ask_question",
  "request_human",
  "start_new_trip",
  "casual_conversation"
];

/** Keys of {@link TravelEntities} that carry a scalar (non-array) value and can be individually confirmed. */
export type ConfirmableEntityKey = Exclude<keyof TravelEntities, "preferences">;

/** Who supplied a confirmed entity's value — used only for observability, never for merge decisions. */
export type EntitySource = "USER_EXPLICIT" | "DERIVED" | "MODEL_INFERRED" | "CORRECTED" | "user" | "llm" | "default";

export interface PendingDepartureDate {
  day: number;
  month: number;
  year: null;
  source: "USER_EXPLICIT";
}

/**
 * Immutable per-field confirmation record. Once `confirmed` is true, {@link mergeConfirmedEntities} will
 * never let a later turn silently overwrite the value — only an explicit user correction (or, for city
 * fields, a confidently-extracted different city) can replace it. This is what stops confirmed facts
 * ("1 day", "5 travelers") from regressing or being re-asked on a later turn.
 */
export interface ConfirmedFieldMeta {
  source: EntitySource;
  confidence: number;
  confirmed: boolean;
  updatedAt: string;
}

export type TravelEntityConfirmation = Partial<Record<ConfirmableEntityKey, ConfirmedFieldMeta>>;
export const EMPTY_TRAVEL_ENTITY_CONFIRMATION: TravelEntityConfirmation = {};

/** A city-name interpretation awaiting a yes/no from the user before it can become confirmed. */
export interface PendingCityClarification {
  field: "originCity" | "destinationCity";
  proposedValue: string;
  rawValue: string | null;
  confidence: number;
}

/**
 * How the traveler wants their budget handled. `USER_DEFINED` means a specific number is the target;
 * `AGENT_RECOMMENDED`/`FLEXIBLE` mean the traveler explicitly asked the assistant to propose a number (or
 * has none in mind) — in both cases a numeric budget must never be requested, and a recommended range is
 * generated once the other required trip fields are known.
 */
export type TravelBudgetMode = "UNKNOWN" | "USER_DEFINED" | "AGENT_RECOMMENDED" | "FLEXIBLE";

/**
 * A structured action the traveler has explicitly asked for but that could not run yet because a
 * required field (almost always the departure city) was still missing. Persisted so that once the
 * blocking field arrives on a later turn, the action resumes immediately instead of falling into the
 * generic "still collecting details" flow and silently forgetting what was actually being asked for.
 */
export type TravelPendingAction =
  | "GENERATE_BUDGET_GUIDANCE"
  | "SEARCH_OPTIONS"
  | "GENERATE_ITINERARY"
  | "MODIFY_HOTEL_BUDGET"
  | "BOOK_FLIGHT"
  | "BOOK_HOTEL"
  | "BOOK_TRIP"
  /** Three simulated package options have been shown; waiting for the traveler to pick Option 1/2/3 —
   *  see travel-package-options.ts. */
  | "AWAITING_OPTION_SELECTION"
  /** An option has been selected; waiting for the full name, age, and gender of every traveller before a
   *  booking summary — and, eventually, a real ticket — can be produced. See travel-package-options.ts's
   *  `PassengerDetail`/`parsePassengerDetailsReply`. */
  | "AWAITING_PASSENGER_DETAILS"
  /** Every traveller's details are collected; waiting for an email and/or WhatsApp number to actually
   *  send the ticket to once the booking is approved — without this, `TravelBooking.customerEmail`/
   *  `customerPhone` stay empty and there is nowhere for the real email/WhatsApp delivery to send the
   *  PDF (it can still be downloaded from the chat attachment or dashboard). "skip" bypasses this. */
  | "AWAITING_TICKET_CONTACT"
  /** An option has been selected and every traveller's details collected; the final booking summary is
   *  shown, waiting for an explicit "Confirm booking" before the BOOKING_HANDOFF workflow (and,
   *  downstream, customer approval + provider booking) is started. */
  | "AWAITING_BOOKING_CONFIRMATION"
  /** A returning customer asked to resend their ticket but hasn't yet given enough to look it up —
   *  waiting for the booking email (required) and, ideally, the travel date. See
   *  `pendingResendLookup`/`isResendTicketRequest`. */
  | "AWAITING_RESEND_TICKET_DETAILS"
  /** BELOW_MINIMUM budget feasibility has been explained and the lowest available simulated option's
   *  price has been shown; waiting for an explicit yes/no before ANY above-budget option is actually
   *  listed. Only an affirmative reply to this exact question sets `budgetOverrideAccepted = true` — see
   *  `handleBelowMinimumFeasibility`/`offerBudgetOverride`. A decline (or a fresh phone number) falls
   *  back to the existing lead-capture offer, unchanged. */
  | "AWAITING_BUDGET_OVERRIDE_CONFIRMATION"
  | null;

/**
 * A deterministic, phrase-based classification of what the traveler's CURRENT message is actually asking
 * for — evaluated fresh every turn (never persisted), and, per policy, always takes priority over a stale
 * pending action or a lingering budget-feasibility state. Distinct from {@link TravelPendingAction} (a
 * blocked action awaiting a field) and from {@link TravelIntent} (the LLM's broader intent label) — this
 * exists specifically so budget feasibility can never hijack an unrelated request like "day plan" or
 * "what's worth seeing".
 */
export type TravelPlanningAction =
  | "ADD_TRIP_LEG"
  | "SUBMIT_ENQUIRY"
  | "CREATE_LEAD"
  | "REQUEST_CALLBACK"
  | "GENERATE_COMPLETE_TRIP_PLAN"
  | "GENERATE_ITINERARY"
  | "BOOK_FLIGHT"
  | "BOOK_HOTEL"
  | "SEARCH_LIVE_OPTIONS"
  | "GENERATE_FLIGHT_RECOMMENDATIONS"
  | "GENERATE_HOTEL_RECOMMENDATIONS"
  | "SEARCH_FLIGHTS"
  | "SEARCH_HOTELS"
  | "CALCULATE_BUDGET"
  | "CALCULATE_JOURNEY_BUDGET"
  | "CONVERT_ESTIMATE_CURRENCY"
  | "RECOMMEND_ATTRACTIONS"
  | "RECOMMEND_FOOD"
  | "RECOMMEND_TRANSPORT"
  | null;

// These four are business-workflow commands, not trip-planning content — they must win over every other
// classification (including the LLM's own intent label, which has been observed to misread "ask anyone to
// call" as a request-human-agent escalation, and "submit"/"generate lead" as a booking confirmation) since
// none of them are ever a reason to touch a search tool.
//
// "continue to <city>" / Hinglish SOV "<origin> se <destination> ka plan continue karo" — a second (or
// later) leg of the SAME journey, never a correction to the current one and never a plain itinerary ask.
// Also matches "ye/yeh bhi include kro" ("include this too") and the bare chain connector "aur fir" ("and
// then") — both strong signals that one or more ADDITIONAL legs are being described, possibly several at
// once (see `parseJourneyLegChain`, used to detect exactly how many).
const ADD_TRIP_LEG_PATTERN =
  /\bcontinue\s+(?:the\s+|this\s+|my\s+)?(?:trip|plan|journey)?\s*(?:to|karo|kar\s+do|kijiye)\b|\badd\s+(?:a\s+|another\s+)?(?:trip\s+)?leg\b|\bnext\s+leg\b|\bthen\s+(?:go|travel|fly|back)\s+to\b|\b(?:ye|yeh|is(?:e|ko)?)\s+bhi\s+include\s+(?:kar\s*(?:o|do|dijiye)|karein|kro)\b|\balso\s+include\s+this\b|\baur\s+fir\b/i;
// Explicit "this is a separate/independent trip" phrasing — must win over structural continuity so a
// deliberately independent trip (e.g. "Plan another trip from Tokyo to London") is never silently folded
// into the existing journey just because its origin happens to match a prior destination.
const NEW_INDEPENDENT_TRIP_PATTERN =
  /\b(?:another|a\s+new|a\s+separate|a\s+different)\s+trip\b|\bstart\s+(?:a\s+)?new\s+trip\b|\bplan\s+(?:another|a\s+separate|a\s+different)\s+trip\b|\bnaya\s+trip\b|\bek\s+(?:aur|naya)\s+trip\b|\balag\s+trip\b/i;
// A bare correction telling us the last few turns should have been chained into ONE multi-city journey
// ("bhai multileg hai") — never itself a new route, just an instruction to reinterpret what's already
// been said as connected. Must never be silently absorbed by ADD_TRIP_LEG_PATTERN's "continue to" phrasing.
const MULTILEG_CORRECTION_PATTERN =
  /\b(?:bhai\s+)?multi[\s-]?(?:leg|city)\s+hai\b|\bye\s+(?:ek\s+)?multi[\s-]?(?:leg|city)\s+(?:trip\s+)?hai\b|\bit'?s\s+(?:a\s+)?multi[\s-]?(?:leg|city)\s+(?:trip|journey)\b|\btreat\s+(?:it|this|ye|isko)\s+as\s+(?:a\s+)?multi[\s-]?(?:leg|city)\b|\bisko\s+multi[\s-]?(?:leg|city)\s+(?:treat\s+)?karo\b|\bthis\s+is\s+multi[\s-]?(?:leg|city)\b/i;

/**
 * Deterministic classification of how the CURRENT message's route relates to the trip already in
 * progress — the load-bearing decision behind "should this extend the existing journey, start a brand new
 * one, or is what I've already said actually one connected trip". Structural continuity (the new leg's
 * origin matches the currently confirmed destination, or the route returns to the traveler's home city) is
 * the primary, low-risk signal — deliberately NOT "any destination change is ambiguous", which would
 * regress the existing, well-tested single-destination-correction flow ("not London, Paris").
 */
export type RouteRelationship = "EXTENSION" | "NEW_TRIP" | "MULTILEG_CORRECTION" | "AMBIGUOUS" | "NONE";

export function classifyRouteRelationship(
  text: string,
  confirmedDestination: string | null,
  homeOriginCity: string | null
): RouteRelationship {
  if (MULTILEG_CORRECTION_PATTERN.test(text)) return "MULTILEG_CORRECTION";
  if (NEW_INDEPENDENT_TRIP_PATTERN.test(text)) return "NEW_TRIP";
  if (ADD_TRIP_LEG_PATTERN.test(text)) return "EXTENSION";
  // A same-leg destination CORRECTION ("not London, Paris") often mentions the current destination
  // immediately followed by the new one — structurally identical to a genuine extension ("London se Paris
  // jana hai"). An explicit negation/correction marker is the deciding signal: never treat it as a route
  // continuation, however the cities happen to be ordered — the existing destination-correction flow (see
  // `mergeConfirmedEntities`'s `destinationChanged`) already owns this case correctly.
  if (/^\s*(?:not|nahi|instead\s+of|actually|galti\s+se|correction[:\s]|i\s+meant)\b/i.test(text)) return "NONE";
  // Fuzzy on purpose: `KNOWN_DESTINATIONS` only has "delhi", not "new delhi" — a traveler whose stated home
  // city is "New Delhi" would otherwise never match a later "back to Delhi" mention via strict equality.
  const sameCity = (a: string, b: string): boolean => {
    const left = a.toLowerCase();
    const right = b.toLowerCase();
    return left === right || left.includes(right) || right.includes(left);
  };
  // A one-city "phir wapas Delhi" ("then back to Delhi") never forms a 2-mention chain — it has an implicit
  // origin (wherever the journey currently is). An explicit return-home marker plus a bare mention of the
  // home city is enough on its own; never requires a full origin->destination pair.
  const RETURN_HOME_MARKER_PATTERN = /\b(?:wapas|wapis|vapas|lauta?te?|return(?:ing)?)\b/i;
  if (homeOriginCity !== null && RETURN_HOME_MARKER_PATTERN.test(text)) {
    const mentionsHome = findKnownCityMentions(text).some((mention) => sameCity(mention.name, homeOriginCity));
    if (mentionsHome) return "EXTENSION";
  }
  const parsedLegs = parseJourneyLegChain(text);
  if (parsedLegs.length === 0) return "NONE";
  const firstLeg = parsedLegs[0];
  if (!firstLeg) return "NONE";
  // The message restates the SAME destination already confirmed (e.g. "plan trip to Dubai" followed later
  // by "Delhi to Dubai on 12 August for 2 adults for 5 days") — this is the traveler filling in more detail
  // for the trip already in progress, never a second "Dubai after Dubai" leg to add and never ambiguous.
  // Checked before `continuesFromDestination`/AMBIGUOUS below so it can never be misread as either.
  if (confirmedDestination !== null && sameCity(firstLeg.destination, confirmedDestination)) return "NONE";
  const continuesFromDestination = confirmedDestination !== null && sameCity(firstLeg.origin, confirmedDestination);
  const returnsHome =
    homeOriginCity !== null && parsedLegs.some((leg) => sameCity(leg.destination, homeOriginCity));
  if (continuesFromDestination || returnsHome) return "EXTENSION";
  // A route was mentioned but doesn't structurally continue from where the journey currently stands — this
  // could be a genuinely separate trip, or a correction the traveler expects to be connected. Never guess;
  // ask instead (see the routing priority order's "route-extension/new-trip classification" stage).
  if (confirmedDestination !== null) return "AMBIGUOUS";
  return "NONE";
}
const SUBMIT_ENQUIRY_PATTERN = /\bsubmit\s+(?:this\s+|the\s+|my\s+)?(?:request|enquiry|inquiry|lead)\b/i;
const CREATE_LEAD_PATTERN = /\b(?:generate|create|raise|log|capture)\s+(?:my\s+|a\s+|the\s+)?lead\b/i;
// Matched independently of CREATE_LEAD/SUBMIT_ENQUIRY so a single message that asks for both ("generate
// lead and ask anyone to call") can be detected as both, even though classifyPlanningAction itself only
// ever returns one action — see the CREATE_LEAD/SUBMIT_ENQUIRY handling in `complete()`.
const REQUEST_CALLBACK_PATTERN =
  /\bcall\s+me\b|\bask\s+(?:anyone|someone|somebody)\s+to\s+call\b|\b(?:request|schedule)\s+a\s+call\s*back\b|\bcall\s*back\s+(?:please|request)\b|\bhave\s+(?:someone|somebody)\s+call\s+me\b|\bget\s+(?:someone|somebody)\s+to\s+call\s+me\b/i;

// A "complete/full/end-to-end" plan asks for everything (flights, hotels, budget, day-wise itinerary) in
// one go — must win over the plain itinerary pattern below, which only ever covers the day-wise schedule.
const COMPLETE_TRIP_PLAN_PATTERN =
  /\bcomplete\s+(?:end[\s-]?to[\s-]?end\s+)?(?:trip\s+)?plan\b|\bend[\s-]?to[\s-]?end\s+(?:trip\s+)?plan\b|\bfull\s+trip\s+plan\b|\bcomplete\s+package\b|\b(?:poora|pura)\s+plan\b|\bflights?\W+hotels?\W+itinerary\s+sab\b/i;
// Explicit "live/current/real-time" phrasing is the ONLY thing that forces a fresh provider call after a
// recent failure (see `hasBlockingProviderFailure`) — everything else defaults to indicative recommendations.
const SEARCH_LIVE_OPTIONS_PATTERN =
  /\blive\s+options?\b|\bcurrent\s+(?:flight|hotel)\s+(?:prices?|options?|availability)\b|\breal[\s-]?time\s+(?:options?|availability|prices?)\b|\blive\s+availability\b|\bactual\s+availability\b|\blive\s+(?:flights?|hotels?)\b|\blive\s+search\b|\bretry\s+(?:the\s+)?(?:live\s+)?search\b/i;
export function isExplicitLiveOptionsRequest(text: string): boolean {
  return SEARCH_LIVE_OPTIONS_PATTERN.test(text);
}
const FLIGHT_RECOMMENDATION_PATTERN =
  /\bflights?\s+recommend|\brecommend\s+(?:me\s+)?(?:some\s+)?flights?\b|\bflight\s+recommendations?\b|\bflights?\s+suggest\b/i;
const HOTEL_RECOMMENDATION_PATTERN =
  /\bhotels?\s+recommend|\brecommend\s+(?:me\s+)?(?:some\s+)?hotels?\b|\bhotel\s+recommendations?\b|\bhotels?\s+suggest\b|\bsuggest\s+(?:me\s+)?(?:some\s+)?hotels?\b/i;
// Generic — no explicit "flight"/"hotel" word — still means "recommend, don't search live"; defaults to
// GENERATE_FLIGHT_RECOMMENDATIONS since the handler always renders both flight AND hotel guidance together.
const GENERIC_RECOMMENDATION_PATTERN =
  /\brecommendations?\s+(?:bhejo|please|send|share|do|dijiye|dena|de\s+do)\b|\bsend\s+(?:me\s+)?(?:some\s+)?recommendations?\b|\bgive\s+me\s+(?:some\s+)?recommendations?\b|\bsuggest\s+(?:me\s+)?(?:a\s+)?(?:complete\s+)?package\b/i;
// Deliberately distinct from HOTEL_SEARCH_ACTION_PATTERN, mirroring BOOK_FLIGHT_ACTION_PATTERN: a definite
// go-ahead, including Hinglish SOV phrasing ("hotel book kar do"), not a browse-the-options ask.
const BOOK_HOTEL_ACTION_PATTERN =
  /\bbook\s+(?:the\s+|a\s+|my\s+|this\s+)?hotels?\b|\bhotels?\s+book\s+(?:kar\s*(?:do|dena|dijiye|dijiyega)|karo|kijiye|kijiyega)\b|\bbook\s+kar\s*(?:do|dena|dijiye|dijiyega)\s+(?:the\s+)?hotels?\b/i;

// Broad on purpose: natural itinerary asks rarely say the word "itinerary" — "trip wise day optimise",
// "din ka plan", "day wise plan mera trip" all mean the same thing. Budget/composition must never gate
// this; it is checked before every other planning action.
const ITINERARY_ACTION_PATTERN =
  /\b(day\s*[-]?\s*plan|itinerary|plan\s+(?:my|the|our|mera|humara)?\s*(?:day|din)\b|daily\s+(?:plan|schedule)|schedule\s+for\s+the\s+day|din\s+(?:ka\s+)?plan|din\s*[-]?\s*wise|day\s*[-]?\s*wise|trip\s*[-]?\s*wise|day\s*[-]?\s*by\s*[-]?\s*day|day\s+to\s+day|din\s*[-]?\s*(?:by|ba)\s*[-]?\s*din|(?:day|din)\b.{0,25}\boptimi[sz]e|optimi[sz]e.{0,25}\b(?:day|din)\b)\b/i;
// Deliberately narrower than a bare "\bhotels?\b"/"\bflights?\b": a message that merely mentions a hotel
// preference ("5-star hotel") or states a budget ("budget of 10000 USD") is not itself a request to search
// or calculate anything — only an actual ask/search framing should classify as one of these actions.
const HOTEL_SEARCH_ACTION_PATTERN =
  /\b(search|show|find|see|check)\s+(?:me\s+)?(?:some\s+)?hotels?\b|\bhotels?\s+(?:options?|please)\b|\bwhich\s+hotels?\b|\bhotels?\s+(?:batao|dikhao)\b/i;
// Deliberately distinct from FLIGHT_SEARCH_ACTION_PATTERN: "book" signals a definite go-ahead, not a
// browse-the-options ask, and must handle Hinglish SOV phrasing ("flight book kar do") where the object
// precedes the verb, not just English verb-first phrasing ("book the flight").
const BOOK_FLIGHT_ACTION_PATTERN =
  /\bbook\s+(?:the\s+|a\s+|my\s+|this\s+)?flights?\b|\bflights?\s+book\s+(?:kar\s*(?:do|dena|dijiye|dijiyega)|karo|kijiye|kijiyega)\b|\bbook\s+kar\s*(?:do|dena|dijiye|dijiyega)\s+(?:the\s+)?flights?\b|\bflight\s+booking\s+(?:kar\s*(?:do|dena)|karo)\b/i;
const FLIGHT_SEARCH_ACTION_PATTERN =
  /\b(search|show|find|see|check)\s+(?:me\s+)?(?:some\s+)?flights?\b|\bflights?\s+(?:options?|please)\b|\bwhich\s+flights?\b|\bflights?\s+(?:batao|dikhao)\b/i;
const BUDGET_ACTION_PATTERN =
  /\b(what(?:'s| is) (?:the |my )?budget|how much (?:will|does|is)|package\s+cost|total\s+cost|cost\s+of\s+(?:the\s+)?(?:trip|package)|(?:total\s+)?budget\s+(?:kitna|batao|btao|check)|calculate\s+(?:the\s+)?budget|(?:you\s+)?estimate\s+(?:the\s+|my\s+|our\s+)?(?:total\s+)?(?:trip\s+)?budget|check\s+(?:the\s+)?budget|kharch\w*\s+(?:batao|kitna|kitni|bta\s*(?:o|do))|total\s+kharch\w*)\b/i;
// Explicit "the whole journey, not just the active leg" budget ask — checked ahead of the plain
// BUDGET_ACTION_PATTERN. A plain budget ask (or "you suggest the budget") is ALSO reclassified to
// CALCULATE_JOURNEY_BUDGET, but only once a multi-leg journey actually exists — see the stateful
// reclassification in `complete()`, since that decision needs `this.journey`, not just the raw text.
const JOURNEY_BUDGET_PATTERN =
  /\b(?:full|total|overall|entire|whole|complete)\s+(?:trip|journey)\s+budget\b|\bjourney\s+budget\b|\bestimate\s+(?:the\s+)?(?:full|entire|whole|complete)?\s*(?:trip|journey)\s+budget\b|\bbudget\s+for\s+(?:the\s+)?(?:full|entire|whole|complete)\s+(?:trip|journey)\b/i;
// "kis date ko Delhi land karunga", "mai kis din wapas aungi", "when will I land/arrive/be back" — a
// conversation-state question about the journey's own final arrival date, answered directly from
// structured journey state (see `projectJourneyReturnDate`), never routed to RAG/knowledge search.
const RETURN_DATE_QUESTION_PATTERN =
  /\b(?:kis|which)\s+(?:date|din)\b.{0,25}\b(?:wapas|wapis|vapas|land\w*|arriv\w*|reach\w*|pahunch\w*)\b|\bwhen\s+(?:will\s+i|do\s+i|would\s+i|can\s+i)\b.{0,25}\b(?:land|arrive|reach|return|be\s+back)\b|\bwapas\s+(?:kab|kis\s+din)\b|\bkab\s+wapas\b|\breturn\s+date\b|\bfinal\s+arrival\s+date\b/i;
const ATTRACTIONS_ACTION_PATTERN =
  /\b(ghumne\s+layak|ghumne\s+ke\s+liye|ghumna\s+chahiye|kaha\s+ghum\w*|places?\s+to\s+(?:see|visit)|sightseeing|attractions?|things?\s+to\s+do|what\s+(?:all\s+)?(?:is|are)\s+(?:worth\s+)?(?:seeing|visiting|there\s+to\s+do))\b/i;
const FOOD_ACTION_PATTERN = /\b(food|restaurants?|cuisine|where\s+to\s+eat|khane\s+ke\s+liye|khana)\b/i;
const TRANSPORT_ACTION_PATTERN =
  /\b(transport(?:ation)?|getting\s+around|local\s+travel|commute|taxi|metro|train\s+pass)\b/i;

const currencyService = new CurrencyService();

/**
 * Deterministic detection of an explicit request to convert the last shown estimate to a different
 * currency ("give in INR", "INR me batao", "convert to dirhams") — this is never a request for a new
 * budget amount, and must never be confused with `detectBudgetModeSignal` or the plain CALCULATE_BUDGET
 * ask. Thin delegation to the standalone {@link CurrencyService} — see `currency.service.ts`.
 */
export function detectCurrencyConversionRequest(text: string): { targetCurrency: string } | null {
  const currency = currencyService.detectRequestedCurrency(text);
  return currency ? { targetCurrency: currency } : null;
}

/**
 * Deterministic classification of the traveler's current planning request, independent of LLM intent —
 * order matters: itinerary/currency-conversion/hotel/flight/budget are checked before the more general
 * informational asks (attractions/food/transport). A hotel-budget-modification request ("trim hotels",
 * "reduce hotel cost") is deliberately excluded here — that has its own dedicated, more specific flow.
 */
export function classifyPlanningAction(text: string): TravelPlanningAction {
  // Business-workflow commands always win — checked before anything else, including itinerary/booking asks.
  if (ADD_TRIP_LEG_PATTERN.test(text)) return "ADD_TRIP_LEG";
  if (SUBMIT_ENQUIRY_PATTERN.test(text)) return "SUBMIT_ENQUIRY";
  if (CREATE_LEAD_PATTERN.test(text)) return "CREATE_LEAD";
  if (REQUEST_CALLBACK_PATTERN.test(text)) return "REQUEST_CALLBACK";
  // A "complete/full/end-to-end" plan ask must never be read as only GENERATE_ITINERARY (a day-wise
  // schedule is just one section of it) — checked first between the two.
  if (COMPLETE_TRIP_PLAN_PATTERN.test(text)) return "GENERATE_COMPLETE_TRIP_PLAN";
  if (ITINERARY_ACTION_PATTERN.test(text)) return "GENERATE_ITINERARY";
  // A booking go-ahead is a stronger, more definite intent than a browse/search ask — must be checked
  // before the generic flight-search pattern so it is never miscategorized as a mere options request.
  if (BOOK_FLIGHT_ACTION_PATTERN.test(text)) return "BOOK_FLIGHT";
  if (BOOK_HOTEL_ACTION_PATTERN.test(text)) return "BOOK_HOTEL";
  // Explicit "live/current" phrasing always means a real provider call — checked before the recommendation
  // patterns below so it's never softened into an indicative-only reply.
  if (SEARCH_LIVE_OPTIONS_PATTERN.test(text)) return "SEARCH_LIVE_OPTIONS";
  if (detectCurrencyConversionRequest(text)) return "CONVERT_ESTIMATE_CURRENCY";
  if (isHotelBudgetModificationRequest(text)) return null;
  // "Recommend"/"suggest"/"send recommendations" phrasing means indicative guidance, never a live search —
  // checked before HOTEL_SEARCH_ACTION_PATTERN/FLIGHT_SEARCH_ACTION_PATTERN, whose own "search/show/find/see/
  // check" wording is what still means an actual live search.
  if (FLIGHT_RECOMMENDATION_PATTERN.test(text)) return "GENERATE_FLIGHT_RECOMMENDATIONS";
  if (HOTEL_RECOMMENDATION_PATTERN.test(text)) return "GENERATE_HOTEL_RECOMMENDATIONS";
  if (GENERIC_RECOMMENDATION_PATTERN.test(text)) return "GENERATE_FLIGHT_RECOMMENDATIONS";
  if (HOTEL_SEARCH_ACTION_PATTERN.test(text)) return "SEARCH_HOTELS";
  if (FLIGHT_SEARCH_ACTION_PATTERN.test(text)) return "SEARCH_FLIGHTS";
  if (JOURNEY_BUDGET_PATTERN.test(text)) return "CALCULATE_JOURNEY_BUDGET";
  if (BUDGET_ACTION_PATTERN.test(text)) return "CALCULATE_BUDGET";
  if (ATTRACTIONS_ACTION_PATTERN.test(text)) return "RECOMMEND_ATTRACTIONS";
  if (FOOD_ACTION_PATTERN.test(text)) return "RECOMMEND_FOOD";
  if (TRANSPORT_ACTION_PATTERN.test(text)) return "RECOMMEND_TRANSPORT";
  return null;
}

/**
 * The language the assistant must reply in. Detected from the traveler's own wording and then sticky —
 * an English city name or date word embedded in an otherwise Hinglish/Hindi message must never flip the
 * conversation back to English (see {@link detectResponseLanguage} and its upgrade-only merge).
 */
export type TravelResponseLanguage = "ENGLISH" | "HINDI" | "HINGLISH";

export type TravelPendingInputAction =
  | "AWAITING_LEAD_CONTACT"
  | "AWAITING_LEAD_CONSENT"
  | "CONFIRM_STANDALONE_CONTACT_USE"
  | "AWAITING_PASSENGER_COMPOSITION"
  | "AWAITING_TRAVEL_YEAR"
  | null;

export type ResolvedTravelInput =
  | { kind: "PENDING_CONTACT"; contact: string }
  | { kind: "PENDING_CONTACT_NON_CONTACT" }
  | { kind: "PENDING_CONTACT_PAUSED" }
  | { kind: "INVALID_CONTACT_ATTEMPT" }
  | { kind: "STANDALONE_CONTACT"; contact: string }
  | { kind: "STANDALONE_CONTACT_CONFIRMED"; contact: string }
  | { kind: "STANDALONE_CONTACT_DECLINED" }
  | { kind: "EXPLICIT_INTENT"; action: Exclude<TravelPlanningAction, null> }
  | { kind: "DATE_INPUT" }
  | { kind: "PASSENGER_INPUT" }
  | { kind: "BUDGET_INPUT" }
  | { kind: "GENERIC_NUMERIC" }
  | { kind: "LLM_FALLBACK" };

export type ConversationTurnIntent =
  | "PROVIDE_CONTACT"
  | "CONFIRM_STANDALONE_CONTACT_USE"
  | "DECLINE_STANDALONE_CONTACT_USE"
  | "PAUSE_PENDING_ACTION"
  | "ACKNOWLEDGEMENT"
  | "PROVIDE_DATE"
  | "PROVIDE_PASSENGER_COMPOSITION"
  | "PROVIDE_BUDGET"
  | "GENERIC_NUMERIC"
  | "EXPLICIT_TRAVEL_ACTION"
  | "SEMANTIC_CLASSIFICATION_REQUIRED";

export type ConversationTurnDecision = {
  intent: ConversationTurnIntent;
  entities: Record<string, unknown>;
  answersPendingAction: boolean;
  supersedesPendingAction: boolean;
  preservePendingAction: boolean;
  confidence: number;
  source: "DETERMINISTIC" | "LLM";
  planningAction?: Exclude<TravelPlanningAction, null>;
};

export type ConversationTurnContext = {
  pendingInputAction?: TravelPendingInputAction;
  pendingContactValue?: string | null;
  tripState?: TravelEntities;
  lastAssistantQuestion?: string | null;
  conversationClosed?: boolean;
  currentLeadState?: "NONE" | "PENDING" | "CREATED" | null;
};

const EMAIL_CONTACT_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_LIKE_PATTERN = /^\s*\+?[\d\s().-]{10,20}\s*$/;

export function extractContactValue(text: string): string | null {
  return extractPhoneNumber(text) ?? EMAIL_CONTACT_PATTERN.exec(text)?.[0] ?? null;
}

export function looksLikePhoneOrContact(text: string): boolean {
  return extractContactValue(text) !== null || PHONE_LIKE_PATTERN.test(text);
}

/**
 * Central arbitration boundary for every Travel Employee turn.
 *
 * A typed pending action is evidence about what the assistant expects, never an exclusive lock on the
 * next message. Explicit requests and corrections are therefore resolved before checking whether the
 * message actually answers the pending question. Ambiguous turns are deliberately returned to semantic
 * classification without mutating state; execution remains deterministic after classification.
 */
export function arbitrateConversationTurn(
  text: string,
  context: ConversationTurnContext
): ConversationTurnDecision {
  const planningAction = classifyPlanningAction(text);
  if (planningAction)
    return {
      intent: "EXPLICIT_TRAVEL_ACTION",
      entities: {},
      answersPendingAction: false,
      supersedesPendingAction: false,
      preservePendingAction: context.pendingInputAction != null,
      confidence: 1,
      source: "DETERMINISTIC",
      planningAction
    };

  const contact = extractContactValue(text);
  if (contact)
    return {
      intent:
        context.pendingInputAction === "CONFIRM_STANDALONE_CONTACT_USE"
          ? "SEMANTIC_CLASSIFICATION_REQUIRED"
          : "PROVIDE_CONTACT",
      entities: { contact },
      answersPendingAction: context.pendingInputAction === "AWAITING_LEAD_CONTACT",
      supersedesPendingAction:
        context.pendingInputAction != null &&
        context.pendingInputAction !== "AWAITING_LEAD_CONTACT",
      preservePendingAction: false,
      confidence: 1,
      source: "DETERMINISTIC"
    };

  if (context.pendingInputAction === "CONFIRM_STANDALONE_CONTACT_USE") {
    if (isAffirmativeResponse(text) && context.pendingContactValue)
      return {
        intent: "CONFIRM_STANDALONE_CONTACT_USE",
        entities: { contact: context.pendingContactValue },
        answersPendingAction: true,
        supersedesPendingAction: false,
        preservePendingAction: false,
        confidence: 1,
        source: "DETERMINISTIC"
      };
    // Sprint 6.6 — Part 15/16/38: a pending question is EVIDENCE about what the assistant expects, never
    // authority to force-fit unrelated text into it. `isNegativeResponse` matches "no"/"nahi" ANYWHERE in
    // the message — "Dubai nahi, Singapore kar do" would otherwise be misread as declining the contact
    // confirmation, silently dropping the correction. Classifying the message first and skipping this
    // branch entirely on CORRECTION/DOMAIN_PIVOT/ACTION lets it fall through to the function's own
    // existing generic tail (below), which already preserves `pendingInputAction` and hands the message to
    // ordinary extraction/routing — the fix is not a one-off `if (text === "nahi")` special case, it's not
    // entering this special case at all when the message is plainly about something else.
    const pendingContactSemantic = classifyUserInput(text, {
      hasPendingQuestion: true,
      pendingQuestionType: context.pendingInputAction
    }).semantic;
    const overridesPendingContact =
      pendingContactSemantic === "CORRECTION" ||
      pendingContactSemantic === "DOMAIN_PIVOT" ||
      pendingContactSemantic === "ACTION";
    if (!overridesPendingContact && (isNegativeResponse(text) || isFarewellMessage(text)))
      return {
        intent: "DECLINE_STANDALONE_CONTACT_USE",
        entities: {},
        answersPendingAction: true,
        supersedesPendingAction: false,
        preservePendingAction: false,
        confidence: 1,
        source: "DETERMINISTIC"
      };
  }

  const dateInput =
    parsePendingDepartureDate(text) !== null ||
    extractTravelMonth(text) !== null ||
    /\b\d{1,2}(?:st|nd|rd|th)?[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(text);
  if (dateInput)
    return {
      intent: "PROVIDE_DATE",
      entities: {},
      answersPendingAction: context.pendingInputAction === "AWAITING_TRAVEL_YEAR",
      supersedesPendingAction: false,
      preservePendingAction:
        context.pendingInputAction != null &&
        context.pendingInputAction !== "AWAITING_TRAVEL_YEAR",
      confidence: 0.98,
      source: "DETERMINISTIC"
    };

  const passengerInput =
    !looksLikePhoneOrContact(text) &&
    /\b(?:\d{1,2}\s*(?:adults?|children?|child|kids?|infants?|travell?ers?|people|pax)|(?:adults?|children?|kids?|infants?)\s*\d{1,2})\b/i.test(
      text
    );
  if (passengerInput)
    return {
      intent: "PROVIDE_PASSENGER_COMPOSITION",
      entities: {},
      answersPendingAction: context.pendingInputAction === "AWAITING_PASSENGER_COMPOSITION",
      supersedesPendingAction: false,
      preservePendingAction:
        context.pendingInputAction != null &&
        context.pendingInputAction !== "AWAITING_PASSENGER_COMPOSITION",
      confidence: 0.98,
      source: "DETERMINISTIC"
    };

  if (extractBudget(text) || currencyService.detectPreference(text))
    return {
      intent: "PROVIDE_BUDGET",
      entities: {},
      answersPendingAction: false,
      supersedesPendingAction: false,
      preservePendingAction: context.pendingInputAction != null,
      confidence: 0.98,
      source: "DETERMINISTIC"
    };

  if (context.pendingInputAction === "AWAITING_LEAD_CONTACT") {
    if (looksLikePhoneOrContact(text))
      return {
        intent: "PROVIDE_CONTACT",
        entities: { invalidContactAttempt: true },
        answersPendingAction: true,
        supersedesPendingAction: false,
        preservePendingAction: true,
        confidence: 1,
        source: "DETERMINISTIC"
      };
    // Sprint 6.6 — Part 15/16/23/38: same guard as CONFIRM_STANDALONE_CONTACT_USE above — a correction or
    // domain pivot stated while a phone number is pending must never be swallowed as "the customer
    // declined to share a number." See that block's comment for the full reasoning; this is the other of
    // the two pending-contact states that shared the exact same bug (both gated on the same unanchored
    // `isNegativeResponse` word match).
    const pendingLeadSemantic = classifyUserInput(text, {
      hasPendingQuestion: true,
      pendingQuestionType: context.pendingInputAction
    }).semantic;
    const overridesPendingLead =
      pendingLeadSemantic === "CORRECTION" ||
      pendingLeadSemantic === "DOMAIN_PIVOT" ||
      pendingLeadSemantic === "ACTION";
    if (!overridesPendingLead && isNegativeResponse(text) && !isFarewellMessage(text))
      return {
        intent: "PAUSE_PENDING_ACTION",
        entities: {},
        answersPendingAction: true,
        supersedesPendingAction: false,
        preservePendingAction: false,
        confidence: 1,
        source: "DETERMINISTIC"
      };
    if (!overridesPendingLead && isFarewellMessage(text))
      return {
        intent: "ACKNOWLEDGEMENT",
        entities: {},
        answersPendingAction: false,
        supersedesPendingAction: false,
        preservePendingAction: true,
        confidence: 1,
        source: "DETERMINISTIC"
      };
  }

  if (/^\s*\d+(?:\.\d+)?\s*$/.test(text))
    return {
      intent: "GENERIC_NUMERIC",
      entities: {},
      answersPendingAction:
        context.pendingInputAction === "AWAITING_PASSENGER_COMPOSITION" ||
        context.pendingInputAction === "AWAITING_TRAVEL_YEAR",
      supersedesPendingAction: false,
      preservePendingAction: false,
      confidence: 0.9,
      source: "DETERMINISTIC"
    };

  return {
    intent: "SEMANTIC_CLASSIFICATION_REQUIRED",
    entities: {},
    answersPendingAction: false,
    supersedesPendingAction: false,
    preservePendingAction: context.pendingInputAction != null,
    confidence: 0,
    source: "LLM"
  };
}

export function resolveTravelInput(
  text: string,
  state: ConversationTurnContext
): ResolvedTravelInput {
  const decision = arbitrateConversationTurn(text, state);
  if (decision.intent === "EXPLICIT_TRAVEL_ACTION" && decision.planningAction)
    return { kind: "EXPLICIT_INTENT", action: decision.planningAction };
  if (decision.intent === "PROVIDE_CONTACT") {
    if (decision.entities.invalidContactAttempt) return { kind: "INVALID_CONTACT_ATTEMPT" };
    const contact = decision.entities.contact;
    if (typeof contact === "string")
      return decision.answersPendingAction
        ? { kind: "PENDING_CONTACT", contact }
        : { kind: "STANDALONE_CONTACT", contact };
  }
  if (
    decision.intent === "CONFIRM_STANDALONE_CONTACT_USE" &&
    typeof decision.entities.contact === "string"
  )
    return { kind: "STANDALONE_CONTACT_CONFIRMED", contact: decision.entities.contact };
  if (decision.intent === "DECLINE_STANDALONE_CONTACT_USE")
    return { kind: "STANDALONE_CONTACT_DECLINED" };
  if (decision.intent === "ACKNOWLEDGEMENT") return { kind: "PENDING_CONTACT_NON_CONTACT" };
  if (decision.intent === "PAUSE_PENDING_ACTION") return { kind: "PENDING_CONTACT_PAUSED" };
  if (decision.intent === "PROVIDE_DATE") return { kind: "DATE_INPUT" };
  if (decision.intent === "PROVIDE_PASSENGER_COMPOSITION") return { kind: "PASSENGER_INPUT" };
  if (decision.intent === "PROVIDE_BUDGET") return { kind: "BUDGET_INPUT" };
  if (decision.intent === "GENERIC_NUMERIC") {
    if (state.pendingInputAction === "AWAITING_PASSENGER_COMPOSITION")
      return { kind: "PASSENGER_INPUT" };
    if (state.pendingInputAction === "AWAITING_TRAVEL_YEAR") return { kind: "DATE_INPUT" };
    return { kind: "GENERIC_NUMERIC" };
  }
  return { kind: "LLM_FALLBACK" };
}

const DEVANAGARI_PATTERN = /[ऀ-ॿ]/;
/** Romanized Hindi function/marker words — presence of any (as a whole word) signals Hinglish. */
const HINGLISH_MARKER_PATTERN =
  /\b(hai|hain|hoga|hogi|jana|jaana|jayenge|jaunga|chahiye|kya|kaise|kaisa|mujhe|humein|hume|tumhe|aapka|aapko|aapki|aapke|mera|meri|mere|kab|kahan|kyun|kyu|nahi|haan|theek|thik|accha|bahut|bhai|yaar|lagbhag|kripya|dhanyavad|shukriya|karo|kijiye|kijiyega|dijiye|dijiyega|batao|bataiye|abhi|paisa|paise|rupaye|rupye|wala|wali|walo)\b/i;

/**
 * Deterministic language detection for a single message: Devanagari script always means HINDI; Romanized
 * Hindi marker words (no Devanagari) mean HINGLISH; anything else defaults to ENGLISH. Never returns null
 * — callers combine this with {@link mergeResponseLanguage} so a plain English sentence never downgrades
 * an already-established Hindi/Hinglish conversation.
 */
export function detectResponseLanguage(text: string): TravelResponseLanguage {
  if (DEVANAGARI_PATTERN.test(text)) return "HINDI";
  if (HINGLISH_MARKER_PATTERN.test(text)) return "HINGLISH";
  return "ENGLISH";
}

/**
 * Sticky-but-switchable merge: a "meaningful" turn — one where `detectResponseLanguage` actually found a
 * Devanagari script or a Romanized Hindi marker word, i.e. anything other than plain ENGLISH — always
 * switches to that language immediately, in either direction (HINDI <-> HINGLISH included). Only a plain,
 * ambiguous ENGLISH-looking message (no markers at all — e.g. just an English city name or "1st Jan")
 * never resets an already-established Hindi/Hinglish conversation back to English; that's the "sticky"
 * part. This intentionally replaced an earlier upgrade-only design that could get permanently stuck on
 * HINDI even after many consecutive, clearly Hinglish turns.
 */
export function mergeResponseLanguage(
  current: TravelResponseLanguage,
  detectedThisTurn: TravelResponseLanguage
): TravelResponseLanguage {
  return detectedThisTurn === "ENGLISH" ? current : detectedThisTurn;
}

/**
 * Everything the orchestrator must carry across turns beyond the plain entity values themselves —
 * confirmation metadata, an in-flight city clarification, which field was last asked about (so a bare
 * short answer like "5" can be attributed to the right field), the current budget mode, any pending
 * action awaiting a blocking field, and the language the assistant must reply in. Persisted alongside
 * `TravelEntities` in the stored conversation state.
 */
export interface TravelConversationMemory {
  confirmation: TravelEntityConfirmation;
  pendingClarification: PendingCityClarification | null;
  lastAskedField: string | null;
  budgetMode: TravelBudgetMode;
  pendingAction: TravelPendingAction;
  pendingInputAction?: TravelPendingInputAction;
  pendingContactValue?: string | null;
  conversationClosed?: boolean;
  responseLanguage: TravelResponseLanguage;
  /**
   * True once the traveler has been shown the BELOW_MINIMUM feasibility explanation at least once.
   * Budget feasibility is a business result, not a global conversation blocker — once informed, generic
   * requests (attractions, a day plan, ...) must never re-trigger the same explanation automatically.
   * Explicitly re-asking about budget, hotels, or flights still shows it again regardless of this flag.
   */
  budgetDiscussionCompleted: boolean;
  /** The last budget estimate actually shown, if any — see {@link StoredBudgetEstimate}. */
  lastBudgetEstimate: StoredBudgetEstimate | null;
  /** A passenger-composition breakdown awaiting reconciliation against a previously stated total. */
  pendingPassengerConflict: PendingPassengerConflict | null;
  pendingDepartureDate?: PendingDepartureDate | null;
  /** The multi-leg trip this conversation is planning, if any leg has ever been finalized — see {@link Journey}. */
  journey: Journey | null;
  /** The most recent itinerary text actually generated, if any — captured into a leg when it is finalized. */
  lastGeneratedItinerary: string | null;
  /** The most recent live-provider failure, if one hasn't yet been retried — see {@link ProviderFailureRecord}. */
  providerFailure: ProviderFailureRecord | null;
  /** Where this conversation is in the Conversation Completion & Lead Capture flow — see
   * {@link ConversationCompletionStage} and `apps/api/src/conversation/conversation-completion.ts`. */
  completionStage: ConversationCompletionStage;
  /** The reference of the {@link TravelLead} captured for this conversation, if any. */
  capturedLeadReference: string | null;
  /** The traveler's chosen DISPLAY currency for cost figures — deliberately separate from the trip's
   * `budgetCurrency` (the original budget constraint, e.g. INR 50,000): a "share in USD" request only
   * changes how amounts are shown, never the underlying budget. Null until the traveler asks for one. */
  displayCurrency: string | null;
  /**
   * Set when `classifyRouteRelationship` returns "AMBIGUOUS" — the traveler mentioned a route that neither
   * structurally continues the current journey nor states outright that it's a new trip. `originalMessage`
   * is kept so the answer ("same trip" / "separate trip") can be applied to the route actually described,
   * without asking the traveler to repeat themselves. A bare Hinglish affirmative ("ji"/"haan") must NEVER
   * resolve this by itself — see the routing priority order's "resolve active clarification" stage.
   */
  pendingRouteClarification: { originalMessage: string; fromDestination: string | null; toDestination: string | null } | null;
  /** The three simulated package options most recently shown, if any — see
   * `travel-package-options.ts`'s `SimulatedPackageOption`. Selection ("Option 2") is validated against
   * THIS persisted array, never against re-parsed prior chat prose. Cleared once a booking is confirmed
   * (a fresh "book" ask always regenerates a new set rather than resurrecting a stale one). */
  pendingRecommendations: SimulatedPackageOption[] | null;
  /** `recommendationId` of the option the traveler picked from `pendingRecommendations`, if any. */
  selectedRecommendationId: string | null;
  /** Name/age/gender collected so far for the current booking's travellers (see
   *  `AWAITING_PASSENGER_DETAILS`) — cleared once the booking is confirmed (or abandoned via a fresh
   *  "book" ask), never carried over into an unrelated later booking. */
  passengerDetails: PassengerDetail[] | null;
  /** Partial identity given so far for a "resend my ticket" request (see
   *  `AWAITING_RESEND_TICKET_DETAILS`) — cleared once the lookup tool call is issued or the request is
   *  abandoned. */
  pendingResendLookup: { email: string | null; travelDate: string | null } | null;
  /** Email/WhatsApp number to actually send the confirmed ticket to (see `AWAITING_TICKET_CONTACT`) —
   *  either field alone is enough; both null only if the traveler explicitly skipped this step. Carried
   *  through to `TravelBooking.customerEmail`/`customerPhone`. */
  ticketContact: { email: string | null; phone: string | null } | null;
  /** True once the traveler has given an explicit affirmative reply to "would you like to continue with
   *  options above your budget?" (see `AWAITING_BUDGET_OVERRIDE_CONFIRMATION`) — the ONLY way this is ever
   *  set. Persists for the rest of the conversation so a later re-evaluation of the same BELOW_MINIMUM
   *  budget never re-asks; a decline (or simply never being asked) leaves this false and above-budget
   *  options are never shown. */
  budgetOverrideAccepted: boolean;
}

/**
 * A live flight/hotel provider call that failed, kept so a later VAGUE follow-up ("recommendations bhejo",
 * a bare "yes") doesn't blindly retry the same broken call — only an explicit "live/current" ask, or a
 * fresh explicit SEARCH_FLIGHTS/SEARCH_HOTELS/BOOK_FLIGHT/BOOK_HOTEL request, does. `provider` is the tool
 * name that failed; `retryable` is currently always true (every failure here is a transient technical one,
 * never a permanent business result — those are handled separately via BELOW_MINIMUM feasibility).
 */
export interface ProviderFailureRecord {
  failedAction: "SEARCH_LIVE_OPTIONS" | "BOOK_FLIGHT" | "BOOK_HOTEL";
  provider: string;
  failedAt: string;
  retryable: boolean;
  /** Which of the three recovery-menu options the traveler picked, if any — see {@link ProviderFailureRecoverySelection}. */
  selectedRecoveryAction: ProviderFailureRecoverySelection | null;
  /**
   * Whether a bare "1"/"2"/"3" reply should still be interpreted as a recovery-menu pick right now. Starts
   * true when the menu is shown; set false the moment ANY other explicit planning action fires (the
   * traveler has moved on) or once `menuExpiresAt` has passed — whichever comes first. `providerFailure`
   * itself is NOT cleared when this goes false: the broader "don't blindly retry a known-broken provider"
   * gate must keep working even after the numeric-reply window has closed.
   */
  menuActive: boolean;
  /** ISO timestamp after which a bare digit reply is no longer treated as a menu pick, even if still active. */
  menuExpiresAt: string;
}

/** The three choices offered after a provider failure — see {@link buildProviderFailureRecoveryOffer}. */
export type ProviderFailureRecoverySelection = "INDICATIVE_RECOMMENDATIONS" | "RETRY_LIVE_SEARCH" | "CALLBACK";

/**
 * A composition breakdown that didn't add up to a previously confirmed total headcount, kept as a
 * candidate so a follow-up correction ("1 infant") can patch just that one field and be re-checked against
 * `expectedTotal`, rather than being interpreted in isolation with no memory of the rest of the breakdown.
 */
export interface PendingPassengerConflict {
  expectedTotal: number;
  candidateAdults: number | null;
  candidateChildren: number | null;
  candidateInfants: number | null;
}

/**
 * The business-workflow status of a {@link Journey}. The orchestrator itself only ever advances a journey
 * as far as `ENQUIRY_SUBMITTED` (submitting it to the CRM) — `SALES_ASSIGNED`, `BOOKED`, and `COMPLETED` are
 * downstream states a human sales/ops workflow sets later (e.g. via the CRM), not something a single
 * conversational turn can determine; the type still models them so a consumer of a persisted `Journey`
 * record has a single, complete status vocabulary to switch on.
 */
export type JourneyStatus =
  | "DRAFT"
  | "PLANNING"
  | "ESTIMATE_READY"
  | "ENQUIRY_SUBMITTED"
  | "SALES_ASSIGNED"
  | "BOOKED"
  | "COMPLETED";

/** One leg's dates — kept as its own shape (rather than flattened) so a leg reads as a self-contained record. */
export interface JourneyLegDates {
  travelMonth: string | null;
  departureDate: string | null;
  returnDate: string | null;
  /**
   * True only when `departureDate` was derived from a prior leg's date + stay duration (see
   * `deriveNextLegDepartureDate`), never stated outright by the traveler — must stay visible wherever this
   * leg's date is shown, per the "clearly label derived dates as assumptions" requirement. Older persisted
   * journeys predate this field and are read back as `false` (a safe "treat as stated" default — there is
   * no way to recover which of those dates were actually assumptions after the fact).
   */
  departureDateIsAssumption: boolean;
}
export interface JourneyLegDuration {
  days: number | null;
  nights: number | null;
}
export interface JourneyLegPassengers {
  adults: number | null;
  children: number | null;
  infants: number | null;
  totalTravellers: number | null;
}
export interface JourneyLegBudget {
  amount: number | null;
  currency: string | null;
}

/**
 * One origin-to-destination leg of a multi-leg {@link Journey} — everything specific to that single trip
 * segment. Traveler-identity facts that carry across every leg (home departure city, cabin/hotel
 * preferences) live on `Journey.travellerProfile` instead, not duplicated per leg.
 */
export interface JourneyLeg {
  /** 1-indexed position within `Journey.legs` — kept as an explicit field (not just array order) per spec. */
  sequence: number;
  origin: string | null;
  destination: string | null;
  dates: JourneyLegDates;
  duration: JourneyLegDuration;
  passengers: JourneyLegPassengers;
  budget: JourneyLegBudget;
  itinerary: string | null;
  estimates: StoredBudgetEstimate | null;
  destinationRole?: "STAY_DESTINATION" | "CONNECTION" | "FINAL_RETURN";
}

/** Traveler-identity facts shared across every leg of a {@link Journey}. */
export interface JourneyTravellerProfile {
  originCity: string | null;
  cabinClass: string | null;
  hotelStars: number | null;
  preferences: string[];
}

/**
 * A traveler's full, potentially multi-leg trip — created lazily the first time a leg is finalized (via
 * ADD_TRIP_LEG) or a lead is captured for a single-leg trip that was never split.
 */
export interface Journey {
  id: string;
  /** Monotonic structural revision; increments only when a leg or destination stay actually changes. */
  version?: number;
  travellerProfile: JourneyTravellerProfile;
  status: JourneyStatus;
  legs: JourneyLeg[];
}

export const EMPTY_TRAVEL_CONVERSATION_MEMORY: TravelConversationMemory = {
  confirmation: EMPTY_TRAVEL_ENTITY_CONFIRMATION,
  pendingClarification: null,
  lastAskedField: null,
  budgetMode: "UNKNOWN",
  pendingAction: null,
  pendingInputAction: null,
  pendingContactValue: null,
  conversationClosed: false,
  responseLanguage: "ENGLISH",
  budgetDiscussionCompleted: false,
  lastBudgetEstimate: null,
  pendingPassengerConflict: null,
  pendingDepartureDate: null,
  journey: null,
  lastGeneratedItinerary: null,
  providerFailure: null,
  completionStage: "NOT_OFFERED",
  capturedLeadReference: null,
  displayCurrency: null,
  pendingRouteClarification: null,
  pendingRecommendations: null,
  selectedRecommendationId: null,
  passengerDetails: null,
  pendingResendLookup: null,
  ticketContact: null,
  budgetOverrideAccepted: false
};

export interface TravelEmployeeRuntimeConfig {
  persona: string;
  welcomeMessage: string;
  escalationContact: string;
  brandTone: string;
  defaultCurrency: string;
  defaultLanguage: string;
  businessHoursStart: string | null;
  businessHoursEnd: string | null;
  businessHoursTimezone: string | null;
}

export const DEFAULT_TRAVEL_EMPLOYEE_CONFIG: TravelEmployeeRuntimeConfig = {
  persona:
    "A friendly, efficient AI travel consultant who plans trips without ever claiming to complete a real booking.",
  welcomeMessage: "Hi \u{1F44B}, I am your travel companion. May I know your name, please?",
  escalationContact: "support@ai-workforce-os.example",
  brandTone: "FRIENDLY",
  defaultCurrency: "USD",
  defaultLanguage: "en",
  businessHoursStart: null,
  businessHoursEnd: null,
  businessHoursTimezone: null
};

const EMPTY_SLOTS: TravelSlots = {
  destination: null,
  travelMonth: null,
  durationDays: null,
  passengers: null,
  budgetAmount: null,
  budgetCurrency: null
};

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
];

export const KNOWN_DESTINATIONS = [
  "dubai",
  "paris",
  "london",
  "new york",
  "tokyo",
  "singapore",
  "bali",
  "goa",
  "kerala",
  "manali",
  "rome",
  "bangkok",
  "istanbul",
  "maldives",
  "bangalore",
  "mumbai",
  "delhi",
  "amsterdam",
  "barcelona",
  "sydney",
  "cape town",
  "zurich",
  "vienna",
  "prague",
  "lisbon",
  "phuket",
  "kuala lumpur",
  "hong kong",
  "seoul",
  "san francisco",
  "los angeles",
  "miami",
  "toronto",
  "dublin",
  "edinburgh",
  "venice",
  "milan",
  "santorini",
  "mykonos",
  "jaipur",
  "udaipur",
  "shimla",
  "darjeeling",
  "ooty",
  "munnar",
  "andaman",
  "adelaide",
  "melbourne",
  "perth",
  "brisbane",
  "auckland",
  "new delhi",
  "washington",
  "kolkata",
  "chennai",
  "hyderabad",
  "pune",
  "ahmedabad",
  "kochi"
];

/**
 * City -> country, for domestic/international travel classification (see `isDomesticTrip`). Keyed by the
 * same lowercase spellings as `KNOWN_DESTINATIONS`. A city missing from this map classifies as unknown
 * (`countryOf` returns null) rather than guessed — `isDomesticTrip` only ever returns true when BOTH
 * cities are positively known to be in the same country, so an unrecognized city never causes a domestic
 * trip to be misclassified as domestic (the safer default, matching the pre-existing international-style
 * estimate, is preserved when classification is uncertain).
 */
const CITY_COUNTRY: Record<string, string> = {
  dubai: "UAE",
  paris: "France",
  london: "UK",
  "new york": "USA",
  tokyo: "Japan",
  singapore: "Singapore",
  bali: "Indonesia",
  goa: "India",
  kerala: "India",
  manali: "India",
  rome: "Italy",
  bangkok: "Thailand",
  istanbul: "Turkey",
  maldives: "Maldives",
  bangalore: "India",
  mumbai: "India",
  delhi: "India",
  amsterdam: "Netherlands",
  barcelona: "Spain",
  sydney: "Australia",
  "cape town": "South Africa",
  zurich: "Switzerland",
  vienna: "Austria",
  prague: "Czechia",
  lisbon: "Portugal",
  phuket: "Thailand",
  "kuala lumpur": "Malaysia",
  "hong kong": "Hong Kong",
  seoul: "South Korea",
  "san francisco": "USA",
  "los angeles": "USA",
  miami: "USA",
  toronto: "Canada",
  dublin: "Ireland",
  edinburgh: "UK",
  venice: "Italy",
  milan: "Italy",
  santorini: "Greece",
  mykonos: "Greece",
  jaipur: "India",
  udaipur: "India",
  shimla: "India",
  darjeeling: "India",
  ooty: "India",
  munnar: "India",
  andaman: "India",
  adelaide: "Australia",
  melbourne: "Australia",
  perth: "Australia",
  brisbane: "Australia",
  auckland: "New Zealand",
  "new delhi": "India",
  washington: "USA",
  kolkata: "India",
  chennai: "India",
  hyderabad: "India",
  pune: "India",
  ahmedabad: "India",
  kochi: "India"
};

/** Looks up a city's country from the curated catalog above — case/whitespace-insensitive, returns null
 * for an unrecognized city rather than guessing. */
export function countryOf(city: string | null): string | null {
  if (!city) return null;
  return CITY_COUNTRY[city.trim().toLowerCase()] ?? null;
}

/**
 * True only when both the origin and destination city are positively known to be in the same country —
 * this is what gates Visa/Insurance out of a budget estimate (see `estimateBudgetRange`). Deliberately
 * conservative: an unknown origin or destination never yields `true`, so an unrecognized city cannot
 * cause a genuinely international trip to be under-estimated by silently dropping Visa/Insurance.
 */
export function isDomesticTrip(originCity: string | null, destinationCity: string | null): boolean {
  const originCountry = countryOf(originCity);
  const destinationCountry = countryOf(destinationCity);
  return originCountry !== null && destinationCountry !== null && originCountry === destinationCountry;
}

/**
 * Scans every user message for the traveler's own name — explicit self-introductions first ("my name is
 * X", "I'm X", "X here"), then a bare short reply anywhere in the transcript (the direct answer to the
 * greeting's "may I know your name?"). Never infers a name from a city, month, or other trip detail.
 * Returns null (never guesses) until a real signal is found.
 *
 * Sprint 6.5 — Part 6: delegates to the shared, platform-level `classifyIdentityCandidate` (identity is a
 * conversation/customer concept, not a Travel concept) instead of Travel's own, previously independently
 * maintained stopword list/patterns — see identity-capture.ts for the full rationale and the shared
 * vocabulary (which now also excludes "Great"/"Got it", a gap this file's own narrower list had).
 */
export function extractCustomerName(userMessages: readonly string[]): string | null {
  for (const message of userMessages) {
    const candidate = classifyIdentityCandidate(message, { knownValueWords: KNOWN_DESTINATIONS });
    if (candidate?.confidence === "HIGH") return candidate.name;
  }
  for (const message of userMessages) {
    const candidate = classifyIdentityCandidate(message, { knownValueWords: KNOWN_DESTINATIONS });
    if (candidate) return candidate.name;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function titleCase(value: string): string {
  return value.replace(/\b\w/g, (character) => character.toUpperCase());
}

function levenshteinDistance(a: string, b: string): number {
  let previousRow: number[] = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const currentRow: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = (previousRow[j] ?? 0) + 1;
      const insertion = (currentRow[j - 1] ?? 0) + 1;
      const substitution = (previousRow[j - 1] ?? 0) + substitutionCost;
      currentRow.push(Math.min(deletion, insertion, substitution));
    }
    previousRow = currentRow;
  }
  return previousRow[b.length] ?? 0;
}

/**
 * Normalizes a free-text city name against the known-destination catalog so minor typos ("peris") and
 * inconsistent casing ("london") converge on one canonical spelling that then persists in state for the
 * rest of the conversation. Falls back to plain title-casing for cities outside the catalog.
 */
export function normalizeCityName(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const alias = trimmed.toLowerCase().replace(/[\s._-]+/g, "");
  if (alias === "nyc" || alias === "newyork") return "New York";
  const lower = trimmed.toLowerCase();
  let best: { name: string; distance: number } | null = null;
  for (const destination of KNOWN_DESTINATIONS) {
    const distance = levenshteinDistance(lower, destination);
    if (!best || distance < best.distance) best = { name: destination, distance };
  }
  const threshold = Math.max(1, Math.floor(lower.length * 0.25));
  if (best && best.distance <= threshold) return titleCase(best.name);
  return titleCase(trimmed);
}

export function extractDestination(text: string): string | null {
  const lower = text.toLowerCase();
  for (const destination of KNOWN_DESTINATIONS)
    if (new RegExp(`\\b${escapeRegExp(destination)}\\b`, "i").test(lower)) return titleCase(destination);
  const match = /\b(?:to|in|visit(?:ing)?)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})/.exec(text);
  return match?.[1] ? match[1].trim() : null;
}

/**
 * Sprint 6.5 — Part 7/29: a deterministic (no-LLM) origin extractor for an explicit "from <City>" phrase
 * — unambiguous by construction ("from" is a strong, dedicated origin signal), unlike a bare city name
 * which needs the pending-question context to disambiguate from a destination (see
 * `resolveOriginReplyDeterministically` below, used only when the assistant explicitly asked "where are
 * you traveling FROM?"). Stops at "to"/a comma/period/end so "from Delhi to Dubai" still yields "Delhi",
 * not "Delhi to Dubai" — connected route pairs are otherwise handled by `reconcileRouteFromMessage`.
 */
export function extractOriginCity(text: string): string | null {
  const match = /\bfrom\s+([A-Za-z][A-Za-z\s]{1,30}?)(?:\s+to\b|[,.]|$)/i.exec(text);
  if (!match?.[1]) return null;
  const captured = match[1].trim();
  const capturedLower = captured.toLowerCase();
  // Prefer an exact known-destination match within the captured span (handles "from delhi" lowercase)
  // before falling back to a bare proper-noun run — the lazy capture above has no stopping boundary other
  // than "to"/a comma/period/end, so an unknown city followed by trailing filler ("from Mumbai please")
  // would otherwise swallow the filler word too.
  for (const destination of KNOWN_DESTINATIONS)
    if (new RegExp(`\\b${escapeRegExp(destination)}\\b`).test(capturedLower)) return titleCase(destination);
  const properNoun = /^[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*){0,2}/.exec(captured);
  return properNoun ? normalizeCityName(properNoun[0]) : null;
}

/**
 * Resolves a reply to a DEDICATED "where are you traveling from?" question deterministically: an
 * explicit "from <City>" phrase, or — since the pending question itself disambiguates a bare reply that
 * would otherwise be indistinguishable from a destination — any known city name via the same catalog
 * `extractDestination` already scans, reinterpreted as origin in this specific context. Never called
 * outside that context, so it can never misfile an ordinary destination-bearing message as origin.
 */
export function resolveOriginReplyDeterministically(text: string): string | null {
  return extractOriginCity(text) ?? normalizeCityName(extractDestination(text));
}

// Longest names first so "new delhi" wins over "delhi" when both could match at the same position —
// regex alternation tries left-to-right and stops at the first alternative that matches. Multi-word names
// use `\s*` (not a literal space) between words so a real, common typing pattern — "newyork", "hongkong",
// "kualalumpur" with no space at all — still matches, not just the properly spaced form.
const KNOWN_CITY_MENTION_PATTERN = new RegExp(
  `\\b(${[...KNOWN_DESTINATIONS]
    .sort((a, b) => b.length - a.length)
    .map((destination) => destination.split(" ").map(escapeRegExp).join("\\s*"))
    .join("|")})\\b`,
  "gi"
);
// Maps a whitespace-compressed destination ("newyork") back to its canonical, properly-spaced titleCase
// form ("New York") — `findKnownCityMentions` matches the compressed form but must never surface it as the
// mention's name, or every downstream leg/route string would silently lose the space.
const KNOWN_DESTINATION_BY_COMPRESSED = new Map<string, string>(
  KNOWN_DESTINATIONS.map((destination) => [destination.replace(/\s+/g, ""), titleCase(destination)])
);

interface CityMention {
  name: string;
  index: number;
  length: number;
}

export function findKnownCityMentions(text: string): CityMention[] {
  return [...text.matchAll(KNOWN_CITY_MENTION_PATTERN)].map((match) => {
    const raw = (match[1] ?? "").toLowerCase();
    const name = KNOWN_DESTINATION_BY_COMPRESSED.get(raw.replace(/\s+/g, "")) ?? titleCase(raw);
    return { name, index: match.index ?? 0, length: match[0].length };
  });
}

/**
 * Binds a stay duration to whichever known city it's stated against — "London me 3 din ka stay" or "3
 * nights in London" — by looking at a small text window immediately after (Hinglish "CITY me N din ka
 * stay") or immediately before (English "N days/nights in CITY") each city mention found, rather than
 * capturing an open-ended run of characters as the city name — free text between unrelated city mentions
 * would otherwise be swept into the capture. Anchored (`^`/`$` against the windowed slice), so it can never
 * span past a clause it doesn't belong to.
 */
interface StayDurationParseResult {
  bindings: Map<string, { days: number | null; nights: number | null }>;
  /** Indices of mentions that are themselves PART OF a stay-duration phrase — e.g. the "London" in "London
   *  me 3 din ka stay" — and must therefore be excluded from route-chain construction: that mention isn't
   *  describing a new leg, only annotating an already-chained one. */
  consumedIndices: Set<number>;
}

function parseStayDurationBindings(text: string, mentions: readonly CityMention[]): StayDurationParseResult {
  const bindings = new Map<string, { days: number | null; nights: number | null }>();
  const consumedIndices = new Set<number>();
  // A stay-annotation mention is only a REDUNDANT annotation (to be excluded from the route chain) when the
  // same city also appears elsewhere — e.g. "...London se Delhi, London me 3 din ka stay". When a city
  // appears just once and carries its own stay ("3 days Tokyo me"), that single mention IS the route node
  // and must stay in the chain; consuming it would drop the leg entirely (the multi-city UAT defect).
  const occurrences = new Map<string, number>();
  for (const mention of mentions)
    occurrences.set(mention.name.toLowerCase(), (occurrences.get(mention.name.toLowerCase()) ?? 0) + 1);
  const bind = (mention: CityMention, days: number | null, nights: number | null): void => {
    bindings.set(mention.name.toLowerCase(), { days, nights });
    if ((occurrences.get(mention.name.toLowerCase()) ?? 0) > 1) consumedIndices.add(mention.index);
  };
  for (const mention of mentions) {
    const afterCity = text.slice(mention.index + mention.length, mention.index + mention.length + 40);
    // "CITY me N din/days/raat (ka stay)?" — the "ka stay" suffix is optional: "Tokyo me 3 days" and
    // "London me 3 din ka stay" are both real UAT phrasings for the same thing.
    const hinglishMatch = /^\s*me(?:in)?\s+(\d{1,3})\s*(din|days?|nights?|raat(?:ein|en)?|rat)\b(?:\s+ka\s+stay\b)?/i.exec(afterCity);
    if (hinglishMatch) {
      const amount = Number(hinglishMatch[1]);
      const unit = (hinglishMatch[2] ?? "").toLowerCase();
      const isNight = unit.startsWith("night") || unit.startsWith("raat") || unit === "rat";
      bind(mention, isNight ? null : amount, isNight ? amount : null);
      continue;
    }
    const directStayMatch = /^\s+(\d{1,3})\s*(din|days?|nights?|raat(?:ein|en)?|rat)\b(?:\s+(?:ka\s+)?stay\b)?/i.exec(afterCity);
    if (directStayMatch) {
      const amount = Number(directStayMatch[1]);
      const unit = (directStayMatch[2] ?? "").toLowerCase();
      const isNight = unit.startsWith("night") || unit.startsWith("raat") || unit === "rat";
      bind(mention, isNight ? null : amount, isNight ? amount : null);
      continue;
    }
    const beforeCity = text.slice(Math.max(0, mention.index - 40), mention.index);
    // Hinglish "N din/days/raat CITY me" — the number precedes the city and "me/mein" follows it
    // ("3 days Tokyo me", "2 din London me", "3 raat Tokyo mein"). This is the exact multi-city phrasing
    // from UAT that the earlier parser missed.
    const hinglishBeforeMatch = /(\d{1,3})\s*(din|days?|nights?|raat(?:ein|en)?|rat)\s+$/i.exec(beforeCity);
    const followedByMe = /^\s*me(?:in)?\b/i.test(afterCity);
    if (hinglishBeforeMatch && followedByMe) {
      const amount = Number(hinglishBeforeMatch[1]);
      const unit = (hinglishBeforeMatch[2] ?? "").toLowerCase();
      const isNight = unit.startsWith("night") || unit.startsWith("raat") || unit === "rat";
      bind(mention, isNight ? null : amount, isNight ? amount : null);
      continue;
    }
    const englishMatch = /(\d{1,3})\s*(days?|nights?)\s+(?:stay\s+)?in\s*$/i.exec(beforeCity);
    if (englishMatch) {
      const amount = Number(englishMatch[1]);
      const unit = (englishMatch[2] ?? "").toLowerCase();
      bind(mention, unit.startsWith("night") ? null : amount, unit.startsWith("night") ? amount : null);
    }
  }
  return { bindings, consumedIndices };
}

export interface ParsedJourneyLeg {
  origin: string;
  destination: string;
  days: number | null;
  nights: number | null;
}

/**
 * Parses one or more origin->destination legs described in a single free-text message — e.g. "Washington se
 * London aur fir London se Delhi, London me 3 din ka stay hai" -> [Washington->London (3 days), London->Delhi
 * (no stay, a same-day connecting/return leg)]. Deliberately anchored on {@link KNOWN_DESTINATIONS} mentions
 * rather than parsing sentence connectors ("se"/"to"/"aur fir") directly: free-text connector parsing is
 * fragile against multi-word city names and trailing clauses, whereas chaining known-city mentions in the
 * order they appear is robust and simple — a repeated mention (the same city ending one leg and starting
 * the next) collapses into a single shared chain node instead of producing a bogus self-loop leg. A mention
 * that's part of a stay-duration phrase (see {@link parseStayDurationBindings}) is excluded from the chain
 * entirely — it annotates a leg, it never introduces one.
 */
export function parseJourneyLegChain(text: string): ParsedJourneyLeg[] {
  const mentions = findKnownCityMentions(text);
  const { bindings: stayBindings, consumedIndices } = parseStayDurationBindings(text, mentions);
  const routeMentions = mentions.filter((mention) => !consumedIndices.has(mention.index));

  const chain: CityMention[] = [];
  for (const mention of routeMentions) {
    const last = chain[chain.length - 1];
    if (last && last.name.toLowerCase() === mention.name.toLowerCase()) continue;
    chain.push(mention);
  }

  const legs: ParsedJourneyLeg[] = [];
  for (let index = 0; index < chain.length - 1; index++) {
    const origin = chain[index]?.name ?? "";
    const destination = chain[index + 1]?.name ?? "";
    const binding = stayBindings.get(destination.toLowerCase()) ?? { days: null, nights: null };
    legs.push({ origin, destination, days: binding.days, nights: binding.nights });
  }
  return legs;
}

/**
 * Finds a stay-duration restatement for one already-known city inside free text, even when that city is
 * never a DESTINATION within {@link parseJourneyLegChain}'s parsed chain — e.g. in "Tokyo me 3 days, phir
 * London me 2 days, then back to Delhi", "Tokyo" only ever appears as the ORIGIN of the new Tokyo->London
 * leg, so `parseJourneyLegChain` never attaches "3 days" to it. That "3 days" is really a correction/
 * confirmation of the duration for the CURRENT, about-to-be-finalized leg (New Delhi->Tokyo), which this
 * helper recovers by re-scanning for stay bindings scoped to just that one city name.
 */
export function extractStayOverrideForCity(
  text: string,
  city: string | null
): { days: number | null; nights: number | null } | null {
  if (!city) return null;
  const mentions = findKnownCityMentions(text).filter((m) => m.name.toLowerCase() === city.toLowerCase());
  if (mentions.length === 0) return null;
  const { bindings } = parseStayDurationBindings(text, mentions);
  return bindings.get(city.toLowerCase()) ?? null;
}

/** Adds `days` calendar days to an ISO-ish "YYYY-MM-DD" date string. Returns null if unparseable. */
function addCalendarDays(dateString: string, days: number): string | null {
  const date = new Date(`${dateString}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface DerivedNextLegDate {
  departureDate: string | null;
  /** True whenever a date IS returned but was computed (prior leg's date + stay), never explicitly stated. */
  isAssumption: boolean;
}

/**
 * A later leg's departure date is never known outright when it's parsed from the same message as the
 * legs before it — but a TENTATIVE one can be derived from the immediately preceding leg's own departure
 * date plus its stay duration (days, or nights+1 when only nights is known). Must always be surfaced as an
 * assumption in the conversation (see `buildMultiLegAddedMessage`), never presented as a confirmed date.
 */
export function deriveNextLegDepartureDate(priorLeg: {
  departureDate: string | null;
  days: number | null;
  nights: number | null;
}): DerivedNextLegDate {
  if (!priorLeg.departureDate) return { departureDate: null, isAssumption: false };
  const stayDays = priorLeg.days ?? (priorLeg.nights !== null ? priorLeg.nights + 1 : null);
  if (stayDays === null) return { departureDate: null, isAssumption: false };
  const derived = addCalendarDays(priorLeg.departureDate, stayDays);
  return { departureDate: derived, isAssumption: derived !== null };
}

/** 3-4 letter month abbreviations this file already recognizes elsewhere (`monthIndexOf`/`MONTH_ABBREVIATIONS`
 * further down, used by `parseAbsoluteDate`) — kept here as a plain list (not the number-keyed map, which
 * is declared later and used via `monthIndexOf`) purely to build the matching regex below. */
const MONTH_ABBREVIATION_WORDS = ["jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"];

/** A message like "10 Sept 2026" or "1 Oct 2026" previously matched full month names only, so this
 * returned null and the caller re-asked "which month?" forever, even though the user had already
 * answered — every later reply, including "book"/"confirm booking", kept getting reinterpreted as an
 * answer to that same stuck question. Delegates the abbreviation -> full-name resolution to `monthIndexOf`
 * (declared later in this file) so there is exactly one abbreviation table, not two. */
export function extractTravelMonth(text: string): string | null {
  const lower = text.toLowerCase();
  const match = new RegExp(`\\b(${[...MONTHS, ...MONTH_ABBREVIATION_WORDS].join("|")})\\b`, "i").exec(lower);
  if (!match?.[1]) return null;
  const index = monthIndexOf(match[1]);
  return index === null ? null : titleCase(MONTHS[index] ?? "");
}

export function extractDurationDays(text: string): number | null {
  const match = /(\d{1,3})[\s-]*(?:days?|din)\b/i.exec(text);
  return match?.[1] ? Number(match[1]) : null;
}

export function extractPassengerComposition(
  text: string
): Pick<TravelEntities, "adults" | "children" | "infants" | "totalTravellers"> {
  if (looksLikePhoneOrContact(text))
    return { adults: null, children: null, infants: null, totalTravellers: null };
  const count = (pattern: RegExp): number | null => {
    const match = pattern.exec(text);
    return match?.[1] ? Number(match[1]) : null;
  };
  const adults = count(/\b(\d{1,2})\s*(?:adults?|grownups?)\b/i);
  const children = count(/\b(\d{1,2})\s*(?:children?|child|kids?)\b/i);
  const infants = count(/\b(\d{1,2})\s*(?:infants?|bab(?:y|ies))\b/i);
  const explicit = adults !== null || children !== null || infants !== null;
  return {
    adults,
    children,
    infants,
    totalTravellers: explicit ? (adults ?? 0) + (children ?? 0) + (infants ?? 0) : extractPassengers(text)
  };
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10
};
const NUMBER_WORD_BY_VALUE: Record<number, string> = Object.fromEntries(
  Object.entries(NUMBER_WORDS).map(([word, value]) => [value, word])
);
/** Spells out small counts ("Five") for natural sentences; falls back to the plain digit for anything larger. */
function numberToWord(value: number): string {
  return NUMBER_WORD_BY_VALUE[value] ?? String(value);
}

export function extractPassengers(text: string): number | null {
  if (looksLikePhoneOrContact(text)) return null;
  const numeric = /(\d{1,2})\s*(?:adults?|passengers?|people|log|travell?ers?|pax|persons?)\b/i.exec(text);
  if (numeric?.[1]) return Number(numeric[1]);
  const family = /family of (\d{1,2})/i.exec(text);
  if (family?.[1]) return Number(family[1]);
  const total = /\btotal\s+(\d{1,2})\b/i.exec(text);
  if (total?.[1]) return Number(total[1]);
  for (const [word, value] of Object.entries(NUMBER_WORDS))
    if (
      new RegExp(`\\b${word}\\b\\s+(?:adults?|passengers?|people|log|travell?ers?)`, "i").test(text) ||
      new RegExp(`(?:adults?|passengers?|people|log|travell?ers?)\\D{0,10}\\b${word}\\b`, "i").test(text)
    )
      return value;
  return null;
}

export function extractBudget(
  text: string,
  fallbackCurrency: string | null = null
): { amount: number; currency: string | null } | null {
  // Sprint 6.6 — Part 22: "lac"/"lacs" is the other common spelling of "lakh"/"lakhs" — same multiplier,
  // same branch.
  const lakh = /(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:lakhs?|lacs?)\b/i.exec(text);
  if (lakh?.[1])
    return { amount: Math.round(parseFloat(lakh[1].replace(/,/g, "")) * 100_000), currency: "INR" };
  // Sprint 6.6 — Part 22: "10k"/"10 K"/"10 thousand"/"10 hazar"/"10 हज़ार" — a safe, explicit x1000
  // multiplier suffix, mirroring the lakh branch above. An explicit ₹/Rs/INR prefix (or the Hindi word
  // itself, which is unambiguously a rupee term) resolves the currency to INR; otherwise the caller's
  // `fallbackCurrency` is used, exactly like the generic bare-number branch at the bottom of this function
  // already does — this never guesses a currency the traveler didn't actually state or imply.
  const thousand =
    /((?:₹|rs\.?|inr)\s*)?([\d,]+(?:\.\d+)?)\s*(?:k|hazar|हज़ार|हजार|thousand)\s*(usd|inr|eur|aed|gbp|sgd|cad|aud|thb|jpy)?\b/i.exec(
      text
    );
  if (thousand?.[2]) {
    // A trailing currency code ("10k AED") always wins — never overridden by the rupee-leaning defaults
    // below, which only apply when the traveler didn't actually state a currency at all.
    const trailingCurrency = thousand[3] ? thousand[3].toUpperCase() : null;
    const isRupee = Boolean(thousand[1]) || /hazar|हज़ार|हजार/i.test(thousand[0]);
    return {
      amount: Math.round(parseFloat(thousand[2].replace(/,/g, "")) * 1_000),
      currency: trailingCurrency ?? (isRupee ? "INR" : fallbackCurrency)
    };
  }
  const dollars = /\$\s*(\d[\d,]*(?:\.\d+)?)|(?:usd)\s*(\d[\d,]*(?:\.\d+)?)/i.exec(text);
  if (dollars)
    return {
      amount: Math.round(parseFloat((dollars[1] ?? dollars[2] ?? "0").replace(/,/g, ""))),
      currency: "USD"
    };
  const rupees = /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)/i.exec(text);
  if (rupees?.[1])
    return { amount: Math.round(parseFloat(rupees[1].replace(/,/g, ""))), currency: "INR" };
  const euros = /€\s*(\d[\d,]*(?:\.\d+)?)|(?:eur)\s*(\d[\d,]*(?:\.\d+)?)/i.exec(text);
  if (euros)
    return {
      amount: Math.round(parseFloat((euros[1] ?? euros[2] ?? "0").replace(/,/g, ""))),
      currency: "EUR"
    };
  // Stage 9F only added POSTFIX ("10000 AED") support for the remaining currencies, leaving PREFIX
  // ("AED 10,000" — the actual UAT phrasing) unrecognized entirely, so a correction like "AED 10,000"
  // silently failed to register as a budget amount at all. This covers prefix ordering for every currency
  // not already handled by the dedicated USD/INR/EUR checks above.
  const prefix = /\b(aed|gbp|sgd|cad|aud|thb|jpy)\s*(\d[\d,]*(?:\.\d+)?)\b/i.exec(text);
  if (prefix?.[1] && prefix[2])
    return { amount: Math.round(parseFloat(prefix[2].replace(/,/g, ""))), currency: prefix[1].toUpperCase() };
  // Postfix ordering ("10000 AED") for every currency this codebase already treats as a first-class
  // display currency (see currency.service.ts's SUPPORTED_CURRENCIES), so a stated amount is recognized
  // the same way regardless of word order.
  const postfix = /(\d[\d,]*(?:\.\d+)?)\s*(usd|inr|eur|aed|gbp|sgd|cad|aud|thb|jpy)\b/i.exec(text);
  if (postfix?.[1] && postfix[2])
    return { amount: Math.round(parseFloat(postfix[1].replace(/,/g, ""))), currency: postfix[2].toUpperCase() };
  // An unrecognized 3-letter currency code (IDR, VND, KRW, ...) sitting right next to the number must
  // never fall through to the generic "just a number" path below and get silently mislabeled with
  // `fallbackCurrency` — a stated "IDR 20000000" is not a $20,000,000 budget (off by a factor of ~1,300).
  // Only the fixed SUPPORTED_CURRENCIES set (currency.service.ts) has a known exchange rate; an
  // unsupported code means the amount is genuinely unrecognized, so this returns null rather than guessing
  // — the caller's normal "what's your approximate budget (in USD)?" follow-up then re-asks correctly.
  const adjacentCode =
    /\b([a-z]{3})\s+[\d,]{2,}(?:\.\d+)?\b/i.exec(text) ?? /\b[\d,]{2,}(?:\.\d+)?\s+([a-z]{3})\b/i.exec(text);
  if (adjacentCode?.[1] && !isSupportedCurrency(adjacentCode[1])) return null;
  const generic = /budget\D{0,12}?([\d,]{2,}(?:\.\d+)?)/i.exec(text);
  if (generic?.[1])
    return { amount: Math.round(parseFloat(generic[1].replace(/,/g, ""))), currency: fallbackCurrency };
  return null;
}

export function extractTravelSlots(
  userMessages: readonly string[],
  fallbackCurrency = "USD"
): TravelSlots {
  const slots: TravelSlots = { ...EMPTY_SLOTS };
  for (const message of userMessages) {
    if (slots.destination === null) slots.destination = extractDestination(message);
    if (slots.travelMonth === null) slots.travelMonth = extractTravelMonth(message);
    if (slots.durationDays === null) slots.durationDays = extractDurationDays(message);
    if (slots.passengers === null) slots.passengers = extractPassengers(message);
    if (slots.budgetAmount === null) {
      const budget = extractBudget(message, fallbackCurrency);
      if (budget) {
        slots.budgetAmount = budget.amount;
        slots.budgetCurrency = budget.currency ?? fallbackCurrency;
      }
    }
  }
  return slots;
}

const REQUIRED_FIELDS: Array<keyof TravelSlots> = [
  "destination",
  "travelMonth",
  "passengers",
  "budgetAmount"
];

export function missingFields(slots: TravelSlots): string[] {
  return REQUIRED_FIELDS.filter((key) => slots[key] === null || slots[key] === undefined);
}

const ESCALATION_PATTERN =
  /\b(human|real person|representative|talk to (?:a )?(?:person|human|agent)|speak to (?:a )?(?:person|human|agent)|escalate|customer service)\b/i;
export function isEscalationRequest(text: string): boolean {
  return ESCALATION_PATTERN.test(text);
}

// A returning customer asking for their ticket again — in a brand-new conversation days/weeks after
// booking, not a follow-up within the same session (that case is already covered by the PDF chat
// attachment shown right after confirmation). Deliberately checked ahead of the name-collection gate in
// `complete()`, so it works even before the traveler has re-introduced themselves.
const RESEND_TICKET_PATTERN =
  /\b(resend|re-?send|send\s+(?:me\s+)?(?:my\s+)?(?:the\s+)?ticket\s+again|send\s+(?:me\s+)?(?:my\s+)?ticket|share\s+(?:my\s+)?ticket|get\s+(?:my\s+)?ticket|need\s+my\s+ticket|lost\s+my\s+ticket|can'?t\s+find\s+my\s+ticket|where'?s\s+my\s+ticket)\b/i;
export function isResendTicketRequest(text: string): boolean {
  return RESEND_TICKET_PATTERN.test(text);
}

// Fix (Travel Booking Closure Pass — Phase 3): broadened from a handful of decline words to cover the
// natural ways a customer answers "where should I send your ticket?" by asking for chat delivery, without
// needing to know the magic word "skip" — see the correction-pass spec's CHAT_DOWNLOAD examples ("share it
// here", "send it here", "download here", "put it in the chat", "chat please", "chat only", "no email",
// "no WhatsApp", "I'll download it here", ...). Deliberately phrase-based (not a bare "chat"/"here"
// single-word match) so it never fires on unrelated text that merely mentions "chat" or "here".
const SKIP_TICKET_CONTACT_PATTERN =
  /\b(?:skip|no\s+thanks?|none|not\s+now|later|don'?t\s+have|no\s+email|no\s+whats\s*app)\b|\b(?:share|send|put|leave|download)\s+it\s+(?:here|in\s+(?:this|the)\s+chat)\b|\bhere\s+is\s+fine\b|\bchat\s+(?:please|only|is\s+fine)\b|\bdownload\s+(?:it\s+)?(?:here|from\s+(?:the\s+)?chat|in\s+(?:the\s+)?chat)\b/i;
/** An explicit (now natural-language-tolerant) decline of the ticket-contact ask — proceeds to booking
 *  confirmation with no email/WhatsApp captured (the ticket then only ever reachable via the chat
 *  attachment or dashboard). Callers should extract email/phone FIRST (see `resolvesTicketDeliveryQuestion`)
 *  — an actual contact value volunteered alongside an incidental "chat"/"no email" word (e.g. "no email,
 *  WhatsApp me at +91...") must still be honored, never discarded. */
export function isSkipTicketContactRequest(text: string): boolean {
  return SKIP_TICKET_CONTACT_PATTERN.test(text);
}

/**
 * Fix (Travel Booking Closure Pass — Phase 2/3): the single authoritative answer to "does this message
 * resolve Travel's currently-pending AWAITING_TICKET_CONTACT question?" — reused both by the dispatch
 * chain below (which branch to take) and by the Receptionist's pending-input-ownership check (whether an
 * active Travel handoff should keep this turn instead of letting domain-switch scoring run at all, see
 * `receptionist/specialist-pending-input.ts`). One definition, so the two can never drift apart.
 */
export function resolvesTicketDeliveryQuestion(text: string): boolean {
  return Boolean(extractEmailAddress(text)) || Boolean(extractPhoneNumber(text)) || isSkipTicketContactRequest(text);
}

// Fix (Travel Booking Closure Pass — Phase 17): natural phrasing over a form-field prompt. Every reply
// this used to explicitly enumerate ("email and/or WhatsApp number", "reply 'skip'") still works exactly
// as before — see `resolvesTicketDeliveryQuestion`'s own broadened natural-language matching (Phase 3) —
// this only changes how the question is ASKED, never what answers are accepted.
export function buildTicketContactRequestMessage(): string {
  return "Once it's confirmed, would you like the ticket here in chat, by email, or on WhatsApp?";
}

// A deliberately NARROWER subset of sprint-4.4b-integration.ts's own `bookingPatterns` — used only by
// `TravelEmployeeLlmOrchestrator`'s booking-options trigger (see its own doc comment for why): that class
// already has a tested "go ahead"/"yes" resume flow for an unrelated pending offer, so the broader phrases
// there (bare "option 1/2", "go ahead", "proceed") are excluded here on purpose.
const LLM_ORCHESTRATOR_BOOKING_INTENT_PATTERN =
  /\bbook\s+(?:the\s+|this\s+|my\s+|that\s+)?(?:ticket|trip|flight|booking|itinerary|option|package|hotels?|flights?)\b|\bi\s+want\s+(?:to\s+)?book\b|^\s*(?:ok(?:ay)?[,.]?\s*)?(?:please\s+)?book\s*(?:it|this|now)?\s*[!.]?\s*$/i;

/** The email the ticket should be looked up/resent against — the same pattern `extractContactValue`
 *  (conversation-completion.ts) uses for a standalone email, kept local here since this file already has
 *  its own `EMAIL_CONTACT_PATTERN` for the same shape. */
export function extractEmailAddress(text: string): string | null {
  return EMAIL_CONTACT_PATTERN.exec(text)?.[0] ?? null;
}

/** An exact travel date for resend lookup — deliberately only the EXPLICIT-date parser (never
 *  `interpretDatePhrase`'s relative phrases like "next week"): a resend request is about a trip that may
 *  already be in the past, where "next Friday" is meaningless. Returns null (never guesses) when no full
 *  date is stated. */
export function extractResendTicketDate(text: string): string | null {
  return parseExplicitTravelDate(text)?.normalizedDate ?? null;
}

// Hinglish affirmatives (ji/jee/haan/ha/theek hai/kar do) count as a booking confirmation too — a bare "ji"
// must deterministically confirm/execute a pending action, never depend solely on the LLM's own intent
// label (which is a hint, not a veto, exactly like `isExecutionRequest`'s own rationale below).
const CONFIRMATION_PATTERN =
  /\b(yes|confirm(?:ed)?|book it|go ahead|sounds good|let'?s book|proceed|okay|ok|ji|jee|haan|ha|theek\s*hai|kar\s*do)\b/i;
export function isBookingConfirmation(text: string): boolean {
  return CONFIRMATION_PATTERN.test(text);
}

// A standalone closing remark — "thanks", "that's all", "bye" — rather than a substantive reply. Deliberately
// anchored to (nearly) the whole message: "thanks, and what about hotels?" must still be answered normally,
// never swallowed as a goodbye just because it starts with a pleasantry. Bare "no"/"yes" are deliberately
// excluded here (too ambiguous outside a specific yes/no context) — see the dedicated short-decline check
// where the Conversation Completion offer is resolved instead. Up to two of these phrases may be chained
// together (a real user very often types "thanks, that's all" or "ok thanks, bye" as one message).
const FAREWELL_PHRASE =
  "no\\s+thanks?|no\\s+thank\\s+you|that'?s\\s+all(?:\\s+for\\s+now)?|thats\\s+all(?:\\s+for\\s+now)?|that\\s+is\\s+all|nothing\\s+else(?:\\s+for\\s+now)?|i'?m\\s+(?:good|done)|all\\s+set|thanks?(?:\\s+(?:so\\s+much|a\\s+lot|very\\s+much))?|thank\\s+you(?:\\s+(?:so\\s+much|a\\s+lot|very\\s+much))?|bye|goodbye|good\\s*bye|see\\s+you(?:\\s+later)?|take\\s+care";
const FAREWELL_PATTERN = new RegExp(
  `^\\s*(?:ok(?:ay)?\\s*[,.!]*)?(?:${FAREWELL_PHRASE})(?:\\s*[,.!]*\\s*(?:and\\s+)?(?:${FAREWELL_PHRASE}))?\\s*[.!]*\\s*$`,
  "i"
);
export function isFarewellMessage(text: string): boolean {
  return FAREWELL_PATTERN.test(text);
}

const TRAVEL_STATE_RECALL_PATTERN =
  /\b(?:sab\s+(?:piche|pehle)\s+(?:bataya|bata)|sab\s+pehle\s+bata\s+chuka|already\s+told\s+you|i\s+shared\s+that\s+earlier|upar\s+dekh|maine\s+details?\s+de\s+di|same\s+details?|kitne\s+log|kitni\s+raat|mera\s+route|maine\s+pehle\s+kya)\b/i;
const TRAVEL_FRUSTRATION_PATTERN =
  /\b(?:kya\s+bakwas|this\s+is\s+wrong|you\s+forgot\s+everything|forgot\s+(?:the\s+)?details?)\b/i;

export function isTravelStateRecallRequest(text: string): boolean {
  return TRAVEL_STATE_RECALL_PATTERN.test(text);
}

export function isTravelFrustrationMessage(text: string): boolean {
  return TRAVEL_FRUSTRATION_PATTERN.test(text);
}

export function buildTravelStateRecallMessage(
  entities: TravelEntities,
  pendingDate: PendingDepartureDate | null,
  journey: Journey | null,
  acknowledge = false
): string {
  const lines: string[] = [acknowledge ? "You’re right — I still have:" : "You’re right. I already have:"];
  const route = journey?.legs.length
    ? describeJourneyRoute(journey.legs)
    : entities.originCity && entities.destinationCity
      ? `${entities.originCity} -> ${entities.destinationCity}`
      : entities.destinationCity;
  if (route) lines.push(`• Route: ${route}`);
  if (entities.adults !== null)
    lines.push(
      `• Travellers: ${entities.adults} adult${entities.adults === 1 ? "" : "s"} and ${entities.children ?? 0} child${entities.children === 1 ? "" : "ren"}`
    );
  else if (entities.totalTravellers !== null) lines.push(`• Travellers: ${entities.totalTravellers}`);
  if (entities.nights !== null) lines.push(`• Stay: ${entities.nights} nights`);
  else if (entities.days !== null) lines.push(`• Stay: ${entities.days} days`);
  if (pendingDate)
    lines.push(`• Travel date: ${pendingDate.day} ${titleCase(MONTHS[pendingDate.month - 1] ?? "")}`);
  else if (entities.departureDate) lines.push(`• Travel date: ${entities.departureDate}`);
  else if (entities.travelMonth) lines.push(`• Travel month: ${entities.travelMonth}`);
  if (pendingDate) lines.push("", `I only need the travel year to complete the plan.`);
  return lines.join("\n");
}

const ITINERARY_MARKER = /reply ['"]?confirm['"]? to proceed|no booking has been made/i;
export function wasItineraryPresented(messages: readonly AiMessage[]): boolean {
  return messages.some((message) => message.role === "assistant" && ITINERARY_MARKER.test(message.content));
}

const ESCALATION_MARKER = /connect you with a human team member/i;
export function wasEscalated(messages: readonly AiMessage[]): boolean {
  return messages.some((message) => message.role === "assistant" && ESCALATION_MARKER.test(message.content));
}

const BOOKING_CONFIRMED_MARKER = /booking intent has been recorded/i;
export function wasBookingConfirmed(messages: readonly AiMessage[]): boolean {
  return messages.some(
    (message) => message.role === "assistant" && BOOKING_CONFIRMED_MARKER.test(message.content)
  );
}

// Mirrors `wasItineraryPresented`'s transcript-scanning pattern for the deterministic (no-LLM)
// `TravelEmployeeProvider`, which is stateless — everything it knows about "where the conversation is" is
// re-derived from the message transcript on every turn, never from persisted instance fields.
const CONTACT_REQUEST_MARKER = /phone number|mobile number/i;
/** True when the LAST assistant turn asked for a phone number — the deterministic provider's own
 * AWAITING_CONTACT-equivalent state, since it has no persisted `completionStage` to check instead. */
export function wasContactInfoRequested(messages: readonly AiMessage[]): boolean {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  return lastAssistant ? CONTACT_REQUEST_MARKER.test(lastAssistant.content) : false;
}

const LEAD_CAPTURED_MARKER = /travel request has been submitted successfully/i;
const LEAD_REFERENCE_MARKER = /reference number:\s*([a-z0-9-]+)/i;
/** True once a lead was actually captured this conversation — see {@link buildLeadCapturedMessage}. */
export function wasLeadCaptured(messages: readonly AiMessage[]): boolean {
  return messages.some((message) => message.role === "assistant" && LEAD_CAPTURED_MARKER.test(message.content));
}
/** Recovers the reference shown in a prior `buildLeadCapturedMessage` turn — used so a repeated
 * confirmation/affirmative after capture re-confirms the SAME reference instead of asking for contact
 * details again or silently doing nothing. */
export function extractCapturedLeadReference(messages: readonly AiMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const match = LEAD_REFERENCE_MARKER.exec(message.content);
    if (match?.[1]) return match[1];
  }
  return null;
}

// Matches the Intent Discovery menu in all three languages (see `buildIntentDiscoveryMessage`) — the
// English "what can I help you with", Hinglish "kis cheez mein madad", and Hindi "किस चीज़ में मदद" lines
// are each distinctive enough on their own not to collide with any other reply.
const INTENT_DISCOVERY_MARKER = /what can i help you with|kis cheez mein madad|किस चीज़ में मदद/i;
/**
 * True only when the Intent Discovery menu is the very last message in the transcript — i.e. it was
 * just shown and the traveler has not replied to it yet. Deliberately checks only the last message
 * (unlike `wasEscalated`/`wasItineraryPresented`, which look for the marker anywhere): once the traveler
 * replies with anything at all, the conversation must move on to whatever that reply says, not keep
 * reporting DISCOVER_INTENT for the rest of the conversation the way ESCALATED/CONFIRM_BOOKING do.
 */
export function isIntentDiscoveryPending(messages: readonly AiMessage[]): boolean {
  const last = messages.at(-1);
  return last?.role === "assistant" && INTENT_DISCOVERY_MARKER.test(last.content);
}

function stageForMissingField(field: string): TravelStage {
  switch (field) {
    case "destination":
      return "COLLECT_DESTINATION";
    case "travelMonth":
      return "COLLECT_DATES";
    case "passengers":
      return "COLLECT_PASSENGERS";
    case "budgetAmount":
      return "COLLECT_BUDGET";
    default:
      return "ASK_MISSING_INFO";
  }
}

/** Recomputes the Travel Employee's structured state from a conversation transcript. Pure and provider-agnostic. */
export function deriveTravelState(messages: readonly AiMessage[], fallbackCurrency = "USD"): TravelState {
  const userMessages = messages.filter((message) => message.role === "user").map((message) => message.content);
  const slots = extractTravelSlots(userMessages, fallbackCurrency);
  const customerName = extractCustomerName(userMessages);
  const missing = missingFields(slots);
  let stage: TravelStage;
  if (wasEscalated(messages)) stage = "ESCALATED";
  else if (wasBookingConfirmed(messages) || wasLeadCaptured(messages)) stage = "BOOKING_CONFIRMED";
  else if (!customerName) stage = "COLLECT_NAME";
  else if (isIntentDiscoveryPending(messages)) stage = "DISCOVER_INTENT";
  else if (missing.length > 0) stage = stageForMissingField(missing[0] ?? "");
  else if (wasItineraryPresented(messages)) stage = "CONFIRM_BOOKING";
  else stage = "RECOMMEND_OPTIONS";
  return {
    ...slots,
    customerName,
    onboardingCompleted: customerName !== null,
    // This function only ever runs on a turn AFTER the proactive greeting has already been shown (see
    // AgentService.execute's greeting bypass) — greetingSent is therefore always true here by construction.
    greetingSent: true,
    stage,
    missingFields: missing
  };
}

function seedFromString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash;
}

const AIRLINES = ["SkyLink Air", "GlobalWing Airways", "Northern Star Airlines"];
/** Star category is fixed per brand so "respect hotel category" filtering has something real to filter on. */
const HOTEL_CATALOG = [
  { name: "Harbor View Hotel", stars: 3 },
  { name: "Central Plaza Inn", stars: 4 },
  { name: "Palm Court Resort", stars: 5 }
] as const;
const PLACEHOLDER_DISCLAIMER =
  "Placeholder data — not connected to a live reservation system. Verify prices and availability before booking.";

export interface FlightOption {
  airline: string;
  price: number;
  currency: string;
  stops: number;
  durationHours: number;
}
export interface HotelOption {
  name: string;
  stars: number;
  pricePerNight: number;
  currency: string;
  rating: number;
}

export function generatePlaceholderFlights(input: {
  destination: string;
  travelMonth?: string | null;
  passengers?: number | null;
}): { flightOptions: FlightOption[]; disclaimer: string } {
  const seed = seedFromString(input.destination.toLowerCase());
  const basePrice = 250 + (seed % 500);
  const passengers = input.passengers ?? 1;
  const flightOptions: FlightOption[] = [0, 1].map((index) => ({
    airline: AIRLINES[(seed + index) % AIRLINES.length] ?? "SkyLink Air",
    price: (basePrice + index * 120) * passengers,
    currency: "USD",
    stops: index,
    durationHours: 4 + ((seed + index * 7) % 10)
  }));
  return { flightOptions, disclaimer: PLACEHOLDER_DISCLAIMER };
}

/**
 * Generates placeholder hotel options, honoring a requested star category when one is known. If no
 * catalog entry matches exactly, falls back to the closest star category(ies) available and returns a
 * `starNote` explaining the substitution — the recommendation flow surfaces that note to the user instead
 * of silently swapping in a different category.
 */
export function generatePlaceholderHotels(input: {
  destination: string;
  travelMonth?: string | null;
  hotelStars?: number | null;
}): { hotelOptions: HotelOption[]; disclaimer: string; starNote: string | null } {
  const seed = seedFromString(input.destination.toLowerCase());
  const requestedStars = input.hotelStars ?? null;
  let starNote: string | null = null;
  let candidates: ReadonlyArray<{ name: string; stars: number }>;
  if (requestedStars === null) {
    candidates = [0, 1].map(
      (index) =>
        HOTEL_CATALOG[(seed + index) % HOTEL_CATALOG.length] ?? { name: "Harbor View Hotel", stars: 3 }
    );
  } else {
    const exact = HOTEL_CATALOG.filter((hotel) => hotel.stars === requestedStars);
    if (exact.length > 0) {
      candidates = exact;
    } else {
      const closest = [...HOTEL_CATALOG].sort(
        (a, b) => Math.abs(a.stars - requestedStars) - Math.abs(b.stars - requestedStars)
      );
      candidates = closest.slice(0, 2);
      const closestStars = Array.from(new Set(candidates.map((hotel) => hotel.stars))).sort((a, b) => a - b);
      starNote = `No ${requestedStars}-star options were available for ${input.destination}, so here ${closestStars.length > 1 ? "are the closest matches" : "is the closest match"} instead (${closestStars.join("/")}-star).`;
    }
  }
  const basePrice = 60 + (seed % 180);
  const hotelOptions: HotelOption[] = candidates.slice(0, 2).map((hotel, index) => ({
    name: hotel.name,
    stars: hotel.stars,
    pricePerNight: Math.round((basePrice + index * 45) * (0.7 + hotel.stars * 0.15)),
    currency: "USD",
    rating: Math.round((3.5 + ((seed + index) % 15) / 10) * 10) / 10
  }));
  return { hotelOptions, disclaimer: PLACEHOLDER_DISCLAIMER, starNote };
}

/** Human-readable passenger breakdown for a {@link TravelLead} row — e.g. "2 adults, 1 child". Falls back
 * to an ambiguous total ("5 travellers") only when no composition breakdown was ever given. */
export function formatPassengerSummaryForLead(entities: TravelEntities): string | null {
  const parts: string[] = [];
  if (entities.adults) parts.push(`${entities.adults} adult${entities.adults === 1 ? "" : "s"}`);
  if (entities.children) parts.push(`${entities.children} child${entities.children === 1 ? "" : "ren"}`);
  if (entities.infants) parts.push(`${entities.infants} infant${entities.infants === 1 ? "" : "s"}`);
  if (parts.length) return parts.join(", ");
  return entities.totalTravellers ? `${entities.totalTravellers} traveller${entities.totalTravellers === 1 ? "" : "s"}` : null;
}

/** One-line summary of the trip for a {@link TravelLead}'s `conversationSummary` — a human agent's first
 * glance at what this enquiry is about, not a full transcript. */
export function buildLeadConversationSummary(entities: TravelEntities): string {
  const route =
    entities.originCity && entities.destinationCity
      ? `${entities.originCity} -> ${entities.destinationCity}`
      : (entities.destinationCity ?? "Travel enquiry");
  const dates = entities.departureDate ?? entities.travelMonth;
  const passengers = formatPassengerSummaryForLead(entities);
  const budget = entities.budget !== null ? `Budget: ${entities.budget} ${entities.budgetCurrency ?? ""}`.trim() : null;
  return [route, dates, passengers, budget].filter((part): part is string => Boolean(part)).join(" | ");
}

export function buildCrmLeadPayload(
  slots: TravelSlots,
  notes: string,
  extra?: {
    originCity?: string | null;
    hotelStars?: number | null;
    cabinClass?: string | null;
    preferences?: string[];
    adults?: number | null;
    children?: number | null;
    infants?: number | null;
    budgetStatus?: "BUDGET_BELOW_MINIMUM";
    followUp?: "SALES_FOLLOW_UP_REQUIRED";
  }
): Record<string, unknown> {
  return {
    source: "TRAVEL_EMPLOYEE_AI",
    interest: slots.destination ? `${slots.destination} trip` : "Travel enquiry",
    notes: notes.slice(0, 2000),
    metadata: {
      destination: slots.destination,
      travelMonth: slots.travelMonth,
      durationDays: slots.durationDays,
      passengers: slots.passengers,
      budgetAmount: slots.budgetAmount,
      budgetCurrency: slots.budgetCurrency,
      ...(extra?.originCity !== undefined ? { origin: extra.originCity } : {}),
      ...(extra?.hotelStars !== undefined ? { hotelStars: extra.hotelStars } : {}),
      ...(extra?.cabinClass !== undefined ? { cabinClass: extra.cabinClass } : {}),
      ...(extra?.preferences !== undefined ? { preferences: extra.preferences } : {}),
      ...(extra?.adults !== undefined ? { adults: extra.adults } : {}),
      ...(extra?.children !== undefined ? { children: extra.children } : {}),
      ...(extra?.infants !== undefined ? { infants: extra.infants } : {}),
      ...(extra?.budgetStatus !== undefined ? { budgetStatus: extra.budgetStatus } : {}),
      ...(extra?.followUp !== undefined ? { followUp: extra.followUp } : {})
    }
  };
}

/** Snapshots the current trip entities as a finalized {@link JourneyLeg} — pure, no orchestrator state. */
export function toJourneyLeg(
  entities: TravelEntities,
  itinerary: string | null,
  estimate: StoredBudgetEstimate | null,
  sequence: number,
  departureDateIsAssumption = false
): JourneyLeg {
  return {
    sequence,
    origin: entities.originCity,
    destination: entities.destinationCity,
    dates: {
      travelMonth: entities.travelMonth,
      departureDate: entities.departureDate,
      returnDate: entities.returnDate,
      departureDateIsAssumption
    },
    duration: { days: entities.days, nights: entities.nights },
    passengers: {
      adults: entities.adults,
      children: entities.children,
      infants: entities.infants,
      totalTravellers: entities.totalTravellers
    },
    budget: { amount: entities.budget, currency: entities.budgetCurrency },
    itinerary,
    estimates: estimate,
    destinationRole: entities.days !== null || entities.nights !== null ? "STAY_DESTINATION" : "CONNECTION"
  };
}

/**
 * Updates matching origin/destination pairs in place and appends only genuinely new continuous legs.
 * Stay durations are destination-scoped and consumed once; they are never summed across cities.
 */
export function reconcileJourneyLegs(
  existingLegs: readonly JourneyLeg[],
  proposedLegs: readonly JourneyLeg[],
  homeOrigin: string | null
): JourneyLeg[] {
  const cityKey = (city: string | null): string | null => {
    const normalized = normalizeCityName(city)?.toLowerCase().replace(/\s+/g, "") ?? null;
    return normalized === "newdelhi" ? "delhi" : normalized;
  };
  const result = existingLegs.map((leg) => ({ ...leg, duration: { ...leg.duration } }));
  for (const proposed of proposedLegs) {
    const origin = normalizeCityName(proposed.origin);
    const destination = normalizeCityName(proposed.destination);
    const match = result.find(
      (leg) =>
        cityKey(leg.origin) === cityKey(origin) &&
        cityKey(leg.destination) === cityKey(destination)
    );
    if (match) {
      if (proposed.duration.days !== null || proposed.duration.nights !== null)
        match.duration = { ...proposed.duration };
      match.passengers = proposed.passengers;
      match.destinationRole =
        match.duration.days !== null || match.duration.nights !== null
          ? "STAY_DESTINATION"
          : (match.destinationRole ?? "CONNECTION");
      continue;
    }
    const lastDestination = result[result.length - 1]?.destination ?? null;
    if (
      result.length === 0 ||
      cityKey(lastDestination) === cityKey(origin) ||
      cityKey(destination) === cityKey(homeOrigin)
    )
      result.push({ ...proposed, origin, destination });
  }
  result.forEach((leg, index) => {
    leg.sequence = index + 1;
    const isLast = index === result.length - 1;
    leg.destinationRole =
      isLast &&
      cityKey(leg.destination) === cityKey(homeOrigin)
        ? "FINAL_RETURN"
        : leg.duration.days !== null || leg.duration.nights !== null
          ? "STAY_DESTINATION"
          : index < result.length - 1
            ? "CONNECTION"
            : (leg.destinationRole ?? "CONNECTION");
  });
  return result;
}

/** Deterministic acknowledgement when a leg is finalized and a new one starts — see ADD_TRIP_LEG. */
export function buildTripLegAddedMessage(
  fromDestination: string | null,
  toDestination: string | null,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const to = toDestination ?? (language === "ENGLISH" ? "your next stop" : "agla stop");
  if (language === "HINGLISH")
    return `${fromDestination ? `${fromDestination} wala plan save ho gaya hai. ` : ""}Ab ${to} ke liye trip plan karte hain.`;
  if (language === "HINDI")
    return `${fromDestination ? `${fromDestination} की योजना सुरक्षित कर ली गई है। ` : ""}अब ${to} के लिए यात्रा की योजना बनाते हैं।`;
  return `${fromDestination ? `Got it — your ${fromDestination} leg is saved. ` : ""}Let's plan the ${to} leg next.`;
}

/** Deterministic acknowledgement when two or more legs are parsed from a single message — see {@link parseJourneyLegChain}. */
/** A parsed leg plus its tentative, derived departure date, if one could be computed — see {@link deriveNextLegDepartureDate}. */
export interface DerivedJourneyLegPlan extends ParsedJourneyLeg {
  departureDate: string | null;
  departureDateIsAssumption: boolean;
}

export function buildMultiLegAddedMessage(
  legs: readonly DerivedJourneyLegPlan[],
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const legLines = legs
    .map((leg, index) => {
      const finalReturn =
        index === legs.length - 1 &&
        normalizeCityName(leg.destination)?.toLowerCase() ===
          normalizeCityName(legs[0]?.origin ?? null)?.toLowerCase();
      const stay =
        finalReturn
          ? "return flight"
          : leg.days !== null || leg.nights !== null
          ? language === "HINGLISH"
            ? `${leg.nights ?? leg.days} ${leg.nights !== null ? "raat" : "din"} ka stay`
            : `${leg.nights ?? leg.days} ${leg.nights !== null ? "night(s)" : "day(s)"} stay`
          : language === "HINGLISH"
            ? "koi stay nahi (connecting)"
            : "no stay (connecting)";
      const dateNote = leg.departureDate
        ? language === "HINGLISH"
          ? ` — tentative date ${leg.departureDate} (assumption, based on the previous leg)`
          : ` — tentative date ${leg.departureDate} (assumption, derived from the previous leg)`
        : "";
      return `  ${leg.origin} -> ${leg.destination} — ${stay}${dateNote}`;
    })
    .join("\n");
  if (language === "HINGLISH") return `Ye legs journey mein add kar diye gaye hain:\n${legLines}`;
  if (language === "HINDI") return `ये चरण यात्रा में जोड़ दिए गए हैं:\n${legLines}`;
  return `Added the following legs to your journey:\n${legLines}`;
}

/** Renders a journey's legs as a single "A -> B -> C" route string, e.g. for acknowledgement messages. */
export function describeJourneyRoute(legs: readonly { origin: string | null; destination: string | null }[]): string {
  if (legs.length === 0) return "";
  const cities = [legs[0]?.origin ?? null, ...legs.map((leg) => leg.destination)].filter(
    (city): city is string => Boolean(city)
  );
  return cities.join(" -> ");
}

/**
 * Response to a MULTILEG_CORRECTION ("bhai multileg hai") — acknowledges the route already established
 * without restarting budget/detail collection and without repeating a generic "what dates work" prompt.
 */
export function buildMultilegCorrectionMessage(
  legs: readonly { origin: string | null; destination: string | null }[],
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const route = describeJourneyRoute(legs);
  const routeText = route || (language === "HINGLISH" ? "abhi tak batayi gayi cities" : "the cities mentioned so far");
  if (language === "HINGLISH")
    return `Theek hai, main ise ek hi connected multi-city trip maan raha hoon: ${routeText}. Jo bhi details aapne pehle batayi hain, wo sab maine rakhi hain — dobara se shuru nahi kar raha.`;
  if (language === "HINDI")
    return `ठीक है, मैं इसे एक ही जुड़ी हुई मल्टी-सिटी यात्रा मान रहा हूँ: ${routeText}। आपने अब तक जो भी बताया है, वह सब सुरक्षित है — दोबारा शुरू नहीं कर रहा।`;
  return `Got it — treating this as one connected multi-city journey: ${routeText}. Everything you've already told me for each leg is preserved; I'm not restarting.`;
}

/**
 * Response when a message's route neither structurally continues the journey nor states it's a new trip —
 * asks rather than guesses (per policy, a bare "ji"/"haan" reply to a pending clarification like this must
 * never be interpreted as answering the ambiguity itself — see `CLARIFY_ROUTE_RELATIONSHIP`).
 */
export function buildRouteRelationshipClarificationMessage(
  fromDestination: string | null,
  toDestination: string | null,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const from = fromDestination ?? (language === "ENGLISH" ? "your current trip" : "abhi tak ka trip");
  const to = toDestination ?? (language === "ENGLISH" ? "this new destination" : "is naye destination");
  if (language === "HINGLISH")
    return `Kya main ${to} ko ${from} wali trip ke baad usi journey mein add karoon, ya ye ek alag/naya trip hai?`;
  if (language === "HINDI")
    return `क्या मैं ${to} को ${from} वाली यात्रा के बाद उसी यात्रा में जोड़ूँ, या यह एक अलग/नई यात्रा है?`;
  return `Should I add ${to} after ${from} in the same trip, or is this a separate trip?`;
}

/**
 * Idempotency: a repeated submit/callback/confirm ask never creates a second {@link TravelLead} for the
 * same conversation — this just re-confirms the one already captured.
 */
export function buildLeadAlreadyCapturedMessage(reference: string, language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH") return `Aapki request pehle se hi submit hai — Reference Number: ${reference}.`;
  if (language === "HINDI") return `आपका अनुरोध पहले से ही सबमिट है — संदर्भ संख्या: ${reference}।`;
  return `Your request is already submitted — Reference Number: ${reference}.`;
}

function greetingPrefix(isFirstTurn: boolean, config: TravelEmployeeRuntimeConfig): string {
  return isFirstTurn ? `${config.welcomeMessage}\n\n` : "";
}

/** Warm, one-time acknowledgement rendered on the turn the traveler's name is first captured. */
export function buildNameAcknowledgment(name: string, language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINDI") return `${name} जी, आपसे मिलकर अच्छा लगा।`;
  return `Nice to meet you, ${name}.`;
}

/**
 * The COLLECT_NAME gate's reply: asks for the traveler's name, naturally acknowledging any destination
 * already mentioned in the same message rather than ignoring it — see UAT example: "Delhi jana hai" during
 * COLLECT_NAME should acknowledge Delhi but still ask for the name, never silently skip onboarding.
 */
export function buildNameRequestMessage(currentText: string): string {
  const destination = extractDestination(currentText);
  const language = detectResponseLanguage(currentText);
  if (!destination) {
    if (language === "HINGLISH") return "Bataiye, aapka naam kya hai?";
    if (language === "HINDI") return "क्या मैं आपका नाम जान सकता/सकती हूँ?";
    return "Before we get started, may I know your name?";
  }
  const place = titleCase(destination);
  if (language === "HINGLISH") return `${place} sounds good. Planning shuru karne se pehle, may I know your name?`;
  if (language === "HINDI") return `${place} बढ़िया विकल्प है। योजना शुरू करने से पहले, क्या मैं आपका नाम जान सकता/सकती हूँ?`;
  return `${place} sounds like a great choice! Before we get started, may I know your name?`;
}

/**
 * Time-of-day greeting word ("Good morning"/"Good afternoon"/"Good evening") for the Intent Discovery
 * message. Uses server time — no per-traveler timezone reaches this runtime today (the `userLocalTime`
 * field on `TravelState` has no populated source yet), so this is an honest best-effort, not a claim of
 * the traveler's actual local time. Boundaries: before 12:00 -> morning, 12:00-16:59 -> afternoon,
 * 17:00+ -> evening.
 */
export function timeOfDayGreeting(now: Date = new Date()): "Good morning" | "Good afternoon" | "Good evening" {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

const INTENT_MENU_ITEMS_EN = [
  "Plan a trip",
  "Build an itinerary",
  "Estimate costs",
  "Explain policies",
  "Answer travel questions"
] as const;
const INTENT_MENU_ITEMS_HINGLISH = [
  "Trip plan karna",
  "Itinerary banana",
  "Cost estimate karna",
  "Policies explain karna",
  "Travel se judhe sawalon ke jawab dena"
] as const;
const INTENT_MENU_ITEMS_HINDI = [
  "यात्रा की योजना बनाना",
  "यात्रा कार्यक्रम बनाना",
  "लागत का अनुमान लगाना",
  "नीतियाँ समझाना",
  "यात्रा संबंधी प्रश्नों के उत्तर देना"
] as const;

/**
 * The Intent Discovery turn's reply — shown exactly once, right after the traveler's name is captured
 * with no trip content stated yet (see the COLLECT_NAME gate in both `TravelEmployeeProvider` and
 * `TravelEmployeeLlmOrchestrator`). Only then does the assistant ask what the traveler actually wants,
 * instead of assuming a trip is being planned and jumping straight to "where would you like to travel?".
 */
export function buildIntentDiscoveryMessage(
  name: string,
  language: TravelResponseLanguage = "ENGLISH",
  now: Date = new Date()
): string {
  const greeting = timeOfDayGreeting(now);
  // Fix (Sprint 6.4 — Part 9): the previous version asked "Aaj main aapki kaise madad kar sakta/sakti
  // hoon?" and then separately said "Main in cheezon mein madad kar sakta/sakti hoon:" — the same question
  // twice in different words, plus a redundant "Aapse milkar accha laga" (nice to meet you) filler line —
  // literally the same double-ask pattern the English branch below was already fixed for in Sprint 6.3,
  // left untouched in Hindi/Hinglish until now. Merged into one natural, spoken-style greeting+menu line
  // (not a literal translation of the English fix — see the module-level guidance on natural Hinglish).
  if (language === "HINGLISH")
    return [
      `${greeting}, ${name}! \u{1F44B} Aaj kis cheez mein madad karoon?`,
      "",
      ...INTENT_MENU_ITEMS_HINGLISH.map((item) => `• ${item}`),
      "",
      "Aur, ye trip leisure ke liye hai ya business ke liye?"
    ].join("\n");
  if (language === "HINDI") {
    const hindiGreeting =
      greeting === "Good morning" ? "सुप्रभात" : greeting === "Good afternoon" ? "शुभ दोपहर" : "शुभ संध्या";
    return [
      `${hindiGreeting}, ${name} जी! \u{1F44B} आज किस चीज़ में मदद करूँ?`,
      "",
      ...INTENT_MENU_ITEMS_HINDI.map((item) => `• ${item}`),
      "",
      "और, क्या यह यात्रा छुट्टियों के लिए है या व्यावसायिक (business) है?"
    ].join("\n");
  }
  // Fix (Sprint 6.3 — Part 4): the previous version asked "How may I help you today?" and then separately
  // said "I can help you:" — the same question twice in different words, plus a redundant "Nice to meet
  // you" filler line. Merged into one greeting+menu pass, matching the same simplification applied
  // generically to every other AI Employee's intent-discovery message in employee-runtime.ts.
  return [
    `${greeting}, ${name}! \u{1F44B} What can I help you with?`,
    "",
    ...INTENT_MENU_ITEMS_EN.map((item) => `• ${item}`),
    "",
    "Also, is this trip for leisure or business?"
  ].join("\n");
}

// A small, deterministic rotation — never random, so output stays testable — used wherever a reply
// would otherwise always open with the same word ("Great!"/"Sure!"/"Got it!" on every turn reads as
// robotic; a real consultant varies their phrasing). Picked by a stable hash of some turn-specific text
// (e.g. the destination) so the SAME input always produces the SAME opener, but different inputs vary.
const ACKNOWLEDGEMENT_OPENERS = [
  "Wonderful!",
  "That sounds like a great trip!",
  "Lovely choice!",
  "Excellent!",
  "That's exciting!"
] as const;
function pickOpener(seedText: string): string {
  const options = ACKNOWLEDGEMENT_OPENERS;
  return options[seedFromString(seedText) % options.length] ?? options[0];
}

export function buildAskMessage(
  field: string,
  slots: TravelSlots,
  isFirstTurn: boolean,
  config: TravelEmployeeRuntimeConfig
): string {
  const prefix = greetingPrefix(isFirstTurn, config);
  if (field === "destination") return `${prefix}Where would you like to travel to?`;
  if (field === "travelMonth") {
    const opener = slots.destination ? `${pickOpener(slots.destination)} ${slots.destination} is a great pick.` : "";
    return `${prefix}${opener} When are you planning to travel (which month), and for how many days?`.trim();
  }
  if (field === "passengers") return `${prefix}How many travelers should I plan for?`;
  if (field === "budgetAmount")
    return `${prefix}What's your approximate budget (in ${config.defaultCurrency})?`;
  return `${prefix}Could you share a bit more detail so I can help plan your trip?`;
}

const MISSING_FIELD_LABELS: Record<string, string> = {
  destination: "your destination",
  travelMonth: "when you're travelling",
  passengers: "how many people",
  budgetAmount: "your approximate budget"
};

/**
 * Combines every missing field into one natural, bulleted ask instead of one mechanical question per
 * turn — the deterministic (non-LLM) engine's equivalent of `combineMissingLabels`/the LLM prompt
 * instruction below. Used for BOTH the first ask (when 2+ fields are already missing at once) and any
 * repeat ask, so the traveler is never marched through the same fields one at a time.
 */
export function buildMissingInfoMessage(
  missing: string[],
  config: TravelEmployeeRuntimeConfig,
  isFirstTurn = false
): string {
  const prefix = greetingPrefix(isFirstTurn, config);
  const items = missing.map((field) => MISSING_FIELD_LABELS[field] ?? field);
  const budgetIndex = missing.indexOf("budgetAmount");
  if (budgetIndex >= 0) items[budgetIndex] = `your approximate budget (in ${config.defaultCurrency})`;
  if (items.length <= 1) return `${prefix}Could you share ${items[0] ?? "a few more trip details"}?`;
  const bullets = items.map((item) => `• ${item}`).join("\n");
  return `${prefix}To recommend the best options, I'd like to know:\n${bullets}\n\nFeel free to answer in one message or separately.`;
}

const IRREGULAR_PLURALS: Record<string, string> = { child: "children" };
function pluralize(word: string, count: number): string {
  if (count === 1) return word;
  return IRREGULAR_PLURALS[word] ?? `${word}s`;
}

/**
 * Renders the full passenger mix as natural text, e.g. "2 adults and 2 children" or
 * "2 adults, 2 children and 1 infant" — never collapsing to "2 adults" when children or infants
 * are present.
 */
function describeTravelerMix(
  adults: number | null,
  children: number | null,
  infants: number | null,
  totalTravellers: number | null = null
): string {
  if (adults === null && totalTravellers !== null) return `${totalTravellers} ${pluralize("traveller", totalTravellers)}`;
  const resolvedAdults = adults ?? 1;
  const adultPart = `${resolvedAdults} ${pluralize("adult", resolvedAdults)}`;
  const parts = [adultPart];
  if (children) parts.push(`${children} ${pluralize("child", children)}`);
  if (infants) parts.push(`${infants} ${pluralize("infant", infants)}`);
  if (parts.length === 1) return adultPart;
  const last = parts[parts.length - 1] ?? adultPart;
  if (parts.length === 2) return `${parts[0] ?? adultPart} and ${last}`;
  return `${parts.slice(0, -1).join(", ")} and ${last}`;
}

export interface RecommendationOptions {
  /** When set, renders origin/destination and adult/child counts in natural consultant wording. */
  consultantStyle?: boolean;
  originCity?: string | null;
  adults?: number | null;
  children?: number | null;
  infants?: number | null;
  starNote?: string | null;
}

export function buildRecommendationMessage(
  slots: TravelSlots,
  flights: FlightOption[],
  hotels: HotelOption[],
  config: TravelEmployeeRuntimeConfig,
  options?: RecommendationOptions
): string {
  const currency = slots.budgetCurrency ?? config.defaultCurrency;
  const consultantStyle = options?.consultantStyle ?? false;
  const flightLines = flights
    .map(
      (flight, index) =>
        `  ${index + 1}. ${flight.airline} — ~${flight.currency} ${flight.price} (${flight.stops === 0 ? "non-stop" : `${flight.stops} stop(s)`}, ~${flight.durationHours}h)`
    )
    .join("\n");
  const hotelLines = hotels
    .map((hotel, index) => {
      const starTag = consultantStyle && hotel.stars ? ` (${hotel.stars}★)` : "";
      return `  ${index + 1}. ${hotel.name}${starTag} — ~${hotel.currency} ${hotel.pricePerNight}/night (rated ${hotel.rating.toFixed(1)}/5)`;
    })
    .join("\n");
  const starNoteParagraph = consultantStyle && options?.starNote ? options.starNote : null;
  const days = slots.durationDays ?? 5;
  const origin = consultantStyle ? options?.originCity ?? null : null;
  const itinerary = [
    origin
      ? `Day 1: Depart ${origin}, arrive in ${slots.destination}, settle in and explore nearby.`
      : `Day 1: Arrive in ${slots.destination}, settle in and explore nearby.`,
    days > 2 ? `Day 2–${Math.max(2, days - 1)}: Guided sightseeing, local cuisine, and free time.` : null,
    `Day ${days}: Final day at leisure and departure.`
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  let introLine: string;
  if (consultantStyle) {
    const routePart = origin ? `from ${origin} to ${slots.destination}` : `to ${slots.destination}`;
    const paxText =
      options?.adults != null
        ? describeTravelerMix(options.adults, options.children ?? null, options.infants ?? null)
        : `${slots.passengers ?? 1} ${pluralize("traveler", slots.passengers ?? 1)}`;
    introLine = `Here's a plan for your trip ${routePart}${slots.travelMonth ? ` in ${slots.travelMonth}` : ""} for ${paxText}, budget ~${currency} ${slots.budgetAmount ?? "n/a"}:`;
  } else {
    introLine = `Here's a plan for your trip to ${slots.destination}${slots.travelMonth ? ` in ${slots.travelMonth}` : ""} for ${slots.passengers ?? 1} traveler(s), budget ~${currency} ${slots.budgetAmount ?? "n/a"}:`;
  }

  const closingLine = consultantStyle
    ? "Let me know if you'd like to go ahead with this, or if you'd like me to adjust the hotel, flights, budget, or dates."
    : "Reply 'confirm' to proceed with this plan, or let me know what you'd like to change.";

  return [
    introLine,
    "",
    "Flight options:",
    flightLines,
    "",
    "Hotel options:",
    hotelLines,
    ...(starNoteParagraph ? ["", starNoteParagraph] : []),
    "",
    "Itinerary summary:",
    itinerary,
    "",
    "This is placeholder planning data — no booking has been made, and prices or availability are not live and should be verified.",
    "",
    closingLine
  ].join("\n");
}

export function buildConfirmPrompt(language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH")
    return "Kya main isse book kar doon, ya kuch adjust karna hai — hotel, flights, budget, ya dates?";
  if (language === "HINDI") return "क्या मैं इसे बुक कर दूँ, या कुछ बदलना है — होटल, फ्लाइट्स, बजट, या तारीखें?";
  return "Would you like me to go ahead and book this, or is there anything you'd like to adjust — the hotel, flights, budget, or dates?";
}

/**
 * Deterministic, non-LLM prompt for when every required field just became known but the traveler didn't
 * explicitly ask for options/search this turn. Per policy, "all fields complete" is not itself
 * authorization to call `travel.search_flights`/`travel.search_hotels` — this offers instead of acting,
 * and the orchestrator parks `pendingAction: "SEARCH_OPTIONS"` so the traveler's next go-ahead resumes it.
 */
export function buildReadyToSearchPromptMessage(language: TravelResponseLanguage = "ENGLISH"): string {
  // Fix (Sprint 6.4 — Part 9): "Mere paas aapki trip ki saari details hain" / "मेरे पास आपकी यात्रा की सारी
  // जानकारी है" reads exactly like the English "I have everything I need" form-confirmation pattern
  // Sprint 6.3 already rephrased below — left untouched in Hindi/Hinglish until now.
  if (language === "HINGLISH")
    return "Ho gaya — kya main abhi aapki trip ke liye flight aur hotel options dhoondh loon?";
  if (language === "HINDI") return "हो गया — क्या मैं अभी आपकी यात्रा के लिए फ्लाइट और होटल विकल्प खोजूँ?";
  // Fix (Sprint 6.3 — Part 4): "I have everything I need" reads like a form confirming its own fields are
  // filled, not a person talking — rephrased as a natural offer instead.
  return "Got it — want me to look up flight and hotel options for your trip now?";
}

export function buildBookingConfirmedMessage(
  reference: string | null,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  if (language === "HINGLISH")
    return `Dhanyavad! Aapki booking intent record kar li gayi hai${reference ? ` (reference ${reference})` : ""}. Hamari team booking complete karne ke liye follow up karegi. Abhi tak koi payment nahi liya gaya hai aur koi reservation final nahi hai.`;
  if (language === "HINDI")
    return `धन्यवाद! आपकी बुकिंग इच्छा दर्ज कर ली गई है${reference ? ` (संदर्भ ${reference})` : ""}। हमारी टीम बुकिंग पूरी करने के लिए संपर्क करेगी। अभी तक कोई भुगतान नहीं लिया गया है और कोई आरक्षण अंतिम नहीं है।`;
  return `Thanks! Your booking intent has been recorded${reference ? ` (reference ${reference})` : ""}. Our team will follow up to complete the booking. No payment has been taken and no reservation is final.`;
}

/** Deterministic, honest reply for the `travel.resend_ticket` tool's result — never claims a resend
 *  succeeded on a channel it didn't actually go out on (see DeliveryRecorderService, which reports real
 *  per-channel SENT/FAILED/SKIPPED status, never a fabricated blanket "delivered"). */
export function buildResendTicketReply(output: {
  found?: unknown;
  pnr?: unknown;
  emailStatus?: unknown;
  whatsappStatus?: unknown;
}): string {
  if (!output.found) {
    return "I couldn't find a ticketed booking matching those details. Could you double-check the email address and travel date?";
  }
  const pnr = typeof output.pnr === "string" ? output.pnr : null;
  const channels: string[] = [];
  if (output.emailStatus === "SENT") channels.push("email");
  if (output.whatsappStatus === "SENT") channels.push("WhatsApp");
  if (channels.length === 0) {
    return `I found your booking${pnr ? ` (PNR: ${pnr})` : ""}, but I wasn't able to resend it just now — please contact support and we'll get it to you directly.`;
  }
  return `I've resent your ticket${pnr ? ` (PNR: ${pnr})` : ""} via ${channels.join(" and ")}. This is a simulated booking in the Krevia.ai demo environment.`;
}

/** Deterministic, non-LLM closing line for a tool-continuation turn that matched no known output shape. */
export function buildGenericContinuationMessage(language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH") return "Dhanyavad — batayein aapki trip ke saath aage kaise badhna hai.";
  if (language === "HINDI") return "धन्यवाद — बताइए आपकी यात्रा के साथ आगे कैसे बढ़ना है।";
  return "Thanks — let me know how you'd like to proceed with your trip.";
}

/** A natural, warm sign-off — see {@link isFarewellMessage}. Never re-asks for anything or repeats
 * whatever was last discussed; the conversation simply ends here. */
export function buildFarewellMessage(customerName: string | null, language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH")
    return `Bilkul${customerName ? `, ${customerName}` : ""}! Jab bhi kuch aur chahiye ho, bas wapas aa jaiyega. Aapki trip shubh ho! \u{1F44B}`;
  if (language === "HINDI")
    return `बिल्कुल${customerName ? `, ${customerName}` : ""}! जब भी कुछ और चाहिए हो, बस वापस आ जाइएगा। आपकी यात्रा शुभ हो! \u{1F44B}`;
  return `You're welcome${customerName ? `, ${customerName}` : ""}! Feel free to come back anytime you need anything else. Have a wonderful trip! \u{1F44B}`;
}

export function buildEscalationMessage(
  config: TravelEmployeeRuntimeConfig,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const hours =
    config.businessHoursStart && config.businessHoursEnd
      ? ` (business hours: ${config.businessHoursStart}-${config.businessHoursEnd}${config.businessHoursTimezone ? ` ${config.businessHoursTimezone}` : ""})`
      : "";
  if (language === "HINGLISH")
    return `Main aapko hamari team ke ek member se connect kar deta hoon. Aap seedhe ${config.escalationContact || "our support team"} par contact kar sakte hain${hours}.`;
  if (language === "HINDI")
    return `मैं आपको हमारी टीम के किसी सदस्य से जोड़ देता हूँ। आप सीधे ${config.escalationContact || "our support team"} पर संपर्क कर सकते हैं${hours}।`;
  return `I'll connect you with a human team member. You can reach us directly at ${config.escalationContact || "our support team"}${hours}.`;
}

// ---------------------------------------------------------------------------------------------------
// Conversation Completion & Lead Capture — Travel's own message copy and readiness/suggestion catalog
// around the generic state machine in `apps/api/src/conversation/conversation-completion.ts`. See the
// three-language pattern used throughout this file (buildConfirmPrompt et al.) — kept consistent here.
// ---------------------------------------------------------------------------------------------------

/**
 * The proactive "would you like to submit this?" ask — shown at most once per conversation (see
 * `completionStage`), and only once the traveler has actually received something substantial (a budget
 * estimate, options, or an itinerary) for a trip whose core details are complete.
 */
export function buildCompletionOfferMessage(
  customerName: string | null,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  if (language === "HINGLISH")
    return "Kya aap chahenge ki main ye travel request submit kar doon, taaki hamari team live pricing aur booking mein aapki madad kar sake?";
  if (language === "HINDI")
    return "क्या आप चाहेंगे कि मैं यह यात्रा अनुरोध सबमिट कर दूँ, ताकि हमारी टीम लाइव प्राइसिंग और बुकिंग में आपकी मदद कर सके?";
  return `Would you like to submit this travel request${customerName ? `, ${customerName}` : ""}, so one of our travel experts can contact you with live pricing and booking assistance?`;
}

/** Asks for a phone number after the traveler has said yes to `buildCompletionOfferMessage`. */
export function buildContactRequestMessage(language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH") return "Bilkul! Kya aap apna mobile number bata sakte hain, taaki hamara travel advisor aapse is trip ke baare mein baat kar sake?";
  if (language === "HINDI") return "बिल्कुल! क्या आप अपना मोबाइल नंबर बता सकते हैं, ताकि हमारा ट्रैवल एडवाइज़र आपसे इस यात्रा के बारे में बात कर सके?";
  return "Wonderful! May I have your mobile number so that our travel advisor can contact you regarding this trip?";
}

/** Shown when a reply during AWAITING_CONTACT doesn't contain a recognizable phone number. */
export function buildInvalidPhoneMessage(language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH") return "Maaf kijiye, wo ek valid mobile number nahi lagta. Kya aap country code ke saath dobara bhej sakte hain (jaise +91 98765 43210)?";
  if (language === "HINDI") return "क्षमा करें, वह एक मान्य मोबाइल नंबर नहीं लगता। क्या आप देश कोड सहित दोबारा भेज सकते हैं (जैसे +91 98765 43210)?";
  return "Sorry, that doesn't look like a valid mobile number. Could you share it again, ideally with the country code (e.g. +91 98765 43210)?";
}

export function buildPendingContactAcknowledgement(
  language: TravelResponseLanguage = "ENGLISH"
): string {
  if (language === "HINGLISH")
    return "Aapka swagat hai. Jab aap ready hon, apna mobile number share kar dijiye aur main travel enquiry submit kar dunga.";
  if (language === "HINDI")
    return "आपका स्वागत है। जब आप तैयार हों, अपना मोबाइल नंबर साझा करें और मैं यात्रा पूछताछ सबमिट कर दूँगा।";
  return "You're welcome. Whenever you're ready, share your mobile number and I can submit the travel enquiry.";
}

export function buildStandaloneContactConfirmation(
  entities: TravelEntities,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const route =
    entities.originCity && entities.destinationCity
      ? ` for your ${entities.originCity}-to-${entities.destinationCity} trip`
      : " for your current trip";
  if (language === "HINGLISH")
    return `Ye mobile number lag raha hai. Kya main ise aapki current trip ke liye travel enquiry create karne ya callback arrange karne ke liye use karun?`;
  if (language === "HINDI")
    return "यह मोबाइल नंबर लगता है। क्या मैं इसे आपकी वर्तमान यात्रा के लिए यात्रा पूछताछ बनाने या कॉलबैक की व्यवस्था करने के लिए उपयोग करूँ?";
  return `That looks like a mobile number. Would you like me to use it to create a travel enquiry or arrange a callback${route}?`;
}

/** Final confirmation once the lead has actually been persisted, with its reference number. */
export function buildLeadCapturedMessage(
  customerName: string | null,
  reference: string,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  if (language === "HINGLISH")
    return `Dhanyavad${customerName ? `, ${customerName}` : ""}!\n\nAapki travel request successfully submit ho gayi hai.\n\nReference Number: ${reference}\n\nHamara travel expert jald hi aapse contact karega.`;
  if (language === "HINDI")
    return `धन्यवाद${customerName ? `, ${customerName}` : ""}!\n\nआपका यात्रा अनुरोध सफलतापूर्वक सबमिट हो गया है।\n\nसंदर्भ संख्या: ${reference}\n\nहमारा यात्रा विशेषज्ञ जल्द ही आपसे संपर्क करेगा।`;
  return `Thank you${customerName ? `, ${customerName}` : ""}.\n\nYour travel request has been submitted successfully.\n\nReference Number: ${reference}\n\nOur travel expert will contact you shortly.`;
}

/** Branches (see `tag`'s `branch` argument) where the traveler has just received something substantial
 * enough — options, a budget figure, or an itinerary — for the Goal Engine and the completion offer to be
 * relevant. Deliberately a safelist: mid-collection questions, clarifications, and error/escalation
 * replies must never carry either. */
const GOAL_ENGINE_ELIGIBLE_BRANCHES = new Set([
  "execute_search",
  "search_hotels",
  "search_flights",
  "search_live_options",
  "resume_search",
  "resume_search_indicative_after_failure",
  "generate_indicative_recommendations",
  "generate_itinerary",
  "resume_generate_itinerary",
  "calculate_budget",
  "resume_budget_guidance",
  "calculate_journey_budget"
]);
const BUDGET_OR_OPTIONS_BRANCHES = new Set([
  "execute_search",
  "search_hotels",
  "search_flights",
  "search_live_options",
  "resume_search",
  "resume_search_indicative_after_failure",
  "generate_indicative_recommendations",
  "calculate_budget",
  "resume_budget_guidance",
  "calculate_journey_budget"
]);
const BUDGET_ONLY_BRANCHES = new Set(["calculate_budget", "resume_budget_guidance", "calculate_journey_budget"]);
const ITINERARY_BRANCHES = new Set(["generate_itinerary", "resume_generate_itinerary"]);

/**
 * The Conversation Goal Engine: context-aware "what next" suggestions computed from what was just
 * delivered on this branch and what TripState still doesn't have — never re-suggesting something already
 * shown. See the OBJECTIVES in the Conversation Completion & Lead Capture spec for the exact catalog.
 */
function computeSuggestedActions(
  branch: string,
  entities: TravelEntities,
  hasItinerary: boolean
): SuggestedAction[] {
  const actions: SuggestedAction[] = [];
  // Domestic trips must never suggest visa/insurance/currency-exchange — those are only ever relevant
  // once origin and destination are positively known to be in different countries. Reuses the same
  // conservative `isDomesticTrip` already used to gate Visa/Insurance out of the budget estimate itself,
  // so the Goal Engine's suggestions and the budget breakdown never disagree about whether this trip is
  // international.
  const international = !isDomesticTrip(entities.originCity, entities.destinationCity);
  const visaWorthAsking = international && entities.visaRequired !== false;
  if (BUDGET_OR_OPTIONS_BRANCHES.has(branch)) {
    if (!hasItinerary) actions.push({ label: "Create a full itinerary" });
    if (BUDGET_ONLY_BRANCHES.has(branch)) {
      actions.push({ label: "Recommend hotels" });
      actions.push({ label: "Suggest flights" });
    }
    if (international) {
      if (visaWorthAsking) actions.push({ label: "Estimate visa cost" });
      actions.push({ label: "Check travel insurance options" });
      actions.push({ label: "Currency exchange guidance" });
    }
    return actions.slice(0, 6);
  }
  if (ITINERARY_BRANCHES.has(branch)) {
    return [
      { label: "Recommend hotels" },
      { label: "Restaurant suggestions" },
      { label: "Weather for your travel dates" },
      { label: "Packing checklist" }
    ];
  }
  return actions;
}

function formatSuggestedActionsLocalized(
  actions: readonly SuggestedAction[],
  language: TravelResponseLanguage
): string {
  const heading =
    language === "HINGLISH" ? "Aapko ye bhi useful lag sakta hai:" : language === "HINDI" ? "आपको ये भी उपयोगी लग सकता है:" : "You might also find these useful:";
  return formatSuggestedActions(actions, heading);
}

function toolAvailable(tools: readonly AiToolDefinition[] | undefined, name: string): boolean {
  return Boolean(tools?.some((tool) => tool.name === name));
}
/** Used only by the BELOW_MINIMUM sales handoff (see `handleBelowMinimumFeasibility`) — a proactive,
 * assistant-initiated escalation distinct from the consent-gated Lead Capture flow, and the one remaining
 * place the optional CRM connector is still used directly. */
function findCrmLeadTool(tools: readonly AiToolDefinition[] | undefined): AiToolDefinition | undefined {
  return tools?.find((tool) => tool.name.endsWith("crm.create_lead"));
}
function safeParseJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
function findPriorToolValue(messages: readonly AiMessage[], key: string): unknown {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== "tool") continue;
    const parsed = safeParseJson(message.content);
    if (key in parsed) return parsed[key];
  }
  return undefined;
}
let toolCallSequence = 0;
function toolResult(name: string, args: Record<string, unknown>): AiCompletionResult {
  toolCallSequence += 1;
  return {
    content: "",
    toolCalls: [{ id: `travel-${name}-${toolCallSequence}`, name, arguments: args }],
    provider: "travel-employee",
    model: "travel-employee-v1",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
  };
}
function textResult(
  content: string,
  meta?: {
    provider?: string;
    model?: string;
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  }
): AiCompletionResult {
  const tokens = Math.max(1, Math.ceil(content.length / 4));
  return {
    content,
    toolCalls: [],
    provider: meta?.provider ?? "travel-employee",
    model: meta?.model ?? "travel-employee-v1",
    usage: meta?.usage ?? { inputTokens: tokens, outputTokens: tokens, totalTokens: tokens * 2 }
  };
}

/**
 * Adapts the deterministic provider's simpler {@link TravelSlots} into a minimal {@link TravelEntities}
 * shell — just enough to reuse the shared `estimateBudgetRange`/`classifyBudgetFeasibility`/
 * `buildBelowMinimumMessage` machinery for its own BELOW_MINIMUM budget-feasibility check, without
 * duplicating that pricing logic. `TravelSlots` has no origin city or adult/child breakdown, so those stay
 * null/unknown here exactly as they are in the slots themselves.
 */
function slotsToMinimalEntities(slots: TravelSlots): TravelEntities {
  return {
    ...EMPTY_TRAVEL_ENTITIES,
    destinationCity: slots.destination,
    travelMonth: slots.travelMonth,
    days: slots.durationDays,
    adults: slots.passengers,
    totalTravellers: slots.passengers,
    budget: slots.budgetAmount,
    budgetCurrency: slots.budgetCurrency
  };
}

/**
 * Stage 9E: which of the two ways Travel Runtime can be run.
 *  - `PLATFORM_MANAGED`: workflow authority (contact collection, submission, booking handoff) belongs
 *    entirely to the Workflow Runtime. Travel Runtime ADDITIONALLY emits a typed `TravelWorkflowSignalDraft`
 *    (see `lastWorkflowSignal` on both engines below) and lets `AgentService`/`WorkflowCoordinator` persist
 *    and own whatever happens next — see the Stage 9E.1 audit below for exactly which legacy fields it
 *    still writes in this mode and why. This is what `AgentService` always uses.
 *  - `STANDALONE_COMPATIBILITY` (the default): the original, pre-Stage-9E behavior — Travel Runtime owns
 *    its own `pendingInputAction`/`completionStage` transitions directly, exactly as before. Every direct
 *    unit-test construction of either engine (e.g. `travel.llm.spec.ts`) is unaffected by Stage 9E because
 *    it never passes this parameter and so keeps this default.
 *
 * Stage 9E.1 audit — every legacy-field mutation reachable in `PLATFORM_MANAGED` mode, classified per the
 * charter's four categories (`required compatibility mirror` / `historical migration support` /
 * `standalone-only behaviour` / `obsolete authority`). This is exhaustive: grep this file for
 * `executionMode === "PLATFORM_MANAGED"` — there are exactly two call sites (the deterministic
 * `TravelEmployeeProvider`'s and the LLM `TravelEmployeeLlmOrchestrator`'s own BELOW_MINIMUM branch), and
 * both make the SAME two mutations:
 *
 *  - `completionStage = "AWAITING_CONTACT"`, `pendingInputAction = "AWAITING_LEAD_CONTACT"` — classified
 *    **required compatibility mirror + historical migration support**, kept intentionally, NOT obsolete:
 *    (1) it is what `WorkflowCoordinator.migrateHistoricalContactState` reads to self-heal if the signal
 *        dispatch itself ever fails on this same turn (a real restart-safety guarantee, not decoration);
 *    (2) removing it was tried during this stage and broke an unrelated downstream branch (`tag()`'s
 *        Conversation-Completion-offer gate also reads `completionStage`) — proven by a dedicated
 *        byte-for-byte response-text comparison test between `STANDALONE_COMPATIBILITY` and
 *        `PLATFORM_MANAGED` (see `travel.llm.spec.ts`/`travel.runtime.spec.ts`'s Stage 9E describe blocks);
 *    (3) it can never let legacy state override an active persisted workflow: `WorkflowCoordinator.
 *        dispatchTurn` checks `findActiveWorkflowsForConversation` FIRST, every turn, before ever
 *        consulting this legacy memory for anything — once a real `WorkflowExecution` row exists (created
 *        the same turn this mutation runs, via the signal dispatch below), this field is provably inert
 *        for every later turn of that conversation (see `workflow-coordinator.spec.ts`'s "Runtime
 *        authority" tests).
 *  - `pendingAction = null`, `providerFailure = null` — classified **standalone-only Travel Runtime
 *    hygiene, not legacy WORKFLOW authority at all**: neither field exists on `WorkflowExecution` or is
 *    ever read by any workflow service; they are Travel Runtime's own per-turn bookkeeping (a blocking
 *    structured action / a live-provider failure record), orthogonal to contact/workflow state, reset here
 *    only because BELOW_MINIMUM is switching this turn's focus to a feasibility explanation. Out of scope
 *    for "legacy workflow-related fields" — nothing to narrow.
 *
 * No mutation in this audit is classified **obsolete authority** — none were removed from
 * `PLATFORM_MANAGED`. The BELOW_MINIMUM-adjacent legacy paths from BEFORE Stage 9E (`STANDALONE_CONTACT`
 * resolution, decline handling, the tool-result CAPTURED transition, etc.) were already established in
 * Stage 9C/9D as provably unreachable in the integrated `AgentService` path (an active/waiting workflow, or
 * `dispatchPendingWorkflowTurn`'s free-text signal derivation, always intercepts the turn before Travel
 * Runtime's own `complete()` runs) — this audit does not change that; it only covers what THIS stage
 * touches.
 */
export type TravelRuntimeExecutionMode = "PLATFORM_MANAGED" | "STANDALONE_COMPATIBILITY";

/**
 * Stage 9E: a minimal, workflows/-module-independent draft of a workflow-start signal. Travel Runtime emits
 * this instead of importing `WorkflowSignal` from the Workflow Runtime (which would create a reverse
 * dependency — several workflow services already import pure functions/types FROM this file). AgentService
 * fills in the remaining typed fields (`sourceTurnId`, `sourceSkillExecutionId`) to build a full
 * `WorkflowSignal` before handing it to `WorkflowCoordinator.dispatchSignal`. Currently only one Travel
 * Runtime business result (BELOW_MINIMUM budget feasibility) emits one of these.
 */
export type TravelWorkflowSignalDraftType = "START_TRIP_SUBMISSION" | "START_BOOKING_HANDOFF";

export interface TravelWorkflowSignalDraft {
  signalType: TravelWorkflowSignalDraftType;
  trigger: string;
  payload?: Record<string, unknown>;
}

/**
 * Deterministic, code-driven conversation engine for the Travel Employee. Runs through the same
 * AiProvider contract and tool-calling loop as any other AI employee, so dashboard chat and the
 * WhatsApp channel share this without duplication. It never claims a booking occurred.
 */
export class TravelEmployeeProvider implements AiProvider {
  private memory: TravelConversationMemory;
  private priorEntities: TravelEntities;
  private pendingWorkflowSignal: TravelWorkflowSignalDraft | null = null;
  private routingHandoffSignal: RoutingHandoffSignal | null = null;

  constructor(
    private readonly config: TravelEmployeeRuntimeConfig,
    priorMemory: TravelConversationMemory = EMPTY_TRAVEL_CONVERSATION_MEMORY,
    priorEntities: TravelEntities = EMPTY_TRAVEL_ENTITIES,
    private readonly executionMode: TravelRuntimeExecutionMode = "STANDALONE_COMPATIBILITY"
  ) {
    this.memory = { ...priorMemory };
    this.priorEntities = priorEntities;
  }

  get lastMemory(): TravelConversationMemory {
    return this.memory;
  }

  /** The full merged trip state after the just-completed turn (see `mergeEntitiesWithPriorState`) —
   *  includes fields (originCity, tripType, preferences, ...) that the older `TravelState`/`TravelSlots`
   *  shape `deriveTravelState` produces does NOT have at all. AgentService must persist THIS, not a
   *  `deriveTravelState` reconstruction, or those fields are silently dropped between turns (a "from
   *  Delhi"-only origin statement, a stated round-trip type, or a vegetarian preference would never
   *  survive to the next turn even though this provider itself tracked it correctly all along). */
  get lastEntities(): TravelEntities {
    return this.priorEntities;
  }

  /** Stage 9E: non-null only the turn Travel Runtime's own business calculation (currently only the
   *  BELOW_MINIMUM budget result) decided a workflow should start — see `TravelRuntimeExecutionMode`.
   *  AgentService reads this once per turn and hands it to `WorkflowCoordinator.dispatchSignal`; it is
   *  never consulted by Travel Runtime itself. Reset at the start of every `complete()` call. */
  get lastWorkflowSignal(): TravelWorkflowSignalDraft | null {
    return this.pendingWorkflowSignal;
  }

  /** Non-null only the turn a routing offer (see `buildOutOfScopeRoutingMessage`) was just confirmed. This
   *  provider has no Prisma access to actually create the handoff conversation — AgentService reads this
   *  once per turn and does the real work, rewriting this turn's response once it knows the outcome. */
  get lastRoutingHandoffSignal(): RoutingHandoffSignal | null {
    return this.routingHandoffSignal;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    this.pendingWorkflowSignal = null;
    this.routingHandoffSignal = null;
    const messages = request.messages;
    const last = messages.at(-1);
    const userMessages = messages.filter((message) => message.role === "user").map((message) => message.content);
    const currentText = userMessages.at(-1) ?? "";

    // Attached document (PDF/DOCX/TXT/JPG/PNG): the extracted text arrives as `[Attachment: ...]` blocks.
    // Acknowledge reading the document and summarise what it's about; if the document clearly belongs to a
    // different employee's domain, route it instead of treating the file's text as ordinary trip input.
    const attachmentBlocks = parseAttachmentBlocks(currentText);
    if (attachmentBlocks.length > 0) {
      return textResult(buildAttachmentReadMessage(TRAVEL_ATTACHMENT_SPEC, attachmentBlocks));
    }
    const lastAssistantMessage =
      [...messages].reverse().find((message) => message.role === "assistant")?.content ?? null;
    // Out-of-scope routing for ordinary messages: a reimbursement/expense/HR/legal request that has nothing
    // to do with trip planning is answered with a polite "not my area — I can route you" reply instead of
    // forcing the traveler through trip-detail questions. Never interrupts an active pending action or
    // contact capture (e.g. a phone number being collected for a real trip).
    if (
      this.memory.pendingAction === null &&
      this.memory.completionStage !== "AWAITING_CONTACT" &&
      this.memory.completionStage !== "CAPTURED"
    ) {
      // Confirming a previously offered routing handoff ("yes", "route it", ...) — checked before a fresh
      // out-of-scope detection, since the confirmation reply itself ("yes") never carries any domain signal.
      const confirmation = detectRoutingConfirmation(TRAVEL_ATTACHMENT_SPEC, messages);
      if (confirmation) {
        this.routingHandoffSignal = {
          targetSlug: confirmation.target.slug,
          originalText: confirmation.originalText
        };
        return textResult(`Connecting you to ${confirmation.target.displayName}…`);
      }
      // Sprint 6.4 — Part 10: pass Travel's own last reply so a bare "budget"/"invoice"-style word that
      // merely echoes a question TRAVEL itself just asked ("...your approximate budget?" -> "budget 10000
      // AED") never gets bounced to Finance — see the `contextEcho` check inside detectOutOfScopeEmployee.
      const travelOutOfScope = detectOutOfScopeEmployee(
        TRAVEL_ATTACHMENT_SPEC,
        currentText,
        lastAssistantMessage
      );
      if (travelOutOfScope) {
        return textResult(buildOutOfScopeRoutingMessage(TRAVEL_ATTACHMENT_SPEC, travelOutOfScope));
      }
    }

    // Captured before the merge below reassigns `this.priorEntities` — used only to tell whether the
    // name was known BEFORE this turn started (e.g. seeded by a Receptionist handoff, or captured on a
    // prior turn), independent of whatever this turn's raw transcript scan would find.
    const nameKnownBeforeThisTurn = Boolean(this.priorEntities.customerName);

    const mergedEntities = mergeEntitiesWithPriorState(
      this.priorEntities,
      currentText,
      userMessages,
      lastAssistantMessage,
      this.config.defaultCurrency || "USD"
    );
    this.priorEntities = mergedEntities;

    // Sprint 6.3 — Part 7: "I want another trip"/"start a new trip" after a trip is already in progress
    // (or already booked) must start completely fresh — not be read as still talking about the OLD trip,
    // which is what happened before this check existed: `mergeEntitiesWithPriorState` carries the prior
    // destination/dates/budget forward untouched (correctly, for an ordinary follow-up), so a message that
    // states no NEW destination looked, to the rest of this dispatch chain, exactly like "everything's
    // still known, ready to confirm" — producing a confusing "book this or adjust it?" reply instead of
    // asking where the new trip should go. Resets trip DETAILS only, never the customer's name (already
    // introduced, never re-asked just because they're planning a different trip) and never the completed
    // booking itself (a real `TravelBooking` row, untouched in Postgres — this only clears this Runtime's
    // own in-memory/persisted trip-planning entities for the NEXT trip).
    if (
      NEW_INDEPENDENT_TRIP_PATTERN.test(currentText) &&
      (mergedEntities.destinationCity || mergedEntities.departureDate || mergedEntities.travelMonth || mergedEntities.budget)
    ) {
      this.priorEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: mergedEntities.customerName };
      this.memory = {
        ...this.memory,
        pendingAction: null,
        pendingInputAction: null,
        completionStage: "NOT_OFFERED",
        conversationClosed: false,
        providerFailure: null,
        pendingRecommendations: null,
        selectedRecommendationId: null,
        passengerDetails: null,
        ticketContact: null,
        pendingContactValue: null,
        pendingPassengerConflict: null
      };
      return textResult(
        mergedEntities.customerName
          ? `Of course, ${mergedEntities.customerName}! Where would you like to go this time?`
          : "Of course! Where would you like to go this time?"
      );
    }

    const rawSlots = extractTravelSlots(userMessages, this.config.defaultCurrency);
    const slots: TravelSlots = {
      destination: mergedEntities.destinationCity ?? rawSlots.destination,
      travelMonth: mergedEntities.travelMonth ?? rawSlots.travelMonth,
      durationDays: mergedEntities.days ?? mergedEntities.nights ?? rawSlots.durationDays,
      passengers: mergedEntities.adults ?? mergedEntities.totalTravellers ?? rawSlots.passengers,
      budgetAmount: mergedEntities.budget ?? rawSlots.budgetAmount,
      budgetCurrency: mergedEntities.budgetCurrency ?? rawSlots.budgetCurrency
    };

    if (last?.role === "tool") {
      const result = this.continueAfterTool(messages, last, slots, request.tools);
      const output = safeParseJson(last.content);
      if (typeof output.reference === "string" && typeof output.leadId === "string")
        this.memory = {
          ...this.memory,
          completionStage: "CAPTURED",
          pendingInputAction: null,
          pendingContactValue: null,
          conversationClosed: false,
          capturedLeadReference: output.reference
        };
      return result;
    }

    // Resend Ticket: a returning customer asking for their ticket again — checked ahead of BOTH
    // `resolveTravelInput` (which would otherwise misclassify a message containing an email as
    // STANDALONE_CONTACT/lead-capture before this ever runs) and the name-collection gate further below,
    // so it works even in a brand-new conversation, before the traveler has re-introduced themselves.
    // Only ever needs an email (the definitive lookup key); the travel date narrows an ambiguous match but
    // is never required, and the customer's name is only used for a friendlier confirmation once the
    // booking is actually found downstream.
    if (this.memory.pendingAction === "AWAITING_RESEND_TICKET_DETAILS" || isResendTicketRequest(currentText)) {
      const priorLookup = this.memory.pendingResendLookup;
      const email = extractEmailAddress(currentText) ?? priorLookup?.email ?? null;
      const travelDate = extractResendTicketDate(currentText) ?? priorLookup?.travelDate ?? null;
      if (!email) {
        this.memory = {
          ...this.memory,
          pendingAction: "AWAITING_RESEND_TICKET_DETAILS" as TravelPendingAction,
          pendingResendLookup: { email, travelDate }
        };
        return textResult(
          "I can resend your ticket — could you share the email address you booked with, and your travel date if you remember it?"
        );
      }
      this.memory = { ...this.memory, pendingAction: null, pendingResendLookup: null };
      return toolResult("travel.resend_ticket", {
        email,
        travelDate,
        // Fix (Sprint 6.3 — Part 1/7): prefer the already-confirmed name over a fresh transcript scan —
        // see `mergeEntitiesWithPriorState`'s own fix for why a raw re-scan can misfire on a later turn.
        customerName: mergedEntities.customerName ?? extractCustomerName(userMessages)
      });
    }

    // Ticket Contact: every traveller's details are recorded and the traveler is now being asked where to
    // send the confirmed ticket — checked ahead of `resolveTravelInput` for the same reason as Resend
    // Ticket above: an email or phone number typed here would otherwise be misclassified as
    // STANDALONE_CONTACT/lead-capture before this pending state is ever consulted.
    if (this.memory.pendingAction === "AWAITING_TICKET_CONTACT") {
      const pendingOptions = this.memory.pendingRecommendations ?? [];
      const selected = pendingOptions.find((option) => option.recommendationId === this.memory.selectedRecommendationId);
      if (!selected) {
        this.memory = {
          ...this.memory,
          pendingAction: null,
          selectedRecommendationId: null,
          passengerDetails: null,
          ticketContact: null
        };
        return textResult("Something went wrong with your booking options — please ask to book your trip again.");
      }
      const confirmedPassengers = this.memory.passengerDetails ?? [];
      if (isChangeOptionRequest(currentText)) {
        this.memory = { ...this.memory, pendingAction: "AWAITING_OPTION_SELECTION" as TravelPendingAction, selectedRecommendationId: null };
        return textResult(formatPackageOptionsMessage(pendingOptions));
      }
      // Fix (Travel Booking Closure Pass — Phase 3): extract an actual contact value FIRST — a customer
      // who volunteers a real email/phone must always be honored, even if their message also happens to
      // contain an incidental "chat"/"no email"-shaped word (e.g. "no email, WhatsApp me at +91..."). Only
      // when no contact value is present does the broadened natural-language CHAT_DOWNLOAD check apply.
      const contactEmail = extractEmailAddress(currentText);
      const contactPhone = extractPhoneNumber(currentText);
      if (contactEmail || contactPhone) {
        this.memory = {
          ...this.memory,
          ticketContact: { email: contactEmail, phone: contactPhone },
          pendingAction: "AWAITING_BOOKING_CONFIRMATION" as TravelPendingAction
        };
        return textResult(buildBookingConfirmationSummary(this.priorEntities, selected, confirmedPassengers));
      }
      if (isSkipTicketContactRequest(currentText)) {
        this.memory = {
          ...this.memory,
          ticketContact: { email: null, phone: null },
          pendingAction: "AWAITING_BOOKING_CONFIRMATION" as TravelPendingAction
        };
        return textResult(buildBookingConfirmationSummary(this.priorEntities, selected, confirmedPassengers));
      }
      return textResult(buildTicketContactRequestMessage());
    }

    const resolvedInput = resolveTravelInput(currentText, {
      pendingInputAction: this.memory.pendingInputAction ?? null,
      pendingContactValue: this.memory.pendingContactValue ?? null,
      tripState: this.priorEntities,
      lastAssistantQuestion:
        [...messages].reverse().find((message) => message.role === "assistant")?.content ?? null,
      conversationClosed: this.memory.conversationClosed ?? false,
      currentLeadState:
        this.memory.completionStage === "CAPTURED"
          ? "CREATED"
          : this.memory.completionStage === "AWAITING_CONTACT"
            ? "PENDING"
            : "NONE"
    });
    if (
      this.memory.completionStage === "CAPTURED" &&
      this.memory.capturedLeadReference &&
      looksLikePhoneOrContact(currentText)
    )
      return textResult(buildLeadAlreadyCapturedMessage(this.memory.capturedLeadReference));
    if (resolvedInput.kind === "PENDING_CONTACT") {
      this.memory = {
        ...this.memory,
        conversationClosed: false,
        pendingAction: null,
        providerFailure: null,
        pendingContactValue: resolvedInput.contact
      };
      return toolResult(
        "travel.create_lead",
        this.buildDeterministicLeadPayload(
          slots,
          mergedEntities.customerName ?? extractCustomerName(userMessages),
          resolvedInput.contact,
          currentText
        )
      );
    }
    if (resolvedInput.kind === "PENDING_CONTACT_NON_CONTACT")
      return textResult(buildPendingContactAcknowledgement());
    if (resolvedInput.kind === "PENDING_CONTACT_PAUSED") {
      this.memory = {
        ...this.memory,
        completionStage: "DECLINED",
        pendingInputAction: null,
        pendingContactValue: null
      };
      return textResult(
        buildFarewellMessage(
          mergedEntities.customerName ?? extractCustomerName(userMessages),
          detectResponseLanguage(currentText)
        )
      );
    }
    if (resolvedInput.kind === "INVALID_CONTACT_ATTEMPT")
      return textResult(buildInvalidPhoneMessage());
    if (resolvedInput.kind === "STANDALONE_CONTACT") {
      this.memory = {
        ...this.memory,
        pendingAction: null,
        providerFailure: null,
        pendingPassengerConflict: null,
        pendingInputAction: "CONFIRM_STANDALONE_CONTACT_USE",
        pendingContactValue: resolvedInput.contact
      };
      return textResult(
        buildStandaloneContactConfirmation(
          {
            ...this.priorEntities,
            destinationCity: slots.destination ?? this.priorEntities.destinationCity
          },
          detectResponseLanguage(currentText)
        )
      );
    }
    if (resolvedInput.kind === "STANDALONE_CONTACT_CONFIRMED") {
      this.memory = { ...this.memory, pendingInputAction: null };
      return toolResult(
        "travel.create_lead",
        this.buildDeterministicLeadPayload(
          slots,
          mergedEntities.customerName ?? extractCustomerName(userMessages),
          resolvedInput.contact,
          currentText
        )
      );
    }
    // Sprint 6.6 — Part 7 (root cause): this kind was never handled here at all — a genuine decline of
    // "would you like me to use this number?" silently fell through this whole method instead of ending
    // the offer gracefully, unlike TravelEmployeeLlmOrchestrator's equivalent branch below (search this
    // file for the same `STANDALONE_CONTACT_DECLINED` check), which already does exactly this. Mirrored
    // verbatim for engine parity rather than inventing a different response here.
    if (resolvedInput.kind === "STANDALONE_CONTACT_DECLINED") {
      this.memory = { ...this.memory, pendingInputAction: null, pendingContactValue: null };
      return textResult(
        buildFarewellMessage(
          mergedEntities.customerName ?? extractCustomerName(userMessages),
          detectResponseLanguage(currentText)
        )
      );
    }
    if (isFarewellMessage(currentText)) {
      this.memory = {
        ...this.memory,
        conversationClosed: true,
        pendingAction: null,
        pendingInputAction: null,
        providerFailure: null,
        pendingPassengerConflict: null
      };
      return textResult(
        buildFarewellMessage(
          mergedEntities.customerName ?? extractCustomerName(userMessages),
          detectResponseLanguage(currentText)
        )
      );
    }

    if (isEscalationRequest(currentText) && !wasEscalated(messages)) {
      if (toolAvailable(request.tools, "travel.escalate"))
        return toolResult("travel.escalate", { reason: currentText.slice(0, 500) });
      return textResult(buildEscalationMessage(this.config));
    }

    // Onboarding gate: the traveler's name is collected before any trip-detail question, per the
    // GREETING -> COLLECT_NAME -> trip-discovery workflow. A message that only states trip content
    // ("Delhi jana hai") is acknowledged but still routed back to asking for the name; a message that
    // introduces the traveler (with or without trip content in the same message) is never re-asked.
    // Prefer the already-merged entity state (which itself already prefers a name found in the current
    // message, falling back to whatever was already known — see `mergeEntitiesWithPriorState`) over a
    // fresh full-transcript scan. This is what lets a name seeded from a Receptionist handoff (present in
    // `this.priorEntities` from turn one, never itself a message in this transcript) actually suppress
    // the name gate — a raw `extractCustomerName(userMessages)` rescan would never find it there.
    const nameKnownBefore = nameKnownBeforeThisTurn || Boolean(extractCustomerName(userMessages.slice(0, -1)));
    const customerName = mergedEntities.customerName ?? extractCustomerName(userMessages);
    if (!customerName) return textResult(buildNameRequestMessage(currentText));
    const justLearnedName = !nameKnownBefore;

    // Intent Discovery: right after the name is captured, if the traveler has not stated any trip
    // content at all yet (across the whole conversation so far — see the combined-message test where
    // the name AND a destination arrive together, which must skip straight past this), offer the intent
    // menu instead of assuming a trip is being planned. Shown exactly once per conversation: on every
    // later turn `justLearnedName` is false, so normal slot collection proceeds untouched.
    const hasStatedTripContent = Object.values(slots).some((value) => value !== null);
    if (justLearnedName && !hasStatedTripContent)
      return textResult(buildIntentDiscoveryMessage(customerName, detectResponseLanguage(currentText)));
    const namePrefix = justLearnedName ? `${buildNameAcknowledgment(customerName)} ` : "";

    // Idempotency / already-captured: once a lead exists for this conversation, ANY later affirmative,
    // repeated phone number, or repeated explicit callback/submit ask re-confirms the SAME reference —
    // never a second lead, and never a re-ask for contact details already given. This is the deterministic
    // provider's own equivalent of `completionStage === "CAPTURED"` (it has no persisted state to check
    // instead — everything is re-derived from the transcript every turn).
    if (wasLeadCaptured(messages)) {
      const reference = extractCapturedLeadReference(messages);
      if (reference) return textResult(buildLeadAlreadyCapturedMessage(reference));
    }

    // Pending-contact continuation: the last turn asked for a phone number (either after the itinerary was
    // confirmed, or after an explicit callback/submit-enquiry ask below) — a bare Hinglish affirmative or
    // unrelated reply here must never be misread as a phone number, and must never silently create a lead
    // without one. Only a message that actually contains a phone number resolves this.
    if (wasContactInfoRequested(messages) && !wasLeadCaptured(messages)) {
      const phone = extractPhoneNumber(currentText);
      if (phone)
        return toolResult("travel.create_lead", this.buildDeterministicLeadPayload(slots, customerName, phone, currentText));
      if (!isNegativeResponse(currentText)) return textResult(buildInvalidPhoneMessage());
      // A clear decline falls through to normal handling below rather than re-asking for a phone number.
    }

    // Explicit callback/submit-enquiry/create-lead requests are terminal, always-win lead-capture asks —
    // never gated on trip-detail completeness (a traveler can ask to be called back mid-collection).
    if (
      REQUEST_CALLBACK_PATTERN.test(currentText) ||
      SUBMIT_ENQUIRY_PATTERN.test(currentText) ||
      CREATE_LEAD_PATTERN.test(currentText)
    ) {
      const phone = extractPhoneNumber(currentText);
      if (phone)
        return toolResult("travel.create_lead", this.buildDeterministicLeadPayload(slots, customerName, phone, currentText));
      this.memory = {
        ...this.memory,
        completionStage: "AWAITING_CONTACT",
        pendingInputAction: "AWAITING_LEAD_CONTACT",
        pendingAction: null,
        providerFailure: null
      };
      return textResult(buildContactRequestMessage());
    }

    const sprintPhase: ConversationPhase =
      wasLeadCaptured(messages) ? "BOOKED" :
      this.memory.completionStage === "AWAITING_CONTACT" ? "BOOKING_APPROVAL_PENDING" :
      this.memory.pendingAction === "AWAITING_OPTION_SELECTION" ||
      this.memory.pendingAction === "AWAITING_PASSENGER_DETAILS" ||
      this.memory.pendingAction === "AWAITING_BOOKING_CONFIRMATION" ||
      this.memory.pendingAction === "BOOK_TRIP" ? "AWAITING_SELECTION" :
      "COLLECTING_DETAILS";

    const sprintIntent = detectSprintIntent(currentText, sprintPhase);

    // Routing priority 1: CANCELLATION
    if (sprintIntent.intent === "CANCELLATION_INTENT") {
      return textResult(
        `I understand you'd like to cancel. A manager will need to approve this cancellation. Please confirm you'd like to proceed.`
      );
    }

    // Routing priority 2a: OPTION SELECTION — a package-options menu is active; this must win over a
    // generic BOOKING_INTENT re-match (bookingPatterns includes "option 1"/"pick 2" itself) and over
    // everything else, since the traveler is answering a specific, already-pending question.
    if (this.memory.pendingAction === "AWAITING_OPTION_SELECTION" && this.memory.pendingRecommendations?.length) {
      const pendingOptions = this.memory.pendingRecommendations;
      if (isChangeOptionRequest(currentText)) {
        return textResult(formatPackageOptionsMessage(pendingOptions));
      }
      const picked = detectOptionSelection(currentText);
      if (picked !== null) {
        if (isOptionSetExpired(pendingOptions)) {
          const fresh = generateSimulatedPackageOptions(this.priorEntities, this.config, packageOptionSeed(this.priorEntities));
          this.memory = { ...this.memory, pendingRecommendations: fresh, selectedRecommendationId: null };
          return textResult(
            `Those options have expired — here is a fresh set:\n\n${formatPackageOptionsMessage(fresh)}`
          );
        }
        const selected = pendingOptions.find((option) => option.optionNumber === picked);
        if (selected) {
          // Passenger details already gathered (e.g. the traveler switched between options after already
          // providing them — every option has the same traveller count) go straight to the confirmation
          // summary; otherwise a real ticket can't be produced without a name for every seat, so this asks
          // for them before anything else.
          const alreadyCollected = this.memory.passengerDetails ?? [];
          if (alreadyCollected.length >= selected.travellers) {
            this.memory = { ...this.memory, selectedRecommendationId: selected.recommendationId };
            if (this.memory.ticketContact === null) {
              this.memory = { ...this.memory, pendingAction: "AWAITING_TICKET_CONTACT" as TravelPendingAction };
              return textResult(buildTicketContactRequestMessage());
            }
            this.memory = { ...this.memory, pendingAction: "AWAITING_BOOKING_CONFIRMATION" as TravelPendingAction };
            return textResult(
              buildBookingConfirmationSummary(this.priorEntities, selected, alreadyCollected.slice(0, selected.travellers))
            );
          }
          this.memory = {
            ...this.memory,
            pendingAction: "AWAITING_PASSENGER_DETAILS" as TravelPendingAction,
            selectedRecommendationId: selected.recommendationId
          };
          return textResult(buildPassengerDetailsRequestMessage(selected.travellers, alreadyCollected));
        }
      }
      return textResult("Sorry, I didn't catch which one you'd like — Value, Recommended, or Premium?");
    }

    // Routing priority 2a-bis: PASSENGER DETAILS — an option is selected; the traveler must supply every
    // traveller's full name, age, and gender before the booking summary (and, eventually, a real ticket)
    // can be produced. See travel-package-options.ts's `parsePassengerDetailsReply`.
    if (this.memory.pendingAction === "AWAITING_PASSENGER_DETAILS") {
      const pendingOptions = this.memory.pendingRecommendations ?? [];
      const selected = pendingOptions.find((option) => option.recommendationId === this.memory.selectedRecommendationId);
      if (!selected) {
        this.memory = { ...this.memory, pendingAction: null, selectedRecommendationId: null, passengerDetails: null };
        return textResult("Something went wrong with your booking options — please ask to book your trip again.");
      }
      if (isChangeOptionRequest(currentText)) {
        this.memory = { ...this.memory, pendingAction: "AWAITING_OPTION_SELECTION" as TravelPendingAction, selectedRecommendationId: null };
        return textResult(formatPackageOptionsMessage(pendingOptions));
      }
      const newlyParsed = parsePassengerDetailsReply(currentText);
      const collected = [...(this.memory.passengerDetails ?? []), ...newlyParsed].slice(0, selected.travellers);
      if (collected.length < selected.travellers) {
        this.memory = { ...this.memory, passengerDetails: collected.length ? collected : null };
        return textResult(buildPassengerDetailsRequestMessage(selected.travellers, collected));
      }
      this.memory = { ...this.memory, passengerDetails: collected };
      if (this.memory.ticketContact === null) {
        this.memory = { ...this.memory, pendingAction: "AWAITING_TICKET_CONTACT" as TravelPendingAction };
        return textResult(buildTicketContactRequestMessage());
      }
      this.memory = { ...this.memory, pendingAction: "AWAITING_BOOKING_CONFIRMATION" as TravelPendingAction };
      return textResult(buildBookingConfirmationSummary(this.priorEntities, selected, collected));
    }

    // Routing priority 2b: BOOKING CONFIRMATION — the final summary is pending an explicit "Confirm
    // booking" (never a generic "yes" from anywhere else — this branch is only reachable while that exact
    // question is the pending action, i.e. pending-input context, not free-floating affirmative parsing).
    if (this.memory.pendingAction === "AWAITING_BOOKING_CONFIRMATION") {
      const pendingOptions = this.memory.pendingRecommendations ?? [];
      const selected = pendingOptions.find((option) => option.recommendationId === this.memory.selectedRecommendationId);
      const confirmedPassengers = this.memory.passengerDetails ?? [];
      if (isChangeOptionRequest(currentText) && pendingOptions.length) {
        this.memory = {
          ...this.memory,
          pendingAction: "AWAITING_OPTION_SELECTION" as TravelPendingAction,
          selectedRecommendationId: null
        };
        return textResult(formatPackageOptionsMessage(pendingOptions));
      }
      if (isExplicitBookingConfirmationReply(currentText) && selected) {
        const entities = this.priorEntities;
        this.pendingWorkflowSignal = {
          signalType: "START_BOOKING_HANDOFF",
          trigger: "BOOKING_INTENT",
          payload: {
            destinationCity: entities.destinationCity,
            originCity: entities.originCity,
            travelDates: entities.departureDate ?? entities.travelMonth,
            selectedOption: selected as unknown as Record<string, unknown>,
            passengerDetails: confirmedPassengers as unknown as Record<string, unknown>[],
            customerEmail: this.memory.ticketContact?.email ?? null,
            customerPhone: this.memory.ticketContact?.phone ?? null
          }
        };
        this.memory = { ...this.memory, pendingAction: null, passengerDetails: null, ticketContact: null };
        return textResult(
          "Thank you — I've submitted your booking request. Your booking request has been received and is waiting for approval. You'll be notified once a decision is made."
        );
      }
      const fallbackOption = selected ?? pendingOptions[0];
      if (!fallbackOption) {
        this.memory = { ...this.memory, pendingAction: null, selectedRecommendationId: null };
        return textResult("Something went wrong with your booking options — please ask to book your trip again.");
      }
      return textResult(buildBookingConfirmationSummary(this.priorEntities, fallbackOption, confirmedPassengers));
    }

    // Routing priority 3: BOOKING INTENT / SEARCH_PACKAGE_OPTIONS — generates three structured, selectable
    // simulated options rather than a free-text price range, and never books immediately. "book my flight"
    // once options already exist (but nothing selected yet) re-shows the SAME persisted options instead of
    // regenerating a new set or repeating a generic price-range message.
    if (sprintIntent.intent === "BOOKING_INTENT") {
      const mergedEntities = this.priorEntities;
      const destination = slots.destination ?? mergedEntities.destinationCity;

      if (!destination) {
        return textResult(`I'd be happy to help book your trip. First, where would you like to go?`);
      }

      const missingForBooking = determineMissingFields(mergedEntities);
      if (missingForBooking.length > 0) {
        this.memory = { ...this.memory, pendingAction: "BOOK_TRIP" as TravelPendingAction };
        return textResult(
          `I'd love to book your trip! I still need a few details:\n${missingForBooking.join("\n")}`
        );
      }

      const options = generateSimulatedPackageOptions(mergedEntities, this.config, packageOptionSeed(mergedEntities));
      this.memory = {
        ...this.memory,
        pendingAction: "AWAITING_OPTION_SELECTION" as TravelPendingAction,
        pendingRecommendations: options,
        selectedRecommendationId: null
      };
      return textResult(formatPackageOptionsMessage(options));
    }

    // Routing priority 3: BUDGET CHANGE
    if (sprintIntent.intent === "BUDGET_CHANGE" || sprintIntent.intent === "BUDGET_FLEXIBLE") {
      const budgetPayload = sprintIntent.payload?.budget as { amount: number; currency: string | null } | undefined;
      if (budgetPayload) {
        this.priorEntities = { ...this.priorEntities, budget: budgetPayload.amount, budgetCurrency: budgetPayload.currency ?? this.config.defaultCurrency };
        slots.budgetAmount = budgetPayload.amount;
        slots.budgetCurrency = budgetPayload.currency ?? this.config.defaultCurrency;
        return textResult(`I've updated your budget to ${budgetPayload.currency ?? this.config.defaultCurrency} ${budgetPayload.amount}.`);
      }
      return textResult(`What revised budget amount and currency would you like to use?`);
    }

    // Routing priority 4: RE-EVALUATION ("I told you earlier")
    if (sprintIntent.intent === "RE_EVALUATION_REQUEST") {
      const entities = this.priorEntities;
      const existing: string[] = [];
      if (entities.originCity) existing.push(`origin: ${entities.originCity}`);
      if (entities.destinationCity) existing.push(`destination: ${entities.destinationCity}`);
      if (entities.departureDate) existing.push(`date: ${entities.departureDate}`);
      if (entities.travelMonth) existing.push(`month: ${entities.travelMonth}`);
      if (entities.days) existing.push(`duration: ${entities.days} days`);
      if (entities.adults) existing.push(`travelers: ${entities.adults} adults`);
      if (entities.budget) existing.push(`budget: ${entities.budgetCurrency ?? ""} ${entities.budget}`);

      if (existing.length > 0) {
        const missingList = determineMissingFields(entities);
        const missingMsg = missingList.length > 0
          ? `\n\nI still need: ${missingList.join(", ")}`
          : "";
        return textResult(`You're right! Here's what I already have:\n${existing.join("\n")}${missingMsg}`);
      }
    }

    const missing = missingFields(slots);
    if (missing.length === 0) {
      if (slots.budgetAmount !== null) {
        const estimate = estimateBudgetRange(slotsToMinimalEntities(slots), this.config);
        const feasibility = classifyBudgetFeasibility(slots.budgetAmount, estimate);
        if (feasibility.classification === "BELOW_MINIMUM") {
          this.memory = {
            ...this.memory,
            completionStage: "AWAITING_CONTACT",
            pendingInputAction: "AWAITING_LEAD_CONTACT",
            pendingAction: null,
            providerFailure: null
          };
          if (this.executionMode === "PLATFORM_MANAGED")
            this.pendingWorkflowSignal = { signalType: "START_TRIP_SUBMISSION", trigger: "BELOW_MINIMUM_BUDGET" };
          return textResult(
            `${buildBelowMinimumMessage(slotsToMinimalEntities(slots), feasibility, "ENGLISH")}\n\n${buildContactRequestMessage()}`
          );
        }
      }
      if (wasItineraryPresented(messages)) {
        // Sprint 6.6 — Part 38 (root cause): `isBookingConfirmation`'s `CONFIRMATION_PATTERN` treats a
        // bare Hinglish "kar do" ANYWHERE in the message as "yes, book it" — a general-purpose imperative
        // marker ("do this"), not a confirmation-specific one. "Actually 3 adults kar do" is a CORRECTION
        // that merely happens to end with "kar do", and was being misread as confirming the plan,
        // prematurely jumping to lead-capture and burying the correction. Guarded here (not by narrowing
        // `CONFIRMATION_PATTERN` itself, which several other call sites also rely on for genuine
        // confirmations like bare "kar do" alone) so a correction always falls through to the normal
        // re-prompt below instead.
        const overridesBookingConfirmation =
          classifyUserInput(currentText, { hasPendingQuestion: true }).semantic === "CORRECTION";
        if (isBookingConfirmation(currentText) && !overridesBookingConfirmation) {
          const phone = extractPhoneNumber(currentText);
          if (phone)
            return toolResult(
              "travel.create_lead",
              this.buildDeterministicLeadPayload(slots, customerName, phone, currentText)
            );
          this.memory = {
            ...this.memory,
            completionStage: "AWAITING_CONTACT",
            pendingInputAction: "AWAITING_LEAD_CONTACT",
            pendingAction: null,
            providerFailure: null
          };
          return textResult(buildContactRequestMessage());
        }
        return textResult(buildConfirmPrompt());
      }
      if (toolAvailable(request.tools, "travel.search_flights"))
        return toolResult("travel.search_flights", {
          destination: slots.destination,
          travelMonth: slots.travelMonth,
          durationDays: slots.durationDays,
          passengers: slots.passengers
        });
      const flights = generatePlaceholderFlights({
        destination: slots.destination ?? "your destination",
        travelMonth: slots.travelMonth,
        passengers: slots.passengers
      });
      const hotels = generatePlaceholderHotels({
        destination: slots.destination ?? "your destination",
        travelMonth: slots.travelMonth
      });
      return textResult(
        buildRecommendationMessage(slots, flights.flightOptions, hotels.hotelOptions, this.config)
      );
    }

    // Once a greeting has already been shown as its own turn (the normal proactive-greeting flow), the
    // welcome message must never be recited again inline — `isFirstTurn` (and the `greetingPrefix` it
    // drives) is deliberately about "no assistant turn has happened yet at all", not "this is the
    // traveler's first reply", to avoid a duplicate greeting on the very first substantive answer.
    const hasAssistantHistory = messages.some((message) => message.role === "assistant");
    // Also false when the traveler's name was already known BEFORE this turn (e.g. seeded from a
    // Receptionist handoff) — the canned welcome text this flag drives ends with its own "may I know
    // your name?" question, which would be a wrong, redundant re-ask of something already answered.
    const isFirstTurn = userMessages.length <= 1 && !hasAssistantHistory && !nameKnownBeforeThisTurn;
    // Destination is discovered on its own first — a human consultant asks "where would you like to go?"
    // before drilling into dates/travellers/budget; only once destination is known do the remaining gaps
    // combine into one natural bulleted ask (see "Clarification strategy").
    if (missing.includes("destination"))
      return textResult(namePrefix + buildAskMessage("destination", slots, isFirstTurn, this.config));
    if (missing.length > 1)
      return textResult(namePrefix + buildMissingInfoMessage(missing, this.config, isFirstTurn));
    return textResult(namePrefix + buildAskMessage(missing[0] ?? "destination", slots, isFirstTurn, this.config));
  }

  /**
   * Payload for the SAME `travel.create_lead` tool call the LLM orchestrator uses — see
   * `TravelLeadService.createInternalLead`. `TravelSlots` has no origin city or multi-leg journey concept
   * (this simpler provider only ever tracks a single destination), so `departureCity`/`journeyId` are
   * always null here; every other field is populated from what this provider actually knows.
   */
  private buildDeterministicLeadPayload(
    slots: TravelSlots,
    customerName: string | null,
    phone: string,
    notes: string
  ): Record<string, unknown> {
    return {
      customerName,
      phoneNumber: phone,
      departureCity: this.priorEntities.originCity,
      destination: slots.destination ?? this.priorEntities.destinationCity,
      travelDates: slots.travelMonth,
      passengers: slots.passengers !== null ? String(slots.passengers) : null,
      budgetAmount: slots.budgetAmount,
      budgetCurrency: slots.budgetCurrency,
      displayCurrency: this.memory.displayCurrency ?? null,
      conversationSummary: (notes || slots.destination || "Travel enquiry").slice(0, 2000)
    };
  }

  private continueAfterTool(
    messages: readonly AiMessage[],
    last: AiMessage,
    slots: TravelSlots,
    tools: readonly AiToolDefinition[] | undefined
  ): AiCompletionResult {
    const output = safeParseJson(last.content);
    if (output.escalated) return textResult(buildEscalationMessage(this.config));
    // Every lead-capture entry point resolves the same way here — the built-in, always-available
    // `travel.create_lead` tool call, never dependent on an external CRM connector. `leadId` is the
    // unambiguous discriminator: no other tool result in this provider returns that field.
    if (typeof output.leadId === "string" && typeof output.reference === "string") {
      const customerName = extractCustomerName(
        messages.filter((message) => message.role === "user").map((message) => message.content)
      );
      return textResult(buildLeadCapturedMessage(customerName, output.reference));
    }
    if (Array.isArray(output.flightOptions)) {
      if (toolAvailable(tools, "travel.search_hotels"))
        return toolResult("travel.search_hotels", {
          destination: slots.destination,
          travelMonth: slots.travelMonth
        });
      const hotels = generatePlaceholderHotels({
        destination: slots.destination ?? "your destination",
        travelMonth: slots.travelMonth
      });
      return textResult(
        buildRecommendationMessage(
          slots,
          output.flightOptions as FlightOption[],
          hotels.hotelOptions,
          this.config
        )
      );
    }
    if (Array.isArray(output.hotelOptions)) {
      const flights = (findPriorToolValue(messages, "flightOptions") as FlightOption[] | undefined) ?? [];
      return textResult(
        buildRecommendationMessage(slots, flights, output.hotelOptions as HotelOption[], this.config)
      );
    }
    if (typeof output.reference === "string" && output.reference.startsWith("LEAD-"))
      return textResult(buildBookingConfirmedMessage(output.reference));
    if (typeof output.resendResult === "boolean") return textResult(buildResendTicketReply(output));
    return textResult("Thanks — let me know how you'd like to proceed with your trip.");
  }
}

/* ------------------------------------------------------------------------------------------------
 * LLM-based entity extraction and conversation generation.
 *
 * Used instead of the regex-driven TravelEmployeeProvider above whenever the organization has
 * configured a real AI provider (OpenAI-compatible or Azure OpenAI) for the Travel Employee plugin.
 * Entity extraction and reply generation go through that real provider; the 11-stage state machine,
 * placeholder flight/hotel search, escalation, and CRM-lead tool calls stay exactly the same
 * code-driven logic used by the deterministic engine, so both engines plug into the identical
 * AiProvider contract and tool-calling loop in AgentService.
 * ---------------------------------------------------------------------------------------------- */

const ENTITY_SCALAR_KEYS: Array<Exclude<keyof TravelEntities, "preferences">> = [
  "customerName",
  "originCity",
  "destinationCity",
  "departureDate",
  "travelMonth",
  "returnDate",
  "days",
  "nights",
  "totalTravellers",
  "adults",
  "children",
  "infants",
  "budget",
  "budgetCurrency",
  "cabinClass",
  "tripType",
  "hotelStars",
  "visaRequired",
  "passportStatus",
  "tripPurpose"
];

const ENTITY_MISSING_LABELS: Record<string, string> = {
  destinationCity: "your destination",
  travelDates: "your travel dates (a month or specific date)",
  duration: "how many days or nights",
  adults: "the number of travelers",
  budget: "your approximate budget"
};

/**
 * Combines 2+ missing-field labels into one natural bullet list, so a traveler is asked for several
 * things together in one message ("when you're travelling, how many people, and your approximate
 * budget") instead of one mechanical question per turn. A single missing field is returned as a plain
 * phrase, never a one-item list.
 */
function combineMissingLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return labels.map((label) => `• ${label}`).join("\n");
}

export const TRAVEL_ENTITY_EXTRACTION_SYSTEM_PROMPT = [
  "You are an information-extraction engine for a travel-planning assistant, doing semantic interpretation:",
  "you propose normalized entities and an intent; a separate deterministic layer validates and decides",
  "what actually happens — so interpret generously, but always report your real confidence rather than",
  "guessing silently.",
  "You are given: the confirmed trip state so far, the current workflow phase, which field (if any) was",
  "last asked about, and the latest user message. Extract ONLY details newly stated or updated in that",
  "latest message. Use null for anything not mentioned. Never restate an already-confirmed value.",
  "",
  "Respond with a single strictly-valid JSON object, no prose, no markdown fences, matching this shape:",
  "{",
  '  "customerName": string|null,',
  '  "originCity": {"rawValue": string|null, "normalizedValue": string|null, "confidence": number,',
  '                 "inferred": boolean, "correctionReason": string|null} | string | null,',
  '  "destinationCity": <same shape as originCity>,',
  '  "departureDate": string|null,',
  '  "travelMonth": string|null,',
  '  "returnDate": string|null,',
  '  "days": number|null,',
  '  "nights": number|null,',
  '  "totalTravellers": number|null,',
  '  "adults": number|null,',
  '  "children": number|null,',
  '  "infants": number|null,',
  '  "budget": number|null,',
  '  "budgetCurrency": string|null,',
  '  "cabinClass": string|null,',
  '  "tripType": string|null,',
  '  "hotelStars": number|null,',
  '  "visaRequired": boolean|null,',
  '  "passportStatus": string|null,',
  '  "tripPurpose": "LEISURE"|"BUSINESS"|null,',
  '  "preferences": string[],',
  '  "intent": string,',
  '  "answersPendingAction": boolean,',
  '  "supersedesPendingAction": boolean,',
  '  "preservePendingAction": boolean,',
  '  "intentConfidence": number',
  "}",
  "",
  "City fields: prefer the rich object shape. `normalizedValue` is your best-guess canonical spelling",
  '(e.g. rawValue "sidni" -> normalizedValue "Sydney"); `confidence` is 0-1 reflecting how sure you are;',
  '`inferred` is true whenever you corrected or guessed rather than the user spelling it correctly;',
  "`correctionReason` is a short human-readable reason (e.g. \"Likely phonetic misspelling of Sydney\").",
  "A plain string or null is also accepted and is treated as full confidence.",
  "",
  "Extraction rules:",
  '- customerName: the traveler\'s own name, captured only from an actual self-introduction ("my name is X",',
  '  "I\'m X", "call me X") or a short reply that is clearly just their name (e.g. answering literally "Krishna"',
  "  to a \"may I know your name\" question). NEVER infer a name from a city, month, currency, or other trip",
  "  detail, and never restate an already-confirmed name.",
  "- NEVER invent or guess a value the user did not actually state — especially a year, a full date, or",
  '  any part of a date. If the user says "10 December" with no year, leave departureDate null and',
  "  populate travelMonth/day information only from what was actually said (the deterministic layer",
  "  resolves the year); do not silently attach a year or a specific date the message never mentioned.",
  "  A missing value must stay null — it is never acceptable to fabricate a plausible-looking one.",
  '- Parse compact currency/amount shorthand: "$5k" = 5000 USD; "₹2 lakh" = 200000 INR;',
  '  "INR 1,50,000" = 150000 INR; "budget 10000 USD" = 10000 USD.',
  '- budgetCurrency is a 3-letter ISO 4217 code (USD, INR, EUR, ...).',
  '- visaRequired: only set from an explicit statement either way ("I need a visa", "I don\'t need a visa",',
  '  "visa nahi chahiye"). NEVER infer it merely from the trip being international — that is a generic',
  "  caveat the assistant already gives separately, not a fact about this specific traveler.",
  '- passportStatus: only set from an explicit statement about the traveler\'s own passport ("my passport is',
  '  valid", "passport expired", "passport is expiring next month", "getting my passport renewed"). Capture',
  "  it close to the traveler's own wording rather than forcing it into a fixed category.",
  '- tripPurpose: "LEISURE" for a personal/vacation/holiday trip, "BUSINESS" for work/official travel — only',
  "  from an explicit statement (usually the traveler's answer to being asked). Never guessed from the",
  "  destination or any other trip detail.",
  '- "5 days 4 nights" => days=5, nights=4. "rat"/"raat"/"रात" is the Hindi/Hinglish word for NIGHT(S):',
  '  "5 days 3 rat" => days=5, nights=3 — NEVER a 3-star hotel. hotelStars is set only from explicit star/',
  '  hotel-tier wording (see the hotelStars rule below), never from a night count.',
  '- An abbreviated or two-digit year IS a real year: "17 jan 27" / "17/01/27" / "Jan 17 27" => a full date',
  '  in 2027 (a 2-digit YY means 20YY). A standalone four-digit year the user gives to clarify the date',
  '  ("2027", "2027 me", "year is 2027") sets the departure YEAR — it is NEVER a budget amount, and must not',
  '  populate budget/budgetCurrency. The deterministic layer also enforces this.',
  '- Traveler count is ambiguous unless a breakdown is given — NEVER assume a raw headcount means "N adults".',
  '  "5 log", "hum 5 log hain", "5 people", "total 5", "family of 5" => totalTravellers=5, adults/children/',
  '  infants stay null (composition unknown). Only set adults/children/infants when the message actually',
  '  breaks the group down, e.g. "2 adults, 2 kids, 1 infant" => adults=2, children=2, infants=1 (and leave',
  "  totalTravellers null — the deterministic layer reconciles it against any previously stated total).",
  "- Interpret natural dates: \"today\", \"tomorrow\", \"next Friday\", \"August 15\", \"mid-September\",",
  '  "for one week" (=> a 7-day duration). Populate departureDate/travelMonth/days accordingly.',
  "- departureDate vs returnDate: a message that states exactly ONE date is ALWAYS the departure date —",
  '  NEVER assume a lone date is a return date. Only ever populate returnDate when the traveler explicitly',
  '  signals a return/back date — "back on the 20th", "returning 20 Dec", "till the 20th", or two distinct',
  '  dates in one message ("15 Aug to 20 Aug", "from the 15th, back by the 20th"), where the first is',
  '  departureDate and the second is returnDate. A duration phrase ("for 5 days", "one week trip") is',
  "  never itself a date — extract it into days/nights, not into returnDate.",
  "- A bare short answer (e.g. just \"5\") must be interpreted using which field was last asked about —",
  "  a number after a travelers question is totalTravellers (an ambiguous headcount, not adults); the same",
  "  number after a duration question is days.",
  "- tripType is one of ONE_WAY, ROUND_TRIP, MULTI_CITY when stated or clearly implied, else null.",
  '- hotelStars is the requested hotel star category as an integer 1-5, e.g. "3-star hotel" => 3,',
  '  "budget hotel" => null (not a specific star count).',
  "- preferences are short free-text tags (e.g. \"vegetarian food\", \"sea view\"), not full sentences.",
  "- Only extract information present in the latest user message; do not restate values already known.",
  "- Corrections override prior confirmed values: \"change budget to 12000 USD\", \"make it September\",",
  '  "not London, Paris", "change destination to Melbourne" all mean the stated field must be extracted',
  "  as its new value — classify these as modify_trip.",
  "",
  "Intent classification — set \"intent\" to exactly one of:",
  '- "provide_trip_details": states or updates trip facts (destination, dates, travelers, budget) with no other ask.',
  '- "ask_budget_guidance": asks for cost/budget guidance, e.g. "how much will this cost", "guide me about budget",',
  '  "is my budget enough", "can it fit in 3000".',
  '- "ask_recommendation": asks for a suggestion or opinion, e.g. "what do you recommend", "which hotel is better".',
  '- "request_plan": explicitly asks to be given the plan/options now, e.g. "give me options",',
  '  "i need plan from you", "suggest flights and hotels".',
  '- "modify_trip": asks to change an already-known field, e.g. "change budget to 12000 USD", "make it September",',
  '  "not London, Paris", "trim hotels".',
  '- "confirm_plan": explicitly agrees to proceed, e.g. "confirm", "yes let\'s book it", "sounds good, go ahead".',
  '- "reject_plan": explicitly declines the current plan, e.g. "no", "I don\'t like this", "cancel".',
  '- "ask_question": any other genuine question not covered above (visa, weather, safety, general travel advice).',
  '- "request_human": wants a human agent or representative.',
  '- "start_new_trip": wants to discard the current trip and plan a different one from scratch.',
  '- "casual_conversation": greetings, thanks, or small talk with no trip content.',
  "When in doubt between provide_trip_details and another intent, prefer provide_trip_details only if the",
  "message contains no question or request beyond stating facts.",
  "A pending action is context, not a lock. Set answersPendingAction=true only when the latest message",
  "actually supplies or declines what that typed action requested. A new budget, itinerary, correction,",
  "or travel question must use answersPendingAction=false and preservePendingAction=true unless it clearly",
  "replaces that workflow. Confidence must be between 0 and 1."
].join("\n");

type SemanticTurnProposal = {
  answersPendingAction: boolean;
  supersedesPendingAction: boolean;
  preservePendingAction: boolean;
  confidence: number;
};

function parseSemanticTurnProposal(raw: string): SemanticTurnProposal {
  const jsonText = extractJsonObject(raw);
  if (!jsonText)
    return {
      answersPendingAction: false,
      supersedesPendingAction: false,
      preservePendingAction: true,
      confidence: 0
    };
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    return {
      answersPendingAction: parsed.answersPendingAction === true,
      supersedesPendingAction: parsed.supersedesPendingAction === true,
      preservePendingAction: parsed.preservePendingAction !== false,
      confidence:
        typeof parsed.intentConfidence === "number" &&
        parsed.intentConfidence >= 0 &&
        parsed.intentConfidence <= 1
          ? parsed.intentConfidence
          : 0
    };
  } catch {
    return {
      answersPendingAction: false,
      supersedesPendingAction: false,
      preservePendingAction: true,
      confidence: 0
    };
  }
}

/** Reads the "intent" field from a raw extraction+classification LLM response, defaulting safely. */
export function parseIntent(raw: string): TravelIntent {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return "provide_trip_details";
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (typeof parsed !== "object" || parsed === null) return "provide_trip_details";
    const value = (parsed as Record<string, unknown>).intent;
    if (typeof value === "string" && (ALL_TRAVEL_INTENTS as readonly string[]).includes(value))
      return value as TravelIntent;
  } catch {
    // fall through to default
  }
  return "provide_trip_details";
}

export function buildTravelExtractionUserPrompt(
  known: TravelEntities,
  message: string,
  context?: {
    workflowPhase?: TravelWorkflowPhase;
    lastAskedField?: string | null;
    pendingInputAction?: TravelPendingInputAction;
    lastAssistantQuestion?: string | null;
  }
): string {
  return [
    `Confirmed trip state so far (JSON): ${JSON.stringify(known)}`,
    context?.workflowPhase ? `Current workflow phase: ${context.workflowPhase}` : null,
    context?.lastAskedField ? `Field last asked about (use this to disambiguate a bare short answer): ${context.lastAskedField}` : null,
    context?.pendingInputAction
      ? `Typed pending action (context only, not a lock): ${context.pendingInputAction}`
      : null,
    context?.lastAssistantQuestion
      ? `Last assistant question: ${context.lastAssistantQuestion.slice(0, 500)}`
      : null,
    "",
    `Latest user message: """${message.replace(/"""/g, '\\"\\"\\"').slice(0, 4000)}"""`,
    "",
    "Return only the JSON object described in the system prompt."
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function extractJsonObject(raw: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return candidate.slice(start, end + 1);
}

/**
 * Reads a city field that may be either a plain string (older/simpler providers, or the catalog
 * fallback) or the richer `{rawValue, normalizedValue, confidence, inferred, correctionReason}` shape
 * described in the extraction contract — LLM-first normalization, with `normalizeCityName` still applied
 * as a deterministic validation pass over whatever the model proposed.
 */
function readCityRaw(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const normalized = (value as Record<string, unknown>).normalizedValue;
    return typeof normalized === "string" && normalized.trim() ? normalized.trim().slice(0, 200) : null;
  }
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null;
}

export function parseExtractedEntities(raw: string): Partial<TravelEntities> {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const str = (key: string): string | null => {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null;
  };
  const num = (key: string): number | null => {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsedNumber = Number(value.replace(/,/g, ""));
      if (Number.isFinite(parsedNumber)) return parsedNumber;
    }
    return null;
  };
  const bool = (key: string): boolean | null => {
    const value = record[key];
    return typeof value === "boolean" ? value : null;
  };
  const tripPurposeRaw = str("tripPurpose")?.toUpperCase();
  const tripPurpose: "LEISURE" | "BUSINESS" | null =
    tripPurposeRaw === "LEISURE" || tripPurposeRaw === "BUSINESS" ? tripPurposeRaw : null;
  const currency = str("budgetCurrency");
  return {
    customerName: str("customerName") ? titleCase(str("customerName") as string) : null,
    originCity: normalizeCityName(readCityRaw(record, "originCity")),
    destinationCity: normalizeCityName(readCityRaw(record, "destinationCity")),
    departureDate: str("departureDate"),
    travelMonth: str("travelMonth"),
    returnDate: str("returnDate"),
    days: num("days"),
    nights: num("nights"),
    totalTravellers: num("totalTravellers"),
    adults: num("adults"),
    children: num("children"),
    infants: num("infants"),
    budget: num("budget"),
    budgetCurrency: currency ? currency.toUpperCase().slice(0, 3) : null,
    cabinClass: str("cabinClass"),
    tripType: str("tripType"),
    hotelStars: num("hotelStars"),
    visaRequired: bool("visaRequired"),
    passportStatus: str("passportStatus"),
    tripPurpose,
    preferences: Array.isArray(record.preferences)
      ? record.preferences.filter((x): x is string => typeof x === "string").slice(0, 10)
      : []
  };
}

const CITY_ENTITY_FIELDS: ReadonlySet<string> = new Set(["originCity", "destinationCity"]);

/** A single field's semantic interpretation, per the structured extraction contract. */
export interface CityInterpretation {
  rawValue: string | null;
  normalizedValue: string | null;
  confidence: number;
  inferred: boolean;
  correctionReason: string | null;
}

/**
 * Reads the rich `{rawValue, normalizedValue, confidence, inferred, correctionReason}` interpretation for
 * one city field out of a raw extraction response, if the model returned that shape. Returns null when
 * the field is missing, absent, or was returned as a plain string (no confidence to gate on — the caller
 * should treat a plain string as full-confidence, deterministic-style input).
 */
export function parseCityInterpretation(raw: string, key: "originCity" | "destinationCity"): CityInterpretation | null {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return null;
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (typeof parsed !== "object" || parsed === null) return null;
    const field = (parsed as Record<string, unknown>)[key];
    if (!field || typeof field !== "object" || Array.isArray(field)) return null;
    const obj = field as Record<string, unknown>;
    const rawNormalized = typeof obj.normalizedValue === "string" ? obj.normalizedValue.trim() : null;
    const normalizedValue = rawNormalized ? normalizeCityName(rawNormalized) : null;
    const rawValue = typeof obj.rawValue === "string" ? obj.rawValue.trim() : normalizedValue;
    const confidence =
      typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
        ? Math.max(0, Math.min(1, obj.confidence))
        : 1;
    const inferred = obj.inferred === true;
    const correctionReason = typeof obj.correctionReason === "string" ? obj.correctionReason.slice(0, 200) : null;
    return { rawValue, normalizedValue, confidence, inferred, correctionReason };
  } catch {
    return null;
  }
}

export type CityConfidenceAction = "accept" | "confirm" | "clarify";

const CITY_CONFIDENCE_AUTO_ACCEPT = 0.85;
const CITY_CONFIDENCE_ASK_CONFIRM = 0.6;

/**
 * Confidence-based clarification policy: >=0.85 is accepted silently, 0.60-0.84 needs a yes/no
 * confirmation ("Did you mean Sydney?"), and below 0.60 needs an open clarifying question — an uncertain
 * correction is never silently accepted.
 */
export function classifyCityConfidence(confidence: number): CityConfidenceAction {
  if (confidence >= CITY_CONFIDENCE_AUTO_ACCEPT) return "accept";
  if (confidence >= CITY_CONFIDENCE_ASK_CONFIRM) return "confirm";
  return "clarify";
}

function cityFieldLabel(field: "originCity" | "destinationCity", language: TravelResponseLanguage): string {
  if (language === "HINGLISH") return field === "originCity" ? "departure city" : "destination";
  if (language === "HINDI") return field === "originCity" ? "प्रस्थान शहर" : "गंतव्य";
  return field === "originCity" ? "departure city" : "destination";
}

/** Deterministic, non-LLM message asking the user to confirm an uncertain city interpretation. */
export function buildCityConfirmationMessage(
  field: "originCity" | "destinationCity",
  proposedValue: string,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const label = cityFieldLabel(field, language);
  if (language === "HINGLISH") return `Kya aapka matlab ${label} ke liye ${proposedValue} tha?`;
  if (language === "HINDI") return `क्या आपका मतलब ${label} के लिए ${proposedValue} था?`;
  return `Did you mean ${proposedValue} for your ${label}?`;
}

/** Deterministic, non-LLM message asking the user to clarify a low-confidence city interpretation. */
export function buildCityClarificationMessage(
  field: "originCity" | "destinationCity",
  rawValue: string | null,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const label = cityFieldLabel(field, language);
  if (language === "HINGLISH")
    return rawValue
      ? `Mujhe "${rawValue}" samajh nahi aaya — aap apne ${label} ke liye kaunsa shehar bata rahe the?`
      : `Aap apne ${label} ke liye kaunsa shehar bata rahe the?`;
  if (language === "HINDI")
    return rawValue
      ? `मुझे "${rawValue}" समझ नहीं आया — आप अपने ${label} के लिए कौन सा शहर बता रहे थे?`
      : `आप अपने ${label} के लिए कौन सा शहर बता रहे थे?`;
  return rawValue
    ? `I couldn't quite place "${rawValue}" — could you tell me which city you meant for your ${label}?`
    : `Could you tell me which city you meant for your ${label}?`;
}

/** Deterministic acknowledgement for a confirmed destination being explicitly replaced by a new one. */
export function buildDestinationChangedMessage(
  previous: string,
  next: string,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  if (language === "HINGLISH") return `Aapka destination ${previous} se ${next} update kar diya gaya hai.`;
  if (language === "HINDI") return `आपका गंतव्य ${previous} से ${next} अपडेट कर दिया गया है।`;
  return `I've updated your destination from ${previous} to ${next}.`;
}

/**
 * Deterministic, natural acknowledgement for a resolved clarification ("Did you mean Sydney?" -> "Yes")
 * when no pending action exists to resume — per policy, a bare clarification answer is never itself
 * authorization to run tools, so this simply confirms the field update and stops there.
 */
export function buildClarificationConfirmedMessage(
  field: "originCity" | "destinationCity",
  value: string,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const label = cityFieldLabel(field, language);
  if (language === "HINGLISH") return `Ji, ${label} ${value} update kar diya gaya hai.`;
  if (language === "HINDI") return `जी, ${label} ${value} अपडेट कर दिया गया है।`;
  return `Got it — ${label} updated to ${value}.`;
}

/**
 * Once a city name is canonicalized (e.g. "Adelaid" -> "Adelaide"), a later message that mentions the
 * same city again — possibly re-mistyped, since the user is typing free text, not selecting from a list —
 * must never reintroduce the raw misspelling. If the newly-extracted value is a close fuzzy match of the
 * already-known canonical value, the canonical spelling wins; only a genuinely different city (large edit
 * distance, e.g. a real correction like "not London, Paris") overrides it.
 */
function reconcileCityValue(priorCanonical: string | null, incoming: string): string {
  if (!priorCanonical || priorCanonical === incoming) return incoming || priorCanonical || incoming;
  const threshold = Math.max(1, Math.floor(priorCanonical.length * 0.25));
  return levenshteinDistance(priorCanonical.toLowerCase(), incoming.toLowerCase()) <= threshold
    ? priorCanonical
    : incoming;
}

/** Merges newly-extracted entities into the prior conversation state. Existing known values are never overwritten by nulls. */
export function mergeTravelEntities(
  prior: TravelEntities,
  extracted: Partial<TravelEntities>
): TravelEntities {
  const merged: TravelEntities = { ...prior };
  for (const key of ENTITY_SCALAR_KEYS) {
    const value = extracted[key];
    if (value === null || value === undefined) continue;
    if (CITY_ENTITY_FIELDS.has(key) && typeof value === "string") {
      (merged[key] as string) = reconcileCityValue(prior[key] as string | null, value);
    } else {
      (merged[key] as string | number | boolean) = value;
    }
  }
  if (Array.isArray(extracted.preferences) && extracted.preferences.length)
    merged.preferences = Array.from(new Set([...prior.preferences, ...extracted.preferences])).slice(
      0,
      20
    );
  return merged;
}

export interface MergeConfirmedEntitiesResult {
  values: TravelEntities;
  confirmation: TravelEntityConfirmation;
  /** Set only when an already-confirmed destination was just explicitly replaced by a different city. */
  destinationChanged: { from: string; to: string } | null;
}

/**
 * Field-level, confirmed-aware merge — the core anti-regression guarantee. Reuses
 * {@link mergeTravelEntities} for the raw merge mechanics (including sticky city-typo reconciliation),
 * then enforces the priority order explicit user correction > confirmed state > LLM extraction > defaults:
 * a field that is already `confirmed` is left untouched unless this turn is an explicit correction
 * (`intent === "modify_trip"`), or — for city fields specifically — the newly-extracted value is a
 * genuinely different city (not a re-typo of the same one, which `reconcileCityValue` already filters out).
 * Only keys actually present in `extracted` are ever touched, so state is updated field-by-field and never
 * rebuilt wholesale.
 */
export function mergeConfirmedEntities(
  priorValues: TravelEntities,
  priorConfirmation: TravelEntityConfirmation,
  extracted: Partial<TravelEntities>,
  intent: TravelIntent,
  now: string = new Date().toISOString()
): MergeConfirmedEntitiesResult {
  const naiveMerged = mergeTravelEntities(priorValues, extracted);
  const isExplicitCorrection = intent === "modify_trip";
  const values: TravelEntities = { ...priorValues };
  const confirmation: TravelEntityConfirmation = { ...priorConfirmation };
  let destinationChanged: { from: string; to: string } | null = null;

  for (const key of ENTITY_SCALAR_KEYS) {
    if (extracted[key] === null || extracted[key] === undefined) continue;
    const proposedValue = naiveMerged[key];
    if (proposedValue === priorValues[key]) continue;
    const meta = priorConfirmation[key];
    const isConfirmed = meta?.confirmed === true;
    const isCityField = CITY_ENTITY_FIELDS.has(key);
    const allowOverride = !isConfirmed || isExplicitCorrection || isCityField;
    if (!allowOverride) continue;
    if (key === "destinationCity" && isConfirmed && typeof priorValues.destinationCity === "string")
      destinationChanged = { from: priorValues.destinationCity, to: String(proposedValue) };
    (values[key] as string | number) = proposedValue as string | number;
    confirmation[key] = { source: "user", confidence: 1, confirmed: true, updatedAt: now };
  }
  if (naiveMerged.preferences !== priorValues.preferences) values.preferences = naiveMerged.preferences;

  return { values, confirmation, destinationChanged };
}

/** Reports every field that is newly known or was corrected to a different value this turn. */
function diffChangedFields(prior: TravelEntities, merged: TravelEntities): string[] {
  const changed: string[] = [];
  for (const key of ENTITY_SCALAR_KEYS) {
    if (merged[key] === null || merged[key] === prior[key]) continue;
    changed.push(prior[key] === null ? `${key}=${String(merged[key])}` : `${key}=${String(merged[key])} (was ${String(prior[key])})`);
  }
  const addedPreferences = merged.preferences.filter((p) => !prior.preferences.includes(p));
  if (addedPreferences.length) changed.push(`preferences=${addedPreferences.join(",")}`);
  return changed;
}

/**
 * The Travel Employee's required fields for moving from data-collection into recommendations. When
 * `budgetMode` is `AGENT_RECOMMENDED` or `FLEXIBLE`, a numeric budget is never required — the traveler
 * explicitly asked the assistant to propose one (or has none in mind), so a recommended range is
 * generated instead of ever asking for a number.
 */
/**
 * Passenger-count state, kept distinct from a single "adults" check: `COMPLETE` means composition
 * (adults/children/infants) is known; `TOTAL_ONLY` means only an ambiguous headcount ("5 log") is known,
 * with composition still unknown; `MISSING` means neither is known. A `TOTAL_ONLY` trip is far enough
 * along to stop asking "how many travelers?" again, but still needs a composition breakdown before an
 * actual flight search that needs age categories — see {@link TravelEmployeeLlmOrchestrator.executeSearch}.
 */
export type TravelPassengerState = "COMPLETE" | "TOTAL_ONLY" | "MISSING";

export function computePassengerState(entities: TravelEntities): TravelPassengerState {
  if (entities.adults !== null) return "COMPLETE";
  if (entities.totalTravellers !== null) return "TOTAL_ONLY";
  return "MISSING";
}

/**
 * Whether a fresh passenger-composition mention this turn is a single-field correction (PATCH — e.g. "1
 * infant", "kids 2") or a full breakdown restatement (FULL_REPLACEMENT — e.g. "2 adults 1 kid"). This
 * distinction matters because a lone corrected field should patch onto the existing candidate/entities,
 * while two or more categories mentioned together is an unambiguous, complete new breakdown that must
 * replace the whole candidate rather than keep a stale, unmentioned category from before. Only counts a
 * category as "mentioned" when it's neither `null` nor `undefined` — extraction always fills an untouched
 * field with `null`, never leaves it `undefined`.
 */
export type PassengerCorrectionMode = "PATCH" | "FULL_REPLACEMENT";

export function detectPassengerCorrectionMode(extracted: {
  adults?: number | null | undefined;
  children?: number | null | undefined;
  infants?: number | null | undefined;
}): PassengerCorrectionMode {
  const mentionedCount = [extracted.adults, extracted.children, extracted.infants].filter(
    (value) => value !== null && value !== undefined
  ).length;
  return mentionedCount >= 2 ? "FULL_REPLACEMENT" : "PATCH";
}

/**
 * GENERATE_ITINERARY's only real requirements: destination, duration, and dates. Passenger composition may
 * personalize the plan but must never block it — budget and passenger state are deliberately excluded here.
 */
export function hasItineraryFields(entities: TravelEntities): boolean {
  return (
    Boolean(entities.destinationCity) &&
    (entities.days !== null || entities.nights !== null) &&
    Boolean(entities.travelMonth || entities.departureDate)
  );
}

/**
 * BOOK_FLIGHT's own required-fields check — deliberately excludes budget. Booking a specific flight is a
 * definite go-ahead, not a cost-planning exercise, so the collection flow must never fall back to asking
 * for a budget amount while this is pending. Origin is checked separately (see `canEstimateFlights`), the
 * same hard-blocker every other flight-dependent flow already uses.
 */
export function missingBookingFields(entities: TravelEntities): string[] {
  const missing: string[] = [];
  if (!entities.destinationCity) missing.push("destinationCity");
  if (!entities.travelMonth && !entities.departureDate) missing.push("travelDates");
  if (entities.days === null && entities.nights === null) missing.push("duration");
  if (computePassengerState(entities) === "MISSING") missing.push("adults");
  return missing;
}

export function computeMissingEntityFields(
  entities: TravelEntities,
  budgetMode: TravelBudgetMode = "UNKNOWN"
): string[] {
  const missing: string[] = [];
  if (!entities.destinationCity) missing.push("destinationCity");
  if (!entities.travelMonth && !entities.departureDate) missing.push("travelDates");
  if (entities.days === null && entities.nights === null) missing.push("duration");
  // A known total headcount (TOTAL_ONLY) is enough to stop asking "how many travelers?" — it is not the
  // same as composition being complete, but it is no longer a missing field for collection purposes.
  if (computePassengerState(entities) === "MISSING") missing.push("adults");
  const budgetIsAgentDriven = budgetMode === "AGENT_RECOMMENDED" || budgetMode === "FLEXIBLE";
  if (entities.budget === null && !budgetIsAgentDriven) missing.push("budget");
  return missing;
}

function stageForMissingEntityField(field: string): TravelStage {
  switch (field) {
    case "destinationCity":
      return "COLLECT_DESTINATION";
    case "travelDates":
    case "duration":
      return "COLLECT_DATES";
    case "adults":
      return "COLLECT_PASSENGERS";
    case "budget":
      return "COLLECT_BUDGET";
    default:
      return "ASK_MISSING_INFO";
  }
}

function summarizeKnownEntities(entities: TravelEntities): string[] {
  const parts: string[] = [];
  if (entities.customerName) parts.push(`traveler's name is ${entities.customerName}`);
  if (entities.originCity) parts.push(`origin ${entities.originCity}`);
  if (entities.destinationCity) parts.push(`destination ${entities.destinationCity}`);
  if (entities.travelMonth) parts.push(`travel month ${entities.travelMonth}`);
  if (entities.departureDate) parts.push(`departure ${entities.departureDate}`);
  if (entities.returnDate) parts.push(`return ${entities.returnDate}`);
  if (entities.days !== null) parts.push(`${entities.days} day(s)`);
  if (entities.nights !== null) parts.push(`${entities.nights} night(s)`);
  if (entities.adults !== null) parts.push(`${entities.adults} adult(s)`);
  else if (entities.totalTravellers !== null)
    parts.push(`${entities.totalTravellers} traveller(s) total (composition not yet broken down)`);
  if (entities.children) parts.push(`${entities.children} child(ren)`);
  if (entities.infants) parts.push(`${entities.infants} infant(s)`);
  if (entities.budget !== null) parts.push(`budget ${entities.budgetCurrency ?? ""} ${entities.budget}`.trim());
  if (entities.cabinClass) parts.push(`${entities.cabinClass} cabin`);
  if (entities.tripType) parts.push(entities.tripType);
  if (entities.hotelStars !== null) parts.push(`${entities.hotelStars}-star hotel preference`);
  if (entities.preferences.length) parts.push(`preferences: ${entities.preferences.join(", ")}`);
  return parts;
}

/** Strict language instruction appended to every LLM generation prompt — grounded response generation. */
function languageInstruction(language: TravelResponseLanguage): string {
  if (language === "HINGLISH")
    return "Reply in Hinglish — natural, casual Romanized Hindi mixed with English, matching how the traveler is writing. Do not switch to pure English.";
  if (language === "HINDI")
    return "Reply in Hindi, using Devanagari script. Do not switch to English.";
  return "Reply in English.";
}

function buildGenerationSystemPrompt(
  config: TravelEmployeeRuntimeConfig,
  entities: TravelEntities,
  missing: string[],
  changed: string[],
  isFirstTurn: boolean,
  startingNewTrip = false,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const known = summarizeKnownEntities(entities);
  const missingLabels = missing.map((field) => ENTITY_MISSING_LABELS[field] ?? field);
  // The welcome branch must never run before extraction: if the very first message already gave us
  // trip details (e.g. "I am planning to go to peris" -> destinationCity captured this turn), the reply
  // must acknowledge what was captured and ask the next missing field — never recite the configured
  // welcome message's built-in question (e.g. "Where would you like to travel to?") over a value the
  // user just supplied in this same message.
  const firstTurnCapturedSomething = isFirstTurn && changed.length > 0;
  // The configured welcome message has the "may I know your name?" question baked into its literal text
  // — reciting it verbatim is only correct when the name is genuinely unknown. When `entities.customerName`
  // is already set and wasn't just captured this turn (that case is `firstTurnCapturedSomething`, handled
  // separately below), the name arrived from elsewhere — a Receptionist handoff seed, most commonly — and
  // the model must greet by name instead of reciting a message that re-asks for something already known.
  const nameAlreadyKnown = isFirstTurn && !firstTurnCapturedSomething && Boolean(entities.customerName);
  return [
    `You are ${config.persona}`,
    `Tone: ${config.brandTone}. Speak like an experienced, warm human travel consultant — concise and conversational, never like a form. Vary your opening words turn to turn — do not start every reply with "Great!", "Sure!", or "Got it!"; use natural, diverse phrasing a real consultant would use. Reply in under 60 words, plain text, no markdown, no lists.`,
    isFirstTurn && !startingNewTrip && !firstTurnCapturedSomething && !nameAlreadyKnown
      ? `This is the first message of the conversation — begin the reply with: "${config.welcomeMessage}"`
      : isFirstTurn && !startingNewTrip && nameAlreadyKnown
        ? `This is the first message of the conversation, and the traveler's name is already known (see "Already known" below) — greet them warmly by name in a few words, then go straight to the next required question below. Do NOT use the generic welcome message and do NOT ask for their name — it is already known.`
        : isFirstTurn && !startingNewTrip && firstTurnCapturedSomething
          ? "This is the first message of the conversation, and it already stated trip details — do not recite the welcome message or ask about anything already captured (see below); briefly greet the traveler in a few words, then go straight to the next required question."
          : startingNewTrip
            ? "The traveler wants to start planning a new, separate trip — briefly acknowledge the fresh start before asking about it."
            : "Do not repeat the welcome message; continue the conversation naturally.",
    changed.length
      ? `Newly captured or updated this turn: ${changed.join(", ")}. Briefly and naturally acknowledge ONLY these — do not acknowledge, restate, or confirm any other number, name, or detail the traveler mentioned in their message unless it is listed here; the workflow may have been unable to store it, so treating it as confirmed would be false.`
      : "No new trip details were captured this turn — even if the traveler's message mentioned numbers or details, do not acknowledge or confirm any of them as captured unless they appear above.",
    known.length
      ? `Already known about this trip: ${known.join(", ")}. Never ask for any of these again.`
      : "Nothing about the trip is known yet.",
    missingLabels.length === 1
      ? `Ask for this one missing detail: ${missingLabels[0]}.`
      : missingLabels.length > 1
        ? `Ask for these missing details together, in ONE natural message (a short lead-in sentence, then each item on its own line) — not one question per turn: ${missingLabels.slice(0, 3).join("; ")}. Do not ask about anything not listed here.`
        : "All required details are known — do not ask any further questions.",
    "Only use the confirmed trip facts listed above — never invent or assume a date, year, duration,",
    "traveler count, price, or option that isn't explicitly listed. A date changing (e.g. a new origin or",
    "destination replacing an old one) never implies the old date, or any date, is still valid — if no date",
    "is listed above, none is known, and none may be stated.",
    "Never claim a booking was made, a payment was taken, or that prices are live/final.",
    "Recording a date, a passenger count, or any other captured detail is never a booking — use neutral",
    "wording like \"departure date noted\" or \"got it, noted\"; never say a flight, hotel, or booking is",
    "\"confirmed\" or \"booked\" unless a real booking was actually made (it never is here).",
    "Do not expose internal stage names or tool/system language — write like a person, not a chatbot script.",
    languageInstruction(language)
  ].join("\n");
}

/**
 * System prompt for turns where the user asked a genuine question or made a comment (ask_question,
 * ask_recommendation, casual_conversation, or a reject_plan that needs an open-ended reply). Instructs
 * the model to answer first, then gently return to the workflow without repeating rote phrases.
 */
function buildContextualSystemPrompt(
  config: TravelEmployeeRuntimeConfig,
  entities: TravelEntities,
  missing: string[],
  itineraryAlreadyPresented: boolean,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const known = summarizeKnownEntities(entities);
  const missingLabels = missing.map((field) => ENTITY_MISSING_LABELS[field] ?? field);
  const nextStep =
    missingLabels.length === 1
      ? `If it flows naturally, gently ask for ${missingLabels[0]} next — but do not force it if it would feel abrupt.`
      : missingLabels.length > 1
        ? `If it flows naturally, gently ask for these together (not one at a time): ${missingLabels.slice(0, 3).join("; ")} — but do not force it if it would feel abrupt.`
        : itineraryAlreadyPresented
          ? "If it flows naturally, invite them to confirm the plan or say what they'd like changed — but do not mechanically repeat 'reply confirm'."
          : "If it flows naturally, invite them to continue planning.";
  return [
    `You are ${config.persona}`,
    `Tone: ${config.brandTone}. Speak like an experienced, warm human travel consultant — concise, natural, conversational. Vary your opening words — avoid starting every reply with "Great!", "Sure!", or "Got it!". Reply in under 80 words, plain text, no markdown, no lists.`,
    "The traveler just asked a question or made a comment. Answer it directly and helpfully first, using only the trip context given below — never invent specific prices, flight numbers, or hotel names.",
    known.length
      ? `Already known about this trip: ${known.join(", ")}. Never ask for any of these again.`
      : "Nothing about the trip is known yet.",
    nextStep,
    "Never say \"Just checking\", and never repeat \"Reply confirm\" unless the user is actually confirming.",
    "Only use the confirmed trip facts listed above — never invent or assume a date, year, duration,",
    "traveler count, price, or option that isn't explicitly listed. If a date or year is not listed above,",
    "it is not known — do not state one anyway.",
    "Never claim a booking was made, a payment was taken, or that prices are live/final. Recording a date or",
    "detail is never a booking — never say a flight, hotel, or booking is \"confirmed\"/\"booked\" here.",
    "Do not expose internal stage names or tool/system language — write like a person, not a chatbot script.",
    languageInstruction(language)
  ].join("\n");
}

/**
 * System prompt for GENERATE_ITINERARY: a concrete, time-blocked day-by-day plan. Budget must never block
 * this — sightseeing/timing content is independent of whether flights/hotels fit the stated budget, so
 * this deliberately never mentions price, feasibility, or the budget at all (that is handled separately).
 */
function buildItinerarySystemPrompt(
  config: TravelEmployeeRuntimeConfig,
  entities: TravelEntities,
  language: TravelResponseLanguage
): string {
  const days = entities.days ?? entities.nights ?? 3;
  const destination = entities.destinationCity ?? "the destination";
  const travelers = describeTravelerMix(entities.adults, entities.children, entities.infants, entities.totalTravellers);
  const dateNote = entities.departureDate
    ? `Travel begins ${entities.departureDate}${entities.returnDate ? ` and returns ${entities.returnDate}` : ""} — reflect this in when the trip starts/ends.`
    : entities.travelMonth
      ? `Travel is planned for ${entities.travelMonth} — pick a seasonally sensible pace and note that some opening hours vary by season.`
      : null;
  const infantNote =
    (entities.infants ?? 0) > 0
      ? "At least one infant is traveling — use a noticeably slower pace: shorter outings, no more than 2-3 activities per day, and an explicit rest/nap period in the itinerary each afternoon."
      : (entities.children ?? 0) > 0
        ? "Children are traveling — favor kid-friendly stops and pacing, with a lighter afternoon."
        : null;
  const preferenceFlags = detectTravellerPreferenceFlags(entities.preferences);
  const vegetarianNote = preferenceFlags.vegetarian
    ? "The traveler is vegetarian/vegan — every meal/restaurant suggestion must accommodate this; never suggest a meat-only venue."
    : null;
  const accessibilityNote = preferenceFlags.accessibility
    ? "The traveler has a stated accessibility/mobility need — favor step-free, wheelchair-friendly venues and avoid long unassisted walks or stairs-only access points."
    : null;
  const elderlyNote = preferenceFlags.elderly
    ? "A senior/elderly traveler is in the group — keep a gentler pace with seated rest points, similar to the infant pacing guidance."
    : null;
  return [
    `You are ${config.persona}`,
    `Tone: ${config.brandTone}. Produce a concrete, practical day-by-day itinerary for ${destination}, ${days} day(s), for ${travelers}.`,
    'Format strictly as "Day N" on its own line, followed by lines of "HH:MM Activity" (24-hour time), one activity per line, using well-known real attractions/areas for the destination where you can name them confidently.',
    "Include a short duration note where it helps (e.g. \"2 hours\") but keep each line brief. Plain text, no markdown, no numbered lists beyond the day/time structure itself.",
    "Treat the arrival day and departure day differently from full days in between: the arrival day starts",
    "later/lighter (allow for check-in and travel fatigue) and the departure day ends early with a clear",
    "buffer before a flight (transit time to the airport plus a safety margin) — never schedule an activity",
    "that would plausibly make the traveler miss a flight.",
    "Leave a realistic transit/rest buffer between distant activities — never chain two far-apart stops",
    "back-to-back with no travel time accounted for.",
    dateNote,
    infantNote,
    vegetarianNote,
    accessibilityNote,
    elderlyNote,
    "Personalize activity choices to the traveler mix and preferences above — do not invent prices or bookings while doing so.",
    "Mention once, briefly, that some attractions' opening hours vary by season and should be verified locally closer to the travel date (this engine has no live operating-hours data).",
    "Do not mention prices, hotel names, flight numbers, airfare, or whether the budget is sufficient — itinerary timing and sightseeing are independent of budget feasibility, which is handled elsewhere.",
    "Never claim a booking was made or that this is a live/confirmed reservation.",
    languageInstruction(language)
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

/**
 * Deterministic, non-LLM fallback itinerary — a generic time-blocked template (no invented named
 * attractions, since a real one can't be guaranteed without a live provider) used only if the real LLM is
 * unavailable. Keeps GENERATE_ITINERARY operational even when the configured provider is down.
 */
function buildFallbackItineraryMessage(entities: TravelEntities, language: TravelResponseLanguage): string {
  const days = entities.days ?? entities.nights ?? 3;
  const destination = entities.destinationCity ?? "your destination";
  const hasInfant = (entities.infants ?? 0) > 0;
  const hasChild = (entities.children ?? 0) > 0;
  const dayBlock = hasInfant
    ? language === "HINGLISH"
      ? ["09:00 Breakfast aur halka sightseeing", "11:00 Rest/nap break", "13:00 Lunch", "15:30 Short afternoon outing", "19:00 Dinner aur evening free time"]
      : language === "HINDI"
        ? ["09:00 नाश्ता और हल्की सैर", "11:00 आराम/झपकी", "13:00 दोपहर का भोजन", "15:30 छोटी शाम की सैर", "19:00 रात का भोजन और आराम"]
        : ["09:00 Breakfast and a gentle morning outing", "11:00 Rest/nap break", "13:00 Lunch", "15:30 Short afternoon outing", "19:00 Dinner and evening at leisure"]
    : language === "HINGLISH"
      ? ["09:00 Breakfast aur morning sightseeing", "13:00 Lunch", "15:00 Afternoon exploration", "19:00 Dinner aur evening free time"]
      : language === "HINDI"
        ? ["09:00 नाश्ता और सुबह की सैर", "13:00 दोपहर का भोजन", "15:00 दोपहर की सैर", "19:00 रात का भोजन और शाम खाली"]
        : ["09:00 Breakfast and morning sightseeing", "13:00 Lunch", "15:00 Afternoon exploration", "19:00 Dinner and evening at leisure"];
  const lines: string[] = [];
  for (let day = 1; day <= days; day++) {
    lines.push(language === "HINGLISH" ? `Din ${day}` : language === "HINDI" ? `दिन ${day}` : `Day ${day}`);
    lines.push(...dayBlock, "");
  }
  const travelers = describeTravelerMix(entities.adults, entities.children, entities.infants, entities.totalTravellers);
  const intro =
    language === "HINGLISH"
      ? `${destination} ke liye din-wise plan (${travelers}):`
      : language === "HINDI"
        ? `${destination} के लिए दिन-वार योजना (${travelers}):`
        : `Here's a day-by-day plan for ${destination} (${travelers}):`;
  const paceNote = hasInfant
    ? language === "HINGLISH"
      ? "Infant ke saath, pace jaan-bujhkar dheemi rakhi gayi hai aur rest breaks add kiye gaye hain."
      : language === "HINDI"
        ? "शिशु के साथ यात्रा को देखते हुए गति जानबूझकर धीमी रखी गई है और आराम के लिए ब्रेक जोड़े गए हैं।"
        : "With an infant traveling, the pace is deliberately slower with built-in rest breaks."
    : hasChild
      ? language === "HINGLISH"
        ? "Bachon ke hisaab se activities aur pace rakha gaya hai."
        : language === "HINDI"
          ? "बच्चों के अनुसार गतिविधियाँ और गति रखी गई है।"
          : "Activities and pacing are kept family-friendly for the children in the group."
      : null;
  const seasonalNote =
    language === "HINGLISH"
      ? "Kuch jagahon ke opening hours season ke hisaab se badal sakte hain — travel date ke kareeb confirm kar lein."
      : language === "HINDI"
        ? "कुछ स्थानों के खुलने का समय मौसम के अनुसार बदल सकता है — यात्रा तिथि के करीब पुष्टि कर लें।"
        : "Some attractions' opening hours vary by season — worth confirming closer to your travel date.";
  return [`${intro}`, "", lines.join("\n").trim(), "", paceNote, seasonalNote].filter(Boolean).join("\n");
}

// ---- Deterministic itinerary safety validation (Sprint 4.2) ----
// A lightweight, purely structural check on the GENERATED itinerary text — never a claim about real
// opening hours, live traffic, or actual flight times (this engine has none of that data; see the
// system prompt's own "opening hours vary by season" disclaimer, unchanged). Catches the failure modes an
// LLM-generated schedule can actually produce: overlapping/non-increasing times, a repeated named
// attraction, an overloaded arrival day when the arrival time is unknown (always true here — this engine
// never tracks a literal arrival time), a departure day with no airport buffer, a missing rest/meal break
// for a child/infant traveler, and a day whose total scheduled span exceeds a configured limit.

export interface ParsedItineraryActivity {
  day: number;
  time: string;
  minutes: number;
  activity: string;
}

const ITINERARY_DAY_HEADER_PATTERN = /^(?:Day|Din|दिन)\s+(\d+)\s*$/i;
const ITINERARY_ACTIVITY_LINE_PATTERN = /^(\d{1,2}):(\d{2})\s+(.+)$/;

/** Parses the "Day N" / "HH:MM Activity" format both the LLM prompt and the deterministic fallback use. */
export function parseItineraryText(text: string): ParsedItineraryActivity[] {
  const activities: ParsedItineraryActivity[] = [];
  let currentDay = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const dayMatch = ITINERARY_DAY_HEADER_PATTERN.exec(line);
    if (dayMatch && dayMatch[1]) {
      currentDay = Number(dayMatch[1]);
      continue;
    }
    const timeMatch = ITINERARY_ACTIVITY_LINE_PATTERN.exec(line);
    if (timeMatch && currentDay > 0 && timeMatch[1] && timeMatch[2] && timeMatch[3]) {
      const hours = Number(timeMatch[1]);
      const mins = Number(timeMatch[2]);
      activities.push({
        day: currentDay,
        time: `${timeMatch[1]}:${timeMatch[2]}`,
        minutes: hours * 60 + mins,
        activity: timeMatch[3].trim()
      });
    }
  }
  return activities;
}

export type ItineraryValidationIssueCode =
  | "UNPARSEABLE"
  | "OVERLAPPING_TIME_SLOTS"
  | "NON_POSITIVE_DURATION"
  | "DUPLICATE_ATTRACTION"
  | "ARRIVAL_DAY_TOO_HEAVY"
  | "DEPARTURE_DAY_NO_AIRPORT_BUFFER"
  | "MISSING_CHILD_INFANT_BREAK"
  | "DAILY_DURATION_EXCEEDS_LIMIT";

export interface ItineraryValidationIssue {
  code: ItineraryValidationIssueCode;
  day: number | null;
  detail: string;
}

export interface ItineraryValidationResult {
  valid: boolean;
  issues: ItineraryValidationIssue[];
}

export interface ItineraryValidationOptions {
  hasChildren: boolean;
  hasInfants: boolean;
  /** Longest allowed span (minutes) from a day's first to last activity — a configured limit, not a live constraint. */
  maxDailyActivityMinutes?: number;
}

/** 12 hours, first activity to last — generous enough for a full sightseeing day without being unbounded. */
export const DEFAULT_MAX_DAILY_ACTIVITY_MINUTES = 12 * 60;
const ARRIVAL_DAY_MIN_START_MINUTES = 13 * 60;
const ARRIVAL_DAY_MAX_ACTIVITIES = 3;
const DEPARTURE_DAY_LATEST_ACTIVITY_MINUTES = 17 * 60;
const GENERIC_REPEATABLE_ACTIVITY_TERMS = [
  "breakfast",
  "lunch",
  "dinner",
  "meal",
  "check-in",
  "check in",
  "check-out",
  "check out",
  "rest",
  "nap",
  "free time",
  "transfer",
  "departure",
  "arrival",
  "hotel"
];

function isGenericRepeatableActivity(activity: string): boolean {
  const lower = activity.toLowerCase();
  return GENERIC_REPEATABLE_ACTIVITY_TERMS.some((term) => lower.includes(term));
}

/**
 * Structural-only validation of a generated itinerary. Returns `{valid:false, issues:[...]}` rather than
 * throwing — the caller (`safeGenerateItinerary`) decides what to do (fall back to the deterministic
 * template); this function never claims to know real opening hours, live traffic, or actual flight times.
 */
export function validateItineraryText(text: string, options: ItineraryValidationOptions): ItineraryValidationResult {
  const activities = parseItineraryText(text);
  const issues: ItineraryValidationIssue[] = [];
  if (activities.length === 0) {
    return { valid: false, issues: [{ code: "UNPARSEABLE", day: null, detail: "No day/time-formatted activities could be parsed from the itinerary text." }] };
  }
  const days = Array.from(new Set(activities.map((activity) => activity.day))).sort((a, b) => a - b);
  const firstDay = days[0] ?? 1;
  const lastDay = days[days.length - 1] ?? firstDay;
  const seenNamedOnDay = new Map<string, number>();

  for (const day of days) {
    const dayActivities = activities.filter((activity) => activity.day === day).sort((a, b) => a.minutes - b.minutes);
    for (let index = 0; index < dayActivities.length; index++) {
      const current = dayActivities[index];
      if (!current) continue;
      if (!isGenericRepeatableActivity(current.activity)) {
        const key = current.activity.trim().toLowerCase();
        const priorDay = seenNamedOnDay.get(key);
        if (priorDay !== undefined) {
          issues.push({
            code: "DUPLICATE_ATTRACTION",
            day,
            detail: `"${current.activity}" on Day ${day} already appeared on Day ${priorDay}.`
          });
        } else {
          seenNamedOnDay.set(key, day);
        }
      }
      const next = dayActivities[index + 1];
      if (next) {
        const gapMinutes = next.minutes - current.minutes;
        if (gapMinutes < 0) {
          issues.push({
            code: "OVERLAPPING_TIME_SLOTS",
            day,
            detail: `"${next.activity}" at ${next.time} starts before "${current.activity}" at ${current.time} on Day ${day}.`
          });
        } else if (gapMinutes === 0) {
          issues.push({
            code: "NON_POSITIVE_DURATION",
            day,
            detail: `"${current.activity}" and "${next.activity}" are both scheduled at ${current.time} on Day ${day}.`
          });
        }
      }
    }
    const dayStart = dayActivities[0]?.minutes ?? 0;
    const dayEnd = dayActivities[dayActivities.length - 1]?.minutes ?? dayStart;
    const maxMinutes = options.maxDailyActivityMinutes ?? DEFAULT_MAX_DAILY_ACTIVITY_MINUTES;
    if (dayEnd - dayStart > maxMinutes) {
      issues.push({
        code: "DAILY_DURATION_EXCEEDS_LIMIT",
        day,
        detail: `Day ${day} spans ${dayEnd - dayStart} minutes (first activity to last), exceeding the ${maxMinutes}-minute configured limit.`
      });
    }
    if (options.hasChildren || options.hasInfants) {
      const hasMeal = dayActivities.some((activity) => /breakfast|lunch|dinner|meal/i.test(activity.activity));
      if (!hasMeal) {
        issues.push({ code: "MISSING_CHILD_INFANT_BREAK", day, detail: `Day ${day} has no meal break scheduled for a traveling child/infant.` });
      }
      if (options.hasInfants) {
        const hasRest = dayActivities.some((activity) => /\brest\b|\bnap\b/i.test(activity.activity));
        if (!hasRest) {
          issues.push({ code: "MISSING_CHILD_INFANT_BREAK", day, detail: `Day ${day} has no rest/nap break scheduled for a traveling infant.` });
        }
      }
    }
  }

  // Arrival day must stay light — this engine never tracks a literal arrival TIME, so the arrival time is
  // always effectively unknown, and the first day must never be scheduled as if it were a full day. The
  // arrival/check-in/transfer activity itself is excluded from the count/start-time check below — noting
  // arrival is exactly what a light arrival day looks like, never something to flag on its own.
  const arrivalDayActivities = activities.filter((activity) => activity.day === firstDay).sort((a, b) => a.minutes - b.minutes);
  const substantiveArrivalDayActivities = arrivalDayActivities.filter(
    (activity) => !/\b(arrival|check-?in|transfer)\b/i.test(activity.activity)
  );
  const substantiveFirstStart = substantiveArrivalDayActivities[0]?.minutes ?? Infinity;
  if (
    substantiveArrivalDayActivities.length > ARRIVAL_DAY_MAX_ACTIVITIES ||
    (substantiveArrivalDayActivities.length > 0 && substantiveFirstStart < ARRIVAL_DAY_MIN_START_MINUTES)
  ) {
    issues.push({
      code: "ARRIVAL_DAY_TOO_HEAVY",
      day: firstDay,
      detail: `Arrival day (Day ${firstDay}) has ${substantiveArrivalDayActivities.length} non-arrival activities, the earliest at ${substantiveArrivalDayActivities[0]?.time ?? "?"} — with the arrival time unknown, substantive activities must start no earlier than 13:00 and number at most ${ARRIVAL_DAY_MAX_ACTIVITIES}.`
    });
  }

  // Departure day (only meaningful for a multi-day trip) needs a clear airport-transit buffer.
  if (lastDay !== firstDay) {
    const departureDayActivities = activities.filter((activity) => activity.day === lastDay).sort((a, b) => a.minutes - b.minutes);
    const lastActivity = departureDayActivities[departureDayActivities.length - 1];
    if (lastActivity && lastActivity.minutes > DEPARTURE_DAY_LATEST_ACTIVITY_MINUTES) {
      issues.push({
        code: "DEPARTURE_DAY_NO_AIRPORT_BUFFER",
        day: lastDay,
        detail: `Departure day (Day ${lastDay})'s last activity "${lastActivity.activity}" starts at ${lastActivity.time}, leaving no clear buffer for airport transit before a typical international flight.`
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

function buildRejectPlanMessage(language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH") return "Koi baat nahi — kya change karna hai: destination, dates, travelers, ya budget?";
  if (language === "HINDI") return "कोई बात नहीं — क्या बदलना है: गंतव्य, तारीखें, यात्री, या बजट?";
  return "No problem — what would you like me to change: the destination, dates, travelers, or budget?";
}

const FLIGHT_BUDGET_REQUIRED_FIELDS: ReadonlyArray<{ key: string; present: (entities: TravelEntities) => boolean }> = [
  { key: "originCity", present: (entities) => Boolean(entities.originCity) },
  { key: "destinationCity", present: (entities) => Boolean(entities.destinationCity) },
  { key: "travelDates", present: (entities) => Boolean(entities.travelMonth || entities.departureDate) },
  { key: "duration", present: (entities) => entities.days !== null || entities.nights !== null },
  // A known total headcount (TOTAL_ONLY) is enough here too — composition is checked separately, right
  // before an actual search, by `computePassengerState` in `executeSearch`.
  { key: "adults", present: (entities) => computePassengerState(entities) !== "MISSING" }
];

/**
 * Validates the inputs a flight-inclusive budget estimate depends on. Origin is the one hard blocker:
 * airfare varies enormously by departure city and there's no safe default for it, unlike destination,
 * dates, duration, or traveler count, which already fall back to sensible defaults elsewhere. So
 * `canEstimateFlights` — not the length of `missingFields` — is what callers must gate on before ever
 * calling the estimator or a flight-search tool, so the assistant can never quote flight numbers and
 * then turn around and ask for the departure city.
 */
export function validateBudgetEstimateInputs(entities: TravelEntities): {
  missingFields: string[];
  canEstimateFlights: boolean;
} {
  const missingFields = FLIGHT_BUDGET_REQUIRED_FIELDS.filter((field) => !field.present(entities)).map(
    (field) => field.key
  );
  return { missingFields, canEstimateFlights: Boolean(entities.originCity) };
}

/** Deterministic, non-LLM refusal so the "no flights/budget without origin" rule can never be talked around. */
export function buildOriginRequiredMessage(language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH")
    return [
      "Bilkul madad karunga. Flights dekhne ya total trip budget estimate karne se pehle, mujhe aapki",
      "departure city janni hogi — airfare aapke departure city ke hisaab se kaafi alag hota hai.",
      "",
      "Aap kis city se travel kar rahe hain?"
    ].join("\n");
  if (language === "HINDI")
    return [
      "मुझे मदद करने में खुशी होगी। फ्लाइट्स देखने या कुल यात्रा बजट का अनुमान लगाने से पहले, मुझे आपका",
      "प्रस्थान शहर जानना होगा — हवाई किराया इस पर काफी निर्भर करता है कि आप कहाँ से यात्रा कर रहे हैं।",
      "",
      "आप किस शहर से यात्रा शुरू करेंगे?"
    ].join("\n");
  return [
    "I'd be happy to help. Before I can look at flights or estimate your total trip budget, I need to know",
    "your departure city — airfare varies significantly depending on where you're flying from.",
    "",
    "Which city will you be departing from?"
  ].join("\n");
}

/**
 * Deterministic, non-LLM prompt for a passenger-composition breakdown, used only when a real flight
 * search needs age categories but the trip so far has only an ambiguous total headcount (TOTAL_ONLY) —
 * never "how many travelers?" again, since the total is already known.
 */
export function buildPassengerCompositionClarificationMessage(
  totalTravellers: number | null,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  if (language === "HINGLISH")
    return totalTravellers !== null
      ? `${totalTravellers} travellers noted. Inmein adults, children aur infants kitne hain?`
      : "Inmein adults, children aur infants kitne hain?";
  if (language === "HINDI")
    return totalTravellers !== null
      ? `${totalTravellers} यात्री दर्ज किए गए। इनमें से कितने वयस्क, बच्चे और शिशु हैं?`
      : "इनमें से कितने वयस्क, बच्चे और शिशु हैं?";
  const countWord = totalTravellers !== null ? titleCase(numberToWord(totalTravellers)) : null;
  return countWord
    ? `${countWord} travellers noted. How many are adults, children and infants?`
    : "How many are adults, children and infants?";
}

/**
 * Deterministic, non-LLM message for when a freshly stated composition breakdown doesn't add up to a
 * previously confirmed total headcount — asks for clarification rather than silently overwriting either
 * number, since it's unclear which one (or both) is wrong.
 */
export function buildPassengerCompositionConflictMessage(
  priorTotal: number,
  newTotal: number,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  if (language === "HINGLISH")
    return `Aapne pehle ${priorTotal} travellers bataye the, lekin yeh breakdown ${newTotal} logon ka hai. Kripya sahi total confirm karein.`;
  if (language === "HINDI")
    return `आपने पहले ${priorTotal} यात्री बताए थे, लेकिन यह विवरण ${newTotal} लोगों का है। कृपया सही कुल संख्या बताएं।`;
  return `You mentioned ${priorTotal} travellers earlier, but this breakdown adds up to ${newTotal}. Could you confirm the correct total?`;
}

/**
 * Internal workflow phase the deterministic orchestrator tracks per turn, independent of the persisted
 * {@link TravelStage}. Exists so "is it safe to call a search tool right now" / "are we mid-modification"
 * decisions are made by explicit, testable state rather than inferred ad hoc from LLM intent — the LLM
 * classifies intent and extracts entities, but never decides whether a tool actually gets called.
 */
export type TravelWorkflowPhase =
  | "COLLECTING_DETAILS"
  | "READY_TO_SEARCH"
  | "SEARCHING"
  | "OPTIONS_PRESENTED"
  | "MODIFYING_OPTIONS"
  | "AWAITING_CONFIRMATION";

/**
 * Structured, per-turn observability trace for the LLM orchestrator — everything a caller needs to log
 * to diagnose a live conversation without guessing: which engine ran, what state was loaded, what the
 * model extracted, what changed, which branch handled the turn, and which tools it attempted. Contains
 * no secrets or raw credentials — only trip-planning fields already stored in conversation state.
 */
export interface TravelTurnDiagnostics {
  runtime: "llm_orchestrator";
  pendingActionBefore: TravelPendingAction;
  budgetModeBefore: TravelBudgetMode;
  responseLanguage: TravelResponseLanguage;
  intent: TravelIntent | null;
  extractedEntityKeys: string[];
  changedFields: string[];
  branch: string;
  toolCallsAttempted: string[];
  /** Business feasibility result for this turn, if a numeric budget could be evaluated — see {@link BudgetFeasibilityResult}. */
  feasibility: BudgetFeasibilityResult | null;
  /** True whenever a search/tool call was skipped in favor of the BELOW_MINIMUM sales-handoff flow. */
  toolExecutionSkippedForFeasibility: boolean;
  /** The ambiguous headcount extracted this turn ("5 log"), if any — see {@link TravelPassengerState}. */
  extractedTotalTravellers: number | null;
  /** The passenger composition extracted this turn, if any. */
  extractedComposition: { adults: number | null; children: number | null; infants: number | null } | null;
  /** Passenger-count state before this turn's merge — see {@link computePassengerState}. */
  passengerStateBeforeMerge: TravelPassengerState;
  /** Passenger-count state after this turn's merge. */
  passengerState: TravelPassengerState;
  /** True whenever this turn asked for an adults/children/infants breakdown instead of proceeding. */
  passengerClarificationRequired: boolean;
  /** Deterministic classification of the current message's planning request — see {@link TravelPlanningAction}. */
  planningAction: TravelPlanningAction;
  /** Whether the BELOW_MINIMUM explanation had already been shown before this turn began. */
  budgetDiscussionCompletedBefore: boolean;
  /** The active journey's id, if one exists yet — correlates every log line for a multi-leg trip together. */
  journeyId: string | null;
  /** Number of finalized legs in the journey at the START of this turn (before anything this turn changes). */
  journeyLegCountBefore: number;
  /** Whether a live-provider failure was already on record at the START of this turn. */
  providerFailureActiveBefore: boolean;
  /** Whether the recovery menu's numeric-shortcut window was still open at the START of this turn. */
  recoveryMenuActiveBefore: boolean;
  /** True if ANY itinerary generated this turn (single-leg or any journey leg) failed validation and fell back. */
  itineraryFallbackUsed: boolean;
  /** Issue codes from every failed itinerary validation this turn — see {@link ItineraryValidationIssueCode}. */
  itineraryValidationIssues: ItineraryValidationIssueCode[];
}

/**
 * Phrases that constitute explicit authorization to act, independent of how the LLM classifies intent.
 * Once the workflow has enough information, any of these must trigger immediate tool execution rather
 * than a conversational "would you like me to..." deflection.
 */
const EXECUTION_REQUEST_PATTERN =
  /\b(yes|yeah|yep|sure|go ahead|please proceed|proceed|share (?:the |some )?options|tell me (?:the )?options|show (?:me )?(?:the )?options|find (?:me )?(?:some )?options|suggest (?:some )?flights?(?:\s+and\s+hotels?)?|flights?\s+and\s+hotels?|give (?:me )?(?:the |a )?plans?(?:\s+from\s+you)?|i need (?:a )?plans?(?:\s+from\s+you)?|give me options|do that|book it)\b/i;
export function isExecutionRequest(text: string): boolean {
  return EXECUTION_REQUEST_PATTERN.test(text);
}

/**
 * Phrases that mean "let the assistant pick the number" or "I have no fixed number in mind" — mapped
 * deterministically to a {@link TravelBudgetMode}, independent of how the LLM classifies intent, per the
 * required mapping: "you suggest your budget" / "recommend a budget" / "you suggest" / "I need budget
 * advice" / "you estimate (the budget)" / "give me your estimate" -> AGENT_RECOMMENDED; "no budget" /
 * "no fixed budget" / "flexible budget" / "budget is open" (and typo/garbled variants like "budget is
 * openb" or "budget is open boss") -> FLEXIBLE. Stage 9F: both modes are this codebase's existing
 * representation of an "OPEN" budget constraint (see `computeMissingEntityFields`'s
 * `budgetIsAgentDriven` check) — no new parallel type was introduced; these phrases now just reach the
 * mode they always should have.
 */
// "you estimate (the/my/your budget)" and "give me (your/an) estimate" both signal an open/recommended
// budget. "give me your estimate" was deliberately excluded in Stage 9F (too generic, risked downgrading
// an already-fixed budget), but is now required explicitly by UAT — gated here so it becomes actionable.
const AGENT_RECOMMENDED_BUDGET_PATTERN =
  /\b(you suggest(?:\s+(?:a|the|your)\s+budget)?|(?:can\s+)?you\s+recommend(?:\s+(?:a|the)\s+budget)?|recommend(?:ed)?\s+a\s+budget|suggest\s+a\s+budget|i\s+need\s+budget\s+advice|budget\s+advice|guide\s+me\s+(?:about|on)\s+budget|what(?:'s| is) a good budget|you\s+estimate(?:\s+(?:the|my|your)?\s*budget)?|give\s+(?:me|us)\s+(?:your|an?\s+)\s*estimate)\b/i;
// `open\w*` (not a bare `open\b`) deliberately absorbs a trailing-typo suffix like "openb" as one token,
// while a `\b` boundary right after still matches "budget is open" as a prefix of "budget is open boss" —
// covering the exact "openb"/"open boss" UAT variants without a separate typo-correction pass.
const FLEXIBLE_BUDGET_PATTERN =
  /\b(no\s+(?:fixed\s+)?budget|flexible\s+budget|budget\s+is\s+flexible|no\s+budget\s+in\s+mind|not\s+sure\s+(?:about|on)\s+(?:the\s+)?budget|budget(?:\s+is)?\s+open\w*|open\s+budget)\b/i;

/**
 * Deterministic, phrase-based budget-mode signal for the current message. Returns null when the message
 * carries no such signal, so callers never overwrite an already-known mode without cause.
 */
export function detectBudgetModeSignal(text: string): TravelBudgetMode | null {
  if (FLEXIBLE_BUDGET_PATTERN.test(text)) return "FLEXIBLE";
  if (AGENT_RECOMMENDED_BUDGET_PATTERN.test(text)) return "AGENT_RECOMMENDED";
  return null;
}

/** Recognizes a request to bring hotel cost down, mapping free-text phrasing to the MODIFY_HOTEL_BUDGET action. */
const HOTEL_BUDGET_MODIFICATION_PATTERN =
  /\b(trim (?:the |our )?hotels?|reduce (?:the )?hotel (?:cost|price|budget)s?|cheaper hotels?|lower(?:ing)? (?:the )?(?:hotel|accommodation) (?:cost|price|budget)|downgrade (?:the )?hotels?)\b/i;
const FIT_BUDGET_PATTERN =
  /\bfit\s+(?:it\s+)?(?:in|within)\s+(?:usd\s*|inr\s*|eur\s*|\$|₹)?\s*[\d,]+(?:\.\d+)?\s*(?:usd|inr|eur)?\b/i;
export function isHotelBudgetModificationRequest(text: string): boolean {
  return HOTEL_BUDGET_MODIFICATION_PATTERN.test(text) || FIT_BUDGET_PATTERN.test(text);
}

// Sprint 6.5 — Part 13: every scalar field a bare, literal restatement in the traveler's own text can
// deterministically correct — the generalized form of Stage 9F's budget-only rule (see
// `detectExplicitFieldCorrection` below).
const EXPLICIT_CORRECTION_FIELDS = [
  "budget",
  "adults",
  "totalTravellers",
  "nights",
  "days",
  "travelMonth",
  "departureDate"
] as const satisfies readonly (keyof TravelEntities)[];

// Sprint 6.5 — Part 15/28: fields that, if they change AFTER package options were already generated,
// make those options stale (priced/curated for the OLD requirements) — destination, dates, travellers,
// trip length, and budget. Cabin class/hotel stars/preferences intentionally excluded: those refine an
// existing search rather than invalidate its premise.
const MATERIAL_PACKAGE_FIELDS = [
  "destinationCity",
  "departureDate",
  "travelMonth",
  "adults",
  "totalTravellers",
  "children",
  "infants",
  "nights",
  "days",
  "budget"
] as const satisfies readonly (keyof TravelEntities)[];

// The pendingAction values that only make sense relative to `pendingRecommendations` — cleared alongside
// it on a material correction so the next turn asks the traveler to select fresh options rather than
// re-prompting for passenger details/contact/confirmation against a package that no longer applies.
const PACKAGE_DEPENDENT_PENDING_ACTIONS: TravelPendingAction[] = [
  "AWAITING_OPTION_SELECTION",
  "AWAITING_PASSENGER_DETAILS",
  "AWAITING_TICKET_CONTACT",
  "AWAITING_BOOKING_CONFIRMATION"
];

/**
 * True when the DETERMINISTIC extractor (never LLM inference) found a literal value for one of
 * `EXPLICIT_CORRECTION_FIELDS` in the traveler's own raw text, and that value differs from the
 * already-known value for the same field — the traveler's own restated number/date always outranks
 * whatever the turn's overall intent was otherwise classified as. Never fires from an LLM hallucinating a
 * change out of ambiguous wording, since `deterministic` here is always the regex-based extractor's
 * output, not model output.
 */
export function detectExplicitFieldCorrection(
  deterministic: Partial<TravelEntities>,
  lastEntities: TravelEntities
): boolean {
  return EXPLICIT_CORRECTION_FIELDS.some((field) => {
    const next = deterministic[field];
    const prior = lastEntities[field];
    return next !== null && next !== undefined && prior !== null && next !== prior;
  });
}

/**
 * Sprint 6.5 — Part 15/28: true when `changed` (the already-computed per-turn diff, `field=X (was Y)`
 * entries only for a genuine change from a known prior value — never a field being set for the first
 * time) includes one of `MATERIAL_PACKAGE_FIELDS`. Pure and reusable so it can be unit-tested directly
 * against representative diff strings without needing a full orchestrator instance.
 */
export function hasMaterialPackageChange(changed: readonly string[]): boolean {
  return changed.some(
    (entry) => entry.includes("(was ") && MATERIAL_PACKAGE_FIELDS.some((field) => entry.startsWith(`${field}=`))
  );
}

/**
 * Deterministic fallback used only when the configured real LLM is unavailable (no provider configured,
 * or the extraction call itself throws) — reuses the regex-based extractors and the typo catalog so the
 * Travel Employee degrades gracefully instead of losing every entity on a transient provider failure.
 */
export function deterministicExtractFallback(message: string): Partial<TravelEntities> {
  const destination = normalizeCityName(extractDestination(message));
  const travelMonth = extractTravelMonth(message);
  const days = extractDurationDays(message);
  const nightsMatch = NIGHTS_SIGNAL_PATTERN.exec(message);
  const composition = extractPassengerComposition(message);
  // extractPassengers only ever recognizes an ambiguous headcount ("5 people", "family of 5") — it can
  // never tell adults/children/infants apart, so it must never be assigned to `adults` directly.
  const budget = extractBudget(message);
  const dateGuess = interpretDatePhrase(message);
  // An EXPLICIT full date with a year ("17 Jan 27") is strictly more informative than the bare-month/
  // relative-phrase guess above, exactly like `augmentWithExplicitDate` already applies for the LLM path —
  // this fallback must apply the same precedence, or a message like "5 adults, 17 Jan 27, 5 days 3 nights"
  // only gets its month (via `extractTravelMonth`, which now also recognizes "Jan") and silently loses the
  // day/year. That partial `travelMonth` result was also enough to trigger the deterministic "fast path" in
  // `safeExtractAndClassify` (skipping the LLM call entirely for expected-date-field turns), which made this
  // fallback's own explicit-date blindness a user-visible regression, not just a theoretical LLM-outage one.
  const explicitDate = parseExplicitTravelDate(message);
  return {
    customerName: extractCustomerName([message]),
    destinationCity: destination,
    travelMonth: explicitDate?.travelMonth ?? travelMonth ?? dateGuess.travelMonth,
    departureDate: explicitDate?.normalizedDate ?? dateGuess.normalizedDate,
    days: days ?? dateGuess.durationDays,
    nights: nightsMatch?.[1] ? Number(nightsMatch[1]) : null,
    ...composition,
    budget: budget?.amount ?? null,
    budgetCurrency: budget?.currency ?? null
  };
}

/** Deterministic fallback intent classification for when the real LLM is unavailable. */
export function classifyIntentDeterministically(message: string): TravelIntent {
  if (isEscalationRequest(message)) return "request_human";
  if (isHotelBudgetModificationRequest(message)) return "modify_trip";
  if (isBookingConfirmation(message)) return "confirm_plan";
  if (isExecutionRequest(message)) return "ask_recommendation";
  return "provide_trip_details";
}

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export interface DateInterpretation {
  rawExpression: string;
  normalizedDate: string | null;
  travelMonth: string | null;
  durationDays: number | null;
  /** Sprint 6.5 — Part 10: set only when the phrase resolves to a window wider than a single day
   *  ("next week", "next month", "first week of October") rather than a precise date. `normalizedDate`
   *  stays null in that case — exactly as it already did for a bare month — so a broad expression is
   *  never silently turned into a fabricated precise date; see `windowStart`/`windowEnd` instead. */
  windowType?: "DAY" | "WEEK" | "MONTH" | null;
  windowStart?: string | null;
  windowEnd?: string | null;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
export function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}
function monthNameOf(date: Date): string {
  return titleCase(MONTHS[date.getUTCMonth()] ?? "");
}

/** Last calendar day of the given UTC year/0-indexed month — computed via `Date`'s own day-0-of-next-
 *  month rollover rather than a hardcoded day-count table, so leap-year February is correct for free. */
function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Resolves a bare month name to its nearest FUTURE occurrence relative to `base` — the same "already
 *  passed this year -> next year" convention the explicit month/day branch below already used, extracted
 *  so every "of <month>" window phrase shares one definition instead of three copies. */
function resolveNamedMonthYear(monthIndex: number, base: Date): number {
  return base.getUTCMonth() <= monthIndex ? base.getUTCFullYear() : base.getUTCFullYear() + 1;
}

/** Resolves "next month" / "this month" tokens (bare or inside a larger "first week of next month" /
 *  "end of this month" phrase) to a concrete {year, monthIndex} pair, correctly rolling December -> next
 *  January. Returns null for a named month string that isn't one of MONTHS (defensive; regexes only ever
 *  pass a validated token). */
function resolveMonthToken(token: string, base: Date): { year: number; monthIndex: number } | null {
  if (token === "next month") {
    const monthIndex = (base.getUTCMonth() + 1) % 12;
    const year = base.getUTCMonth() === 11 ? base.getUTCFullYear() + 1 : base.getUTCFullYear();
    return { year, monthIndex };
  }
  if (token === "this month") return { year: base.getUTCFullYear(), monthIndex: base.getUTCMonth() };
  if (MONTHS.includes(token)) {
    const monthIndex = MONTHS.indexOf(token);
    return { year: resolveNamedMonthYear(monthIndex, base), monthIndex };
  }
  return null;
}

/**
 * Deterministic natural-date normalizer: "today", "tomorrow", "day after tomorrow", "next Friday",
 * "next week", "this/next weekend", "this/next month", "first/second week of <month>", "end of <month>",
 * "August 15", "mid-September", and "for N day(s)/week(s)" durations. Accepts an injectable reference
 * date so behavior is testable without depending on the real current date (Sprint 6.5 Part 11/25).
 *
 * Timezone note (Sprint 6.5 Part 11): every date computed here uses UTC calendar arithmetic (`Date.UTC`)
 * applied to `referenceDate`'s own UTC year/month/day — there is deliberately no separate timezone
 * parameter. No per-customer or per-organization timezone reaches this far today (`TravelState
 * .userLocalTime` is declared but never populated anywhere; `businessHoursTimezone` is display-only) and
 * this function is a plain, DI-free module function with no access to `Organization.timezone` at its
 * call sites — threading a decorative parameter through that would affect no computation would be worse
 * than being explicit about the gap. Documented as a known limitation in the Sprint 6.5 report rather
 * than silently glossed over.
 *
 * Never overwrites a confirmed date on its own — callers only apply the result when the corresponding
 * field is not already confirmed. Deliberately does NOT attempt lunar-calendar festival phrases ("around
 * Diwali") — guessing a date it cannot state with confidence would violate the "don't guess when
 * genuinely ambiguous" rule; such phrases fall through to `UNKNOWN`/LLM-assisted handling untouched.
 */
export function interpretDatePhrase(raw: string, referenceDate: Date = new Date()): DateInterpretation {
  const text = raw.trim().toLowerCase();
  const base = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate()));
  const empty: DateInterpretation = { rawExpression: raw, normalizedDate: null, travelMonth: null, durationDays: null };

  const forWeeks = /\bfor\s+(?:a|one|1)\s+week\b/.exec(text) ?? /\bfor\s+(\d{1,2})\s+weeks?\b/.exec(text);
  if (forWeeks) {
    const weeks = forWeeks[1] ? Number(forWeeks[1]) : 1;
    return { ...empty, durationDays: weeks * 7 };
  }
  const forDays = /\bfor\s+(\d{1,2})\s+days?\b/.exec(text);
  if (forDays?.[1]) return { ...empty, durationDays: Number(forDays[1]) };

  // "day after tomorrow" must be checked BEFORE the bare "tomorrow" check below, since it contains
  // "tomorrow" as a substring.
  if (/\bday after tomorrow\b/.test(text)) {
    const target = addDays(base, 2);
    return { ...empty, normalizedDate: toIsoDate(target), travelMonth: monthNameOf(target) };
  }
  if (/\btoday\b/.test(text)) return { ...empty, normalizedDate: toIsoDate(base), travelMonth: monthNameOf(base) };
  if (/\btomorrow\b/.test(text)) {
    const target = addDays(base, 1);
    return { ...empty, normalizedDate: toIsoDate(target), travelMonth: monthNameOf(target) };
  }
  const nextWeekday = /\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(text);
  if (nextWeekday?.[1]) {
    const targetIndex = WEEKDAY_NAMES.indexOf(nextWeekday[1]);
    let delta = targetIndex - base.getUTCDay();
    if (delta <= 0) delta += 7;
    delta += 7;
    const target = addDays(base, delta);
    return { ...empty, normalizedDate: toIsoDate(target), travelMonth: monthNameOf(target) };
  }

  // "this weekend" / "next weekend" — Saturday-Sunday. If today itself is Sunday, "this weekend" means
  // [yesterday(Saturday), today] — the weekend the user is currently in — rather than a week away.
  const weekendMatch = /\b(this|next)\s+weekend\b/.exec(text);
  if (weekendMatch?.[1]) {
    const dow = base.getUTCDay(); // 0=Sun..6=Sat
    let saturday = dow === 0 ? addDays(base, -1) : addDays(base, 6 - dow);
    if (weekendMatch[1] === "next") saturday = addDays(saturday, 7);
    const sunday = addDays(saturday, 1);
    return {
      ...empty,
      windowType: "WEEK",
      windowStart: toIsoDate(saturday),
      windowEnd: toIsoDate(sunday),
      travelMonth: monthNameOf(saturday)
    };
  }

  // "next week" (bare — NOT "next <weekday>", already handled above) — Monday-Sunday of the following
  // calendar week.
  if (/\bnext week\b/.test(text)) {
    const dow = base.getUTCDay();
    const daysSinceMonday = (dow + 6) % 7;
    const thisMonday = addDays(base, -daysSinceMonday);
    const nextMonday = addDays(thisMonday, 7);
    const nextSunday = addDays(nextMonday, 6);
    return {
      ...empty,
      windowType: "WEEK",
      windowStart: toIsoDate(nextMonday),
      windowEnd: toIsoDate(nextSunday),
      travelMonth: monthNameOf(nextMonday)
    };
  }

  // "first/second week of <month | this month | next month>" — checked BEFORE the bare "this/next month"
  // window below, since "first week of next month" would otherwise also satisfy the bare pattern and lose
  // the "first week" qualifier entirely.
  const weekOfMonth = /\b(first|second)\s+week\s+of\s+(next\s+month|this\s+month|[a-z]+)\b/.exec(text);
  if (weekOfMonth?.[1] && weekOfMonth[2]) {
    const resolved = resolveMonthToken(weekOfMonth[2], base);
    if (resolved) {
      const dayStart = weekOfMonth[1] === "first" ? 1 : 8;
      const dayEnd = weekOfMonth[1] === "first" ? 7 : 14;
      const start = new Date(Date.UTC(resolved.year, resolved.monthIndex, dayStart));
      const end = new Date(Date.UTC(resolved.year, resolved.monthIndex, dayEnd));
      return {
        ...empty,
        windowType: "WEEK",
        windowStart: toIsoDate(start),
        windowEnd: toIsoDate(end),
        travelMonth: monthNameOf(start)
      };
    }
  }

  // "end of <month | this month | next month>" — also checked before the bare "this/next month" window.
  const endOfMonth = /\bend\s+of\s+(next\s+month|this\s+month|[a-z]+)\b/.exec(text);
  if (endOfMonth?.[1]) {
    const resolved = resolveMonthToken(endOfMonth[1], base);
    if (resolved) {
      const lastDay = lastDayOfMonth(resolved.year, resolved.monthIndex);
      const start = new Date(Date.UTC(resolved.year, resolved.monthIndex, Math.max(1, lastDay - 6)));
      const end = new Date(Date.UTC(resolved.year, resolved.monthIndex, lastDay));
      return {
        ...empty,
        windowType: "WEEK",
        windowStart: toIsoDate(start),
        windowEnd: toIsoDate(end),
        travelMonth: monthNameOf(start)
      };
    }
  }

  // "this month" / "next month" (bare) — a full-month window, never collapsed to a fake precise date.
  const monthWindowMatch = /\b(this|next)\s+month\b/.exec(text);
  if (monthWindowMatch?.[1]) {
    const resolved = resolveMonthToken(`${monthWindowMatch[1]} month`, base);
    if (resolved) {
      const start = new Date(Date.UTC(resolved.year, resolved.monthIndex, 1));
      const end = new Date(Date.UTC(resolved.year, resolved.monthIndex, lastDayOfMonth(resolved.year, resolved.monthIndex)));
      return {
        ...empty,
        windowType: "MONTH",
        windowStart: toIsoDate(start),
        windowEnd: toIsoDate(end),
        travelMonth: monthNameOf(start)
      };
    }
  }

  const midMonth = /\bmid[- ]?([a-z]+)\b/.exec(text);
  if (midMonth?.[1] && MONTHS.includes(midMonth[1])) {
    const monthIndex = MONTHS.indexOf(midMonth[1]);
    const year = resolveNamedMonthYear(monthIndex, base);
    const target = new Date(Date.UTC(year, monthIndex, 15));
    return {
      ...empty,
      normalizedDate: toIsoDate(target),
      travelMonth: titleCase(midMonth[1]),
      windowType: "WEEK",
      windowStart: toIsoDate(new Date(Date.UTC(year, monthIndex, 11))),
      windowEnd: toIsoDate(new Date(Date.UTC(year, monthIndex, 20)))
    };
  }
  const monthDay = /\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text);
  if (monthDay?.[1] && monthDay[2] && MONTHS.includes(monthDay[1])) {
    const monthIndex = MONTHS.indexOf(monthDay[1]);
    const day = Number(monthDay[2]);
    const year = base.getUTCMonth() <= monthIndex ? base.getUTCFullYear() : base.getUTCFullYear() + 1;
    const target = new Date(Date.UTC(year, monthIndex, day));
    return { ...empty, normalizedDate: toIsoDate(target), travelMonth: titleCase(monthDay[1]) };
  }
  // Day-first order ("15 October") — unambiguous (a leading 1-2 digit number can't be a month name), so
  // this is safe to resolve deterministically the same way the month-first branch above does.
  const dayMonth = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\b/.exec(text);
  if (dayMonth?.[1] && dayMonth[2] && MONTHS.includes(dayMonth[2])) {
    const monthIndex = MONTHS.indexOf(dayMonth[2]);
    const day = Number(dayMonth[1]);
    const year = resolveNamedMonthYear(monthIndex, base);
    const target = new Date(Date.UTC(year, monthIndex, day));
    return { ...empty, normalizedDate: toIsoDate(target), travelMonth: titleCase(dayMonth[2]) };
  }
  return empty;
}

const MONTH_ABBREVIATIONS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  sept: 8,
  oct: 9,
  nov: 10,
  dec: 11
};

/** Resolves a month name or 3-4 letter abbreviation to a 0-based month index, or null. */
function monthIndexOf(token: string): number | null {
  const lower = token.trim().toLowerCase();
  const full = MONTHS.indexOf(lower);
  if (full >= 0) return full;
  if (lower in MONTH_ABBREVIATIONS) return MONTH_ABBREVIATIONS[lower] ?? null;
  return null;
}

/** Parses day+month without inventing a year. Month is stored 1-based for a user-facing date record. */
export function parsePendingDepartureDate(raw: string): PendingDepartureDate | null {
  const monthAlt =
    "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";
  const text = raw.trim().toLowerCase();
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthAlt})\\.?\\b`, "i").exec(text);
  const monthDay = new RegExp(`\\b(${monthAlt})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i").exec(text);
  const numeric = /\b(\d{1,2})\/(\d{1,2})\b(?!\/)/.exec(text);
  let day: number | null = null;
  let month: number | null = null;
  if (dayMonth) {
    day = Number(dayMonth[1]);
    const index = monthIndexOf(dayMonth[2] ?? "");
    month = index === null ? null : index + 1;
  } else if (monthDay) {
    day = Number(monthDay[2]);
    const index = monthIndexOf(monthDay[1] ?? "");
    month = index === null ? null : index + 1;
  } else if (numeric) {
    day = Number(numeric[1]);
    month = Number(numeric[2]);
  }
  if (day === null || month === null || day < 1 || day > 31 || month < 1 || month > 12) return null;
  return { day, month, year: null, source: "USER_EXPLICIT" };
}

/**
 * Deterministic century-resolution policy for a 1-2 digit year: `YY` maps to `20YY` (2000-2099). Kept
 * simple and forward-looking on purpose — travel dates are near-future, so "27" is 2027, "30" is 2030.
 * A already-4-digit year is returned unchanged.
 */
export function resolveTravelYear(raw: number): number {
  if (raw >= 1000) return raw;
  return 2000 + raw;
}

/**
 * Deterministic parser for an EXPLICIT calendar date that includes a year — including the common
 * abbreviated-year forms the natural-language interpreter and the LLM both tended to drop: "17 jan 27",
 * "17 january '27", "17 jan 2027", "Jan 17 27", "17/01/27", "17-01-27". Returns a full ISO date and the
 * month name, or null. Numeric forms are read day-first (Indian convention); an unambiguous month/day
 * ordering (one component > 12) overrides that. This is the fix for the "year was silently dropped" defect.
 */
export function parseExplicitTravelDate(raw: string): { normalizedDate: string; travelMonth: string } | null {
  const text = raw.trim().toLowerCase();
  const monthAlt = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";

  // Form 1: "17 jan 27" / "17 january '27" / "17 jan 2027"  (day month year)
  const dayMonthYear = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthAlt})\\.?\\s+'?(\\d{2,4})\\b`, "i").exec(text);
  if (dayMonthYear) {
    const day = Number(dayMonthYear[1]);
    const month = monthIndexOf(dayMonthYear[2] ?? "");
    const year = resolveTravelYear(Number(dayMonthYear[3]));
    if (month !== null && day >= 1 && day <= 31) return buildIsoDate(year, month, day);
  }

  // Form 2: "jan 17 27" / "january 17th 2027"  (month day year)
  const monthDayYear = new RegExp(`\\b(${monthAlt})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+'?(\\d{2,4})\\b`, "i").exec(text);
  if (monthDayYear) {
    const month = monthIndexOf(monthDayYear[1] ?? "");
    const day = Number(monthDayYear[2]);
    const year = resolveTravelYear(Number(monthDayYear[3]));
    if (month !== null && day >= 1 && day <= 31) return buildIsoDate(year, month, day);
  }

  // Form 3: "17/01/27" / "17-01-27" / "17.01.2027"  (numeric, day-first unless a component forces MM/DD)
  const numeric = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/.exec(text);
  if (numeric) {
    let day = Number(numeric[1]);
    let month1 = Number(numeric[2]);
    const year = resolveTravelYear(Number(numeric[3]));
    // Day-first by default; flip only when the first component can't be a day-as-month situation.
    if (day <= 12 && month1 > 12) {
      // First is month, second is day (MM/DD).
      const tmp = day;
      day = month1;
      month1 = tmp;
    }
    const monthIndex = month1 - 1;
    if (monthIndex >= 0 && monthIndex <= 11 && day >= 1 && day <= 31) return buildIsoDate(year, monthIndex, day);
  }

  return null;
}

function buildIsoDate(year: number, monthIndex: number, day: number): { normalizedDate: string; travelMonth: string } {
  const date = new Date(Date.UTC(year, monthIndex, day));
  return { normalizedDate: date.toISOString().slice(0, 10), travelMonth: titleCase(MONTHS[monthIndex] ?? "") };
}

/**
 * Deterministic pass: an EXPLICIT full date (with a year) always wins — it is applied to `departureDate`
 * (and `travelMonth`) even when the LLM already reported a bare month, because a fully-specified date is
 * strictly more informative than a month alone. This guarantees a stated year survives extraction.
 */
export function augmentWithExplicitDate(message: string, extracted: Partial<TravelEntities>): Partial<TravelEntities> {
  const explicit = parseExplicitTravelDate(message);
  if (!explicit) return extracted;
  // If the model already produced this exact departure date, don't churn it.
  if (extracted.departureDate === explicit.normalizedDate) return extracted;
  return { ...extracted, departureDate: explicit.normalizedDate, travelMonth: explicit.travelMonth };
}

/**
 * Deterministic augmentation pass applied after LLM extraction: if the model didn't confidently populate
 * any date field, try the natural-date interpreter directly against the raw message so "today"/"next
 * Friday"/"for one week" style input isn't silently dropped just because the model missed it.
 */
export function augmentWithDatePhrase(message: string, extracted: Partial<TravelEntities>): Partial<TravelEntities> {
  if (extracted.travelMonth || extracted.departureDate || extracted.days) return extracted;
  const interpretation = interpretDatePhrase(message);
  if (!interpretation.normalizedDate && !interpretation.durationDays) return extracted;
  return {
    ...extracted,
    ...(interpretation.normalizedDate
      ? { departureDate: interpretation.normalizedDate, travelMonth: interpretation.travelMonth }
      : {}),
    ...(interpretation.durationDays ? { days: interpretation.durationDays } : {})
  };
}

// Matches an explicit return/back signal in the traveler's own words — the ONLY thing allowed to
// legitimize a `returnDate` extraction. Deliberately narrow (not just "return" alone, which also appears
// in unrelated phrasing like "return the deposit") isn't a real risk here since this only ever gates an
// already-proposed returnDate value, never invents one.
const RETURN_DATE_SIGNAL_PATTERN = /\b(return(?:ing)?|back|coming back|arrive back|come back|till|until)\b/i;

/**
 * Defensive backstop against the extraction model populating `returnDate` for what is actually the only
 * date the traveler gave — regardless of prompt compliance, a `returnDate` with no `departureDate` and no
 * explicit return/back signal in the raw message is reinterpreted as the departure date, never silently
 * trusted. A message with both fields already populated, or with a genuine return signal, is untouched.
 */
export function guardReturnDateAssumption(message: string, extracted: Partial<TravelEntities>): Partial<TravelEntities> {
  if (!extracted.returnDate || extracted.departureDate) return extracted;
  if (RETURN_DATE_SIGNAL_PATTERN.test(message)) return extracted;
  return { ...extracted, departureDate: extracted.returnDate, returnDate: null };
}

// Nights ("3 nights", "3 raat", "3 rat", "3 रात") — multilingual, deliberately NOT the same as a hotel
// star tier. "rat"/"raat" is the Hinglish/Hindi word for night; it must never be read as "star".
const NIGHTS_SIGNAL_PATTERN = /\b(\d{1,2})\s*(?:nights?|raat(?:ein|en)?|rat|रात(?:ें)?|raaten)\b/i;
// An explicit hotel-tier cue — the ONLY thing that legitimizes a `hotelStars` value. Stage 9F: `luxary`
// (a common typo for "luxury" seen in UAT) is tolerated here alongside the correct spelling — this cue
// never touches `budget`/`cabinClass`, so recognizing it can never reopen the budget slot or mislabel it
// as a cabin-class preference.
const HOTEL_TIER_CUE_PATTERN =
  /\b(\d\s*star|\d-star|star\s+hotel|stars?\b|deluxe|lux(?:ury|ary)|premium|standard|budget\s+hotel|five[-\s]?star|four[-\s]?star|three[-\s]?star|two[-\s]?star)\b/i;

/**
 * "N rat"/"N raat"/"N रात"/"N nights" is a NIGHT COUNT, never a hotel star tier. Regardless of how the
 * extraction model read it, this pass sets `nights` from that signal and — when the model mistakenly set
 * `hotelStars` to the same number with NO explicit star/tier wording present — drops the false star tier.
 * This is the fix for the "5 days 3 rat" -> "3-star hotel" parsing defect.
 */
export function guardNightsVsHotelStars(message: string, extracted: Partial<TravelEntities>): Partial<TravelEntities> {
  const nightsMatch = NIGHTS_SIGNAL_PATTERN.exec(message);
  if (!nightsMatch?.[1]) return extracted;
  const nights = Number(nightsMatch[1]);
  let result: Partial<TravelEntities> = { ...extracted, nights };
  if (result.hotelStars === nights && !HOTEL_TIER_CUE_PATTERN.test(message)) {
    result = { ...result, hotelStars: null };
  }
  return result;
}

// Any wording that gives a bare number a MONETARY meaning — a currency symbol/code/name, or a budget/cost
// word (English + Hinglish). Used so a four-digit year is never mistaken for a budget amount.
const MONETARY_CONTEXT_PATTERN =
  /[$₹€£¥]|\b(usd|inr|eur|gbp|aed|thb|sgd|cad|aud|jpy|dollars?|rupees?|euros?|pounds?|dirhams?|baht|yen|budget|cost|kharch\w*|price|paisa|paise|lakh|thousand)\b/i;

/** True when the message gives a number a monetary reading (currency or budget/cost wording). */
export function hasMonetaryContext(text: string): boolean {
  return MONETARY_CONTEXT_PATTERN.test(text);
}

// A four-digit near-future year (2020-2099), used to recognize a year answer/clarification.
const FOUR_DIGIT_YEAR_PATTERN = /\b(20[2-9]\d)\b/;

/**
 * Detects that a message is answering/clarifying a YEAR — either the whole message is essentially just a
 * year ("2027", "2027 me", "2027 mein", "'27" is handled by the date parser), or it explicitly frames the
 * number as a year ("year is 2027", "2027 is the year", "saal 2027"). Returns null when the number has any
 * monetary context (so "budget 2027 USD" stays money) or no year is present. This is what stops a bare
 * four-digit year from being misclassified as a budget amount.
 */
export function detectYearClarification(text: string): number | null {
  if (hasMonetaryContext(text)) return null;
  const match = FOUR_DIGIT_YEAR_PATTERN.exec(text);
  if (!match?.[1]) return null;
  const year = Number(match[1]);
  const trimmed = text.trim();
  const bare = /^\s*'?20[2-9]\d\s*(?:me|mein|hai|is)?\s*(?:year|saal)?\.?\s*$/i.test(trimmed);
  const cued = /\byear\b|\bsaal\b|\bis\s+the\s+year\b/i.test(trimmed);
  return bare || cued ? year : null;
}

/**
 * A bare/clarified year must never be extracted as a budget amount. When the message reads as a year
 * clarification (see {@link detectYearClarification}) and the extraction model turned that same number into
 * a `budget`, this drops the false budget (and its currency). This is the fix for the "2027 ME" ->
 * "USD 2,027 budget" defect.
 */
export function guardYearNotBudget(message: string, extracted: Partial<TravelEntities>): Partial<TravelEntities> {
  const year = detectYearClarification(message);
  if (year === null) return extracted;
  if (extracted.budget === year) return { ...extracted, budget: null, budgetCurrency: null };
  return extracted;
}

/** Replaces the year component of an ISO date string, keeping month/day. Returns null if unparseable. */
function withYear(dateString: string, year: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  if (!match) return null;
  return `${String(year).padStart(4, "0")}-${match[2]}-${match[3]}`;
}

/**
 * When both a departure and return date are known but no day/night count was ever explicitly given,
 * derives it from the date range — so a traveler who states both dates is never asked the redundant
 * "how many days" question the two dates already answer. Never overwrites an explicitly stated duration.
 */
export function deriveDurationFromDateRange(entities: TravelEntities): TravelEntities {
  if (entities.days !== null || entities.nights !== null) return entities;
  if (!entities.departureDate || !entities.returnDate) return entities;
  const start = Date.parse(entities.departureDate);
  const end = Date.parse(entities.returnDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return entities;
  const nights = Math.round((end - start) / 86_400_000);
  return { ...entities, nights, days: nights + 1 };
}

/**
 * A stricter, connector-aware pairing than {@link parseJourneyLegChain}: only treats two known-city
 * mentions as an origin->destination pair when an explicit "se"/"to" connector sits directly between
 * them ("Mumbai se London", "delhi to mumbai"). `parseJourneyLegChain` is deliberately looser — built for
 * chaining an open-ended sequence of leg mentions ("aur fir") — which is exactly wrong for this purpose:
 * a bare juxtaposition of two cities with no connector ("not London, Paris" — a correction, not a route)
 * must never be read as a route.
 */
function findConnectedRoutePair(text: string): { origin: string; destination: string } | null {
  const mentions = findKnownCityMentions(text);
  for (let index = 0; index < mentions.length - 1; index++) {
    const first = mentions[index];
    const second = mentions[index + 1];
    if (!first || !second) continue;
    if (first.name.toLowerCase() === second.name.toLowerCase()) continue;
    const between = text.slice(first.index + first.length, second.index);
    if (/^\s*(?:se|to)\s*$/i.test(between)) return { origin: first.name, destination: second.name };
  }
  return null;
}

// "mujhe X jana hai" / "want to travel to X" / "trip to X" — an explicit first-person "I want to GO
// somewhere" statement. Deliberately narrower than a bare city mention: this is what distinguishes a
// genuine destination statement from an unrelated mention of the same city (a correction like "not
// London, Paris", or a bare one-word reply to "which city are you departing from?").
const DESTINATION_VERB_PATTERN =
  /\b(?:jana\s+hai|jaana\s+hai|jana\s+chahta|jana\s+chahti|want\s+to\s+(?:travel|go)|travel(?:ling)?\s+to|trip\s+to|planning\s+to\s+(?:go|travel)|going\s+to)\b/i;

/**
 * Deterministic origin/destination correction applied after extraction (LLM or fallback) — the current
 * message is the most reliable signal for which city is origin vs. destination and must never be
 * second-guessed against stale prior state.
 *
 * - An explicit connector-based route ("Mumbai se London jana hai", "delhi to mumbai") -> that
 *   origin/destination pair is authoritative, overriding whatever the LLM proposed.
 * - An explicit destination statement naming exactly one known city with no connector ("mujhe mumbai
 *   jana hai") -> that city is ALWAYS the destination, never inferred as the origin — this is what stops
 *   a second, unrelated destination statement from being misread as supplying the origin for an
 *   already-known destination (the LLM has been observed to guess the new city must be the origin once a
 *   destination is already confirmed). Only clears a proposed `originCity` when it duplicates this same
 *   city (the specific error mode); a distinct origin the model separately identified is left untouched.
 * - A bare city mention with no "jana hai"/"want to go"/"trip to" verb at all (e.g. a one-word reply
 *   "Delhi" to "which city are you departing from?") is left entirely to the extraction result — this
 *   function only ever corrects an explicit destination statement, never guesses at a bare noun-phrase
 *   reply, which context (`lastAskedField`) already disambiguates upstream.
 * - Skipped when the assistant just asked for the origin (`lastAskedField === "originCity"`) even if a
 *   destination-verb phrase is present, since that context takes priority.
 */
export function reconcileRouteFromMessage(
  message: string,
  extracted: Partial<TravelEntities>,
  lastAskedField: string | null
): Partial<TravelEntities> {
  const routePair = findConnectedRoutePair(message);
  if (routePair) {
    return {
      ...extracted,
      originCity: normalizeCityName(routePair.origin),
      destinationCity: normalizeCityName(routePair.destination)
    };
  }
  // Sprint 6.5 — Part 7/29: an explicit, UNPROMPTED "from <City>" statement ("from Delhi", sent on its
  // own turn rather than in reply to a dedicated origin question) deterministically supplies origin — the
  // same extractor the dedicated-question fast path uses (`extractOriginCity`), not gated on
  // `lastAskedField` here since the traveler volunteered it without being asked.
  const explicitOrigin = extractOriginCity(message);
  if (explicitOrigin) return { ...extracted, originCity: explicitOrigin };
  if (lastAskedField !== "originCity" && DESTINATION_VERB_PATTERN.test(message)) {
    const singleCity = normalizeCityName(extractDestination(message));
    if (singleCity) {
      const proposedOrigin = extracted.originCity ? normalizeCityName(extracted.originCity) : null;
      return {
        ...extracted,
        destinationCity: singleCity,
        originCity: proposedOrigin === singleCity ? null : (extracted.originCity ?? null)
      };
    }
  }
  return extracted;
}

/**
 * Maps a "what are we currently asking about" field label to the {@link TravelEntities} key a bare short
 * answer should fill. A bare number after the generic travelers question ("adults") is an ambiguous
 * headcount, not a composition statement, so it fills `totalTravellers` — never `adults` directly.
 */
const LAST_ASKED_FIELD_TO_ENTITY_KEY: Record<string, ConfirmableEntityKey> = {
  duration: "days",
  adults: "totalTravellers",
  budget: "budget"
};

/**
 * Context-sensitive short-input disambiguation: a bare number like "5" is meaningless on its own — it
 * only means "5 travelers" or "5 days" in light of which field was last asked about. Only fills the field
 * the model itself left null this turn, so a confident LLM extraction is never overridden.
 */
export function resolveShortAnswerForLastAskedField(
  message: string,
  lastAskedField: string | null,
  extracted: Partial<TravelEntities>
): Partial<TravelEntities> {
  if (!lastAskedField) return extracted;
  const bareNumber = /^\s*(\d{1,3})\s*$/.exec(message);
  if (!bareNumber?.[1]) return extracted;
  const key = LAST_ASKED_FIELD_TO_ENTITY_KEY[lastAskedField];
  if (!key) return extracted;
  if (extracted[key] !== null && extracted[key] !== undefined) return extracted;
  return { ...extracted, [key]: Number(bareNumber[1]) };
}

/** Lowers the requested hotel star category by one catalog tier to bring nightly cost down. */
export function lowerHotelStarCategory(currentStars: number | null): { newStars: number; hitFloor: boolean } {
  const tiers = HOTEL_CATALOG.map((hotel) => hotel.stars)
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort((a, b) => b - a);
  const floor = tiers.at(-1) ?? 3;
  if (currentStars === null) return { newStars: floor, hitFloor: true };
  if (currentStars <= floor) return { newStars: floor, hitFloor: true };
  // tiers is sorted descending, so the first entry below currentStars is the next tier down.
  const next = tiers.find((tier) => tier < currentStars);
  return next === undefined ? { newStars: floor, hitFloor: true } : { newStars: next, hitFloor: next === floor };
}

/**
 * Validates that every field a `travel.search_flights` / `travel.search_hotels` tool call depends on is
 * present before the tool is ever invoked — the same required set as {@link validateBudgetEstimateInputs},
 * exposed under its own name for tool-call-site validation and logging.
 */
export function validateToolTripContext(entities: TravelEntities): { valid: boolean; missingFields: string[] } {
  const { missingFields } = validateBudgetEstimateInputs(entities);
  return { valid: missingFields.length === 0, missingFields };
}

/** Deterministic, non-LLM recovery reply for when a travel tool call fails — never a raw error or stack trace. */
export function buildToolFailureRecoveryMessage(language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH")
    return "Abhi options retrieve nahi ho paaye. Aapki trip details save hain, dobara batane ki zaroorat nahi — kripya search dobara try karein.";
  if (language === "HINDI")
    return "अभी विकल्प प्राप्त नहीं हो पाए। आपकी यात्रा जानकारी सुरक्षित है, दोबारा बताने की ज़रूरत नहीं — कृपया खोज दोबारा करें।";
  return "I couldn't retrieve the options just now. Your trip details are saved, so you don't need to repeat them. Please retry the search.";
}

/**
 * Deterministic, honest fallback when the sales-handoff CRM-lead save fails (a genuine technical/system
 * error, distinct from a low-budget business result) — per policy, a callback is only ever promised after
 * the enquiry has actually been persisted, so this explicitly does not promise one.
 */
export function buildSalesHandoffFallbackMessage(language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH")
    return "Maaf kijiye, abhi aapki enquiry save nahi ho paayi. Aap thodi der baad dobara try kar sakte hain, ya seedhe hamari team se baat kar sakte hain.";
  if (language === "HINDI")
    return "क्षमा करें, अभी आपकी पूछताछ सुरक्षित नहीं हो पाई। आप कुछ देर बाद दोबारा प्रयास कर सकते हैं, या सीधे हमारी टीम से बात कर सकते हैं।";
  return "Sorry, I wasn't able to save your enquiry just now. Please try again shortly, or ask to speak with our team directly.";
}

/** Deterministic confirmation once the BELOW_MINIMUM sales-handoff enquiry has actually been persisted. */
export function buildSalesHandoffConfirmedMessage(language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH")
    return "Aapki enquiry save kar li gayi hai. Hamari sales team ka executive aapko shortly contact karke lowest-cost alternatives suggest karega.";
  if (language === "HINDI")
    return "आपकी पूछताछ सुरक्षित कर ली गई है। हमारी सेल्स टीम का एक कार्यकारी जल्द ही आपसे संपर्क करके सबसे किफायती विकल्प सुझाएगा।";
  return "Your enquiry has been saved. A member of our sales team will contact you shortly to suggest the lowest-cost alternatives.";
}

export interface BudgetEstimateLine {
  label: string;
  low: number;
  high: number;
  /** Per-traveller share of low/high, for lines priced per head (Flights, Visa, Insurance) — makes the
   *  distinction between "cost per traveller" and "cost for the whole party" explicit rather than only
   *  ever showing the party total. Omitted for lines that aren't priced per head. */
  perTraveller?: { low: number; high: number };
  /** Per-night share, Hotel line only. */
  perNight?: { low: number; high: number };
  /** Per-room share, Hotel line only. */
  perRoom?: { low: number; high: number };
}

/**
 * Stage 9B: explicit scope for a formatted amount range — never let a message imply the wrong one (the
 * fix for a real defect: a TOTAL_PARTY flight amount was previously shown labeled "per traveler").
 */
export type AmountScope = "PER_TRAVELLER" | "TOTAL_PARTY" | "PER_NIGHT" | "TOTAL_STAY";

/**
 * Formats a low–high range together with a label naming its scope, so a caller can never present one
 * scope's number under another scope's label. `travellerCount` only affects the TOTAL_PARTY label.
 */
export function formatScopedAmount(
  range: { low: number; high: number },
  currency: string,
  scope: AmountScope,
  language: TravelResponseLanguage = "ENGLISH",
  travellerCount: number | null = null
): string {
  const amount = `${currency} ${formatAmount(range.low)}–${formatAmount(range.high)}`;
  if (scope === "PER_TRAVELLER") {
    if (language === "HINGLISH") return `${amount} per traveller`;
    if (language === "HINDI") return `${amount} प्रति यात्री`;
    return `${amount} per traveler`;
  }
  if (scope === "TOTAL_PARTY") {
    if (language === "HINGLISH")
      return travellerCount ? `${amount} total (${travellerCount} travellers ke liye)` : `${amount} total`;
    if (language === "HINDI")
      return travellerCount ? `${amount} कुल (${travellerCount} यात्रियों के लिए)` : `${amount} कुल`;
    return travellerCount ? `${amount} total for ${travellerCount} travellers` : `${amount} total`;
  }
  if (scope === "PER_NIGHT") {
    if (language === "HINGLISH") return `${amount} per night`;
    if (language === "HINDI") return `${amount} प्रति रात`;
    return `${amount} per night`;
  }
  // TOTAL_STAY
  if (language === "HINGLISH") return `${amount} poore stay ke liye`;
  if (language === "HINDI") return `${amount} पूरे ठहराव के लिए`;
  return `${amount} for the full stay`;
}

export interface BudgetEstimate {
  /** Currency the amounts below are DISPLAYED in (the traveler's budget/display currency). */
  currency: string;
  /** Currency the amounts were natively COMPUTED in before conversion — always the placeholder pricing
   * engine's currency ({@link PRICING_SOURCE_CURRENCY}). Tracked so a conversion is always applied exactly
   * once, from a single known source, and so an estimate can never silently mislabel USD numbers as another
   * currency. Optional so older callers/snapshots stay valid. */
  sourceCurrency?: string;
  low: number;
  high: number;
  breakdown: BudgetEstimateLine[];
}

/**
 * The currency the placeholder pricing engine ({@link generatePlaceholderFlights}/
 * {@link generatePlaceholderHotels} and the per-day cost constants) is natively denominated in. Every
 * estimate is computed in this currency and then converted exactly once to the traveler's display currency
 * — never relabeled. This is the fix for the "USD amounts shown as INR" implausibility defect.
 */
export const PRICING_SOURCE_CURRENCY = "USD";

/**
 * A snapshot of the last budget estimate actually shown to the traveler — source currency, every category
 * range, the total range, a short human-readable summary of the assumptions it was computed under, and
 * when it was computed. Persisted so a later "give in INR" can convert the SAME numbers rather than
 * silently recomputing (which could disagree) or merely relabeling the currency without converting.
 */
export interface StoredBudgetEstimate {
  /** Currency the amounts below are denominated in. Snapshots produced by this engine are always stored in
   * their canonical {@link PRICING_SOURCE_CURRENCY} so a later currency request converts from one stable
   * source exactly once (no cumulative rounding drift). */
  currency: string;
  low: number;
  high: number;
  breakdown: BudgetEstimateLine[];
  assumptions: string;
  computedAt: string;
  /** Currency the estimate should be rendered to the traveler in — the persisted display preference at the
   * time it was shown. Optional so older persisted snapshots stay valid (they default to `currency`). */
  displayCurrency?: string;
  /** Whether these numbers came from a live provider search or an indicative placeholder estimate. */
  availabilityType?: "LIVE" | "INDICATIVE";
}

/**
 * Converts one amount from `from` to `to` using one consistent exchange rate — never a partial/mixed
 * conversion, and never a relabel-only "conversion" that leaves the number unchanged. Thin delegation to
 * the standalone {@link CurrencyService} (see `currency.service.ts`); an unrecognized currency code on
 * either side is left unconverted (rounded, not re-derived) rather than guessing at a rate.
 */
export function convertCurrencyAmount(amount: number, from: string, to: string): number {
  if (!isSupportedCurrency(from) || !isSupportedCurrency(to)) return Math.round(amount);
  return currencyService.convert(amount, from.toUpperCase() as CurrencyCode, to.toUpperCase() as CurrencyCode);
}

/**
 * FX-failure-safe amount conversion: returns null (never a fabricated or mislabeled number) when either
 * currency is unsupported or the exchange-rate provider is unavailable/invalid. See
 * {@link convertStoredBudgetEstimateSafe}.
 */
export function tryConvertCurrencyAmount(amount: number, from: string, to: string): number | null {
  if (!isSupportedCurrency(from) || !isSupportedCurrency(to)) return null;
  return currencyService.tryConvert(amount, from.toUpperCase() as CurrencyCode, to.toUpperCase() as CurrencyCode);
}

/**
 * FX-failure-safe version of {@link convertStoredBudgetEstimate}: returns null when the conversion can't be
 * performed (provider unavailable/invalid, or an unsupported currency), so the caller can respond safely
 * (persist the display preference, offer the original currency) instead of showing a fabricated or
 * mislabeled figure. A same-currency target is always safe.
 */
export function convertStoredBudgetEstimateSafe(
  estimate: StoredBudgetEstimate,
  targetCurrency: string
): StoredBudgetEstimate | null {
  const target = targetCurrency.toUpperCase();
  if (estimate.currency.toUpperCase() === target) return estimate;
  const amounts: number[] = [estimate.low, estimate.high];
  for (const line of estimate.breakdown) amounts.push(line.low, line.high);
  for (const amount of amounts) {
    if (tryConvertCurrencyAmount(amount, estimate.currency, target) === null) return null;
  }
  return convertStoredBudgetEstimate(estimate, target);
}

/** Converts a single breakdown line (including any per-traveller/per-night/per-room sub-ranges) to `target`. */
function convertBudgetEstimateLine(line: BudgetEstimateLine, from: string, target: string): BudgetEstimateLine {
  const conv = (value: number): number => convertCurrencyAmount(value, from, target);
  return {
    ...line,
    low: conv(line.low),
    high: conv(line.high),
    ...(line.perTraveller ? { perTraveller: { low: conv(line.perTraveller.low), high: conv(line.perTraveller.high) } } : {}),
    ...(line.perNight ? { perNight: { low: conv(line.perNight.low), high: conv(line.perNight.high) } } : {}),
    ...(line.perRoom ? { perRoom: { low: conv(line.perRoom.low), high: conv(line.perRoom.high) } } : {})
  };
}

/**
 * Converts a computed {@link BudgetEstimate} to `targetCurrency` exactly once, from its `sourceCurrency`.
 * The top-level total is recomputed as the sum of the converted lines (never converted independently) so
 * the "total equals the sum of its breakdown" invariant (see {@link reconcileBudgetEstimate}) always holds
 * after conversion. A same-currency target is a no-op relabel, never a re-derivation.
 */
export function convertBudgetEstimate(estimate: BudgetEstimate, targetCurrency: string): BudgetEstimate {
  const target = targetCurrency.toUpperCase();
  if (estimate.currency.toUpperCase() === target) return estimate;
  const breakdown = estimate.breakdown.map((line) => convertBudgetEstimateLine(line, estimate.currency, target));
  return {
    currency: target,
    ...(estimate.sourceCurrency ? { sourceCurrency: estimate.sourceCurrency } : {}),
    low: breakdown.reduce((sum, line) => sum + line.low, 0),
    high: breakdown.reduce((sum, line) => sum + line.high, 0),
    breakdown
  };
}

/**
 * Converts every number in a stored estimate to `targetCurrency` using one consistent FX rate. Never
 * relabels unchanged amounts: if the target currency is the same as the source, the estimate (numbers and
 * all) is returned unchanged rather than merely re-stamped. The `displayCurrency` is always updated to the
 * target so the snapshot records what it is now shown in.
 */
export function convertStoredBudgetEstimate(estimate: StoredBudgetEstimate, targetCurrency: string): StoredBudgetEstimate {
  const target = targetCurrency.toUpperCase();
  if (estimate.currency.toUpperCase() === target) return estimate;
  return {
    ...estimate,
    currency: target,
    displayCurrency: target,
    low: convertCurrencyAmount(estimate.low, estimate.currency, target),
    high: convertCurrencyAmount(estimate.high, estimate.currency, target),
    breakdown: estimate.breakdown.map((line) => convertBudgetEstimateLine(line, estimate.currency, target))
  };
}

/**
 * Builds the persisted snapshot of an estimate right after it was computed and shown to the traveler.
 * `estimate` is the CANONICAL source-currency ({@link PRICING_SOURCE_CURRENCY}) estimate — the snapshot is
 * deliberately stored in that canonical currency, with the display preference tracked separately, so a
 * later "share in USD"/"give in INR" converts from a single stable source exactly once.
 */
function toStoredBudgetEstimate(
  estimate: BudgetEstimate,
  entities: TravelEntities,
  now: string,
  displayCurrency: string,
  availabilityType: "LIVE" | "INDICATIVE"
): StoredBudgetEstimate {
  const travelers = describeTravelerMix(entities.adults, entities.children, entities.infants, entities.totalTravellers);
  const days = entities.days ?? entities.nights ?? 5;
  const destination = entities.destinationCity ?? "the destination";
  return {
    currency: estimate.currency,
    low: estimate.low,
    high: estimate.high,
    breakdown: estimate.breakdown,
    assumptions: `${travelers}, ${days} day(s) to ${destination}, economy class`,
    computedAt: now,
    displayCurrency,
    availabilityType
  };
}

/**
 * Deterministic, non-LLM message for CONVERT_ESTIMATE_CURRENCY: the previously shown estimate, converted
 * to the requested currency with one FX rate — never a request for a new budget amount.
 */
export function buildConvertedEstimateMessage(
  estimate: StoredBudgetEstimate,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const lines = estimate.breakdown.map(
    (line) => `• ${line.label}: ${estimate.currency} ${formatAmount(line.low)}–${formatAmount(line.high)}`
  );
  const intro =
    language === "HINGLISH"
      ? `Yahan ${estimate.currency} mein estimate hai (${estimate.assumptions}):`
      : language === "HINDI"
        ? `यहाँ ${estimate.currency} में अनुमान है (${estimate.assumptions}):`
        : `Here's the estimate in ${estimate.currency} (${estimate.assumptions}):`;
  const total =
    language === "HINGLISH"
      ? `Total: ${estimate.currency} ${formatAmount(estimate.low)}–${formatAmount(estimate.high)}`
      : language === "HINDI"
        ? `कुल: ${estimate.currency} ${formatAmount(estimate.low)}–${formatAmount(estimate.high)}`
        : `Total: ${estimate.currency} ${formatAmount(estimate.low)}–${formatAmount(estimate.high)}`;
  return [intro, ...lines, "", total].join("\n");
}

/** Deterministic, non-LLM message for when a currency conversion is requested but no estimate exists yet. */
export function buildNoEstimateToConvertMessage(language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH")
    return "Abhi tak koi budget estimate nahi banaya gaya hai jise convert kiya ja sake — pehle budget ya cost puchhein.";
  if (language === "HINDI") return "अभी तक कोई बजट अनुमान नहीं बना है जिसे बदला जा सके — पहले बजट या लागत पूछें।";
  return "There's no budget estimate yet to convert — ask about the budget or cost first.";
}

/** Acknowledges a display-currency change when there is no estimate to show yet — the journey simply
 * continues from its current state (never triggers a search). */
export function buildDisplayCurrencySetMessage(currency: string, language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH") return `Theek hai — ab se saare estimates ${currency} mein dikhaunga.`;
  if (language === "HINDI") return `ठीक है — अब से सभी अनुमान ${currency} में दिखाऊँगा।`;
  return `Sure — I'll show future estimates in ${currency}.`;
}

/** Acknowledges the display currency AND preserves a still-pending search confirmation, asking it once
 * more with the currency context — only used when no recommendation has been generated yet. */
export function buildCurrencyAckWithSearchPromptMessage(
  currency: string,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  if (language === "HINGLISH")
    return `Theek hai — results ${currency} mein dikhaunga. Kya main abhi flight aur hotel options dhoondh loon?`;
  if (language === "HINDI")
    return `ठीक है — परिणाम ${currency} में दिखाऊँगा। क्या मैं अभी फ्लाइट और होटल विकल्प खोजूँ?`;
  return `Sure — I'll show the results in ${currency}. Would you like me to run the flight and hotel search now?`;
}

/** Short preface used when the estimate is already displayed in the requested currency (idempotent). */
export function buildAlreadyInCurrencyMessage(currency: string, language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH") return `Estimate pehle se hi ${currency} mein dikhaya gaya hai.`;
  if (language === "HINDI") return `अनुमान पहले से ही ${currency} में दिखाया गया है।`;
  return `The estimate is already shown in ${currency}.`;
}

/** A clear, non-looping response for a currency we don't support — names the ones we do, never triggers a
 * search or slot collection. */
export function buildUnsupportedCurrencyMessage(language: TravelResponseLanguage = "ENGLISH"): string {
  const list = SUPPORTED_CURRENCIES.join(", ");
  if (language === "HINGLISH")
    return `Maaf kijiye, main abhi sirf ${list} mein amounts dikha sakta hoon. Inमें से kaunsi currency chahiye?`;
  if (language === "HINDI")
    return `क्षमा करें, मैं अभी केवल ${list} में राशि दिखा सकता हूँ। इनमें से कौन सी मुद्रा चाहिए?`;
  return `I can show amounts in ${list}. Which of these would you like?`;
}

/** FX-failure-safe response: the display preference is still recorded, but live conversion isn't available
 * right now, so the estimate is offered in its original currency rather than a fabricated one. */
export function buildConversionUnavailableMessage(
  targetCurrency: string,
  estimate: StoredBudgetEstimate,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const original = buildConvertedEstimateMessage(estimate, language);
  if (language === "HINGLISH")
    return `Abhi ${targetCurrency} ka live conversion available nahi hai. Yahan wahi estimate uski original currency mein hai:\n\n${original}`;
  if (language === "HINDI")
    return `अभी ${targetCurrency} का लाइव रूपांतरण उपलब्ध नहीं है। यहाँ वही अनुमान उसकी मूल मुद्रा में है:\n\n${original}`;
  return `I can't convert to ${targetCurrency} right now, but here's the same estimate in its original currency:\n\n${original}`;
}

/**
 * Deterministic budget-range estimator. Sources its flight and hotel numbers from the exact same
 * {@link generatePlaceholderFlights} / {@link generatePlaceholderHotels} functions used to build the
 * actual recommendation, so budget guidance never quotes a different price model than the tools do.
 */
/**
 * Resolves a payer/room headcount even when passenger composition is unknown: prefers real composition
 * (adults + children), falls back to an ambiguous `totalTravellers` count as a documented approximation
 * for early budget estimation (never for an actual flight search — see {@link computePassengerState}),
 * and finally defaults to a single traveler when nothing at all is known.
 */
function resolveFarePayers(entities: TravelEntities): number {
  if (entities.adults !== null) return entities.adults + (entities.children ?? 0);
  if (entities.totalTravellers !== null) return entities.totalTravellers;
  return 1;
}

// Sprint 4.2 pricing-consistency fix (option B): this engine has no provider-backed passenger-tier
// pricing, so it must never DISPLAY a numerical child/infant discount factor that the headline total does
// not actually apply — a prior version showed "children ~75%, infants ~10%" while `resolveFarePayers`
// silently counted children at full fare and infants at zero, a real reconciliation bug (the displayed
// formula and the computed total disagreed). Rather than inventing a live-feeling per-passenger pricing
// model (option A) — which would require a real fare-class/provider rate card to be honest, and would
// silently re-open every hardcoded budget-total test in this file — this engine now states only the
// QUALITATIVE fact, worded to exactly match what `resolveFarePayers` actually does, so the note always
// reconciles with the number displayed next to it.
export interface TravellerCostBreakdown {
  adults: { count: number };
  children: { count: number };
  infants: { count: number };
}

/** Computed purely for the transparency note — never a numeric input to the headline low/high total. */
export function describeTravellerCostBreakdown(entities: {
  adults: number | null;
  children: number | null;
  infants: number | null;
  totalTravellers: number | null;
}): TravellerCostBreakdown {
  const adults = entities.adults ?? entities.totalTravellers ?? 1;
  const children = entities.adults !== null ? (entities.children ?? 0) : 0;
  const infants = entities.adults !== null ? (entities.infants ?? 0) : 0;
  return { adults: { count: adults }, children: { count: children }, infants: { count: infants } };
}

/**
 * Deterministic transparency note — omitted entirely for an adults-only trip (nothing to differentiate).
 * Deliberately carries NO percentage or numeric formula: the wording states exactly what `resolveFarePayers`
 * does (every child costed at the full adult fare, infants not added), so it can never drift out of sync
 * with the headline total the way a separate invented factor could.
 */
export function buildTravellerCostFactorNote(
  breakdown: TravellerCostBreakdown,
  language: TravelResponseLanguage = "ENGLISH"
): string | null {
  if (breakdown.children.count === 0 && breakdown.infants.count === 0) return null;
  if (language === "HINGLISH")
    return "Bachon aur infants ka asli fare airline/route ke hisaab se alag hota hai — koi guaranteed discount is indicative estimate mein nahi maana gaya hai. Upar ka total har bachche ko poore adult fare par count karta hai (kabhi under-estimate nahi karta), aur infant ka fare alag se add nahi kiya gaya hai.";
  if (language === "HINDI")
    return "बच्चों और शिशुओं का वास्तविक किराया एयरलाइन/मार्ग के अनुसार अलग होता है — इस संकेतात्मक अनुमान में किसी गारंटीड छूट को नहीं माना गया है। ऊपर का कुल हर बच्चे को पूर्ण वयस्क किराए पर गिनता है (कभी कम नहीं आँकता), और शिशु का किराया अलग से नहीं जोड़ा गया है।";
  return "Child and infant airfares vary by airline and route — this indicative estimate does not assume any guaranteed discount. The total above counts every child at the full adult fare (so it's never understated) and does not add infant airfare separately.";
}

export interface TravellerPreferenceFlags {
  vegetarian: boolean;
  accessibility: boolean;
  elderly: boolean;
}

/** Scans free-text preferences for a small set of known, actionable flags — never invents ones not stated. */
export function detectTravellerPreferenceFlags(preferences: readonly string[]): TravellerPreferenceFlags {
  const joined = preferences.join(" ").toLowerCase();
  return {
    vegetarian: /vegetarian|vegan/.test(joined),
    accessibility: /wheelchair|accessib|mobility[\s-]?(?:issue|need|assist)/.test(joined),
    elderly: /elderly|senior citizen|senior traveller|senior travel(?:l)?er/.test(joined)
  };
}

/**
 * A single visible note confirming which stated preferences are being applied — required so vegetarian,
 * accessibility, and elderly/pacing preferences are never silently dropped once mentioned. Returns null
 * when nothing recognizable was stated (never fabricates a preference the traveler didn't give).
 */
export function buildPreferenceApplicationNote(
  preferences: readonly string[],
  hasChildren: boolean,
  hasInfants: boolean,
  language: TravelResponseLanguage = "ENGLISH"
): string | null {
  const flags = detectTravellerPreferenceFlags(preferences);
  const parts: string[] = [];
  if (language === "HINGLISH") {
    if (flags.vegetarian) parts.push("vegetarian/vegan dining");
    if (flags.accessibility) parts.push("wheelchair/accessibility needs");
    if (flags.elderly) parts.push("senior-friendly, slower pace");
    if (hasInfants) parts.push("infant pacing (extra rest breaks)");
    else if (hasChildren) parts.push("kid-friendly pacing");
    if (!parts.length) return null;
    return `Preferences applied: ${parts.join(", ")}.`;
  }
  if (language === "HINDI") {
    if (flags.vegetarian) parts.push("शाकाहारी/वीगन भोजन");
    if (flags.accessibility) parts.push("व्हीलचेयर/सुगम्यता आवश्यकताएं");
    if (flags.elderly) parts.push("वरिष्ठ-अनुकूल, धीमी गति");
    if (hasInfants) parts.push("शिशु गति (अतिरिक्त आराम विराम)");
    else if (hasChildren) parts.push("बच्चों के अनुकूल गति");
    if (!parts.length) return null;
    return `लागू प्राथमिकताएं: ${parts.join(", ")}।`;
  }
  if (flags.vegetarian) parts.push("vegetarian/vegan dining");
  if (flags.accessibility) parts.push("wheelchair/accessibility needs");
  if (flags.elderly) parts.push("senior-friendly, slower pace");
  if (hasInfants) parts.push("infant pacing (extra rest breaks)");
  else if (hasChildren) parts.push("kid-friendly pacing");
  if (!parts.length) return null;
  return `Preferences applied: ${parts.join(", ")}.`;
}

/** Duration-tracking: which of days/nights the traveler actually stated — never silently relabeled as the other. */
export type DurationSource = "EXPLICIT_DAYS" | "EXPLICIT_NIGHTS" | "BOTH_STATED" | "UNKNOWN";
export function resolveDurationSource(entities: { days: number | null; nights: number | null }): DurationSource {
  if (entities.days !== null && entities.nights !== null) return "BOTH_STATED";
  if (entities.days !== null) return "EXPLICIT_DAYS";
  if (entities.nights !== null) return "EXPLICIT_NIGHTS";
  return "UNKNOWN";
}

/** Renders exactly what's known — "N day(s)"/"N night(s)"/both — never mislabeling one as the other. */
export function buildDurationPhrase(
  entities: { days: number | null; nights: number | null },
  language: TravelResponseLanguage = "ENGLISH"
): string | null {
  const dayWord = language === "ENGLISH" ? "day(s)" : "din";
  const nightWord = language === "ENGLISH" ? "night(s)" : language === "HINDI" ? "रात" : "raat";
  const source = resolveDurationSource(entities);
  if (source === "BOTH_STATED") return `${entities.days} ${dayWord} / ${entities.nights} ${nightWord}`;
  if (source === "EXPLICIT_DAYS") return `${entities.days} ${dayWord}`;
  if (source === "EXPLICIT_NIGHTS") return `${entities.nights} ${nightWord}`;
  return null;
}

/**
 * States the assumption BEFORE hotel costing whenever nights had to be derived from days (or vice versa) —
 * required so a "3 days" statement never silently becomes "3 nights" of hotel cost without saying so.
 * Returns null when nights are already explicitly known (nothing was assumed) or duration is unknown
 * entirely (a different, generic missing-field ask handles that case).
 */
export function buildDurationAssumptionNote(
  entities: { days: number | null; nights: number | null },
  language: TravelResponseLanguage = "ENGLISH"
): string | null {
  const source = resolveDurationSource(entities);
  if (source !== "EXPLICIT_DAYS") return null;
  const assumedNights = Math.max((entities.days ?? 1) - 1, 1);
  if (language === "HINGLISH")
    return `Assumption: ${entities.days} din ke liye hotel cost ${assumedNights} raaton ke hisaab se lagayi gayi hai.`;
  if (language === "HINDI")
    return `मान्यता: ${entities.days} दिनों के लिए होटल लागत ${assumedNights} रातों के आधार पर लगाई गई है।`;
  return `Assumption: hotel cost is calculated for ${assumedNights} night(s), derived from the ${entities.days} day(s) stated.`;
}

/**
 * Computes the estimate in the pricing engine's native currency ({@link PRICING_SOURCE_CURRENCY}) — every
 * number here comes straight from {@link generatePlaceholderFlights}/{@link generatePlaceholderHotels} and
 * the per-day USD cost constants, all in that one currency. {@link estimateBudgetRange} converts the result
 * to the traveler's display currency exactly once; this function never mixes currencies or relabels.
 */
function computeBudgetEstimateUsd(
  entities: TravelEntities,
  config: TravelEmployeeRuntimeConfig
): BudgetEstimate {
  void config;
  const adults = entities.adults ?? entities.totalTravellers ?? 1;
  // Fare-/cost-paying headcount: children occupy a seat, a bed, and a plate, so they must factor into
  // every priced category — only infants (typically lap/free) are excluded from per-head multipliers.
  // Falls back to an ambiguous `totalTravellers` count (a documented approximation) when composition is
  // still unknown — see {@link resolveFarePayers}. (A separate, indicative per-category child/infant cost
  // SHARE is available via {@link describeTravellerCostBreakdown} for transparency — see its own doc comment
  // for why it does not feed back into this total.)
  const farePayers = resolveFarePayers(entities);
  // Duration used for cost math ONLY — never presented to the traveler as if it were the stated value; see
  // {@link buildDurationPhrase}/{@link buildDurationAssumptionNote} for the honest, source-aware display.
  const days = entities.days ?? entities.nights ?? 5;
  const nights = entities.nights ?? Math.max(days - 1, 1);
  const destination = entities.destinationCity ?? "your destination";

  const { flightOptions } = generatePlaceholderFlights({
    destination,
    travelMonth: entities.travelMonth,
    passengers: farePayers
  });
  const flightPrices = flightOptions.map((flight) => flight.price);
  const flightsLow = Math.min(...flightPrices);
  const flightsHigh = Math.max(...flightPrices);

  const rooms = Math.max(1, Math.ceil(adults / 2));
  const { hotelOptions } = generatePlaceholderHotels({
    destination,
    travelMonth: entities.travelMonth,
    hotelStars: entities.hotelStars
  });
  const hotelPrices = hotelOptions.map((hotel) => hotel.pricePerNight);
  const hotelPerNightLow = Math.min(...hotelPrices);
  const hotelPerNightHigh = Math.max(...hotelPrices);
  const hotelPerRoomLow = hotelPerNightLow * nights;
  const hotelPerRoomHigh = hotelPerNightHigh * nights;
  const hotelLow = hotelPerRoomLow * rooms;
  const hotelHigh = hotelPerRoomHigh * rooms;

  const foodLow = farePayers * days * 25;
  const foodHigh = farePayers * days * 40;

  const localTransportLow = farePayers * days * 10;
  const localTransportHigh = farePayers * days * 18;

  const activitiesLow = farePayers * days * 15;
  const activitiesHigh = farePayers * days * 30;

  // Domestic travel (origin and destination in the same country — see `isDomesticTrip`) never carries a
  // visa or international-travel-insurance assumption; only a genuinely cross-border trip does. An
  // unrecognized origin/destination is never assumed domestic (see `isDomesticTrip`'s own doc comment),
  // so this never silently under-estimates a real international trip.
  const domestic = isDomesticTrip(entities.originCity, entities.destinationCity);
  const visaLow = domestic ? 0 : farePayers * 40;
  const visaHigh = domestic ? 0 : farePayers * 80;

  const insuranceLow = domestic ? 0 : farePayers * 20;
  const insuranceHigh = domestic ? 0 : farePayers * 40;

  const subtotalLow = flightsLow + hotelLow + foodLow + localTransportLow + activitiesLow + visaLow + insuranceLow;
  const subtotalHigh = flightsHigh + hotelHigh + foodHigh + localTransportHigh + activitiesHigh + visaHigh + insuranceHigh;
  const contingencyLow = Math.round(subtotalLow * 0.05);
  const contingencyHigh = Math.round(subtotalHigh * 0.08);

  const breakdown: BudgetEstimateLine[] = [
    {
      label: "Flights",
      low: flightsLow,
      high: flightsHigh,
      perTraveller: { low: flightsLow / farePayers, high: flightsHigh / farePayers }
    },
    {
      label: "Hotel",
      low: hotelLow,
      high: hotelHigh,
      perNight: { low: hotelPerNightLow, high: hotelPerNightHigh },
      perRoom: { low: hotelPerRoomLow, high: hotelPerRoomHigh }
    },
    { label: "Food", low: foodLow, high: foodHigh },
    { label: "Local transport", low: localTransportLow, high: localTransportHigh },
    { label: "Activities", low: activitiesLow, high: activitiesHigh },
    ...(domestic
      ? []
      : [
          {
            label: "Visa",
            low: visaLow,
            high: visaHigh,
            perTraveller: { low: visaLow / farePayers, high: visaHigh / farePayers }
          },
          {
            label: "Insurance",
            low: insuranceLow,
            high: insuranceHigh,
            perTraveller: { low: insuranceLow / farePayers, high: insuranceHigh / farePayers }
          }
        ]),
    { label: "Contingency", low: contingencyLow, high: contingencyHigh }
  ];
  return {
    currency: PRICING_SOURCE_CURRENCY,
    sourceCurrency: PRICING_SOURCE_CURRENCY,
    low: breakdown.reduce((sum, line) => sum + line.low, 0),
    high: breakdown.reduce((sum, line) => sum + line.high, 0),
    breakdown
  };
}

/**
 * Deterministic budget-range estimator, in the traveler's display currency. Computes the estimate in the
 * pricing engine's native {@link PRICING_SOURCE_CURRENCY} and converts it exactly once to `displayCurrency`
 * (defaulting to the trip's budget currency, then the config default). This is the fix for the "USD amounts
 * shown as INR" implausibility defect: amounts are always genuinely converted, never relabeled.
 */
export function estimateBudgetRange(
  entities: TravelEntities,
  config: TravelEmployeeRuntimeConfig,
  displayCurrency?: string
): BudgetEstimate {
  const usd = computeBudgetEstimateUsd(entities, config);
  const target = displayCurrency ?? entities.budgetCurrency ?? config.defaultCurrency;
  return convertBudgetEstimate(usd, target);
}

/**
 * Generic, route-agnostic plausibility sanity checks for a computed estimate — never route-specific price
 * thresholds. A failure here is a signal to qualify the estimate to the traveler rather than present a
 * confidently misleading number; it never silently alters the figures. Checks: all amounts finite and
 * non-negative, min <= max on every line and the total, the total equals the sum of its lines (conversion
 * applied consistently, exactly once), and an explicit, supported source/display currency.
 */
export function validateBudgetEstimatePlausibility(estimate: BudgetEstimate): string[] {
  const issues: string[] = [];
  const finitePositive = (value: number): boolean => Number.isFinite(value) && value >= 0;
  if (!finitePositive(estimate.low) || !finitePositive(estimate.high)) issues.push("TOTAL_NOT_FINITE_POSITIVE");
  if (estimate.low > estimate.high) issues.push("TOTAL_MIN_EXCEEDS_MAX");
  for (const line of estimate.breakdown) {
    if (!finitePositive(line.low) || !finitePositive(line.high)) issues.push(`LINE_NOT_FINITE_POSITIVE:${line.label}`);
    if (line.low > line.high) issues.push(`LINE_MIN_EXCEEDS_MAX:${line.label}`);
  }
  if (reconcileBudgetEstimate(estimate).length > 0) issues.push("TOTAL_NOT_SUM_OF_LINES");
  if (!isSupportedCurrency(estimate.currency)) issues.push("DISPLAY_CURRENCY_UNSUPPORTED");
  if (estimate.sourceCurrency && !isSupportedCurrency(estimate.sourceCurrency)) issues.push("SOURCE_CURRENCY_UNSUPPORTED");
  return issues;
}

/** A single reconciliation mismatch — see {@link reconcileBudgetEstimate}/{@link reconcileJourneyBudgetEstimate}. */
export interface BudgetReconciliationViolation {
  scope: "SINGLE_ESTIMATE" | "JOURNEY_CATEGORY" | "JOURNEY_TOTAL";
  label?: string;
  expectedLow: number;
  actualLow: number;
  expectedHigh: number;
  actualHigh: number;
}

/** Invariant: a `BudgetEstimate`'s top-level low/high must equal the sum of its own breakdown lines. */
export function reconcileBudgetEstimate(estimate: BudgetEstimate): BudgetReconciliationViolation[] {
  const expectedLow = estimate.breakdown.reduce((sum, line) => sum + line.low, 0);
  const expectedHigh = estimate.breakdown.reduce((sum, line) => sum + line.high, 0);
  if (expectedLow === estimate.low && expectedHigh === estimate.high) return [];
  return [{ scope: "SINGLE_ESTIMATE", expectedLow, actualLow: estimate.low, expectedHigh, actualHigh: estimate.high }];
}

function formatAmount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

// ---- Multi-leg journey budget aggregation ----

/**
 * Per-leg budget estimate used only for journey aggregation — deliberately NOT `estimateBudgetRange` reused
 * as-is, because that function defaults an entirely-unknown duration to 5 days (the right assumption for a
 * single, still-being-planned trip, but wrong for a leg that has no stay at all, e.g. a same-day connecting
 * or return leg): here, a leg with no known days/nights gets ZERO hotel/food/local-transport/activities
 * cost, while flights are still costed (a sector still needs to be flown regardless of whether anyone stays
 * overnight there). Has no "Contingency" line — that is computed once, after aggregation, at the journey
 * level (see `estimateJourneyBudgetRange`), never summed per leg.
 */
function estimateJourneyLegBudget(
  leg: JourneyLeg,
  travellerProfile: JourneyTravellerProfile,
  config: TravelEmployeeRuntimeConfig
): BudgetEstimate {
  const farePayers =
    leg.passengers.adults !== null
      ? leg.passengers.adults + (leg.passengers.children ?? 0)
      : (leg.passengers.totalTravellers ?? 1);
  void config;
  const hasStay = leg.duration.days !== null || leg.duration.nights !== null;
  const days = leg.duration.days ?? leg.duration.nights ?? 0;
  const nights = leg.duration.nights ?? (hasStay ? Math.max(days - 1, 1) : 0);
  const destination = leg.destination ?? "your destination";

  const { flightOptions } = generatePlaceholderFlights({
    destination,
    travelMonth: leg.dates.travelMonth,
    passengers: farePayers
  });
  const flightPrices = flightOptions.map((flight) => flight.price);
  const flightsLow = Math.min(...flightPrices);
  const flightsHigh = Math.max(...flightPrices);

  let hotelLow = 0;
  let hotelHigh = 0;
  let hotelPerNightLow = 0;
  let hotelPerNightHigh = 0;
  let hotelPerRoomLow = 0;
  let hotelPerRoomHigh = 0;
  let foodLow = 0;
  let foodHigh = 0;
  let localTransportLow = 0;
  let localTransportHigh = 0;
  let activitiesLow = 0;
  let activitiesHigh = 0;
  if (hasStay) {
    const rooms = Math.max(1, Math.ceil((leg.passengers.adults ?? farePayers) / 2));
    const { hotelOptions } = generatePlaceholderHotels({
      destination,
      travelMonth: leg.dates.travelMonth,
      hotelStars: travellerProfile.hotelStars
    });
    const hotelPrices = hotelOptions.map((hotel) => hotel.pricePerNight);
    hotelPerNightLow = Math.min(...hotelPrices);
    hotelPerNightHigh = Math.max(...hotelPrices);
    hotelPerRoomLow = hotelPerNightLow * nights;
    hotelPerRoomHigh = hotelPerNightHigh * nights;
    hotelLow = hotelPerRoomLow * rooms;
    hotelHigh = hotelPerRoomHigh * rooms;
    foodLow = farePayers * days * 25;
    foodHigh = farePayers * days * 40;
    localTransportLow = farePayers * days * 10;
    localTransportHigh = farePayers * days * 18;
    activitiesLow = farePayers * days * 15;
    activitiesHigh = farePayers * days * 30;
  }

  // Same domestic/international gate as `estimateBudgetRange` — a leg entirely within one country never
  // carries a visa or international-insurance assumption.
  const legDomestic = isDomesticTrip(leg.origin, leg.destination);
  const visaLow = legDomestic ? 0 : farePayers * 40;
  const visaHigh = legDomestic ? 0 : farePayers * 80;
  const insuranceLow = legDomestic ? 0 : farePayers * 20;
  const insuranceHigh = legDomestic ? 0 : farePayers * 40;

  const breakdown: BudgetEstimateLine[] = [
    {
      label: "Flights",
      low: flightsLow,
      high: flightsHigh,
      perTraveller: { low: flightsLow / farePayers, high: flightsHigh / farePayers }
    },
    {
      label: "Hotel",
      low: hotelLow,
      high: hotelHigh,
      perNight: { low: hotelPerNightLow, high: hotelPerNightHigh },
      perRoom: { low: hotelPerRoomLow, high: hotelPerRoomHigh }
    },
    { label: "Food", low: foodLow, high: foodHigh },
    { label: "Local transport", low: localTransportLow, high: localTransportHigh },
    { label: "Activities", low: activitiesLow, high: activitiesHigh },
    ...(legDomestic
      ? []
      : [
          {
            label: "Visa",
            low: visaLow,
            high: visaHigh,
            perTraveller: { low: visaLow / farePayers, high: visaHigh / farePayers }
          },
          {
            label: "Insurance",
            low: insuranceLow,
            high: insuranceHigh,
            perTraveller: { low: insuranceLow / farePayers, high: insuranceHigh / farePayers }
          }
        ])
  ];
  return {
    currency: PRICING_SOURCE_CURRENCY,
    sourceCurrency: PRICING_SOURCE_CURRENCY,
    low: breakdown.reduce((sum, line) => sum + line.low, 0),
    high: breakdown.reduce((sum, line) => sum + line.high, 0),
    breakdown
  };
}

export interface JourneyLegBudgetEntry {
  origin: string | null;
  destination: string | null;
  estimate: BudgetEstimate;
}

export interface JourneyBudgetEstimate {
  currency: string;
  perLeg: JourneyLegBudgetEntry[];
  combined: BudgetEstimate;
}

/**
 * Aggregates a per-leg estimate into one journey-level total, per the required aggregation rules:
 * - Flights, Hotel, Food, Local transport, Activities: summed across every leg (each leg's own stay
 *   duration and destination already drive its own numbers — see `estimateJourneyLegBudget`).
 * - Visa: charged once per unique destination, EXCLUDING the traveler's home/origin city (no visa needed
 *   to return home) — never double-counted when the same destination appears in more than one leg.
 * - Insurance: journey-level, computed once — the underlying pricing model has no per-leg differentiation
 *   for insurance (it only ever depends on headcount, not destination or duration), so summing it per leg
 *   would just be the same number repeated, not a genuine per-leg cost.
 * - Contingency: computed from the aggregated subtotal, never summed from per-leg contingency figures.
 */
export function estimateJourneyBudgetRange(
  legs: readonly JourneyLeg[],
  travellerProfile: JourneyTravellerProfile,
  config: TravelEmployeeRuntimeConfig
): JourneyBudgetEstimate {
  const currency = legs.find((leg) => leg.budget.currency)?.budget.currency ?? config.defaultCurrency;
  // Every per-leg estimate is computed canonically in the pricing source currency; the combined total and
  // each per-leg entry are converted to the traveler's display currency exactly once, at the end.
  const perLegUsd: JourneyLegBudgetEntry[] = legs.map((leg) => ({
    origin: leg.origin,
    destination: leg.destination,
    estimate: estimateJourneyLegBudget(leg, travellerProfile, config)
  }));
  const perLeg = perLegUsd;

  const sumCategory = (label: string): { low: number; high: number } =>
    perLeg.reduce(
      (total, entry) => {
        const line = entry.estimate.breakdown.find((candidate) => candidate.label === label);
        return { low: total.low + (line?.low ?? 0), high: total.high + (line?.high ?? 0) };
      },
      { low: 0, high: 0 }
    );

  const flights = sumCategory("Flights");
  const hotel = sumCategory("Hotel");
  const food = sumCategory("Food");
  const localTransport = sumCategory("Local transport");
  const activities = sumCategory("Activities");

  const homeCity = travellerProfile.originCity?.trim().toLowerCase() ?? null;
  const seenVisaDestinations = new Set<string>();
  let visaLow = 0;
  let visaHigh = 0;
  for (const leg of legs) {
    const destinationKey = leg.destination?.trim().toLowerCase() ?? null;
    if (!destinationKey || destinationKey === homeCity || seenVisaDestinations.has(destinationKey)) continue;
    seenVisaDestinations.add(destinationKey);
    const line = perLeg
      .find((entry) => entry.destination?.trim().toLowerCase() === destinationKey)
      ?.estimate.breakdown.find((candidate) => candidate.label === "Visa");
    visaLow += line?.low ?? 0;
    visaHigh += line?.high ?? 0;
  }

  // Insurance depends only on headcount in this pricing model (never destination/duration), so every leg's
  // figure is identical when the same travel party continues throughout — reusing the first leg's line
  // AS-IS (never stripped down) is exactly "journey-level, computed once", not an arbitrary pick, and keeps
  // its `perTraveller` breakdown intact for the combined total too.
  const insuranceLine: BudgetEstimateLine = perLeg[0]?.estimate.breakdown.find(
    (candidate) => candidate.label === "Insurance"
  ) ?? { label: "Insurance", low: 0, high: 0 };
  const journeyFarePayers =
    legs[0]?.passengers.adults !== null && legs[0] !== undefined
      ? (legs[0].passengers.adults ?? 0) + (legs[0].passengers.children ?? 0)
      : (legs[0]?.passengers.totalTravellers ?? 1);

  const subtotalLow = flights.low + hotel.low + food.low + localTransport.low + activities.low + visaLow + insuranceLine.low;
  const subtotalHigh =
    flights.high + hotel.high + food.high + localTransport.high + activities.high + visaHigh + insuranceLine.high;
  const contingencyLow = Math.round(subtotalLow * 0.05);
  const contingencyHigh = Math.round(subtotalHigh * 0.08);

  const breakdown: BudgetEstimateLine[] = [
    {
      label: "Flights",
      low: flights.low,
      high: flights.high,
      perTraveller: { low: flights.low / journeyFarePayers, high: flights.high / journeyFarePayers }
    },
    { label: "Hotel", low: hotel.low, high: hotel.high },
    { label: "Food", low: food.low, high: food.high },
    { label: "Local transport", low: localTransport.low, high: localTransport.high },
    { label: "Activities", low: activities.low, high: activities.high },
    {
      label: "Visa",
      low: visaLow,
      high: visaHigh,
      perTraveller: { low: visaLow / journeyFarePayers, high: visaHigh / journeyFarePayers }
    },
    insuranceLine,
    { label: "Contingency", low: contingencyLow, high: contingencyHigh }
  ];
  const combinedUsd: BudgetEstimate = {
    currency: PRICING_SOURCE_CURRENCY,
    sourceCurrency: PRICING_SOURCE_CURRENCY,
    low: breakdown.reduce((sum, line) => sum + line.low, 0),
    high: breakdown.reduce((sum, line) => sum + line.high, 0),
    breakdown
  };
  const combined = convertBudgetEstimate(combinedUsd, currency);
  const convertedPerLeg: JourneyLegBudgetEntry[] = perLeg.map((entry) => ({
    ...entry,
    estimate: convertBudgetEstimate(entry.estimate, currency)
  }));
  return { currency, perLeg: convertedPerLeg, combined };
}

/**
 * Invariant: the journey's combined total reconciles internally (see `reconcileBudgetEstimate`), every
 * per-leg estimate reconciles internally, AND the summed categories (Flights/Hotel/Food/Local
 * transport/Activities) match the combined total's own line for that category exactly — Visa/Insurance/
 * Contingency are deliberately excluded from this per-category check, since dedup/once/after-aggregation
 * rules apply to them instead of a plain sum (see `estimateJourneyBudgetRange`'s own doc comment).
 */
export function reconcileJourneyBudgetEstimate(journeyEstimate: JourneyBudgetEstimate): BudgetReconciliationViolation[] {
  const violations: BudgetReconciliationViolation[] = [
    ...reconcileBudgetEstimate(journeyEstimate.combined),
    ...journeyEstimate.perLeg.flatMap((entry) => reconcileBudgetEstimate(entry.estimate))
  ];
  const summedCategories = ["Flights", "Hotel", "Food", "Local transport", "Activities"];
  for (const label of summedCategories) {
    const combinedLine = journeyEstimate.combined.breakdown.find((line) => line.label === label);
    const expectedLow = journeyEstimate.perLeg.reduce(
      (sum, entry) => sum + (entry.estimate.breakdown.find((line) => line.label === label)?.low ?? 0),
      0
    );
    const expectedHigh = journeyEstimate.perLeg.reduce(
      (sum, entry) => sum + (entry.estimate.breakdown.find((line) => line.label === label)?.high ?? 0),
      0
    );
    if (combinedLine && (combinedLine.low !== expectedLow || combinedLine.high !== expectedHigh)) {
      violations.push({ scope: "JOURNEY_CATEGORY", label, expectedLow, actualLow: combinedLine.low, expectedHigh, actualHigh: combinedLine.high });
    }
  }
  return violations;
}

/**
 * Journey summary + each leg + its own per-leg estimate + the combined total + assumptions and the required
 * indicative/live disclaimer — per the response-format requirement. Never a fabricated live price: every
 * number here traces back to the same aggregate estimator used throughout the rest of this engine.
 */
export function buildJourneyBudgetMessage(
  legs: readonly JourneyLeg[],
  journeyEstimate: JourneyBudgetEstimate,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const header = language === "HINGLISH" ? "Journey summary:" : language === "HINDI" ? "यात्रा सारांश:" : "Journey summary:";
  const legLines = legs.map((leg, index) => {
    const perLegEstimate = journeyEstimate.perLeg[index]?.estimate;
    const range = perLegEstimate
      ? `${journeyEstimate.currency} ${formatAmount(perLegEstimate.low)}–${formatAmount(perLegEstimate.high)}`
      : "—";
    // Shows exactly what was stated for this leg (days, nights, or both) — never silently relabeling one
    // as the other; a leg with neither is an honest "no stay (connecting)", not a fabricated night count.
    const stay =
      leg.destinationRole === "FINAL_RETURN"
        ? language === "HINGLISH"
          ? "return flight"
          : "return flight"
        : buildDurationPhrase(leg.duration, language) ??
          (language === "HINGLISH" ? "koi stay nahi (connecting)" : "no stay (connecting)");
    return `  Leg ${leg.sequence}: ${leg.origin ?? "?"} -> ${leg.destination ?? "?"} — ${stay} — est. ${range}`;
  });
  const durationAssumptions = legs
    .map((leg) => buildDurationAssumptionNote(leg.duration, language))
    .filter((note): note is string => Boolean(note));
  const travellerFactorNote = buildTravellerCostFactorNote(
    describeTravellerCostBreakdown(legs[0]?.passengers ?? { adults: null, children: null, infants: null, totalTravellers: null }),
    language
  );
  const combinedLines = journeyEstimate.combined.breakdown.map(
    (line) => `  • ${line.label}: ${journeyEstimate.currency} ${formatAmount(line.low)}–${formatAmount(line.high)}`
  );
  const total =
    language === "HINGLISH"
      ? `Total (combined): ${journeyEstimate.currency} ${formatAmount(journeyEstimate.combined.low)}–${formatAmount(journeyEstimate.combined.high)}`
      : language === "HINDI"
        ? `कुल (संयुक्त): ${journeyEstimate.currency} ${formatAmount(journeyEstimate.combined.low)}–${formatAmount(journeyEstimate.combined.high)}`
        : `Total (combined): ${journeyEstimate.currency} ${formatAmount(journeyEstimate.combined.low)}–${formatAmount(journeyEstimate.combined.high)}`;
  const assumptions =
    language === "HINGLISH"
      ? "Assumptions: economy class, standard hotel occupancy, known dates/duration per leg."
      : language === "HINDI"
        ? "मान्यताएं: इकॉनमी क्लास, मानक होटल अधिभोग, प्रत्येक चरण के लिए ज्ञात तिथियां/अवधि।"
        : "Assumptions: economy class, standard hotel occupancy, known dates/duration per leg.";
  return [
    header,
    ...legLines,
    "",
    language === "HINGLISH" ? "Combined budget (category-wise):" : "Combined budget (category-wise):",
    ...combinedLines,
    total,
    "",
    assumptions,
    ...durationAssumptions,
    ...(travellerFactorNote ? [travellerFactorNote] : []),
    INDICATIVE_DISCLAIMER[language]
  ].join("\n");
}

/** One leg's flight/hotel options within a {@link buildJourneyRecommendationMessage}. */
export interface JourneyLegRecommendation {
  leg: JourneyLeg;
  flights: readonly FlightOption[];
  hotels: readonly HotelOption[];
}

/**
 * Search/recommendation across EVERY leg of a journey, never just the currently active one — a live
 * single-leg tool call (or a single-leg placeholder) can only ever answer for one leg, which is exactly the
 * reported bug: a bare "ji" confirming a multi-city journey returned only the LAST leg's hotels. Reuses the
 * same combined-budget total as {@link buildJourneyBudgetMessage} so the two never disagree on numbers.
 */
export function buildJourneyRecommendationMessage(
  perLeg: readonly JourneyLegRecommendation[],
  journeyEstimate: JourneyBudgetEstimate,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const header =
    language === "HINGLISH"
      ? "Aapki poori journey ke liye options:"
      : language === "HINDI"
        ? "आपकी पूरी यात्रा के विकल्प:"
        : "Options across your full journey:";
  const legBlocks = perLeg.map(({ leg, flights, hotels }) => {
    const flightLines = flights
      .map(
        (flight, index) =>
          `    ${index + 1}. ${flight.airline} — ~${flight.currency} ${flight.price} (${flight.stops === 0 ? "non-stop" : `${flight.stops} stop(s)`}, ~${flight.durationHours}h)`
      )
      .join("\n");
    const hotelLines = hotels
      .map(
        (hotel, index) =>
          `    ${index + 1}. ${hotel.name} — ~${hotel.currency} ${hotel.pricePerNight}/night (rated ${hotel.rating.toFixed(1)}/5)`
      )
      .join("\n");
    return [
      `  Leg ${leg.sequence}: ${leg.origin ?? "?"} -> ${leg.destination ?? "?"}`,
      "    Flights:",
      flightLines,
      "    Hotels:",
      hotelLines
    ].join("\n");
  });
  const total = `Total (combined): ${journeyEstimate.currency} ${formatAmount(journeyEstimate.combined.low)}–${formatAmount(journeyEstimate.combined.high)}`;
  const closing =
    language === "HINGLISH"
      ? "Batayiye agar ye theek hai, ya kisi leg mein kuch adjust karna hai."
      : language === "HINDI"
        ? "बताइए अगर यह ठीक है, या किसी चरण में कुछ बदलना है।"
        : "Let me know if this works, or if you'd like any leg adjusted.";
  return [
    header,
    "",
    ...legBlocks,
    "",
    total,
    "",
    "This is placeholder planning data — no booking has been made, and prices or availability are not live and should be verified.",
    "",
    closing
  ].join("\n");
}

/** One leg's date within a {@link JourneyDateProjection} — see `projectJourneyReturnDate`. */
export interface JourneyLegDateProjection {
  origin: string | null;
  destination: string | null;
  departureDate: string | null;
  isAssumption: boolean;
}

/**
 * The traveler's projected final-leg arrival date, built from structured journey state alone. `confidence`
 * distinguishes a date the traveler stated outright from one this runtime computed via day-math from stay
 * durations — never fabricates an exact time, and is always accompanied by the assumptions that produced
 * it (departure day counts as day one, no live flight-schedule/timezone data is available here).
 */
export interface JourneyDateProjection {
  legDates: JourneyLegDateProjection[];
  finalArrivalDate: string | null;
  finalArrivalDateRange: { earliest: string; latest: string } | null;
  confidence: "EXACT_FROM_USER" | "DERIVED" | "INDICATIVE";
  assumptions: string[];
}

/**
 * Projects the journey's final-leg arrival date from its legs' own (possibly already-derived) departure
 * dates — the last leg IS the "back home" leg, so its departure date doubles as the arrival-date basis
 * (flight duration/timezone crossing isn't modeled here, hence the assumptions list). Never guesses when
 * the final leg's own date isn't known at all — `finalArrivalDate` stays null rather than fabricating one.
 */
export function projectJourneyReturnDate(
  legs: readonly { origin: string | null; destination: string | null; dates: JourneyLegDates }[]
): JourneyDateProjection {
  const assumptions: string[] = [
    "The departure day counts as day one of each leg's stay.",
    "Dates don't account for exact flight times, overnight/red-eye departures, or timezone-crossing date shifts.",
    "Live flight schedules aren't available here, so the actual arrival date could land a day earlier or later."
  ];
  const legDates: JourneyLegDateProjection[] = legs.map((leg) => ({
    origin: leg.origin,
    destination: leg.destination,
    departureDate: leg.dates.departureDate,
    isAssumption: leg.dates.departureDateIsAssumption
  }));
  const lastLeg = legDates[legDates.length - 1] ?? null;
  if (!lastLeg || lastLeg.departureDate === null) {
    return {
      legDates,
      finalArrivalDate: null,
      finalArrivalDateRange: null,
      confidence: "INDICATIVE",
      assumptions: [
        ...assumptions,
        "The final leg's own date isn't confirmed yet, so no arrival date could be projected — share it and I'll calculate this."
      ]
    };
  }
  const anyAssumption = legDates.some((leg) => leg.isAssumption);
  return {
    legDates,
    finalArrivalDate: lastLeg.departureDate,
    finalArrivalDateRange: null,
    confidence: anyAssumption ? "DERIVED" : "EXACT_FROM_USER",
    assumptions
  };
}

/** Renders a {@link JourneyDateProjection} as a customer-facing message — never claims false precision. */
export function buildReturnDateProjectionMessage(
  projection: JourneyDateProjection,
  homeCity: string | null,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const home = homeCity ?? (language === "ENGLISH" ? "home" : "ghar");
  if (!projection.finalArrivalDate) {
    if (language === "HINGLISH")
      return `Abhi final leg ki date confirm nahi hai, isliye ${home} wapas aane ki exact date nahi bata sakta — date milte hi calculate kar dunga.`;
    if (language === "HINDI")
      return `अभी अंतिम चरण की तारीख निश्चित नहीं है, इसलिए ${home} वापसी की सटीक तिथि नहीं बता सकता — तारीख मिलते ही गणना कर दूँगा।`;
    return `I can't pin down an exact date for arriving back in ${home} yet since the final leg's own date isn't confirmed — share that and I'll calculate it.`;
  }
  const qualifier =
    projection.confidence === "EXACT_FROM_USER"
      ? language === "HINGLISH"
        ? "(aapki di gayi date ke hisaab se)"
        : "(based on the date you gave)"
      : language === "HINGLISH"
        ? "(estimated — pichle legs ke stay ke hisaab se; live flight schedule ke hisaab se badal sakta hai)"
        : "(estimated from your stated stay lengths — the exact date depends on live flight schedules)";
  if (language === "HINGLISH") return `Aap lagbhag ${projection.finalArrivalDate} ko ${home} land karenge ${qualifier}.`;
  if (language === "HINDI") return `आप लगभग ${projection.finalArrivalDate} को ${home} पहुँचेंगे ${qualifier}।`;
  return `You'd land back in ${home} around ${projection.finalArrivalDate} ${qualifier}.`;
}

// ---- Provider-independent indicative recommendations & the complete trip plan ----
// Deliberately never sourced from generatePlaceholderFlights/generatePlaceholderHotels, which invent a
// specific airline name, hotel name, and per-night price for the LIVE-search-success path — an indicative
// recommendation (shown when there is no live result to show) must never resemble a live quote. Only the
// aggregate, already-hedged category-wise BudgetEstimate range and qualitative route/area knowledge are used.
const DESTINATION_AIRPORT_HINTS: Record<string, string> = {
  dubai: "Dubai International Airport (DXB)",
  paris: "Paris Charles de Gaulle (CDG) or Orly (ORY)",
  london: "London Heathrow (LHR) or Gatwick (LGW)",
  "new york": "John F. Kennedy (JFK), Newark (EWR), or LaGuardia (LGA)",
  tokyo: "Tokyo Narita (NRT) or Haneda (HND)",
  singapore: "Singapore Changi (SIN)",
  bali: "Ngurah Rai International, Denpasar (DPS)",
  goa: "Goa's Dabolim (GOI) or Manohar International (GOX)",
  bangkok: "Bangkok Suvarnabhumi (BKK) or Don Mueang (DMK)",
  istanbul: "Istanbul Airport (IST)",
  maldives: "Velana International Airport (MLE)"
};
/** Destination-specific area alias resolution — maps user-friendly area names to canonical
 *  recommendation labels per destination. Used by {@link extractHotelArea} to determine whether
 *  the traveler explicitly asked about a specific area (e.g. "near Marina" → "Dubai Marina"). */
const HOTEL_AREA_ALIASES: Record<string, Record<string, string>> = {
  dubai: {
    marina: "Dubai Marina",
    "dubai marina": "Dubai Marina",
    jbr: "Jumeirah Beach Residence (JBR)",
    "jumeirah beach residence": "Jumeirah Beach Residence (JBR)",
    downtown: "Downtown Dubai",
    "downtown dubai": "Downtown Dubai",
    "business bay": "Business Bay",
    deira: "Deira",
    palm: "Palm Jumeirah",
    "palm jumeirah": "Palm Jumeirah",
    jumeirah: "Jumeirah"
  }
};

/**
 * Extracts an explicitly requested hotel area from the user's message, resolved against the trip's
 * destination city. Returns the canonical area label when a known alias is found, or null when no
 * area was requested (the caller falls back to generic destination-wide guidance).
 */
export function extractHotelArea(text: string, destinationCity: string | null): string | null {
  if (!destinationCity || !text) return null;
  const destKey = destinationCity.trim().toLowerCase();
  const aliases = HOTEL_AREA_ALIASES[destKey];
  if (!aliases) return null;
  const areaPattern = /\b(?:near|in|around|at)\s+(\w+(?:\s+\w+){0,2}?)(?:\s*[.,;!?]|\s+(?:and|or|please)|\s*$)/i;
  const match = areaPattern.exec(text);
  if (!match) return null;
  const captured = match[1];
  if (!captured) return null;
  const raw = captured.trim().toLowerCase();
  return aliases[raw] ?? null;
}

const DESTINATION_HOTEL_AREA_HINTS: Record<string, string> = {
  dubai: "Downtown Dubai/Business Bay for central attractions, or Deira for a more local, budget-friendly base",
  paris: "Le Marais or near the Champs-Élysées for central access, or the outer arrondissements for better value",
  london: "South Kensington or Covent Garden for central access, or Zone 2/3 for better value",
  "new york": "Midtown Manhattan for central access, or Brooklyn/Queens for better value with an easy commute",
  tokyo: "Shinjuku or Shibuya for central access and strong transit links",
  singapore: "Orchard Road or Marina Bay for central access",
  bali: "Seminyak/Kuta for nightlife and beaches, or Ubud for a quieter, cultural base",
  goa: "North Goa (Calangute/Baga) for nightlife, or South Goa for quieter beaches",
  bangkok: "Sukhumvit or Silom for central access and BTS Skytrain links",
  istanbul: "Sultanahmet for historic sights, or Beyoğlu/Taksim for nightlife and transit links",
  maldives: "resort islands are typically booked as a package with transfers included from Malé"
};
const DESTINATION_TRANSPORT_HINTS: Record<string, string> = {
  dubai: "the Dubai Metro and ride-hailing apps (Careem/Uber) cover most tourist areas well",
  paris: "the Metro and RER cover the city extensively; a multi-day transit pass is usually worthwhile",
  london: "the Tube and buses cover the city well; an Oyster/contactless card is the easiest way to pay",
  "new york": "the subway runs 24/7 and is the fastest way around; a weekly MetroCard/OMNY cap is usually worthwhile",
  tokyo: "the JR and metro lines cover the city extensively; a rechargeable IC card (Suica/Pasmo) is convenient",
  singapore: "the MRT covers the island well and is the easiest way to get around",
  bali: "ride-hailing apps (Gojek/Grab) and scooter rentals are the most common ways to get around",
  goa: "scooter/bike rentals are common; taxis and ride-hailing are also available in the main towns",
  bangkok: "the BTS Skytrain, MRT, and ride-hailing apps (Grab) cover the city well",
  istanbul: "trams, ferries, and the metro cover the city well; an Istanbulkart covers all of them",
  maldives: "inter-island transfers are by speedboat or seaplane, usually arranged with your resort"
};

function destinationHint(map: Record<string, string>, destination: string | null): string | null {
  if (!destination) return null;
  return map[destination.trim().toLowerCase()] ?? null;
}

const INDICATIVE_DISCLAIMER: Record<TravelResponseLanguage, string> = {
  ENGLISH: "These are indicative recommendations, not live availability.",
  HINGLISH: "Ye indicative recommendations hain, live availability nahi.",
  HINDI: "ये संकेतात्मक सुझाव हैं, लाइव उपलब्धता नहीं।"
};

/** Qualitative, never-invented route/airport guidance — no specific airline, flight number, or live price. */
export function buildAirportRouteGuidance(
  originCity: string | null,
  destinationCity: string | null,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const destination = destinationCity ?? "your destination";
  const airport = destinationHint(DESTINATION_AIRPORT_HINTS, destinationCity) ?? `${destination}'s main international airport`;
  if (language === "HINGLISH")
    return originCity
      ? `${originCity} se ${destination} ke liye aam taur par ${airport} par land karte hain — direct ya one-stop dono routes mil sakte hain; exact carrier live search se confirm hoga.`
      : `${destination} ke liye aam taur par ${airport} par land karte hain; exact carrier live search se confirm hoga.`;
  if (language === "HINDI")
    return originCity
      ? `${originCity} से ${destination} के लिए आमतौर पर ${airport} पर उतरा जाता है — डायरेक्ट या एक-स्टॉप दोनों मार्ग मिल सकते हैं; सटीक एयरलाइन लाइव सर्च से पता चलेगी।`
      : `${destination} के लिए आमतौर पर ${airport} पर उतरा जाता है; सटीक एयरलाइन लाइव सर्च से पता चलेगी।`;
  return originCity
    ? `From ${originCity}, flights to ${destination} typically land at ${airport} — both direct and one-stop routings are common on this route; the exact carrier and schedule will show once a live search runs.`
    : `Flights to ${destination} typically land at ${airport}; the exact carrier and schedule will show once a live search runs.`;
}

/** Indicative flight guidance: the budget estimate's flight range, never a specific invented fare/airline. */
export function buildIndicativeFlightGuidance(
  entities: TravelEntities,
  estimate: BudgetEstimate,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const flightsLine = estimate.breakdown.find((line) => line.label === "Flights");
  // Flights are always priced per farepayer (see computeBudgetEstimateUsd) — this message says "per
  // traveler", so it must show the PER_TRAVELLER-scoped figure, never `flightsLine.low/high` (the
  // TOTAL_PARTY amount all farePayers pay combined) mislabeled as a per-head number.
  const perTravellerAmount = flightsLine?.perTraveller ?? flightsLine ?? null;
  const range = perTravellerAmount
    ? formatScopedAmount(perTravellerAmount, estimate.currency, "PER_TRAVELLER", language)
    : null;
  const cabin = entities.cabinClass ? ` (${entities.cabinClass} cabin)` : "";
  if (language === "HINGLISH")
    return range
      ? `Flights${cabin} ka indicative range: ${range}, route aur season ke hisaab se.`
      : `Flights${cabin} ka fare route aur season ke hisaab se alag hoga — exact price live search se milegi.`;
  if (language === "HINDI")
    return range
      ? `फ्लाइट्स${cabin} की संकेतात्मक सीमा: ${range}, मार्ग और मौसम के अनुसार।`
      : `फ्लाइट्स${cabin} का किराया मार्ग और मौसम के अनुसार अलग होगा — सटीक कीमत लाइव सर्च से मिलेगी।`;
  return range
    ? `Indicative flight range${cabin}: ${range}, depending on route and season.`
    : `Flight fares${cabin} vary by route and season — the exact price will come from a live search.`;
}

/** Indicative hotel guidance: the budget estimate's hotel range, never a specific invented property/price. */
export function buildIndicativeHotelGuidance(
  entities: TravelEntities,
  estimate: BudgetEstimate,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const hotelLine = estimate.breakdown.find((line) => line.label === "Hotel");
  const range = hotelLine ? `${estimate.currency} ${formatAmount(hotelLine.low)}–${formatAmount(hotelLine.high)}` : null;
  const starTier = entities.hotelStars ? ` (${entities.hotelStars}-star tier)` : "";
  if (language === "HINGLISH")
    return range
      ? `Hotels${starTier} ka indicative range: total ${range}, stay ki duration ke hisaab se.`
      : `Hotel${starTier} ka price stay ki duration aur category ke hisaab se hoga — exact rate live search se milegi.`;
  if (language === "HINDI")
    return range
      ? `होटल${starTier} की संकेतात्मक सीमा: कुल ${range}, ठहरने की अवधि के अनुसार।`
      : `होटल${starTier} की कीमत ठहरने की अवधि और श्रेणी पर निर्भर करेगी — सटीक दर लाइव सर्च से मिलेगी।`;
  return range
    ? `Indicative hotel range${starTier}: ${range} total, depending on length of stay.`
    : `Hotel rates${starTier} depend on length of stay and category — the exact rate will come from a live search.`;
}

export function buildHotelAreaGuidance(
  destinationCity: string | null,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const destination = destinationCity ?? "your destination";
  const hint = destinationHint(DESTINATION_HOTEL_AREA_HINTS, destinationCity);
  if (language === "HINGLISH")
    return hint
      ? `${destination} mein recommended areas: ${hint}.`
      : `${destination} mein, attractions ke paas ka area convenient hota hai; thoda bahar jaane se cost kam ho sakta hai.`;
  if (language === "HINDI")
    return hint
      ? `${destination} में अनुशंसित क्षेत्र: ${hint}।`
      : `${destination} में, मुख्य आकर्षणों के पास का क्षेत्र सुविधाजनक होता है; थोड़ा बाहर जाने से लागत कम हो सकती है।`;
  return hint
    ? `Recommended areas in ${destination}: ${hint}.`
    : `In ${destination}, staying near the main attractions is usually most convenient; a little further out tends to be better value.`;
}

/** Room-count and occupancy guidance derived from passenger composition — no invented specific inventory. */
export function buildRoomOccupancyGuidance(
  entities: TravelEntities,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const adults = entities.adults ?? entities.totalTravellers ?? 1;
  const rooms = Math.max(1, Math.ceil(adults / 2));
  const hasChildren = (entities.children ?? 0) > 0;
  const hasInfants = (entities.infants ?? 0) > 0;
  if (language === "HINGLISH") {
    const base = `${adults} adults ke liye, aam taur par ${rooms} room${rooms > 1 ? "s" : ""} chahiye honge (standard occupancy 2 adults/room).`;
    const childNote = hasChildren ? " Bachon ke liye extra bed ya connecting room maangi ja sakti hai." : "";
    const infantNote = hasInfants ? " Infants aksar bina extra charge ke parents ke room mein stay karte hain." : "";
    return `${base}${childNote}${infantNote}`;
  }
  if (language === "HINDI") {
    const base = `${adults} वयस्कों के लिए आमतौर पर ${rooms} कमरे चाहिए होंगे (मानक अधिभोग 2 वयस्क/कमरा)।`;
    const childNote = hasChildren ? " बच्चों के लिए अतिरिक्त बेड या कनेक्टिंग रूम माँगा जा सकता है।" : "";
    const infantNote = hasInfants ? " शिशु आमतौर पर बिना अतिरिक्त शुल्क के माता-पिता के कमरे में रहते हैं।" : "";
    return `${base}${childNote}${infantNote}`;
  }
  const base = `For ${adults} adult(s), you'd typically need ${rooms} room${rooms > 1 ? "s" : ""} at standard occupancy (2 adults/room).`;
  const childNote = hasChildren ? " An extra bed or a connecting room is usually available for children." : "";
  const infantNote = hasInfants ? " Infants commonly stay in the parents' room at no extra charge." : "";
  return `${base}${childNote}${infantNote}`;
}

export function buildLocalTransportGuidance(
  destinationCity: string | null,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const destination = destinationCity ?? "your destination";
  const hint = destinationHint(DESTINATION_TRANSPORT_HINTS, destinationCity);
  if (language === "HINGLISH")
    return hint ? `Getting around ${destination}: ${hint}.` : `${destination} mein taxis, ride-hailing aur public transport aam taur par available hote hain.`;
  if (language === "HINDI")
    return hint ? `${destination} में घूमने के लिए: ${hint}।` : `${destination} में टैक्सी, राइड-हेलिंग और सार्वजनिक परिवहन आमतौर पर उपलब्ध होते हैं।`;
  return hint
    ? `Getting around ${destination}: ${hint}.`
    : `Taxis, ride-hailing, and public transport are typically available in ${destination}.`;
}

/** Qualitative packing guidance, personalized by passenger composition — never a fabricated packing-list SKU. */
export function buildPackingGuidance(entities: TravelEntities, language: TravelResponseLanguage = "ENGLISH"): string {
  const hasChildren = (entities.children ?? 0) > 0;
  const hasInfants = (entities.infants ?? 0) > 0;
  const familyNote = hasInfants
    ? language === "HINGLISH"
      ? " Infant ke saath: diapers, feeds/snacks, aur ek familiar comfort item extra pack karein."
      : language === "HINDI"
        ? " शिशु के साथ: डायपर, फीड/स्नैक्स, और एक परिचित आराम की वस्तु अतिरिक्त पैक करें।"
        : " Traveling with an infant: pack extra diapers, feeds/snacks, and a familiar comfort item."
    : hasChildren
      ? language === "HINGLISH"
        ? " Bachon ke liye: snacks aur kuch entertainment (books/games) saath rakhein."
        : language === "HINDI"
          ? " बच्चों के लिए: स्नैक्स और कुछ मनोरंजन (किताबें/खेल) साथ रखें।"
          : " With children along: pack snacks and some entertainment (books/games) for the journey."
      : "";
  if (language === "HINGLISH")
    return `Packing: weather-appropriate clothes, universal adapter, basic medicines, aur documents ki photocopies saath rakhein.${familyNote}`;
  if (language === "HINDI")
    return `पैकिंग: मौसम के अनुसार कपड़े, यूनिवर्सल एडाप्टर, बेसिक दवाइयाँ, और दस्तावेज़ों की फोटोकॉपी साथ रखें।${familyNote}`;
  return `Packing: weather-appropriate clothing, a universal adapter, basic medicines, and photocopies of your documents.${familyNote}`;
}

/** Generic, honest practical tips — never destination-specific claims we can't verify (currency rates, safety advisories). */
export function buildTravelTips(language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH")
    return "Tips: local currency thodi cash mein rakhein, emergency contacts save kar lein, aur important documents ki digital copy bhi rakhein.";
  if (language === "HINDI")
    return "टिप्स: कुछ स्थानीय मुद्रा नकद में रखें, आपातकालीन संपर्क सेव कर लें, और महत्वपूर्ण दस्तावेज़ों की डिजिटल कॉपी भी रखें।";
  return "Tips: carry some local currency in cash, save emergency contacts, and keep a digital copy of your important documents.";
}

/** Generic, honest visa/insurance caveat — never destination- or nationality-specific, since that depends on the traveler's passport. */
export function buildVisaInsuranceCaveat(language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH")
    return "Visa requirement aapke passport aur destination par depend karta hai — booking se pehle relevant embassy/consulate se confirm kar lein. Travel insurance strongly recommended hai, especially bachon/infants ke saath.";
  if (language === "HINDI")
    return "वीज़ा आवश्यकता आपके पासपोर्ट और गंतव्य पर निर्भर करती है — बुकिंग से पहले संबंधित दूतावास/वाणिज्य दूतावास से पुष्टि कर लें। यात्रा बीमा अत्यधिक अनुशंसित है, विशेष रूप से बच्चों/शिशुओं के साथ।";
  return "Visa requirements depend on your passport and destination — please verify with the relevant embassy/consulate before booking. Travel insurance is strongly recommended, especially when traveling with children or infants.";
}

export function buildNextActionMessage(language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH")
    return "Next: reply 'confirm' plan ke saath aage badhne ke liye, live options dekhne ke liye kahiye, ya lead/callback request kar sakte hain.";
  if (language === "HINDI")
    return "अगला कदम: योजना के साथ आगे बढ़ने के लिए 'confirm' का जवाब दें, लाइव विकल्प देखने के लिए कहें, या लीड/कॉलबैक का अनुरोध करें।";
  return "Next: reply 'confirm' to proceed with this plan, ask for live options, or request a lead/callback.";
}

// Fix (Travel Booking Closure Pass — Phase 17/18): natural phrasing over a numbered menu. Every reply this
// used to expect — bare "1"/"2"/"3", "option 1", "first one"/"second one"/"third one"/"callback" — still
// works exactly as before (see RECOVERY_OPTION_1/2/3_PATTERN right below); this only changes how the
// choice is OFFERED, never what answers are accepted. Web may still render this as numbered buttons/cards.
/** The three-way offer after a provider failure — retry live, take the indicative guidance already shown, or hand off to sales. */
export function buildProviderFailureRecoveryOffer(language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH")
    return "Koi baat nahi — hum ye kar sakte hain: abhi ke liye ye indicative numbers use karein, live search dobara try karein, ya main ek callback arrange kar doon. Aapko kya theek lagega?";
  if (language === "HINDI")
    return "कोई बात नहीं — हम यह कर सकते हैं: अभी के लिए ये संकेतात्मक आंकड़े उपयोग करें, लाइव सर्च दोबारा करें, या मैं एक कॉलबैक की व्यवस्था कर दूँ। आपको क्या ठीक लगेगा?";
  return "No worries — here's what we can do: use the indicative numbers I already have, try the live search again, or I can arrange a callback so our team can help directly. Which would you prefer?";
}

// A bare "1"/"2"/"3" (optionally "option 1") or its natural-language equivalent, ONLY meaningful as a menu
// pick when a recovery offer was actually just shown (`this.providerFailure !== null`) — see
// `detectProviderFailureRecoverySelection` and its call site in `complete()`.
const RECOVERY_OPTION_1_PATTERN = /^\s*(?:option\s*1|1)\s*[.)]?\s*$|^\s*(?:pehla|pehli|first(?:\s+one)?)\s*$/i;
const RECOVERY_OPTION_2_PATTERN = /^\s*(?:option\s*2|2)\s*[.)]?\s*$|^\s*(?:dusra|doosra|second(?:\s+one)?)\s*$/i;
const RECOVERY_OPTION_3_PATTERN = /^\s*(?:option\s*3|3)\s*[.)]?\s*$|^\s*(?:teesra|tisra|third(?:\s+one)?|callback)\s*$/i;

/**
 * Detects a reply to the three-way recovery menu shown after a provider failure — a bare digit (or its
 * natural-language equivalent), never a broader phrase, so it can never misfire on an unrelated message
 * that merely happens to contain a number (e.g. "2 adults").
 */
export function detectProviderFailureRecoverySelection(text: string): ProviderFailureRecoverySelection | null {
  if (RECOVERY_OPTION_1_PATTERN.test(text)) return "INDICATIVE_RECOMMENDATIONS";
  if (RECOVERY_OPTION_2_PATTERN.test(text)) return "RETRY_LIVE_SEARCH";
  if (RECOVERY_OPTION_3_PATTERN.test(text)) return "CALLBACK";
  return null;
}

/** How long a bare digit reply is still honored as a recovery-menu pick after the menu was shown. */
export const PROVIDER_FAILURE_MENU_TTL_MS = 15 * 60 * 1000;

/**
 * Whether a bare digit reply should still be interpreted as a recovery-menu pick right now — false once
 * `menuActive` was cleared by an intervening explicit action (see `invalidateRecoveryMenu`) or once
 * `menuExpiresAt` has passed, whichever happened first. The broader "don't blindly retry" gate on
 * `providerFailure` itself is unaffected either way — only the numeric-shortcut interpretation expires.
 */
export function isRecoveryMenuActive(providerFailure: ProviderFailureRecord | null): boolean {
  if (!providerFailure || !providerFailure.menuActive) return false;
  return Date.now() < new Date(providerFailure.menuExpiresAt).getTime();
}

/** Deterministic acknowledgement for option 1 — continues with the recommendations already shown, never repeats the menu. */
export function buildRecoveryContinuationMessage(language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH")
    return "Theek hai, in indicative recommendations ke hisaab se hi aage badhte hain. Aur kuch chahiye?";
  if (language === "HINDI") return "ठीक है, इन संकेतात्मक सुझावों के हिसाब से ही आगे बढ़ते हैं। और कुछ चाहिए?";
  return "Sounds good — let's continue with these indicative recommendations. Anything else you'd like to adjust?";
}

/**
 * Provider-independent recommendation message: flight + hotel guidance derived only from the aggregate
 * budget estimate and qualitative route/area knowledge, always carrying the required disclaimer. Used for
 * GENERATE_FLIGHT_RECOMMENDATIONS/GENERATE_HOTEL_RECOMMENDATIONS and for the provider-failure fallback (which
 * additionally appends the three-way recovery offer).
 */
export function buildIndicativeRecommendationsMessage(
  entities: TravelEntities,
  estimate: BudgetEstimate,
  language: TravelResponseLanguage = "ENGLISH",
  afterProviderFailure = false
): string {
  // Stage 9B: the traveler's stated TOTAL_PARTY budget must always be compared against the TOTAL_PARTY
  // trip estimate here too — reusing buildBudgetFeasibilityNote (the same comparison
  // buildBudgetGuidanceMessage already makes) so this path never omits a clear "this exceeds your
  // budget" statement the way it previously did.
  const feasibilityNote = buildBudgetFeasibilityNote(entities, estimate, language);
  const lines = [
    buildIndicativeFlightGuidance(entities, estimate, language),
    buildAirportRouteGuidance(entities.originCity, entities.destinationCity, language),
    buildIndicativeHotelGuidance(entities, estimate, language),
    buildHotelAreaGuidance(entities.destinationCity, language),
    ...(feasibilityNote ? ["", feasibilityNote] : []),
    "",
    INDICATIVE_DISCLAIMER[language]
  ];
  if (afterProviderFailure) lines.push("", buildProviderFailureRecoveryOffer(language));
  return lines.join("\n");
}

/**
 * Area-specific guidance when the traveler explicitly asked about a specific hotel area — replaces the
 * generic destination-wide area list with a focused recommendation for the requested area.
 */
export function buildRequestedAreaGuidance(
  destinationCity: string | null,
  requestedArea: string,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const destNote = destinationCity ? ` in ${destinationCity}` : "";
  if (language === "HINGLISH")
    return `${requestedArea}${destNote} mein recommended area hai — yahan hotels, dining aur attractions ka accha collection hai.`;
  if (language === "HINDI")
    return `${requestedArea}${destNote} में अनुशंसित क्षेत्र है — यहाँ होटल, भोजन और आकर्षण का अच्छा संग्रह है।`;
  return `${requestedArea}${destNote} is a recommended area with a good concentration of hotels, dining, and attractions nearby.`;
}

/**
 * Hotel-only recommendations for a GENERATE_HOTEL_RECOMMENDATIONS request — no flights, no airport
 * guidance, no budget-feasibility replay. When `requestedArea` is provided (e.g. "Dubai Marina"),
 * produces area-specific guidance instead of the generic destination-wide area list.
 */
export function buildHotelRecommendationsMessage(
  entities: TravelEntities,
  estimate: BudgetEstimate,
  language: TravelResponseLanguage = "ENGLISH",
  requestedArea: string | null = null
): string {
  const lines: string[] = [
    buildIndicativeHotelGuidance(entities, estimate, language),
  ];
  if (requestedArea) {
    lines.push(buildRequestedAreaGuidance(entities.destinationCity, requestedArea, language));
  } else {
    lines.push(buildHotelAreaGuidance(entities.destinationCity, language));
  }
  lines.push("", INDICATIVE_DISCLAIMER[language]);
  return lines.join("\n");
}

/**
 * One-line trip-details-noted summary — every known field, nothing invented. Deliberately never says
 * "confirmed"/"booked"/"reserved": nothing has actually been booked at this point, only captured, and
 * wording that implies otherwise would misrepresent the state to the traveler.
 */
function buildConfirmedTripSummaryLine(entities: TravelEntities, language: TravelResponseLanguage): string {
  const travelers = describeTravelerMix(entities.adults, entities.children, entities.infants, entities.totalTravellers);
  const dates = entities.departureDate ?? entities.travelMonth ?? (language === "ENGLISH" ? "dates not yet set" : "tareekh abhi tay nahi");
  const durationPart = buildDurationPhrase(entities, language);
  const budgetPart =
    entities.budget !== null ? `${entities.budgetCurrency ?? ""} ${entities.budget}`.trim() : null;
  const parts = [
    entities.originCity ? `${entities.originCity} -> ${entities.destinationCity ?? "?"}` : (entities.destinationCity ?? "?"),
    dates,
    durationPart,
    travelers,
    budgetPart ? `budget ${budgetPart}` : null
  ].filter((part): part is string => Boolean(part));
  if (language === "HINGLISH") return `Trip details noted (proposed, not booked): ${parts.join(", ")}.`;
  if (language === "HINDI") return `यात्रा विवरण दर्ज (प्रस्तावित, बुक नहीं): ${parts.join(", ")}।`;
  return `Trip details noted (proposed, not booked): ${parts.join(", ")}.`;
}

/** The category-wise budget breakdown, formatted as a short list — reused as-is from the estimate. */
function buildBudgetBreakdownBlock(estimate: BudgetEstimate, language: TravelResponseLanguage): string {
  const header = language === "HINGLISH" ? "Estimated budget (category-wise):" : language === "HINDI" ? "अनुमानित बजट (श्रेणी-वार):" : "Estimated budget (category-wise):";
  const lines = estimate.breakdown.map(
    (line) => `  • ${line.label}: ${estimate.currency} ${formatAmount(line.low)}–${formatAmount(line.high)}`
  );
  const total =
    language === "HINGLISH"
      ? `Total: ${estimate.currency} ${formatAmount(estimate.low)}–${formatAmount(estimate.high)}`
      : language === "HINDI"
        ? `कुल: ${estimate.currency} ${formatAmount(estimate.low)}–${formatAmount(estimate.high)}`
        : `Total: ${estimate.currency} ${formatAmount(estimate.low)}–${formatAmount(estimate.high)}`;
  return [header, ...lines, total].join("\n");
}

/**
 * Every section a complete trip plan must have, exactly once — see `buildCompleteTripPlan`/
 * `validateCompleteTripPlan`. Order here is also render order.
 */
export const COMPLETE_TRIP_PLAN_REQUIRED_SECTIONS = [
  "summary",
  "flights",
  "hotels",
  "budget",
  "itinerary",
  "transport",
  "packing",
  "tips",
  "visaInsurance",
  "disclaimer",
  "nextSteps"
] as const;
export type CompleteTripPlanSectionKey = (typeof COMPLETE_TRIP_PLAN_REQUIRED_SECTIONS)[number];

export interface CompleteTripPlanSection {
  key: CompleteTripPlanSectionKey;
  heading: string | null;
  body: string;
}

export interface CompleteTripPlan {
  sections: CompleteTripPlanSection[];
}

export interface CompleteTripPlanValidationResult {
  valid: boolean;
  missingSections: CompleteTripPlanSectionKey[];
  duplicateSections: CompleteTripPlanSectionKey[];
}

/** Invariant: every required section is present exactly once — never fewer (an omission), never more (a duplicate). */
export function validateCompleteTripPlan(plan: CompleteTripPlan): CompleteTripPlanValidationResult {
  const counts = new Map<CompleteTripPlanSectionKey, number>();
  for (const section of plan.sections) counts.set(section.key, (counts.get(section.key) ?? 0) + 1);
  const missingSections = COMPLETE_TRIP_PLAN_REQUIRED_SECTIONS.filter((key) => !counts.has(key));
  const duplicateSections = COMPLETE_TRIP_PLAN_REQUIRED_SECTIONS.filter((key) => (counts.get(key) ?? 0) > 1);
  return { valid: missingSections.length === 0 && duplicateSections.length === 0, missingSections, duplicateSections };
}

export function renderCompleteTripPlan(plan: CompleteTripPlan): string {
  return plan.sections.map((section) => (section.heading ? `${section.heading}\n${section.body}` : section.body)).join("\n\n");
}

/**
 * Builds the structured plan — confirmed-known summary, indicative flight/hotel recommendations,
 * airport/route guidance, hotel areas, room/occupancy guidance, category-wise budget (with the duration
 * assumption and traveller cost-factor notes when applicable), the day-wise itinerary (generated
 * separately and passed in), local transport, packing, tips, visa/insurance caveats, the required
 * disclaimer, and a next action — every section personalized from known entities and stated preferences,
 * nothing invented for what isn't yet known.
 */
export function buildCompleteTripPlan(
  entities: TravelEntities,
  itineraryText: string,
  estimate: BudgetEstimate,
  language: TravelResponseLanguage = "ENGLISH"
): CompleteTripPlan {
  const sectionHeader = (en: string, hinglish: string, hindi: string): string =>
    language === "HINGLISH" ? hinglish : language === "HINDI" ? hindi : en;
  const durationAssumption = buildDurationAssumptionNote(entities, language);
  const travellerFactorNote = buildTravellerCostFactorNote(describeTravellerCostBreakdown(entities), language);
  const preferenceNote = buildPreferenceApplicationNote(
    entities.preferences,
    (entities.children ?? 0) > 0,
    (entities.infants ?? 0) > 0,
    language
  );
  const sections: CompleteTripPlanSection[] = [
    { key: "summary", heading: null, body: buildConfirmedTripSummaryLine(entities, language) },
    {
      key: "flights",
      heading: sectionHeader("Flights:", "Flights:", "फ्लाइट्स:"),
      body: [buildIndicativeFlightGuidance(entities, estimate, language), buildAirportRouteGuidance(entities.originCity, entities.destinationCity, language)].join(
        "\n"
      )
    },
    {
      key: "hotels",
      heading: sectionHeader("Hotels:", "Hotels:", "होटल:"),
      body: [
        buildIndicativeHotelGuidance(entities, estimate, language),
        buildHotelAreaGuidance(entities.destinationCity, language),
        buildRoomOccupancyGuidance(entities, language)
      ].join("\n")
    },
    {
      key: "budget",
      heading: null,
      body: [buildBudgetBreakdownBlock(estimate, language), durationAssumption, travellerFactorNote]
        .filter((line): line is string => Boolean(line))
        .join("\n")
    },
    {
      key: "itinerary",
      heading: sectionHeader("Day-wise itinerary:", "Din-wise itinerary:", "दिन-वार यात्रा-कार्यक्रम:"),
      body: [itineraryText, preferenceNote].filter((line): line is string => Boolean(line)).join("\n")
    },
    {
      key: "transport",
      heading: sectionHeader("Getting around:", "Getting around:", "स्थानीय परिवहन:"),
      body: buildLocalTransportGuidance(entities.destinationCity, language)
    },
    { key: "packing", heading: null, body: buildPackingGuidance(entities, language) },
    { key: "tips", heading: null, body: buildTravelTips(language) },
    { key: "visaInsurance", heading: null, body: buildVisaInsuranceCaveat(language) },
    { key: "disclaimer", heading: null, body: INDICATIVE_DISCLAIMER[language] },
    { key: "nextSteps", heading: null, body: buildNextActionMessage(language) }
  ];
  return { sections };
}

export function buildCompleteTripPlanMessage(
  entities: TravelEntities,
  itineraryText: string,
  estimate: BudgetEstimate,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const plan = buildCompleteTripPlan(entities, itineraryText, estimate, language);
  const validation = validateCompleteTripPlan(plan);
  if (!validation.valid) {
    // Defensive only: buildCompleteTripPlan always emits every required section exactly once. If this ever
    // fires, fail loudly rather than silently ship a plan missing a required section.
    throw new Error(
      `CompleteTripPlan failed validation — missing: [${validation.missingSections.join(", ")}], duplicate: [${validation.duplicateSections.join(", ")}]`
    );
  }
  return renderCompleteTripPlan(plan);
}

// ---- Journey-native complete plans (multi-leg) ----
// Sprint 4.2: Journey is the authoritative source for EVERY complete plan, single- or multi-leg — the
// orchestrator always resolves a Journey + its ordered JourneyLeg[] first (see `ensureJourney`/
// `collectAllJourneyLegs`), and single-leg trips render via the existing `buildCompleteTripPlan` above
// (a journey holding exactly one leg, reusing that already-tested single-BudgetEstimate path unchanged).
// Only once 2+ legs exist does the following multi-leg structure take over — it never renders a multi-leg
// plan from a single BudgetEstimate or from bare TravelEntities.originCity/destinationCity alone.

/** Reconstructs a leg's own entities so every existing entity-shaped guidance builder can be reused per-leg. */
function legToEntities(leg: JourneyLeg, travellerProfile: JourneyTravellerProfile): TravelEntities {
  return {
    ...EMPTY_TRAVEL_ENTITIES,
    originCity: leg.origin,
    destinationCity: leg.destination,
    departureDate: leg.dates.departureDate,
    travelMonth: leg.dates.travelMonth,
    returnDate: leg.dates.returnDate,
    days: leg.duration.days,
    nights: leg.duration.nights,
    adults: leg.passengers.adults,
    children: leg.passengers.children,
    infants: leg.passengers.infants,
    totalTravellers: leg.passengers.totalTravellers,
    budget: leg.budget.amount,
    budgetCurrency: leg.budget.currency,
    cabinClass: travellerProfile.cabinClass,
    hotelStars: travellerProfile.hotelStars,
    preferences: travellerProfile.preferences
  };
}

/** A leg has an actual overnight stay at its destination only when some duration was stated for it. */
function legHasStay(leg: JourneyLeg): boolean {
  return leg.duration.days !== null || leg.duration.nights !== null;
}

function buildJourneySummarySection(legs: readonly JourneyLeg[], language: TravelResponseLanguage): string {
  const header = language === "HINDI" ? "यात्रा सारांश:" : "Journey summary:";
  const noStay = language === "HINGLISH" ? "koi stay nahi (connecting)" : language === "HINDI" ? "कोई ठहराव नहीं (कनेक्टिंग)" : "no stay (connecting)";
  const lines = legs.map((leg) => {
    const stay = buildDurationPhrase(leg.duration, language) ?? noStay;
    const dateNote = leg.dates.departureDate
      ? leg.dates.departureDateIsAssumption === true
        ? language === "HINGLISH"
          ? ` — tentative date ${leg.dates.departureDate} (assumption, based on the previous leg)`
          : language === "HINDI"
            ? ` — अस्थायी तिथि ${leg.dates.departureDate} (अनुमान, पिछले चरण पर आधारित)`
            : ` — tentative date ${leg.dates.departureDate} (assumption, derived from the previous leg)`
        : ` — departs ${leg.dates.departureDate}`
      : "";
    return `  Leg ${leg.sequence}: ${leg.origin ?? "?"} -> ${leg.destination ?? "?"} — ${stay}${dateNote}`;
  });
  return [header, ...lines].join("\n");
}

export const JOURNEY_COMPLETE_TRIP_PLAN_JOURNEY_SECTIONS = [
  "journeySummary",
  "combinedBudget",
  "transport",
  "packing",
  "tips",
  "visaInsurance",
  "disclaimer",
  "nextSteps"
] as const;
/** Emitted exactly once per leg, regardless of whether that leg has a stay. */
export const JOURNEY_COMPLETE_TRIP_PLAN_LEG_SECTIONS = ["legFlights", "legItinerary", "legBudget"] as const;
/** Emitted exactly once per leg, but ONLY for legs with an actual stay at their destination — see `legHasStay`. */
export const JOURNEY_COMPLETE_TRIP_PLAN_STAY_SECTIONS = ["legHotel", "legOccupancy"] as const;

export type JourneyCompleteTripPlanSectionKey =
  | (typeof JOURNEY_COMPLETE_TRIP_PLAN_JOURNEY_SECTIONS)[number]
  | (typeof JOURNEY_COMPLETE_TRIP_PLAN_LEG_SECTIONS)[number]
  | (typeof JOURNEY_COMPLETE_TRIP_PLAN_STAY_SECTIONS)[number];

export interface JourneyCompleteTripPlanSection {
  key: JourneyCompleteTripPlanSectionKey;
  /** Null for journey-level sections; the owning leg's 1-indexed sequence for leg-scoped sections. */
  legSequence: number | null;
  heading: string | null;
  body: string;
}

export interface JourneyCompleteTripPlan {
  sections: JourneyCompleteTripPlanSection[];
}

export interface JourneyCompleteTripPlanValidationResult {
  valid: boolean;
  /** Human-readable identifiers — e.g. "journeySummary" or "leg 2: legHotel". */
  missingSections: string[];
  duplicateSections: string[];
}

/**
 * Invariant: every journey-level section appears exactly once, every leg has its own flights/itinerary/
 * budget section exactly once, and every leg WITH A STAY additionally has its own hotel/occupancy section
 * exactly once (a pure connecting leg is never expected to carry hotel guidance for a stay it doesn't have).
 */
export function validateJourneyCompleteTripPlan(
  plan: JourneyCompleteTripPlan,
  legs: readonly JourneyLeg[]
): JourneyCompleteTripPlanValidationResult {
  const missingSections: string[] = [];
  const duplicateSections: string[] = [];
  const countOf = (key: JourneyCompleteTripPlanSectionKey, legSequence: number | null): number =>
    plan.sections.filter((section) => section.key === key && section.legSequence === legSequence).length;
  for (const key of JOURNEY_COMPLETE_TRIP_PLAN_JOURNEY_SECTIONS) {
    const count = countOf(key, null);
    if (count === 0) missingSections.push(key);
    if (count > 1) duplicateSections.push(key);
  }
  for (const leg of legs) {
    for (const key of JOURNEY_COMPLETE_TRIP_PLAN_LEG_SECTIONS) {
      const count = countOf(key, leg.sequence);
      if (count === 0) missingSections.push(`leg ${leg.sequence}: ${key}`);
      if (count > 1) duplicateSections.push(`leg ${leg.sequence}: ${key}`);
    }
    if (legHasStay(leg)) {
      for (const key of JOURNEY_COMPLETE_TRIP_PLAN_STAY_SECTIONS) {
        const count = countOf(key, leg.sequence);
        if (count === 0) missingSections.push(`leg ${leg.sequence}: ${key}`);
        if (count > 1) duplicateSections.push(`leg ${leg.sequence}: ${key}`);
      }
    }
  }
  return { valid: missingSections.length === 0 && duplicateSections.length === 0, missingSections, duplicateSections };
}

export function renderJourneyCompleteTripPlan(plan: JourneyCompleteTripPlan): string {
  return plan.sections.map((section) => (section.heading ? `${section.heading}\n${section.body}` : section.body)).join("\n\n");
}

/**
 * Builds the full multi-leg plan directly from the Journey + its ordered legs — flights/hotel/occupancy/
 * day-plan/budget PER LEG, plus the ordered journey summary (with every derived date's assumption clearly
 * labeled), the combined journey budget, and the shared journey-level sections (transport, packing, tips,
 * visa/insurance, disclaimer, next steps). Never sourced from a single BudgetEstimate or from standalone
 * TravelEntities.originCity/destinationCity — everything here traces back to `legs`/`journeyEstimate`.
 */
export function buildJourneyCompleteTripPlan(
  journey: Journey,
  legs: readonly JourneyLeg[],
  perLegItineraries: readonly string[],
  journeyEstimate: JourneyBudgetEstimate,
  language: TravelResponseLanguage = "ENGLISH"
): JourneyCompleteTripPlan {
  const firstLeg = legs[0];
  if (!firstLeg) throw new Error("buildJourneyCompleteTripPlan requires at least one leg");
  const legHeading = (leg: JourneyLeg, label: string): string =>
    `${language === "HINDI" ? "चरण" : "Leg"} ${leg.sequence} (${leg.origin ?? "?"} -> ${leg.destination ?? "?"}) — ${label}:`;

  const sections: JourneyCompleteTripPlanSection[] = [
    { key: "journeySummary", legSequence: null, heading: null, body: buildJourneySummarySection(legs, language) }
  ];

  legs.forEach((leg, index) => {
    const legEntities = legToEntities(leg, journey.travellerProfile);
    const legEstimate = journeyEstimate.perLeg[index]?.estimate ?? null;
    const flightsLabel = language === "HINGLISH" ? "flights" : language === "HINDI" ? "फ्लाइट्स" : "flights";
    sections.push({
      key: "legFlights",
      legSequence: leg.sequence,
      heading: legHeading(leg, flightsLabel),
      body: [
        legEstimate ? buildIndicativeFlightGuidance(legEntities, legEstimate, language) : null,
        buildAirportRouteGuidance(leg.origin, leg.destination, language)
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n")
    });
    if (legHasStay(leg) && legEstimate) {
      const hotelLabel = language === "HINGLISH" ? "hotel" : language === "HINDI" ? "होटल" : "hotel";
      sections.push({
        key: "legHotel",
        legSequence: leg.sequence,
        heading: legHeading(leg, hotelLabel),
        body: [buildIndicativeHotelGuidance(legEntities, legEstimate, language), buildHotelAreaGuidance(leg.destination, language)].join(
          "\n"
        )
      });
      sections.push({
        key: "legOccupancy",
        legSequence: leg.sequence,
        heading: null,
        body: buildRoomOccupancyGuidance(legEntities, language)
      });
    }
    const itineraryLabel =
      language === "HINGLISH" ? "Din-wise itinerary" : language === "HINDI" ? "दिन-वार यात्रा-कार्यक्रम" : "Day-wise itinerary";
    const preferenceNote = buildPreferenceApplicationNote(
      journey.travellerProfile.preferences,
      (leg.passengers.children ?? 0) > 0,
      (leg.passengers.infants ?? 0) > 0,
      language
    );
    sections.push({
      key: "legItinerary",
      legSequence: leg.sequence,
      heading: `${itineraryLabel} — ${leg.destination ?? "?"}:`,
      body: [perLegItineraries[index] ?? "", preferenceNote].filter((line): line is string => Boolean(line)).join("\n")
    });
    sections.push({
      key: "legBudget",
      legSequence: leg.sequence,
      heading: null,
      body: legEstimate
        ? buildBudgetBreakdownBlock(legEstimate, language)
        : language === "HINGLISH"
          ? "Is leg ke liye abhi budget calculate nahi ho saka (dates/duration missing)."
          : language === "HINDI"
            ? "इस चरण के लिए अभी बजट की गणना नहीं हो सकी (तिथियां/अवधि अनुपलब्ध)।"
            : "Budget for this leg could not be calculated yet (dates/duration missing)."
    });
  });

  const durationAssumptions = legs
    .map((leg) => buildDurationAssumptionNote(leg.duration, language))
    .filter((note): note is string => Boolean(note));
  const travellerFactorNote = buildTravellerCostFactorNote(describeTravellerCostBreakdown(firstLeg.passengers), language);
  sections.push({
    key: "combinedBudget",
    legSequence: null,
    heading: language === "HINDI" ? "संयुक्त यात्रा बजट:" : "Combined journey budget:",
    body: [buildBudgetBreakdownBlock(journeyEstimate.combined, language), ...durationAssumptions, travellerFactorNote]
      .filter((line): line is string => Boolean(line))
      .join("\n")
  });
  sections.push({
    key: "transport",
    legSequence: null,
    heading: language === "HINDI" ? "स्थानीय परिवहन:" : "Getting around:",
    body: legs.map((leg) => buildLocalTransportGuidance(leg.destination, language)).join("\n")
  });
  sections.push({
    key: "packing",
    legSequence: null,
    heading: null,
    body: buildPackingGuidance(legToEntities(firstLeg, journey.travellerProfile), language)
  });
  sections.push({ key: "tips", legSequence: null, heading: null, body: buildTravelTips(language) });
  sections.push({ key: "visaInsurance", legSequence: null, heading: null, body: buildVisaInsuranceCaveat(language) });
  sections.push({ key: "disclaimer", legSequence: null, heading: null, body: INDICATIVE_DISCLAIMER[language] });
  sections.push({ key: "nextSteps", legSequence: null, heading: null, body: buildNextActionMessage(language) });
  return { sections };
}

/**
 * Business classification of whether a stated budget can realistically cover a trip — kept entirely
 * separate from technical tool/provider failures. A low budget is a planning constraint to explain to the
 * traveler, never a reason to fail the turn. Thresholds: at/above the minimum -> FEASIBLE; up to 10% below
 * the minimum -> TIGHT (workable but tight); more than 10% below -> BELOW_MINIMUM.
 */
export type TravelBudgetFeasibility = "FEASIBLE" | "TIGHT" | "BELOW_MINIMUM";

export interface BudgetFeasibilityResult {
  classification: TravelBudgetFeasibility;
  currency: string;
  userBudget: number;
  minimum: number;
  shortfall: number;
  shortfallPercent: number;
}

/**
 * Classifies a stated budget against a realistic minimum estimate. `shortfallPercent` is
 * `shortfall / minimum` — e.g. USD 2,000 against a USD 5,443 minimum is a ~63% shortfall, always reported
 * as BELOW_MINIMUM and worded accordingly (never softened to "a little under").
 */
export function classifyBudgetFeasibility(userBudget: number, estimate: BudgetEstimate): BudgetFeasibilityResult {
  const minimum = estimate.low;
  if (userBudget >= minimum)
    return {
      classification: "FEASIBLE",
      currency: estimate.currency,
      userBudget,
      minimum,
      shortfall: 0,
      shortfallPercent: 0
    };
  const shortfall = minimum - userBudget;
  const shortfallPercent = minimum > 0 ? shortfall / minimum : 1;
  return {
    classification: shortfallPercent <= 0.1 ? "TIGHT" : "BELOW_MINIMUM",
    currency: estimate.currency,
    userBudget,
    minimum,
    shortfall,
    shortfallPercent
  };
}

const FEASIBILITY_ALTERNATIVES: Record<TravelResponseLanguage, string> = {
  ENGLISH: [
    "A few things that could help:",
    "• A shorter stay",
    "• Fewer paid activities",
    "• Alternate travel dates",
    "• A lower-cost destination",
    "• A cheaper airport or route"
  ].join("\n"),
  HINGLISH: [
    "Kuch options jo madad kar sakte hain:",
    "• Chhoti trip duration",
    "• Kam paid activities",
    "• Alternate travel dates",
    "• Kam kharchile destination",
    "• Sasta airport ya route"
  ].join("\n"),
  HINDI: [
    "कुछ विकल्प जो मदद कर सकते हैं:",
    "• छोटी अवधि की यात्रा",
    "• कम भुगतान वाली गतिविधियाँ",
    "• वैकल्पिक यात्रा तिथियाँ",
    "• कम खर्चीला गंतव्य",
    "• सस्ता एयरपोर्ट या रूट"
  ].join("\n")
};

/**
 * Deterministic, language-aware BELOW_MINIMUM response — a polite business explanation of why the trip
 * isn't feasible at the stated budget, with concrete alternatives. Never a technical-failure message; this
 * is a business result, not an error.
 */
export function buildBelowMinimumMessage(
  entities: TravelEntities,
  feasibility: BudgetFeasibilityResult,
  language: TravelResponseLanguage
): string {
  const destination = entities.destinationCity ?? "your destination";
  const origin = entities.originCity;
  const { currency, minimum, userBudget, shortfall } = feasibility;
  let intro: string;
  if (language === "HINGLISH") {
    const route = origin ? `${origin} se ${destination}` : destination;
    intro = `Aapke ${route} trip ka practical minimum budget lagbhag ${currency} ${formatAmount(minimum)} se shuru hota hai. Aapka ${currency} ${formatAmount(userBudget)} budget is minimum se lagbhag ${currency} ${formatAmount(shortfall)} kam hai, isliye same dates, duration aur passenger mix ke saath trip feasible hona mushkil hai.`;
  } else if (language === "HINDI") {
    const route = origin ? `${origin} से ${destination}` : destination;
    intro = `आपकी ${route} यात्रा का वास्तविक न्यूनतम बजट लगभग ${currency} ${formatAmount(minimum)} से शुरू होता है। आपका ${currency} ${formatAmount(userBudget)} बजट इस न्यूनतम से लगभग ${currency} ${formatAmount(shortfall)} कम है, इसलिए समान तारीखों, अवधि और यात्रियों की संख्या के साथ यह यात्रा संभव होना मुश्किल है।`;
  } else {
    const route = origin ? `${origin} to ${destination}` : destination;
    intro = `A realistic minimum budget for your ${route} trip starts at around ${currency} ${formatAmount(minimum)}. Your ${currency} ${formatAmount(userBudget)} budget is about ${currency} ${formatAmount(shortfall)} below that, so this trip is unlikely to be feasible with the same dates, duration, and travelers.`;
  }
  return `${intro}\n\n${FEASIBILITY_ALTERNATIVES[language]}`;
}

/**
 * Fix (Travel Booking UAT correction pass — budget-override bug): the explicit, priced yes/no question
 * that must be asked — and answered affirmatively — before ANY above-budget simulated option is ever
 * shown. Never invents a price: `lowestAmount`/`lowestCurrency` must come from the SAME
 * `generateSimulatedPackageOptions` set that will actually be shown if the traveler says yes, so the
 * number quoted here always matches what they see next.
 */
function buildBudgetOverrideQuestion(
  feasibility: BudgetFeasibilityResult,
  lowestAmount: number,
  lowestCurrency: string,
  language: TravelResponseLanguage
): string {
  const { currency, userBudget } = feasibility;
  if (language === "HINGLISH")
    return `Sabhi available simulated options aapke ${currency} ${formatAmount(userBudget)} budget se zyada hain. Sabse kam wala option ${lowestCurrency} ${formatAmount(lowestAmount)} hai. Kya aap chahenge ki main aapke budget se upar wale options dikhau? (Ya apna mobile number share karein, ek travel advisor budget ke andar kuch dhoondhne mein madad karega.)`;
  if (language === "HINDI")
    return `सभी उपलब्ध सिम्युलेटेड विकल्प आपके ${currency} ${formatAmount(userBudget)} बजट से अधिक हैं। सबसे कम विकल्प ${lowestCurrency} ${formatAmount(lowestAmount)} है। क्या आप चाहेंगे कि मैं आपके बजट से ऊपर के विकल्प दिखाऊं? (या अपना मोबाइल नंबर साझा करें, एक ट्रैवल एडवाइज़र बजट के भीतर कुछ खोजने में मदद करेगा।)`;
  return `All available simulated options exceed your ${currency} ${formatAmount(userBudget)} budget. The lowest option is ${lowestCurrency} ${formatAmount(lowestAmount)}. Would you like me to continue with options above your budget? (Or share your mobile number and a travel advisor can help find something within budget.)`;
}

/**
 * Fix (Travel Booking Closure Pass — Phase 2): the single authoritative answer to "does this message
 * resolve Travel's currently-pending AWAITING_BUDGET_OVERRIDE_CONFIRMATION question?" — reused by the
 * Receptionist's pending-input-ownership check (`receptionist/specialist-pending-input.ts`) exactly the
 * way `resolvesTicketDeliveryQuestion` is. A clear yes/no reply to "would you like to continue with
 * options above your budget?" must never be misread as an unrelated domain switch merely because it
 * contains the word "budget" (which happens to be Finance's own routing alias too).
 */
export function resolvesBudgetOverrideQuestion(text: string): boolean {
  return isAffirmativeResponse(text) || isNegativeResponse(text);
}

/**
 * Deterministic, language-aware one-line feasibility statement for FEASIBLE/TIGHT budgets. BELOW_MINIMUM
 * is handled separately by {@link buildBelowMinimumMessage} (alternatives + possible sales handoff).
 */
function buildFeasibilityStatement(feasibility: BudgetFeasibilityResult, language: TravelResponseLanguage): string {
  const { classification, currency, userBudget, minimum } = feasibility;
  if (classification === "FEASIBLE") {
    if (language === "HINGLISH")
      return `Aapka ${currency} ${formatAmount(userBudget)} budget comfortable hai aur behtar hotel ya flexible flights ke liye jagah chhodta hai.`;
    if (language === "HINDI")
      return `आपका ${currency} ${formatAmount(userBudget)} बजट पर्याप्त है और बेहतर होटल या अधिक लचीली फ्लाइट्स के लिए जगह छोड़ता है।`;
    return `Your ${currency} ${formatAmount(userBudget)} budget is comfortable and leaves room for better hotels or more flexible flights.`;
  }
  // TIGHT
  if (language === "HINGLISH")
    return `Aapka ${currency} ${formatAmount(userBudget)} budget thoda tight hai — practical ${currency} ${formatAmount(minimum)} minimum estimate ke kareeb hai, lekin trip ban sakti hai.`;
  if (language === "HINDI")
    return `आपका ${currency} ${formatAmount(userBudget)} बजट थोड़ा टाइट है — व्यावहारिक ${currency} ${formatAmount(minimum)} न्यूनतम अनुमान के करीब है, लेकिन यात्रा संभव है।`;
  return `Your ${currency} ${formatAmount(userBudget)} budget is workable but tight — close to a practical ${currency} ${formatAmount(minimum)} minimum estimate.`;
}

/** Deterministic budget-guidance reply: a realistic range broken into categories, per requirement. */
export function buildBudgetGuidanceMessage(
  entities: TravelEntities,
  config: TravelEmployeeRuntimeConfig,
  language: TravelResponseLanguage = "ENGLISH",
  displayCurrency?: string
): string {
  const estimate = estimateBudgetRange(entities, config, displayCurrency);
  // Never silently relabel one as the other — a traveler who said "3 nights" must see "3 nights" in the
  // summary, not a fabricated "3 days" (or a derived day-count reported as a fact). Falls back to a plain
  // "5 day(s)" ONLY when duration is genuinely unknown (matches `estimateBudgetRange`'s own default).
  const durationPhrase = buildDurationPhrase(entities, language) ?? (language === "ENGLISH" ? "5 day(s)" : "5 din");
  const destination = entities.destinationCity ?? "your destination";
  const travelers = describeTravelerMix(
    entities.adults,
    entities.children,
    entities.infants,
    entities.totalTravellers
  );
  const introLine =
    language === "HINGLISH"
      ? `${entities.originCity ? `${entities.originCity} se ${destination}` : destination} trip ke liye (${travelers}, ${durationPhrase}), ek practical economy estimate lagbhag ${estimate.currency} ${formatAmount(estimate.low)}–${formatAmount(estimate.high)} hai:`
      : language === "HINDI"
        ? `${entities.originCity ? `${entities.originCity} से ${destination}` : destination} यात्रा के लिए (${travelers}, ${durationPhrase}), एक व्यावहारिक इकोनॉमी अनुमान लगभग ${estimate.currency} ${formatAmount(estimate.low)}–${formatAmount(estimate.high)} है:`
        : `Sure — for ${travelers} travelling ${entities.originCity ? `from ${entities.originCity} to ${destination}` : `to ${destination}`} for ${durationPhrase}, a practical estimate in economy would be around ${estimate.currency} ${formatAmount(estimate.low)}–${formatAmount(estimate.high)}:`;
  const footerNote =
    language === "HINGLISH"
      ? "Ye estimates indicative hain jab tak live booking provider connect nahi hota — actual prices alag ho sakte hain."
      : language === "HINDI"
        ? "जब तक लाइव बुकिंग प्रोवाइडर कनेक्ट नहीं होता, ये अनुमान सांकेतिक हैं — वास्तविक कीमतें अलग हो सकती हैं।"
        : "These are indicative estimates until a live booking provider is connected — actual prices will vary.";
  const durationAssumption = buildDurationAssumptionNote(entities, language);
  const travellerFactorNote = buildTravellerCostFactorNote(describeTravellerCostBreakdown(entities), language);
  const lines = [
    introLine,
    ...estimate.breakdown.map((line) => `• ${line.label}: ${estimate.currency} ${formatAmount(line.low)}–${formatAmount(line.high)}`),
    "",
    ...(durationAssumption ? [durationAssumption] : []),
    ...(travellerFactorNote ? [travellerFactorNote] : []),
    footerNote
  ];
  if (entities.budget !== null) {
    const feasibility = classifyBudgetFeasibility(entities.budget, estimate);
    lines.push(
      feasibility.classification === "BELOW_MINIMUM"
        ? buildBelowMinimumMessage(entities, feasibility, language)
        : buildFeasibilityStatement(feasibility, language)
    );
  }
  const closing =
    language === "HINGLISH"
      ? "Aap budget, standard ya premium options me se kya prefer karenge?"
      : language === "HINDI"
        ? "क्या आप बजट, स्टैंडर्ड या प्रीमियम विकल्पों में से कोई पसंद करेंगे?"
        : "Would you prefer budget, standard, or premium options?";
  lines.push(closing);
  return lines.join("\n");
}

/**
 * Deterministic budget-feasibility note appended to a recommendation once real flight/hotel options
 * exist: never a technical failure, always a grounded statement of whether the stated budget is
 * achievable and, if not, the shortfall against a realistic estimate — reusing the exact same estimator
 * {@link buildBudgetGuidanceMessage} uses, so the two never disagree on numbers.
 */
export function buildBudgetFeasibilityNote(
  entities: TravelEntities,
  estimate: BudgetEstimate,
  language: TravelResponseLanguage = "ENGLISH"
): string | null {
  if (entities.budget === null) return null;
  const feasibility = classifyBudgetFeasibility(entities.budget, estimate);
  return feasibility.classification === "BELOW_MINIMUM"
    ? buildBelowMinimumMessage(entities, feasibility, language)
    : buildFeasibilityStatement(feasibility, language);
}

/** Rebuilds a budget estimate's Hotel line (and totals) from a fresh set of hotel options, keeping every other category unchanged — used after MODIFY_HOTEL_BUDGET reruns the hotel search. */
function recomputeEstimateWithHotelOptions(
  entities: TravelEntities,
  baseEstimate: BudgetEstimate,
  hotelOptions: HotelOption[]
): BudgetEstimate {
  const adults = entities.adults ?? entities.totalTravellers ?? 1;
  const days = entities.days ?? entities.nights ?? 5;
  const nights = entities.nights ?? Math.max(days - 1, 1);
  const rooms = Math.max(1, Math.ceil(adults / 2));
  const prices = hotelOptions.map((hotel) => hotel.pricePerNight);
  const hotelLow = prices.length ? Math.min(...prices) * rooms * nights : 0;
  const hotelHigh = prices.length ? Math.max(...prices) * rooms * nights : 0;
  const breakdown = baseEstimate.breakdown.map((line) =>
    line.label === "Hotel" ? { ...line, low: hotelLow, high: hotelHigh } : line
  );
  return {
    currency: baseEstimate.currency,
    low: breakdown.reduce((sum, line) => sum + line.low, 0),
    high: breakdown.reduce((sum, line) => sum + line.high, 0),
    breakdown
  };
}

/**
 * Deterministic reply for the MODIFY_HOTEL_BUDGET action: explains the hotel-category change, shows the
 * old estimate, the new estimate, the savings, and states plainly whether the target budget is now
 * achievable (using the same percentage-based {@link classifyBudgetFeasibility} as everywhere else — never
 * a softened "a little under" when the remaining shortfall is material). If the cheapest catalog tier was
 * already selected and the trip is still infeasible, explains that trade-offs beyond hotel category
 * (shorter trip, lower cabin class, fewer activities) would be needed. Always computed locally from
 * placeholder pricing — never a technical failure, even when no hotel tier can make the budget feasible.
 */
function buildHotelModificationMessage(
  entities: TravelEntities,
  oldEstimate: BudgetEstimate,
  hotelOptions: HotelOption[],
  hitFloor: boolean,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const newEstimate = recomputeEstimateWithHotelOptions(entities, oldEstimate, hotelOptions);
  const savingsLow = Math.max(0, oldEstimate.low - newEstimate.low);
  const savingsHigh = Math.max(0, oldEstimate.high - newEstimate.high);
  const feasibility = entities.budget !== null ? classifyBudgetFeasibility(entities.budget, newEstimate) : null;
  const budget = entities.budget ?? 0;

  if (language === "HINGLISH") {
    const hotelLines = hotelOptions.map(
      (hotel, index) => `  ${index + 1}. ${hotel.name} (${hotel.stars}★) — ~${hotel.currency} ${hotel.pricePerNight}/night`
    );
    const lines = [
      `Hotel category ${hitFloor ? "ab pehle se hi sabse economical tier par hai, isliye ise aur" : ""} reduce karne se approximately ${newEstimate.currency} ${formatAmount(savingsLow)} ki saving ho sakti hai, lekin revised minimum budget ab bhi ${newEstimate.currency} ${formatAmount(newEstimate.low)} ke aas-paas rahega.`,
      "",
      ...hotelLines
    ];
    if (feasibility) {
      lines.push("");
      if (feasibility.classification === "FEASIBLE")
        lines.push(`Ab yeh aapke ${newEstimate.currency} ${formatAmount(budget)} budget me fit ho jaata hai.`);
      else if (feasibility.classification === "TIGHT")
        lines.push(`Aapka ${newEstimate.currency} ${formatAmount(budget)} budget ab thoda tight hai, lekin trip ban sakti hai.`);
      else lines.push(`Aapka ${newEstimate.currency} ${formatAmount(budget)} budget ab bhi kaafi kam hai.`);
      if (hitFloor && feasibility.classification !== "FEASIBLE")
        lines.push(
          "Hum already sabse economical hotel category par hain, isliye baaki gap ke liye dates, trip length, cabin class ya activities adjust karni hongi."
        );
    }
    return lines.join("\n");
  }

  if (language === "HINDI") {
    const hotelLines = hotelOptions.map(
      (hotel, index) => `  ${index + 1}. ${hotel.name} (${hotel.stars}★) — ~${hotel.currency} ${hotel.pricePerNight}/रात`
    );
    const lines = [
      `होटल श्रेणी घटाने से लगभग ${newEstimate.currency} ${formatAmount(savingsLow)} की बचत हो सकती है, लेकिन संशोधित न्यूनतम बजट अब भी ${newEstimate.currency} ${formatAmount(newEstimate.low)} के आसपास रहेगा।`,
      "",
      ...hotelLines
    ];
    if (feasibility) {
      lines.push("");
      if (feasibility.classification === "FEASIBLE")
        lines.push(`अब यह आपके ${newEstimate.currency} ${formatAmount(budget)} बजट में फिट हो जाता है।`);
      else if (feasibility.classification === "TIGHT")
        lines.push(`आपका ${newEstimate.currency} ${formatAmount(budget)} बजट अब थोड़ा टाइट है, लेकिन यात्रा संभव है।`);
      else lines.push(`आपका ${newEstimate.currency} ${formatAmount(budget)} बजट अब भी काफी कम है।`);
      if (hitFloor && feasibility.classification !== "FEASIBLE")
        lines.push(
          "हम पहले से ही सबसे किफायती होटल श्रेणी में हैं, इसलिए बाकी अंतर को पाटने के लिए तारीखें, यात्रा अवधि, केबिन क्लास या गतिविधियाँ समायोजित करनी होंगी।"
        );
    }
    return lines.join("\n");
  }

  // ENGLISH
  const hotelLines = hotelOptions.map(
    (hotel, index) =>
      `  ${index + 1}. ${hotel.name} (${hotel.stars}★) — ~${hotel.currency} ${hotel.pricePerNight}/night (rated ${hotel.rating.toFixed(1)}/5)`
  );
  const lines = [
    hitFloor
      ? "I've switched to our most economical hotel category to bring the cost down:"
      : "I've moved to a lower hotel category to bring the cost down:",
    "",
    ...hotelLines,
    "",
    `Previous estimate: ${oldEstimate.currency} ${formatAmount(oldEstimate.low)}–${formatAmount(oldEstimate.high)}`,
    `New estimate: ${newEstimate.currency} ${formatAmount(newEstimate.low)}–${formatAmount(newEstimate.high)}`,
    `Estimated savings: ${newEstimate.currency} ${formatAmount(savingsLow)}–${formatAmount(savingsHigh)}`
  ];
  if (feasibility) {
    if (feasibility.classification === "FEASIBLE") {
      lines.push(`This now fits within your ${newEstimate.currency} ${formatAmount(budget)} budget.`);
    } else {
      lines.push(
        feasibility.classification === "TIGHT"
          ? `Your ${newEstimate.currency} ${formatAmount(budget)} budget is workable but tight against this revised estimate.`
          : `Your ${newEstimate.currency} ${formatAmount(budget)} budget is still well below this revised estimate.`
      );
      if (hitFloor)
        lines.push(
          "We're already at the most economical hotel category, so closing the rest of the gap would mean adjusting the dates, trip length, cabin class, or trimming planned activities."
        );
    }
  }
  return lines.join("\n");
}

/**
 * Deterministic fallback used only when the real LLM reply-generation call fails — must stand on its own
 * without any model help, so it applies the same "ask several missing things together" strategy as the
 * LLM prompts (see `combineMissingLabels`) rather than asking one field at a time.
 */
export function buildFallbackAskMessage(
  missing: string[],
  config: TravelEmployeeRuntimeConfig,
  isFirstTurn: boolean,
  language: TravelResponseLanguage = "ENGLISH",
  justLearnedName: string | null = null,
  // True when the traveler's name was already known BEFORE this turn (e.g. seeded from a Receptionist
  // handoff) — the configured welcome message has its own "may I know your name?" question baked into its
  // literal text, so reciting it verbatim here would be a real (not just wording) re-ask of a known fact.
  nameAlreadyKnown = false
): string {
  const greeting = isFirstTurn && !nameAlreadyKnown ? `${config.welcomeMessage}\n\n` : "";
  const nameAck = justLearnedName ? `${buildNameAcknowledgment(justLearnedName, language)} ` : "";
  const prefix = greeting + nameAck;
  const labels = missing
    .map((field) => ENTITY_MISSING_LABELS[field])
    .filter((label): label is string => Boolean(label));
  if (!labels.length) {
    if (language === "HINGLISH") return `${prefix}Kya aap thodi aur trip details share kar sakte hain?`;
    if (language === "HINDI") return `${prefix}क्या आप थोड़ी और यात्रा जानकारी साझा कर सकते हैं?`;
    return `${prefix}Could you share a few more trip details?`;
  }
  if (labels.length === 1) {
    if (language === "HINGLISH") return `${prefix}Kya aap ${labels[0]} bata sakte hain?`;
    if (language === "HINDI") return `${prefix}क्या आप ${labels[0]} बता सकते हैं?`;
    return `${prefix}Could you share ${labels[0]}?`;
  }
  const bullets = combineMissingLabels(labels);
  if (language === "HINGLISH") return `${prefix}Kya aap ye bata sakte hain:\n${bullets}`;
  if (language === "HINDI") return `${prefix}क्या आप ये बता सकते हैं:\n${bullets}`;
  return `${prefix}To plan this well, could you share:\n${bullets}`;
}

/**
 * Sprint 6.5 — Part 12: when the traveler just supplied a broad date WINDOW ("next month", "next week")
 * rather than a precise day, acknowledge what was understood and invite — never demand — more precision:
 * "September works. Do you have a preferred departure date, or should I look across the month?" instead
 * of a generic "please provide an exact travel date." Re-parses the raw turn text directly (cheap, pure,
 * no coupling to the entity-merge pipeline) rather than threading window metadata through it, so this is
 * safe to call from every `safeGenerateReply` call site uniformly. Returns null once a precise
 * `departureDate` is already known (nothing to acknowledge) or when the phrase didn't resolve to a
 * window at all (an exact date needs no such caveat).
 */
export function buildDateWindowAcknowledgment(
  entities: TravelEntities,
  userMessage: string,
  language: TravelResponseLanguage = "ENGLISH"
): string | null {
  if (entities.departureDate || !entities.travelMonth) return null;
  const interpretation = interpretDatePhrase(userMessage);
  if (interpretation.windowType !== "MONTH" && interpretation.windowType !== "WEEK") return null;
  const month = entities.travelMonth;
  if (language === "HINGLISH")
    return `${month} theek rahega. Koi specific departure date chahiye, ya poore mahine mein dhoondhun?`;
  if (language === "HINDI") return `${month} ठीक रहेगा। कोई विशेष प्रस्थान तिथि चाहिए, या पूरे महीने में देखूं?`;
  return `${month} works. Do you have a preferred departure date, or should I look across the month?`;
}

/** Adapts the extended entity schema to the legacy slot shape so the deterministic recommendation/CRM builders can be reused unchanged. */
export function toLegacySlots(entities: TravelEntities): TravelSlots {
  return {
    destination: entities.destinationCity,
    travelMonth: entities.travelMonth,
    durationDays: entities.days,
    passengers:
      entities.adults !== null ? entities.adults + (entities.children ?? 0) : entities.totalTravellers,
    budgetAmount: entities.budget,
    budgetCurrency: entities.budgetCurrency
  };
}

/**
 * Builds the memory-persisted state document: legacy TravelState fields plus the full extended entity
 * schema. `memory`, when given, additionally persists confirmation metadata, any in-flight city
 * clarification, and which field was last asked about — without this, confirmed-entity immutability and
 * clarification state would reset every turn, since each request reconstructs the orchestrator fresh.
 */
export function entitiesToStoredState(
  entities: TravelEntities,
  stage: TravelStage,
  memory?: TravelConversationMemory
): Record<string, unknown> {
  const legacy = toLegacySlots(entities);
  return {
    ...legacy,
    stage,
    missingFields: computeMissingEntityFields(entities, memory?.budgetMode),
    onboardingCompleted: entities.customerName !== null,
    // This is only ever called on a turn after the proactive greeting has already been shown (see
    // AgentService.execute's greeting bypass) — greetingSent is therefore always true here by construction.
    greetingSent: true,
    ...entities,
    ...(memory
      ? {
          entityConfirmation: memory.confirmation,
          pendingClarification: memory.pendingClarification,
          lastAskedField: memory.lastAskedField,
          budgetMode: memory.budgetMode,
          pendingAction: memory.pendingAction,
          pendingInputAction: memory.pendingInputAction,
          pendingContactValue: memory.pendingContactValue,
          conversationClosed: memory.conversationClosed,
          responseLanguage: memory.responseLanguage,
          budgetDiscussionCompleted: memory.budgetDiscussionCompleted,
          lastBudgetEstimate: memory.lastBudgetEstimate,
          pendingPassengerConflict: memory.pendingPassengerConflict,
          pendingDepartureDate: memory.pendingDepartureDate,
          journey: memory.journey,
          lastGeneratedItinerary: memory.lastGeneratedItinerary,
          providerFailure: memory.providerFailure,
          completionStage: memory.completionStage,
          capturedLeadReference: memory.capturedLeadReference,
          displayCurrency: memory.displayCurrency,
          pendingRouteClarification: memory.pendingRouteClarification,
          pendingRecommendations: memory.pendingRecommendations,
          selectedRecommendationId: memory.selectedRecommendationId,
          passengerDetails: memory.passengerDetails,
          pendingResendLookup: memory.pendingResendLookup,
          ticketContact: memory.ticketContact,
          budgetOverrideAccepted: memory.budgetOverrideAccepted
        }
      : {})
  };
}

const VALID_BUDGET_MODES: readonly TravelBudgetMode[] = ["UNKNOWN", "USER_DEFINED", "AGENT_RECOMMENDED", "FLEXIBLE"];
const VALID_PENDING_ACTIONS: readonly Exclude<TravelPendingAction, null>[] = [
  "GENERATE_BUDGET_GUIDANCE",
  "SEARCH_OPTIONS",
  "GENERATE_ITINERARY",
  "MODIFY_HOTEL_BUDGET",
  "BOOK_FLIGHT",
  "BOOK_HOTEL",
  "BOOK_TRIP",
  "AWAITING_OPTION_SELECTION",
  "AWAITING_PASSENGER_DETAILS",
  "AWAITING_TICKET_CONTACT",
  "AWAITING_BOOKING_CONFIRMATION",
  "AWAITING_RESEND_TICKET_DETAILS",
  "AWAITING_BUDGET_OVERRIDE_CONFIRMATION"
];
const VALID_PENDING_INPUT_ACTIONS: readonly Exclude<TravelPendingInputAction, null>[] = [
  "AWAITING_LEAD_CONTACT",
  "AWAITING_LEAD_CONSENT",
  "CONFIRM_STANDALONE_CONTACT_USE",
  "AWAITING_PASSENGER_COMPOSITION",
  "AWAITING_TRAVEL_YEAR"
];
const VALID_RESPONSE_LANGUAGES: readonly TravelResponseLanguage[] = ["ENGLISH", "HINDI", "HINGLISH"];

/** Reconstructs {@link TravelConversationMemory} from a stored state document, defaulting safely for older documents. */
export function memoryFromStoredState(value: Record<string, unknown> | null | undefined): TravelConversationMemory {
  if (!value) return EMPTY_TRAVEL_CONVERSATION_MEMORY;
  const confirmation =
    typeof value.entityConfirmation === "object" && value.entityConfirmation !== null
      ? (value.entityConfirmation as TravelEntityConfirmation)
      : EMPTY_TRAVEL_ENTITY_CONFIRMATION;
  const pendingClarification =
    typeof value.pendingClarification === "object" && value.pendingClarification !== null
      ? (value.pendingClarification as PendingCityClarification)
      : null;
  const lastAskedField = typeof value.lastAskedField === "string" ? value.lastAskedField : null;
  const budgetMode =
    typeof value.budgetMode === "string" &&
    (VALID_BUDGET_MODES as readonly string[]).includes(value.budgetMode)
      ? (value.budgetMode as TravelBudgetMode)
      : "UNKNOWN";
  const pendingAction =
    typeof value.pendingAction === "string" &&
    (VALID_PENDING_ACTIONS as readonly string[]).includes(value.pendingAction)
      ? (value.pendingAction as TravelPendingAction)
      : null;
  const pendingInputAction =
    typeof value.pendingInputAction === "string" &&
    (VALID_PENDING_INPUT_ACTIONS as readonly string[]).includes(value.pendingInputAction)
      ? (value.pendingInputAction as TravelPendingInputAction)
      : value.completionStage === "AWAITING_CONTACT"
        ? "AWAITING_LEAD_CONTACT"
        : null;
  const pendingContactValue =
    typeof value.pendingContactValue === "string" ? value.pendingContactValue : null;
  const conversationClosed = value.conversationClosed === true;
  const responseLanguage =
    typeof value.responseLanguage === "string" &&
    (VALID_RESPONSE_LANGUAGES as readonly string[]).includes(value.responseLanguage)
      ? (value.responseLanguage as TravelResponseLanguage)
      : "ENGLISH";
  const budgetDiscussionCompleted = value.budgetDiscussionCompleted === true;
  const lastBudgetEstimate =
    typeof value.lastBudgetEstimate === "object" && value.lastBudgetEstimate !== null
      ? (value.lastBudgetEstimate as StoredBudgetEstimate)
      : null;
  const pendingPassengerConflict =
    typeof value.pendingPassengerConflict === "object" && value.pendingPassengerConflict !== null
      ? (value.pendingPassengerConflict as PendingPassengerConflict)
      : null;
  const rawPendingDepartureDate = value.pendingDepartureDate as Record<string, unknown> | null | undefined;
  const pendingDepartureDate: PendingDepartureDate | null =
    rawPendingDepartureDate &&
    typeof rawPendingDepartureDate.day === "number" &&
    typeof rawPendingDepartureDate.month === "number"
      ? {
          day: rawPendingDepartureDate.day,
          month: rawPendingDepartureDate.month,
          year: null,
          source: "USER_EXPLICIT"
        }
      : null;
  const journey =
    typeof value.journey === "object" &&
    value.journey !== null &&
    typeof (value.journey as Record<string, unknown>).id === "string" &&
    Array.isArray((value.journey as Record<string, unknown>).legs)
      ? (value.journey as Journey)
      : null;
  const lastGeneratedItinerary = typeof value.lastGeneratedItinerary === "string" ? value.lastGeneratedItinerary : null;
  const VALID_PROVIDER_FAILURE_ACTIONS = ["SEARCH_LIVE_OPTIONS", "BOOK_FLIGHT", "BOOK_HOTEL"];
  const rawProviderFailure = value.providerFailure as Record<string, unknown> | null | undefined;
  const providerFailure: ProviderFailureRecord | null =
    typeof rawProviderFailure === "object" &&
    rawProviderFailure !== null &&
    VALID_PROVIDER_FAILURE_ACTIONS.includes(rawProviderFailure.failedAction as string)
      ? {
          failedAction: rawProviderFailure.failedAction as ProviderFailureRecord["failedAction"],
          provider: typeof rawProviderFailure.provider === "string" ? rawProviderFailure.provider : "unknown",
          failedAt: typeof rawProviderFailure.failedAt === "string" ? rawProviderFailure.failedAt : new Date(0).toISOString(),
          retryable: rawProviderFailure.retryable !== false,
          selectedRecoveryAction: (rawProviderFailure.selectedRecoveryAction as ProviderFailureRecoverySelection | null) ?? null,
          // Older persisted records predate the menu-lifecycle fields — default to "already inactive" rather
          // than risk resurrecting a numeric-shortcut window the traveler never actually saw in this session.
          menuActive: rawProviderFailure.menuActive === true,
          menuExpiresAt: typeof rawProviderFailure.menuExpiresAt === "string" ? rawProviderFailure.menuExpiresAt : new Date(0).toISOString()
        }
      : null;
  const VALID_COMPLETION_STAGES: readonly ConversationCompletionStage[] = [
    "NOT_OFFERED",
    "OFFERED",
    "AWAITING_CONTACT",
    "CAPTURED",
    "DECLINED"
  ];
  const completionStage =
    typeof value.completionStage === "string" &&
    (VALID_COMPLETION_STAGES as readonly string[]).includes(value.completionStage)
      ? (value.completionStage as ConversationCompletionStage)
      : "NOT_OFFERED";
  const capturedLeadReference = typeof value.capturedLeadReference === "string" ? value.capturedLeadReference : null;
  const displayCurrency =
    typeof value.displayCurrency === "string" && isSupportedCurrency(value.displayCurrency)
      ? value.displayCurrency.toUpperCase()
      : null;
  const rawPendingRouteClarification = value.pendingRouteClarification as Record<string, unknown> | null | undefined;
  const pendingRouteClarification =
    typeof rawPendingRouteClarification === "object" &&
    rawPendingRouteClarification !== null &&
    typeof rawPendingRouteClarification.originalMessage === "string"
      ? {
          originalMessage: rawPendingRouteClarification.originalMessage,
          fromDestination:
            typeof rawPendingRouteClarification.fromDestination === "string"
              ? rawPendingRouteClarification.fromDestination
              : null,
          toDestination:
            typeof rawPendingRouteClarification.toDestination === "string"
              ? rawPendingRouteClarification.toDestination
              : null
        }
      : null;
  const pendingRecommendations = Array.isArray(value.pendingRecommendations)
    ? (value.pendingRecommendations as SimulatedPackageOption[])
    : null;
  const selectedRecommendationId =
    typeof value.selectedRecommendationId === "string" ? value.selectedRecommendationId : null;
  const passengerDetails = Array.isArray(value.passengerDetails)
    ? (value.passengerDetails as PassengerDetail[]).filter(
        (entry): entry is PassengerDetail =>
          typeof entry === "object" &&
          entry !== null &&
          typeof entry.name === "string" &&
          typeof entry.age === "number" &&
          (entry.gender === "MALE" || entry.gender === "FEMALE" || entry.gender === "OTHER")
      )
    : null;
  const rawPendingResendLookup = value.pendingResendLookup as Record<string, unknown> | null | undefined;
  const pendingResendLookup =
    typeof rawPendingResendLookup === "object" && rawPendingResendLookup !== null
      ? {
          email: typeof rawPendingResendLookup.email === "string" ? rawPendingResendLookup.email : null,
          travelDate: typeof rawPendingResendLookup.travelDate === "string" ? rawPendingResendLookup.travelDate : null
        }
      : null;
  const rawTicketContact = value.ticketContact as Record<string, unknown> | null | undefined;
  const ticketContact =
    typeof rawTicketContact === "object" && rawTicketContact !== null
      ? {
          email: typeof rawTicketContact.email === "string" ? rawTicketContact.email : null,
          phone: typeof rawTicketContact.phone === "string" ? rawTicketContact.phone : null
        }
      : null;
  const budgetOverrideAccepted = value.budgetOverrideAccepted === true;
  return {
    confirmation,
    pendingClarification,
    lastAskedField,
    budgetMode,
    pendingAction,
    pendingInputAction,
    pendingContactValue,
    conversationClosed,
    responseLanguage,
    budgetDiscussionCompleted,
    lastBudgetEstimate,
    pendingPassengerConflict,
    pendingDepartureDate,
    journey,
    lastGeneratedItinerary,
    providerFailure,
    completionStage,
    capturedLeadReference,
    displayCurrency,
    pendingRouteClarification,
    pendingRecommendations,
    selectedRecommendationId,
    passengerDetails,
    pendingResendLookup,
    ticketContact,
    budgetOverrideAccepted
  };
}

/** Reconstructs entities from a stored state document, tolerating older documents that only have legacy TravelSlots fields. */
export function entitiesFromStoredState(value: Record<string, unknown> | null | undefined): TravelEntities {
  if (!value) return EMPTY_TRAVEL_ENTITIES;
  const str = (key: string): string | null => (typeof value[key] === "string" ? (value[key] as string) : null);
  const num = (key: string): number | null => (typeof value[key] === "number" ? (value[key] as number) : null);
  const bool = (key: string): boolean | null => (typeof value[key] === "boolean" ? (value[key] as boolean) : null);
  const adults = num("adults");
  // `passengers` is the legacy TravelSlots mirror — only meaningful as an ambiguous total fallback for a
  // document that predates `totalTravellers` and has no real composition either. Never read it into
  // `adults`, or a stored ambiguous total would silently become "N adults" on the next load.
  const totalTravellers = num("totalTravellers") ?? (adults === null ? num("passengers") : null);
  const storedTripPurpose = str("tripPurpose");
  const tripPurpose: "LEISURE" | "BUSINESS" | null =
    storedTripPurpose === "LEISURE" || storedTripPurpose === "BUSINESS" ? storedTripPurpose : null;
  return {
    customerName: str("customerName"),
    originCity: str("originCity"),
    destinationCity: str("destinationCity") ?? str("destination"),
    departureDate: str("departureDate"),
    travelMonth: str("travelMonth"),
    returnDate: str("returnDate"),
    days: num("days") ?? num("durationDays"),
    nights: num("nights"),
    totalTravellers,
    adults,
    children: num("children"),
    infants: num("infants"),
    budget: num("budget") ?? num("budgetAmount"),
    budgetCurrency: str("budgetCurrency"),
    cabinClass: str("cabinClass"),
    tripType: str("tripType"),
    hotelStars: num("hotelStars"),
    visaRequired: bool("visaRequired"),
    passportStatus: str("passportStatus"),
    tripPurpose,
    preferences: Array.isArray(value.preferences)
      ? (value.preferences as unknown[]).filter((x): x is string => typeof x === "string")
      : []
  };
}

/**
 * Conversation engine for the Travel Employee when a real AI provider (OpenAI-compatible or Azure
 * OpenAI) is configured. Uses that provider for structured entity extraction and for composing the
 * natural-language reply; every other concern — stage progression, missing-field detection, placeholder
 * flight/hotel search, escalation, and CRM-lead capture — reuses the exact same deterministic helpers
 * and tool-calling flow as {@link TravelEmployeeProvider}, so dashboard chat and WhatsApp share this
 * without duplication and remain unaffected by which engine is active.
 */
export class TravelEmployeeLlmOrchestrator implements AiProvider {
  lastEntities: TravelEntities;
  lastStage: TravelStage = "GREETING";
  /** Internal workflow phase for the current/most recent turn — see {@link TravelWorkflowPhase}. */
  lastWorkflowPhase: TravelWorkflowPhase = "COLLECTING_DETAILS";
  /** Per-field confirmation metadata — see {@link TravelEntityConfirmation}. Persisted across turns. */
  confirmation: TravelEntityConfirmation;
  /** A city interpretation awaiting a yes/no from the user. Persisted across turns. */
  pendingClarification: PendingCityClarification | null;
  /** Which field the assistant most recently asked about, for context-sensitive short-answer disambiguation. */
  lastAskedField: string | null;
  /** How the traveler wants their budget handled — see {@link TravelBudgetMode}. Persisted across turns. */
  budgetMode: TravelBudgetMode;
  /** A structured action awaiting a blocking field — see {@link TravelPendingAction}. Persisted across turns. */
  pendingAction: TravelPendingAction;
  pendingInputAction: TravelPendingInputAction;
  pendingContactValue: string | null;
  conversationClosed: boolean;
  /** The language every user-facing reply must be composed in — see {@link TravelResponseLanguage}. */
  responseLanguage: TravelResponseLanguage;
  /** Whether the BELOW_MINIMUM explanation has already been shown at least once. Persisted across turns. */
  budgetDiscussionCompleted: boolean;
  /** The last budget estimate actually shown, if any — see {@link StoredBudgetEstimate}. Persisted across turns. */
  lastBudgetEstimate: StoredBudgetEstimate | null;
  /** A composition breakdown awaiting reconciliation against a previously stated total. Persisted across turns. */
  pendingPassengerConflict: PendingPassengerConflict | null;
  pendingDepartureDate: PendingDepartureDate | null;
  /** The multi-leg trip this conversation is planning, if any — see {@link Journey}. Persisted across turns. */
  journey: Journey | null;
  /** The most recent itinerary text generated, captured into a leg when it is finalized. Persisted across turns. */
  lastGeneratedItinerary: string | null;
  /** The most recent live-provider failure, if not yet retried — see {@link ProviderFailureRecord}. Persisted across turns. */
  providerFailure: ProviderFailureRecord | null;
  /** Where this conversation is in the Conversation Completion & Lead Capture flow — see
   * {@link ConversationCompletionStage}. Persisted across turns. */
  completionStage: ConversationCompletionStage;
  /** The reference of the {@link TravelLead} captured for this conversation, if any — lets a repeat
   * submit/callback/confirm ask re-confirm it instead of asking for a phone number again. Persisted
   * across turns. */
  capturedLeadReference: string | null;
  /** The traveler's chosen display currency for cost figures — see {@link TravelConversationMemory.displayCurrency}. Persisted. */
  displayCurrency: string | null;
  /** An ambiguous route awaiting "same trip or separate trip" — see {@link TravelConversationMemory.pendingRouteClarification}. Persisted. */
  pendingRouteClarification: TravelConversationMemory["pendingRouteClarification"];
  /** Set while a proactively-offered or explicitly-requested lead capture is awaiting its
   * `travel.create_lead` tool response — resolved in `continueAfterTool`. Not persisted across requests:
   * the tool round-trip always completes within the same execution's iteration loop. */
  private pendingLeadCapture = false;
  /** Set while a BELOW_MINIMUM sales handoff is awaiting its CRM-lead tool response. Not persisted across requests. */
  private pendingSalesHandoff: { feasibilityMessage: string } | null = null;
  /** Structured per-turn trace for observability — see {@link TravelTurnDiagnostics}. Not persisted. */
  private diagnostics: TravelTurnDiagnostics | null = null;
  /** Stage 9E: non-null only the turn a Travel Runtime business result (currently only BELOW_MINIMUM
   *  budget feasibility) decided a workflow should start — see {@link TravelRuntimeExecutionMode} and
   *  `lastWorkflowSignal`. Reset at the start of every `complete()` call. Not persisted across requests. */
  private pendingWorkflowSignal: TravelWorkflowSignalDraft | null = null;
  /** Non-null only the turn a routing offer (see `buildOutOfScopeRoutingMessage`) was just confirmed —
   *  same convention as `lastWorkflowSignal`. Reset at the start of every `complete()` call. */
  private routingHandoffSignal: RoutingHandoffSignal | null = null;
  // The LLM orchestrator never generates or reads structured package options itself (that's the
  // deterministic provider's job today — see travel-package-options.ts and the disclosed LLM-parity gap
  // in ARCHITECTURE.md); it only round-trips these two fields so a conversation that used the
  // deterministic provider on an earlier turn never has this state silently dropped by a later turn that
  // happens to hit this orchestrator instead.
  private pendingRecommendations: SimulatedPackageOption[] | null;
  private selectedRecommendationId: string | null;
  private passengerDetails: PassengerDetail[] | null;
  private pendingResendLookup: { email: string | null; travelDate: string | null } | null;
  private ticketContact: { email: string | null; phone: string | null } | null;
  /** See {@link TravelConversationMemory.budgetOverrideAccepted}. Persisted across turns. */
  private budgetOverrideAccepted: boolean;

  constructor(
    private readonly realProvider: AiProvider,
    private readonly config: TravelEmployeeRuntimeConfig,
    priorEntities: TravelEntities,
    priorMemory: TravelConversationMemory = EMPTY_TRAVEL_CONVERSATION_MEMORY,
    private readonly executionMode: TravelRuntimeExecutionMode = "STANDALONE_COMPATIBILITY"
  ) {
    this.lastEntities = priorEntities;
    this.confirmation = priorMemory.confirmation;
    this.pendingClarification = priorMemory.pendingClarification;
    this.lastAskedField = priorMemory.lastAskedField;
    this.budgetMode = priorMemory.budgetMode;
    this.pendingAction = priorMemory.pendingAction;
    this.pendingInputAction =
      priorMemory.pendingInputAction ??
      (priorMemory.completionStage === "AWAITING_CONTACT" ? "AWAITING_LEAD_CONTACT" : null);
    this.pendingContactValue = priorMemory.pendingContactValue ?? null;
    this.conversationClosed = priorMemory.conversationClosed ?? false;
    this.responseLanguage = priorMemory.responseLanguage;
    this.budgetDiscussionCompleted = priorMemory.budgetDiscussionCompleted;
    this.lastBudgetEstimate = priorMemory.lastBudgetEstimate;
    this.pendingPassengerConflict = priorMemory.pendingPassengerConflict;
    this.pendingDepartureDate = priorMemory.pendingDepartureDate ?? null;
    this.journey = priorMemory.journey;
    this.lastGeneratedItinerary = priorMemory.lastGeneratedItinerary;
    // Cloned, never aliased: `menuActive` is mutated in place during a turn (see the invalidation check in
    // `complete()`), and a shared/reused `priorMemory` object (as several tests intentionally do, and as a
    // caller caching memory between conversations might) must never have that mutation leak sideways.
    this.providerFailure = priorMemory.providerFailure ? { ...priorMemory.providerFailure } : null;
    this.completionStage = priorMemory.completionStage;
    this.capturedLeadReference = priorMemory.capturedLeadReference;
    this.displayCurrency = priorMemory.displayCurrency;
    this.pendingRouteClarification = priorMemory.pendingRouteClarification;
    this.pendingRecommendations = priorMemory.pendingRecommendations ?? null;
    this.selectedRecommendationId = priorMemory.selectedRecommendationId ?? null;
    this.passengerDetails = priorMemory.passengerDetails ?? null;
    this.pendingResendLookup = priorMemory.pendingResendLookup ?? null;
    this.ticketContact = priorMemory.ticketContact ?? null;
    this.budgetOverrideAccepted = priorMemory.budgetOverrideAccepted ?? false;
  }

  /** Snapshot of everything besides plain entity values that must be persisted between turns. */
  get lastMemory(): TravelConversationMemory {
    return {
      confirmation: this.confirmation,
      pendingClarification: this.pendingClarification,
      lastAskedField: this.lastAskedField,
      budgetMode: this.budgetMode,
      pendingAction: this.pendingAction,
      pendingInputAction: this.pendingInputAction,
      pendingContactValue: this.pendingContactValue,
      conversationClosed: this.conversationClosed,
      responseLanguage: this.responseLanguage,
      budgetDiscussionCompleted: this.budgetDiscussionCompleted,
      lastBudgetEstimate: this.lastBudgetEstimate,
      pendingPassengerConflict: this.pendingPassengerConflict,
      pendingDepartureDate: this.pendingDepartureDate,
      journey: this.journey,
      lastGeneratedItinerary: this.lastGeneratedItinerary,
      providerFailure: this.providerFailure,
      completionStage: this.completionStage,
      capturedLeadReference: this.capturedLeadReference,
      displayCurrency: this.displayCurrency,
      pendingRouteClarification: this.pendingRouteClarification,
      pendingRecommendations: this.pendingRecommendations,
      selectedRecommendationId: this.selectedRecommendationId,
      passengerDetails: this.passengerDetails,
      pendingResendLookup: this.pendingResendLookup,
      ticketContact: this.ticketContact,
      budgetOverrideAccepted: this.budgetOverrideAccepted
    };
  }

  /** Structured diagnostic trace for the most recently completed turn — see {@link TravelTurnDiagnostics}. */
  get lastDiagnostics(): TravelTurnDiagnostics | null {
    return this.diagnostics;
  }

  /** Stage 9E: see the field doc above. AgentService reads this once per turn (PLATFORM_MANAGED mode
   *  only — always null in STANDALONE_COMPATIBILITY) and hands it to WorkflowCoordinator.dispatchSignal. */
  get lastWorkflowSignal(): TravelWorkflowSignalDraft | null {
    return this.pendingWorkflowSignal;
  }

  get lastRoutingHandoffSignal(): RoutingHandoffSignal | null {
    return this.routingHandoffSignal;
  }

  /**
   * Tags the branch this turn resolved to, then — for a real text reply on a branch where the traveler
   * just received something substantial (see {@link GOAL_ENGINE_ELIGIBLE_BRANCHES}) — appends either the
   * Conversation Completion offer (at most once per conversation, and only in place of the Goal Engine
   * suggestions on the turn it fires, never both at once) or the Goal Engine's suggested next actions.
   * A pending tool call (no text yet) or an ineligible branch passes through unchanged.
   */
  private tag(branch: string, result: AiCompletionResult): AiCompletionResult {
    if (this.diagnostics) {
      this.diagnostics.branch = branch;
      this.diagnostics.toolCallsAttempted = result.toolCalls.map((call) => call.name);
    }
    if (result.toolCalls.length > 0 || !result.content || !GOAL_ENGINE_ELIGIBLE_BRANCHES.has(branch)) return result;
    if (this.completionStage === "NOT_OFFERED" && this.isReadyForCompletionOffer()) {
      this.completionStage = "OFFERED";
      this.lastStage = "OFFER_TRAVEL_REQUEST";
      return {
        ...result,
        content: `${result.content}\n\n${buildCompletionOfferMessage(this.lastEntities.customerName, this.responseLanguage)}`
      };
    }
    const suggestions = computeSuggestedActions(branch, this.lastEntities, this.lastGeneratedItinerary !== null);
    if (!suggestions.length) return result;
    return { ...result, content: `${result.content}${formatSuggestedActionsLocalized(suggestions, this.responseLanguage)}` };
  }

  /** Whether this is a good moment to proactively offer to submit the travel request — core trip details
   * complete and something substantial already delivered. `completionStage` (checked by the caller) is
   * what actually prevents re-offering after an explicit submit/callback/confirm already ran this
   * conversation — both paths share the same stage, so there is nothing further to check here. */
  private isReadyForCompletionOffer(): boolean {
    // A budget-override question is itself a pending, more specific yes/no ask — see
    // AWAITING_BUDGET_OVERRIDE_CONFIRMATION. Offering "submit this travel request?" on the SAME turn (or
    // reading a later "yes" answering the override question as an affirmative reply to THIS offer, via
    // ContactCaptureWorkflowService.shouldStart's own OFFERED+affirmative trigger) would ask two competing
    // questions/hijack one answer for the wrong question. `completionStage` deliberately stays untouched
    // (still NOT_OFFERED) so the legitimate completion offer can still fire normally once this resolves.
    if (this.pendingAction === "AWAITING_BUDGET_OVERRIDE_CONFIRMATION") return false;
    if (computeMissingEntityFields(this.lastEntities, this.budgetMode).length > 0) return false;
    return this.lastBudgetEstimate !== null || this.lastGeneratedItinerary !== null;
  }

  /** All captured trip preferences, shaped for `travel.search_flights` / `travel.search_hotels` tool calls. */
  private buildToolTripContext(entities: TravelEntities): Record<string, unknown> {
    return {
      origin: entities.originCity,
      destination: entities.destinationCity,
      travelMonth: entities.travelMonth,
      departureDate: entities.departureDate,
      returnDate: entities.returnDate,
      durationDays: entities.days,
      nights: entities.nights,
      adults: entities.adults,
      children: entities.children,
      infants: entities.infants,
      hotelStars: entities.hotelStars,
      budget: entities.budget,
      currency: entities.budgetCurrency,
      cabinClass: entities.cabinClass,
      preferences: entities.preferences
    };
  }

  /** Payload for the `travel.create_lead` tool call — see `TravelLead` (database/prisma/schema.prisma).
   * The reference is generated here (Travel-owned copy), not by the persistence handler, so the
   * confirmation message and the stored row are guaranteed to agree on it. When a multi-leg journey
   * exists (see {@link Journey}), the destination and summary cover every leg, not just the current one —
   * the same "submit the whole journey" behavior the old CRM-only path had. */
  private buildTravelLeadPayload(phoneNumber: string): Record<string, unknown> {
    const entities = this.lastEntities;
    const legs = this.journey ? this.collectAllJourneyLegs(this.journey, entities) : null;
    // The COMPLETE route, including the very first leg's own origin — never just the chain of
    // destinations (which would silently drop where the journey started from).
    const destination = legs && legs.length > 1 ? describeJourneyRoute(legs) : entities.destinationCity;
    const conversationSummary =
      legs && legs.length > 1
        ? legs
            .map((leg, index) => `Leg ${index + 1}: ${leg.origin ?? "?"} -> ${leg.destination ?? "?"}`)
            .join(" | ")
        : buildLeadConversationSummary(entities);
    return {
      reference: generateLeadReference("TRV"),
      // Ties this lead to the SAME journey-scoped idempotency key `TravelLeadService` uses — a repeated
      // "ji"/"haan"/re-submit for this same journey collapses onto one lead; a genuinely new journey (a
      // fresh `Journey.id`) always gets its own.
      journeyId: this.journey?.id ?? null,
      customerName: entities.customerName,
      phoneNumber,
      departureCity: entities.originCity,
      destination,
      travelDates: entities.departureDate ?? entities.travelMonth,
      passengers: formatPassengerSummaryForLead(entities),
      // No dedicated "business vs leisure" purpose is collected anywhere in this runtime today — left null
      // rather than mislabeling `tripType` (ONE_WAY/ROUND_TRIP/MULTI_CITY, a route shape, not a purpose).
      tripPurpose: null,
      budgetAmount: entities.budget,
      budgetCurrency: entities.budgetCurrency,
      displayCurrency: this.displayCurrency,
      conversationSummary
    };
  }

  private recommendationOptions(entities: TravelEntities, starNote?: string | null): RecommendationOptions {
    return {
      consultantStyle: true,
      originCity: entities.originCity,
      adults: entities.adults,
      children: entities.children,
      infants: entities.infants,
      starNote: starNote ?? null
    };
  }

  /** The COLLECT_NAME gate's reply — acknowledges any destination captured this same turn, never silently drops it. */
  private buildNameGateReply(entities: TravelEntities, changed: string[]): string {
    const mentionedDestination = changed.some((entry) => entry.startsWith("destinationCity=")) && entities.destinationCity;
    if (mentionedDestination) {
      if (this.responseLanguage === "HINGLISH")
        return `${entities.destinationCity} sounds good. Planning shuru karne se pehle, may I know your name?`;
      if (this.responseLanguage === "HINDI")
        return `${entities.destinationCity} बढ़िया विकल्प है। योजना शुरू करने से पहले, क्या मैं आपका नाम जान सकता/सकती हूँ?`;
      return `${entities.destinationCity} sounds like a wonderful choice! Before we get started, may I know your name?`;
    }
    if (this.responseLanguage === "HINGLISH") return "Bataiye, aapka naam kya hai?";
    if (this.responseLanguage === "HINDI") return "क्या मैं आपका नाम जान सकता/सकती हूँ?";
    return "Before we get started, may I know your name?";
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    this.pendingWorkflowSignal = null;
    this.routingHandoffSignal = null;
    const messages = request.messages;
    const last = messages.at(-1);
    const currentText = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
    // Attached document (PDF/DOCX/TXT/JPG/PNG): the extracted text arrives as `[Attachment: ...]` blocks.
    // Read the document, state its intent, and — if it clearly belongs to a different employee's domain —
    // offer to route it, instead of treating the file's text as ordinary trip input. Handled identically to
    // the deterministic TravelEmployeeProvider so both engines behave the same.
    const travelAttachmentBlocks = parseAttachmentBlocks(currentText);
    if (travelAttachmentBlocks.length > 0 && last?.role !== "tool") {
      return textResult(buildAttachmentReadMessage(TRAVEL_ATTACHMENT_SPEC, travelAttachmentBlocks));
    }
    // Out-of-scope routing for ordinary messages too: a reimbursement/expense/HR request that has nothing
    // to do with trip planning is answered with a polite "not my area — I can route you" reply instead of
    // forcing the traveler through trip-detail questions. Only when there is no active workflow/booking
    // flow in progress (never interrupts contact capture or an active pending action).
    if (
      last?.role !== "tool" &&
      this.pendingAction === null &&
      this.completionStage !== "AWAITING_CONTACT" &&
      this.completionStage !== "CAPTURED"
    ) {
      // Confirming a previously offered routing handoff ("yes", "route it", ...) — checked before a fresh
      // out-of-scope detection, since the confirmation reply itself ("yes") never carries any domain signal.
      const confirmation = detectRoutingConfirmation(TRAVEL_ATTACHMENT_SPEC, messages);
      if (confirmation) {
        this.routingHandoffSignal = {
          targetSlug: confirmation.target.slug,
          originalText: confirmation.originalText
        };
        return textResult(`Connecting you to ${confirmation.target.displayName}…`);
      }
      // Sprint 6.4 — Part 10: see the identical fix in TravelEmployeeProvider.complete() above — a bare
      // "budget"/"invoice"-style word that only echoes what Travel itself just asked must never bounce to
      // another employee (contextEcho, inside detectOutOfScopeEmployee).
      const recentOwnMessage =
        [...messages].reverse().find((message) => message.role === "assistant")?.content ?? null;
      const travelOutOfScope = detectOutOfScopeEmployee(TRAVEL_ATTACHMENT_SPEC, currentText, recentOwnMessage);
      if (travelOutOfScope) {
        return textResult(buildOutOfScopeRoutingMessage(TRAVEL_ATTACHMENT_SPEC, travelOutOfScope));
      }
    }
    // Once a greeting has already been shown as its own turn (the normal proactive-greeting flow),
    // `isFirstTurn` must never be true again — otherwise the configured welcome message gets recited a
    // second time inline on the traveler's first substantive reply. "No assistant turn has happened yet
    // at all" is the real condition, not "this is the traveler's first reply".
    const hasAssistantHistory = messages.some((message) => message.role === "assistant");
    const isFirstTurn = messages.filter((message) => message.role === "user").length <= 1 && !hasAssistantHistory;
    // Captured before anything below can mutate `this.lastEntities` — ADD_TRIP_LEG needs the leg that was
    // in progress BEFORE this turn, and reading it here means a misclassified intent (e.g. the LLM reading
    // "continue to New York" as `start_new_trip`) can never wipe it out from under the finalize step.
    const priorEntitiesSnapshot = this.lastEntities;

    // Language detection from the traveler's own wording, upgrade-only (sticky) so an English city name or
    // date word embedded in an otherwise Hinglish/Hindi message never flips the conversation to English.
    if (currentText.trim())
      this.responseLanguage = mergeResponseLanguage(this.responseLanguage, detectResponseLanguage(currentText));

    this.diagnostics = {
      runtime: "llm_orchestrator",
      pendingActionBefore: this.pendingAction,
      budgetModeBefore: this.budgetMode,
      responseLanguage: this.responseLanguage,
      intent: null,
      extractedEntityKeys: [],
      changedFields: [],
      branch: "unresolved",
      toolCallsAttempted: [],
      feasibility: null,
      toolExecutionSkippedForFeasibility: false,
      extractedTotalTravellers: null,
      extractedComposition: null,
      passengerStateBeforeMerge: computePassengerState(this.lastEntities),
      passengerState: computePassengerState(this.lastEntities),
      passengerClarificationRequired: false,
      planningAction: null,
      budgetDiscussionCompletedBefore: this.budgetDiscussionCompleted,
      journeyId: this.journey?.id ?? null,
      journeyLegCountBefore: this.journey?.legs.length ?? 0,
      providerFailureActiveBefore: this.providerFailure !== null,
      recoveryMenuActiveBefore: isRecoveryMenuActive(this.providerFailure),
      itineraryFallbackUsed: false,
      itineraryValidationIssues: []
    };

    if (last?.role === "tool") return this.tag("tool_continuation", this.continueAfterTool(messages, last, request.tools));

    // Resend Ticket — same priority/behavior as the deterministic provider (see its own copy of this
    // block for the full rationale): checked ahead of every other routing below so it works even in a
    // brand-new conversation, before the LLM's own intent classification or entity extraction runs.
    if (this.pendingAction === "AWAITING_RESEND_TICKET_DETAILS" || isResendTicketRequest(currentText)) {
      const priorLookup = this.pendingResendLookup;
      const email = extractEmailAddress(currentText) ?? priorLookup?.email ?? null;
      const travelDate = extractResendTicketDate(currentText) ?? priorLookup?.travelDate ?? null;
      if (!email) {
        this.pendingAction = "AWAITING_RESEND_TICKET_DETAILS" as TravelPendingAction;
        this.pendingResendLookup = { email, travelDate };
        return this.tag(
          "resend_ticket_ask_details",
          textResult(
            "I can resend your ticket — could you share the email address you booked with, and your travel date if you remember it?"
          )
        );
      }
      this.pendingAction = null;
      this.pendingResendLookup = null;
      return this.tag(
        "resend_ticket_lookup",
        toolResult("travel.resend_ticket", { email, travelDate, customerName: extractCustomerName([currentText]) ?? this.lastEntities.customerName })
      );
    }

    // Fix (Travel Booking UAT correction pass — budget-override bug): an explicit, priced yes/no question
    // is pending — see `handleBelowMinimumFeasibility`/`buildBudgetOverrideQuestion`. Only an affirmative
    // reply to THIS exact question ever sets `budgetOverrideAccepted`, and only then are the above-budget
    // options (already generated and stashed in `pendingRecommendations` when the question was asked) ever
    // actually shown. A decline falls back to the existing lead-capture offer, unchanged. Checked ahead of
    // every other routing below, mirroring every other single-purpose pending-input gate in this class.
    if (this.pendingAction === "AWAITING_BUDGET_OVERRIDE_CONFIRMATION") {
      if (isAffirmativeResponse(currentText) && !isNegativeResponse(currentText)) {
        this.budgetOverrideAccepted = true;
        const options =
          this.pendingRecommendations?.length
            ? this.pendingRecommendations
            : generateSimulatedPackageOptions(this.lastEntities, this.config, packageOptionSeed(this.lastEntities));
        this.pendingAction = "AWAITING_OPTION_SELECTION" as TravelPendingAction;
        this.pendingRecommendations = options;
        this.selectedRecommendationId = null;
        return this.tag("budget_override_accepted", textResult(formatPackageOptionsMessage(options)));
      }
      // Fix (Travel Booking Closure Pass — Phase 1 regression fix, found via automated test rather than
      // live UAT): deliberately no `!isFarewellMessage(currentText)` guard here, unlike the analogous
      // AWAITING_LEAD_CONTACT branch elsewhere in this file. "no thanks" is BOTH a farewell phrase (see
      // FAREWELL_PHRASE) AND the single most natural way to decline this specific yes/no question — for
      // THIS narrow, unambiguous pending question, a negative reply always means "no, don't show me
      // above-budget options," never "goodbye, end this whole conversation." Confirmed via a direct
      // reproduction: with the guard in place, "no thanks" fell through to the ambiguous re-ask branch and
      // silently re-asked the same question forever instead of declining.
      //
      // Also treats a volunteered phone/email as an equally sufficient decline signal — a customer who
      // skips ahead and just types their number instead of answering yes/no is clearly not asking for
      // above-budget options, and re-asking "would you like options above budget?" while ignoring the
      // contact info they just gave would waste it: `dispatchSignal`'s downstream `TripSubmissionWorkflowService.
      // start()` reads THIS SAME TURN's raw text for its own "immediate contact" shortcut (see
      // `extractContactValue`), so emitting the signal on the same turn the number was typed lets the lead
      // be captured immediately instead of asking the customer to repeat themselves.
      if (isNegativeResponse(currentText) || extractEmailAddress(currentText) || extractPhoneNumber(currentText)) {
        this.pendingAction = null;
        this.pendingRecommendations = null;
        if (this.completionStage !== "CAPTURED") {
          this.completionStage = "AWAITING_CONTACT";
          this.pendingInputAction = "AWAITING_LEAD_CONTACT";
          // Fix (Travel Booking Closure Pass — Phase 1 regression fix): mirrors
          // `handleBelowMinimumFeasibility`'s own PLATFORM_MANAGED branch exactly — without this, declining
          // the budget-override offer transitioned the legacy memory fields correctly but never actually
          // gave WorkflowCoordinator authority over the next turn's contact reply (no TRIP_SUBMISSION
          // workflow would ever start), silently breaking lead capture for this path in PLATFORM_MANAGED
          // mode. Never emitted in STANDALONE_COMPATIBILITY, matching every other signal-emission site.
          if (this.executionMode === "PLATFORM_MANAGED") {
            this.pendingWorkflowSignal = { signalType: "START_TRIP_SUBMISSION", trigger: "BELOW_MINIMUM_BUDGET" };
          }
        }
        return this.tag("budget_override_declined", textResult(buildContactRequestMessage(this.responseLanguage)));
      }
      // Neither a clear yes nor no — re-ask the same priced question rather than letting an ambiguous
      // reply fall through to generic classification (which could misroute it as an unrelated request).
      const options =
        this.pendingRecommendations?.length
          ? this.pendingRecommendations
          : generateSimulatedPackageOptions(this.lastEntities, this.config, packageOptionSeed(this.lastEntities));
      this.pendingRecommendations = options;
      const lowest = options.reduce((min, option) => (option.totalAmount < min.totalAmount ? option : min), options[0]!);
      const feasibilityForReask =
        this.lastEntities.budget !== null
          ? classifyBudgetFeasibility(this.lastEntities.budget, estimateBudgetRange(this.lastEntities, this.config))
          : null;
      return this.tag(
        "budget_override_reask",
        textResult(
          feasibilityForReask
            ? buildBudgetOverrideQuestion(feasibilityForReask, lowest.totalAmount, lowest.currency, this.responseLanguage)
            : "Would you like me to continue with options above your budget?"
        )
      );
    }

    // Booking options: an option set is pending selection, passenger details are pending, or the final
    // confirmation summary is pending an explicit "Confirm booking" — mirrors the deterministic
    // provider's own three-stage flow exactly (see travel-package-options.ts), reusing the SAME
    // functions so both engines produce identical option sets/summaries for identical trip state.
    if (this.pendingAction === "AWAITING_OPTION_SELECTION" && this.pendingRecommendations?.length) {
      const pendingOptions = this.pendingRecommendations;
      if (isChangeOptionRequest(currentText)) {
        return this.tag("booking_options_reshow", textResult(formatPackageOptionsMessage(pendingOptions)));
      }
      const picked = detectOptionSelection(currentText);
      if (picked !== null) {
        if (isOptionSetExpired(pendingOptions)) {
          const fresh = generateSimulatedPackageOptions(this.lastEntities, this.config, packageOptionSeed(this.lastEntities));
          this.pendingRecommendations = fresh;
          this.selectedRecommendationId = null;
          return this.tag(
            "booking_options_expired",
            textResult(`Those options have expired — here is a fresh set:\n\n${formatPackageOptionsMessage(fresh)}`)
          );
        }
        const selected = pendingOptions.find((option) => option.optionNumber === picked);
        if (selected) {
          const alreadyCollected = this.passengerDetails ?? [];
          if (alreadyCollected.length >= selected.travellers) {
            this.selectedRecommendationId = selected.recommendationId;
            if (this.ticketContact === null) {
              this.pendingAction = "AWAITING_TICKET_CONTACT" as TravelPendingAction;
              return this.tag("ticket_contact_ask", textResult(buildTicketContactRequestMessage()));
            }
            this.pendingAction = "AWAITING_BOOKING_CONFIRMATION" as TravelPendingAction;
            return this.tag(
              "booking_confirmation_summary",
              textResult(buildBookingConfirmationSummary(this.lastEntities, selected, alreadyCollected.slice(0, selected.travellers)))
            );
          }
          this.pendingAction = "AWAITING_PASSENGER_DETAILS" as TravelPendingAction;
          this.selectedRecommendationId = selected.recommendationId;
          return this.tag(
            "booking_passenger_details_ask",
            textResult(buildPassengerDetailsRequestMessage(selected.travellers, alreadyCollected))
          );
        }
      }
      return this.tag(
        "booking_options_reprompt",
        textResult("Sorry, I didn't catch which one you'd like — Value, Recommended, or Premium?")
      );
    }

    if (this.pendingAction === "AWAITING_PASSENGER_DETAILS") {
      const pendingOptions = this.pendingRecommendations ?? [];
      const selected = pendingOptions.find((option) => option.recommendationId === this.selectedRecommendationId);
      if (!selected) {
        this.pendingAction = null;
        this.selectedRecommendationId = null;
        this.passengerDetails = null;
        return this.tag(
          "booking_options_lost",
          textResult("Something went wrong with your booking options — please ask to book your trip again.")
        );
      }
      if (isChangeOptionRequest(currentText)) {
        this.pendingAction = "AWAITING_OPTION_SELECTION" as TravelPendingAction;
        this.selectedRecommendationId = null;
        return this.tag("booking_options_reshow", textResult(formatPackageOptionsMessage(pendingOptions)));
      }
      const newlyParsed = parsePassengerDetailsReply(currentText);
      const collected = [...(this.passengerDetails ?? []), ...newlyParsed].slice(0, selected.travellers);
      if (collected.length < selected.travellers) {
        this.passengerDetails = collected.length ? collected : null;
        return this.tag(
          "booking_passenger_details_ask",
          textResult(buildPassengerDetailsRequestMessage(selected.travellers, collected))
        );
      }
      this.passengerDetails = collected;
      if (this.ticketContact === null) {
        this.pendingAction = "AWAITING_TICKET_CONTACT" as TravelPendingAction;
        return this.tag("ticket_contact_ask", textResult(buildTicketContactRequestMessage()));
      }
      this.pendingAction = "AWAITING_BOOKING_CONFIRMATION" as TravelPendingAction;
      return this.tag(
        "booking_confirmation_summary",
        textResult(buildBookingConfirmationSummary(this.lastEntities, selected, collected))
      );
    }

    if (this.pendingAction === "AWAITING_TICKET_CONTACT") {
      const pendingOptions = this.pendingRecommendations ?? [];
      const selected = pendingOptions.find((option) => option.recommendationId === this.selectedRecommendationId);
      if (!selected) {
        this.pendingAction = null;
        this.selectedRecommendationId = null;
        this.passengerDetails = null;
        this.ticketContact = null;
        return this.tag(
          "booking_options_lost",
          textResult("Something went wrong with your booking options — please ask to book your trip again.")
        );
      }
      const confirmedPassengers = this.passengerDetails ?? [];
      if (isChangeOptionRequest(currentText)) {
        this.pendingAction = "AWAITING_OPTION_SELECTION" as TravelPendingAction;
        this.selectedRecommendationId = null;
        return this.tag("booking_options_reshow", textResult(formatPackageOptionsMessage(pendingOptions)));
      }
      // Fix (Travel Booking Closure Pass — Phase 3): extract an actual contact value FIRST — see the
      // deterministic provider's own copy of this comment for why (a real email/phone must always be
      // honored even alongside an incidental "chat"/"no email"-shaped word).
      const email = extractEmailAddress(currentText);
      const phone = extractPhoneNumber(currentText);
      if (email || phone) {
        this.ticketContact = { email, phone };
        this.pendingAction = "AWAITING_BOOKING_CONFIRMATION" as TravelPendingAction;
        return this.tag(
          "booking_confirmation_summary",
          textResult(buildBookingConfirmationSummary(this.lastEntities, selected, confirmedPassengers))
        );
      }
      if (isSkipTicketContactRequest(currentText)) {
        this.ticketContact = { email: null, phone: null };
        this.pendingAction = "AWAITING_BOOKING_CONFIRMATION" as TravelPendingAction;
        return this.tag(
          "booking_confirmation_summary",
          textResult(buildBookingConfirmationSummary(this.lastEntities, selected, confirmedPassengers))
        );
      }
      return this.tag("ticket_contact_ask", textResult(buildTicketContactRequestMessage()));
    }

    if (this.pendingAction === "AWAITING_BOOKING_CONFIRMATION") {
      const pendingOptions = this.pendingRecommendations ?? [];
      const selected = pendingOptions.find((option) => option.recommendationId === this.selectedRecommendationId);
      const confirmedPassengers = this.passengerDetails ?? [];
      if (isChangeOptionRequest(currentText) && pendingOptions.length) {
        this.pendingAction = "AWAITING_OPTION_SELECTION" as TravelPendingAction;
        this.selectedRecommendationId = null;
        return this.tag("booking_options_reshow", textResult(formatPackageOptionsMessage(pendingOptions)));
      }
      if (isExplicitBookingConfirmationReply(currentText) && selected) {
        const entities = this.lastEntities;
        this.pendingWorkflowSignal = {
          signalType: "START_BOOKING_HANDOFF",
          trigger: "BOOKING_INTENT",
          payload: {
            destinationCity: entities.destinationCity,
            originCity: entities.originCity,
            travelDates: entities.departureDate ?? entities.travelMonth,
            selectedOption: selected as unknown as Record<string, unknown>,
            passengerDetails: confirmedPassengers as unknown as Record<string, unknown>[],
            customerEmail: this.ticketContact?.email ?? null,
            customerPhone: this.ticketContact?.phone ?? null
          }
        };
        this.pendingAction = null;
        this.passengerDetails = null;
        this.ticketContact = null;
        return this.tag(
          "booking_confirmed_submit",
          textResult(
            "Thank you — I've submitted your booking request. Your booking request has been received and is waiting for approval. You'll be notified once a decision is made."
          )
        );
      }
      const fallbackOption = selected ?? pendingOptions[0];
      if (!fallbackOption) {
        this.pendingAction = null;
        this.selectedRecommendationId = null;
        return this.tag(
          "booking_options_lost",
          textResult("Something went wrong with your booking options — please ask to book your trip again.")
        );
      }
      return this.tag(
        "booking_confirmation_summary",
        textResult(buildBookingConfirmationSummary(this.lastEntities, fallbackOption, confirmedPassengers))
      );
    }

    // An explicit "book"-verb request (not just a generic "yes, show me options") generates the same
    // structured, selectable Option 1/2/3 package set as the deterministic provider, instead of this
    // class's own free-text indicative-range recommendation — that prose flow stays exactly as-is for a
    // plain "show me options"/"what would you recommend" ask, which never itself starts a booking.
    //
    // Deliberately NOT `detectSprintIntent`/the shared `bookingPatterns` here (unlike the deterministic
    // provider's own equivalent check): this class already has its own tested "would you like me to look
    // up options now?" -> SEARCH_OPTIONS -> "go ahead"/"yes" resume flow, and `bookingPatterns` includes
    // broad phrases like "go ahead" and bare "option 1/2" that are exactly what that flow's own resume
    // step expects — reusing them here hijacked that unrelated, already-tested behavior (a real
    // regression caught by travel.llm.spec.ts). Only an unambiguous "book" verb is treated as booking
    // intent in this class.
    if (
      LLM_ORCHESTRATOR_BOOKING_INTENT_PATTERN.test(currentText) &&
      determineMissingFields(this.lastEntities).length === 0
    ) {
      const options = generateSimulatedPackageOptions(this.lastEntities, this.config, packageOptionSeed(this.lastEntities));
      this.pendingAction = "AWAITING_OPTION_SELECTION" as TravelPendingAction;
      this.pendingRecommendations = options;
      this.selectedRecommendationId = null;
      return this.tag("booking_options_offer", textResult(formatPackageOptionsMessage(options)));
    }

    const resolvedInput = resolveTravelInput(currentText, {
      pendingInputAction: this.pendingInputAction,
      pendingContactValue: this.pendingContactValue,
      tripState: this.lastEntities,
      lastAssistantQuestion:
        [...messages].reverse().find((message) => message.role === "assistant")?.content ?? null,
      conversationClosed: this.conversationClosed,
      currentLeadState:
        this.completionStage === "CAPTURED"
          ? "CREATED"
          : this.completionStage === "AWAITING_CONTACT"
            ? "PENDING"
            : "NONE"
    });

    if (this.completionStage === "CAPTURED" && this.capturedLeadReference && looksLikePhoneOrContact(currentText)) {
      return this.tag(
        "lead_contact_already_captured",
        textResult(buildLeadAlreadyCapturedMessage(this.capturedLeadReference, this.responseLanguage))
      );
    }
    if (resolvedInput.kind === "PENDING_CONTACT") {
      this.pendingAction = null;
      this.providerFailure = null;
      this.pendingPassengerConflict = null;
      this.pendingContactValue = resolvedInput.contact;
      this.pendingLeadCapture = true;
      return this.tag(
        "lead_capture_submit",
        toolResult("travel.create_lead", this.buildTravelLeadPayload(resolvedInput.contact))
      );
    }
    if (resolvedInput.kind === "INVALID_CONTACT_ATTEMPT")
      return this.tag("lead_capture_invalid_contact", textResult(buildInvalidPhoneMessage(this.responseLanguage)));
    if (resolvedInput.kind === "PENDING_CONTACT_NON_CONTACT") {
      this.lastStage = "AWAITING_CONTACT";
      return this.tag(
        "lead_capture_waiting",
        textResult(buildPendingContactAcknowledgement(this.responseLanguage))
      );
    }
    if (resolvedInput.kind === "PENDING_CONTACT_PAUSED") {
      this.pendingInputAction = null;
      this.pendingContactValue = null;
      this.completionStage = "DECLINED";
      return this.tag(
        "lead_capture_paused",
        textResult(buildFarewellMessage(this.lastEntities.customerName, this.responseLanguage))
      );
    }
    if (resolvedInput.kind === "STANDALONE_CONTACT") {
      this.pendingAction = null;
      this.providerFailure = null;
      this.pendingPassengerConflict = null;
      this.pendingContactValue = resolvedInput.contact;
      this.pendingInputAction = "CONFIRM_STANDALONE_CONTACT_USE";
      return this.tag(
        "standalone_contact_confirmation",
        textResult(buildStandaloneContactConfirmation(this.lastEntities, this.responseLanguage))
      );
    }
    if (resolvedInput.kind === "STANDALONE_CONTACT_CONFIRMED") {
      this.conversationClosed = false;
      this.pendingInputAction = null;
      this.pendingLeadCapture = true;
      return this.tag(
        "standalone_contact_submit",
        toolResult("travel.create_lead", this.buildTravelLeadPayload(resolvedInput.contact))
      );
    }
    if (resolvedInput.kind === "STANDALONE_CONTACT_DECLINED") {
      this.pendingInputAction = null;
      this.pendingContactValue = null;
      return this.tag(
        "standalone_contact_declined",
        textResult(buildFarewellMessage(this.lastEntities.customerName, this.responseLanguage))
      );
    }
    if (!isFarewellMessage(currentText)) this.conversationClosed = false;

    // Graceful conversation closing: a standalone "thanks"/"that's all"/"bye" ends the conversation
    // naturally — never re-classified as trip content, and never a reason to fall into slot collection,
    // repeat a recommendation, or restart any other workflow step. Checked before everything else so it
    // takes priority regardless of what stage the conversation is in. A still-open completion offer or
    // contact request is gracefully closed out (never repeated later) rather than left dangling.
    if (isFarewellMessage(currentText)) {
      if (this.completionStage === "OFFERED") {
        this.completionStage = "DECLINED";
      }
      this.conversationClosed = true;
      this.pendingAction = null;
      this.providerFailure = null;
      this.pendingPassengerConflict = null;
      this.pendingDepartureDate = null;
      this.pendingInputAction = null;
      return this.tag("farewell", textResult(buildFarewellMessage(this.lastEntities.customerName, this.responseLanguage)));
    }

    // State recall/frustration is answered from structured memory before any LLM extraction, route
    // addition, tool action, or knowledge path. It must never restart slot collection.
    if (isTravelStateRecallRequest(currentText) || isTravelFrustrationMessage(currentText)) {
      return this.tag(
        isTravelFrustrationMessage(currentText) ? "frustration_state_repair" : "conversation_state_recall",
        textResult(
          buildTravelStateRecallMessage(
            this.lastEntities,
            this.pendingDepartureDate,
            this.journey,
            isTravelFrustrationMessage(currentText)
          )
        )
      );
    }

    // Conversation Completion & Lead Capture: resolve a pending offer/contact-request before anything
    // else this turn — the reply to "would you like to submit this?" or "may I have your number?" is
    // never a new trip detail, it's an answer to that specific ask. Mirrors the pendingClarification
    // priority immediately below.
    if (this.completionStage === "OFFERED") {
      if (isAffirmativeResponse(currentText)) {
        this.completionStage = "AWAITING_CONTACT";
        this.pendingInputAction = "AWAITING_LEAD_CONTACT";
        this.pendingAction = null;
        this.providerFailure = null;
        this.lastStage = "AWAITING_CONTACT";
        return this.tag("lead_capture_request_phone", textResult(buildContactRequestMessage(this.responseLanguage)));
      }
      // A short, standalone "no"/"not now" (nothing else in the message) ends the offer gracefully right
      // here — never falls through to re-classification, which could otherwise "restart" an unrelated
      // workflow step. A decline with more content ("no, but what about visa requirements") still falls
      // through so that real content gets a real answer.
      if (isNegativeResponse(currentText) && currentText.trim().split(/\s+/).length <= 4) {
        this.completionStage = "DECLINED";
        this.pendingInputAction = null;
        return this.tag("farewell_declined_offer", textResult(buildFarewellMessage(this.lastEntities.customerName, this.responseLanguage)));
      }
      if (isNegativeResponse(currentText)) {
        this.completionStage = "DECLINED";
        this.pendingInputAction = null;
        // Falls through deliberately: per policy, a decline only stops the offer from being repeated —
        // whatever else this message says (or if it says nothing else) is still handled normally below.
      }
      // Anything else leaves the offer open for a later turn and falls through to normal processing.
    }

    // Explicit currency preference/update ("share in USD", "estimate in usd", bare "usd", "convert to
    // dirhams"). Deterministic, state-aware, and deliberately HIGH priority — above trip-completeness
    // confirmation, search confirmation, recommendation generation, slot recollection, and generic intent
    // classification — so a currency-only follow-up is never misread as a search/recommendation request or
    // an incomplete-trip update, and never loops the "would you like me to look up options now?" prompt.
    // The original budget (`budgetAmount`/`budgetCurrency`) is never touched — only how amounts are shown.
    const currencyPreference = currencyService.detectPreference(currentText);
    if (currencyPreference) {
      return this.tag("currency_preference", this.handleCurrencyPreference(currencyPreference));
    }

    // Resolve an in-flight "Did you mean X?" before anything else — the reply to that question is not a
    // new trip detail, it's a yes/no about a value already proposed last turn. A bare "yes" here is only
    // ever a clarification answer, never authorization to run tools — that decision is entirely delegated
    // to `resolveCityClarificationYes`, which only resumes a pending action the user separately asked for.
    if (this.pendingClarification) {
      const pending = this.pendingClarification;
      const declinesCandidate = /^\s*(no|nope|not\s+quite|wrong|incorrect)\b/i.test(currentText);
      // Sprint 6.6 — Part 12/29 (Test C): "No, Dubai" supplies the replacement in the SAME breath as the
      // decline — re-asking blindly (the old behavior) discarded "Dubai" entirely. A literal match against
      // the known-city catalog needs no further confidence gate (nothing else in this codebase re-gates a
      // catalog hit), so when the decline message itself names a recognizable city, treat it the same way
      // the "anything else" branch below already does: drop the pending clarification and let this turn's
      // own extraction pick it up, rather than taking the blind re-ask early return.
      const declineReplacementCity = declinesCandidate
        ? pending.field === "originCity"
          ? extractOriginCity(currentText)
          : normalizeCityName(extractDestination(currentText))
        : null;
      if (declinesCandidate && declineReplacementCity) {
        // A literal catalog-known city named in the SAME decline message ("No, Dubai") is committed
        // directly here — deterministically, with no LLM re-extraction round-trip needed — rather than
        // falling through and hoping a later extraction pass re-derives it (which, in a no-LLM
        // environment or a minimal LLM response, may not happen at all). Reuses the exact same
        // commit-and-resume-any-pending-action logic the "yes" path already uses.
        return this.tag(
          "city_clarify_declined_with_replacement",
          await this.resolveCityClarificationYes(pending, request.tools, {
            value: declineReplacementCity,
            confidence: 1
          })
        );
      }
      if (declinesCandidate) {
        this.pendingClarification = null;
        return this.tag(
          "city_clarify_declined",
          textResult(buildCityClarificationMessage(pending.field, pending.rawValue, this.responseLanguage))
        );
      }
      if (/^\s*(yes|yeah|yep|correct|that'?s\s+right|right|confirm(?:ed)?|haan|ji|theek)\b/i.test(currentText))
        return this.tag("clarification_confirmed", await this.resolveCityClarificationYes(pending, request.tools));
      // Anything else — including a decline that also stated a replacement — drops the pending
      // clarification and lets this turn's own extraction reinterpret the message fresh, rather than
      // forcing a yes/no reading onto an unrelated (or richer) reply.
      this.pendingClarification = null;
    }

    // Resolve an in-flight "same trip or separate trip?" ambiguity before anything else — mirrors the
    // pendingClarification handling above. A bare Hinglish affirmative ("ji"/"haan") must NEVER resolve
    // this by itself (see CLARIFY_ROUTE_RELATIONSHIP in the spec): only an explicit "same trip" or
    // "separate/new trip" answer picks a side; anything else re-asks rather than guessing.
    if (this.pendingRouteClarification) {
      const pending = this.pendingRouteClarification;
      const sameTripAnswer =
        /\bsame\s+trip\b|\bsame\s+journey\b|\bisi\s+trip\b|\bus\s+(?:hi\s+)?trip\s+(?:mein|me)\b|\bek\s+hi\s+trip\b|\badd\s+it\b|\bconnect\s+it\b|\bcontinue\s+(?:the\s+)?(?:same|current)\s+trip\b/i.test(
          currentText
        );
      const separateTripAnswer =
        NEW_INDEPENDENT_TRIP_PATTERN.test(currentText) || /\bseparate\s+trip\b|\bnew\s+trip\b|\balag\s+trip\b/i.test(currentText);
      if (sameTripAnswer) {
        this.pendingRouteClarification = null;
        const parsedLegs = parseJourneyLegChain(pending.originalMessage);
        if (parsedLegs.length >= 2) {
          return this.tag(
            "route_relationship_resolved_extension",
            this.startMultipleJourneyLegs(priorEntitiesSnapshot, parsedLegs, pending.originalMessage)
          );
        }
        // `startNewJourneyLeg` infers the new leg's origin from whether `this.lastEntities.originCity`
        // already differs from the pre-merge snapshot (normally true because extraction already ran on the
        // route-bearing message) — but here, the route came from a STORED earlier message that was never
        // re-extracted this turn, so that inference must be primed explicitly from the parsed leg first.
        const firstLeg = parsedLegs[0];
        if (firstLeg) {
          this.lastEntities = { ...this.lastEntities, originCity: firstLeg.origin, destinationCity: firstLeg.destination };
        }
        return this.tag(
          "route_relationship_resolved_extension",
          await this.startNewJourneyLeg(priorEntitiesSnapshot, pending.originalMessage, isFirstTurn)
        );
      }
      if (separateTripAnswer) {
        this.pendingRouteClarification = null;
        const parsedLegs = parseJourneyLegChain(pending.originalMessage);
        const lastLeg = parsedLegs[parsedLegs.length - 1] ?? null;
        if (lastLeg) {
          const freshTrip: TravelEntities = {
            ...EMPTY_TRAVEL_ENTITIES,
            customerName: this.lastEntities.customerName,
            originCity: lastLeg.origin,
            destinationCity: lastLeg.destination,
            days: lastLeg.days,
            nights: lastLeg.nights,
            adults: this.lastEntities.adults,
            children: this.lastEntities.children,
            infants: this.lastEntities.infants,
            totalTravellers: this.lastEntities.totalTravellers,
            cabinClass: this.lastEntities.cabinClass,
            hotelStars: this.lastEntities.hotelStars,
            tripType: this.lastEntities.tripType,
            preferences: this.lastEntities.preferences
          };
          this.lastEntities = freshTrip;
          this.confirmation = EMPTY_TRAVEL_ENTITY_CONFIRMATION;
          this.lastBudgetEstimate = null;
          this.lastGeneratedItinerary = null;
          this.budgetDiscussionCompleted = false;
          this.pendingAction = null;
          this.lastWorkflowPhase = "COLLECTING_DETAILS";
          const missing = computeMissingEntityFields(freshTrip, this.budgetMode);
          this.lastStage = stageForMissingEntityField(missing[0] ?? "");
          this.lastAskedField = missing[0] ?? null;
          const reply = await this.safeGenerateReply(freshTrip, missing, [], currentText, isFirstTurn, false);
          return this.tag("route_relationship_resolved_new_trip", textResult(reply));
        }
        // No parsable route survived from the original message — fall through to this turn's own text.
      } else {
        return this.tag(
          "route_relationship_clarify_repeat",
          textResult(
            buildRouteRelationshipClarificationMessage(pending.fromDestination, pending.toDestination, this.responseLanguage)
          )
        );
      }
    }

    if (isEscalationRequest(currentText) && !wasEscalated(messages)) {
      this.lastStage = "ESCALATED";
      if (toolAvailable(request.tools, "travel.escalate"))
        return this.tag("escalate", toolResult("travel.escalate", { reason: currentText.slice(0, 500) }));
      return this.tag("escalate", textResult(buildEscalationMessage(this.config, this.responseLanguage)));
    }

    // The traveler's explicit current request always wins over stale state — budget feasibility (or any
    // other pending action) must never hijack an unrelated ask like "day plan" or "what's worth seeing".
    // Computed early (a pure function of the raw text alone) so the business-workflow actions below can
    // run — and, for CREATE_LEAD/SUBMIT_ENQUIRY/REQUEST_CALLBACK, pre-empt the LLM's own intent label —
    // before extraction, merge, or intent-based branches ever see this turn.
    let planningAction = classifyPlanningAction(currentText);
    const correctionRouteCue =
      /\b(?:first|actually|correction|nahi|maine\s+kaha|bhai|pehle)\b/i.test(currentText) &&
      parseJourneyLegChain(currentText).length > 0;
    if (correctionRouteCue) planningAction = "ADD_TRIP_LEG";
    // A multi-leg journey changes what a budget ask MEANS: once 2+ legs exist (already-finalized legs plus
    // the current in-progress one), any budget-related ask — however phrased, including a plain "you
    // suggest the budget" that would otherwise map to the single-leg AGENT_RECOMMENDED flow — must estimate
    // the WHOLE journey. Never silently fall back to the active leg's estimate once this is the case.
    const hasMultiLegJourney = (this.journey?.legs.length ?? 0) + (this.lastEntities.destinationCity ? 1 : 0) >= 2;
    // GENERATE_COMPLETE_TRIP_PLAN/GENERATE_ITINERARY are their own explicit, already-correct asks — a
    // full plan or a day-wise itinerary must never be silently narrowed down to a budget-only reply just
    // because the message happens to mention cities that match an existing leg (journey source of truth:
    // these two actions own their routing outright once explicitly classified).
    if (
      hasMultiLegJourney &&
      planningAction !== "ADD_TRIP_LEG" &&
      planningAction !== "CALCULATE_JOURNEY_BUDGET" &&
      planningAction !== "GENERATE_COMPLETE_TRIP_PLAN" &&
      planningAction !== "GENERATE_ITINERARY"
    ) {
      const referencesExistingLegs = parseJourneyLegChain(currentText).some((parsedLeg) =>
        (this.journey?.legs ?? []).some(
          (leg) =>
            leg.origin?.toLowerCase() === parsedLeg.origin.toLowerCase() &&
            leg.destination?.toLowerCase() === parsedLeg.destination.toLowerCase()
        )
      );
      if (planningAction === "CALCULATE_BUDGET" || detectBudgetModeSignal(currentText) !== null || referencesExistingLegs) {
        planningAction = "CALCULATE_JOURNEY_BUDGET";
      }
    }
    // Route-relationship classification: does this message's route extend the journey, start an
    // independent new trip, correct earlier turns into "one connected journey" ("bhai multileg hai"), or
    // is it genuinely ambiguous? Skipped when ADD_TRIP_LEG/CALCULATE_JOURNEY_BUDGET are already decided —
    // nothing to reclassify, and a budget ask about the existing journey is never itself a route change.
    if (planningAction !== "ADD_TRIP_LEG" && planningAction !== "CALCULATE_JOURNEY_BUDGET") {
      const homeOriginCity = this.journey?.travellerProfile.originCity ?? priorEntitiesSnapshot.originCity;
      const routeRelationship = classifyRouteRelationship(
        currentText,
        priorEntitiesSnapshot.destinationCity,
        homeOriginCity
      );
      if (routeRelationship === "EXTENSION") {
        planningAction = "ADD_TRIP_LEG";
      } else if (routeRelationship === "MULTILEG_CORRECTION") {
        return this.tag("multileg_correction_acknowledged", this.acknowledgeMultilegCorrection(priorEntitiesSnapshot));
      } else if (routeRelationship === "AMBIGUOUS") {
        const candidateLegs = parseJourneyLegChain(currentText);
        const lastCandidate = candidateLegs[candidateLegs.length - 1] ?? null;
        this.pendingRouteClarification = {
          originalMessage: currentText,
          fromDestination: priorEntitiesSnapshot.destinationCity,
          toDestination: lastCandidate?.destination ?? null
        };
        return this.tag(
          "route_relationship_clarify",
          textResult(
            buildRouteRelationshipClarificationMessage(
              priorEntitiesSnapshot.destinationCity,
              lastCandidate?.destination ?? null,
              this.responseLanguage
            )
          )
        );
      }
    }
    if (this.diagnostics) this.diagnostics.planningAction = planningAction;
    // Any OTHER recognized explicit planning action means the traveler has moved on from the recovery
    // menu — invalidate the numeric-shortcut window so a LATER, unrelated bare digit is never misread as a
    // menu pick. `providerFailure` itself is untouched: the broader "don't blindly retry" gate still holds.
    if (this.providerFailure && planningAction !== null) this.providerFailure.menuActive = false;

    const {
      entities: extracted,
      intent,
      cityInterpretations,
      turnProposal
    } = await this.safeExtractAndClassify(currentText);
    if (
      this.pendingInputAction &&
      turnProposal.supersedesPendingAction &&
      turnProposal.confidence >= 0.75
    ) {
      this.pendingInputAction = null;
      this.pendingContactValue = null;
    }
    this.diagnostics.intent = intent;
    this.diagnostics.extractedEntityKeys = (Object.keys(extracted) as Array<keyof TravelEntities>).filter(
      (key) => extracted[key] !== null && extracted[key] !== undefined
    );
    this.diagnostics.extractedTotalTravellers = extracted.totalTravellers ?? null;
    this.diagnostics.extractedComposition =
      extracted.adults !== null && extracted.adults !== undefined
        ? { adults: extracted.adults, children: extracted.children ?? null, infants: extracted.infants ?? null }
        : null;
    this.diagnostics.passengerStateBeforeMerge = computePassengerState(this.lastEntities);

    // Confidence-based clarification: an uncertain city correction is never silently accepted. This must
    // run before the merge, since a medium/low-confidence guess should not even be considered this turn.
    const gated = this.applyCityConfidenceGate(cityInterpretations, extracted);
    if (gated) return this.tag("city_confidence_gate", gated);

    // Reconciliation: a fresh composition breakdown ("2 adults, 2 kids, 1 infant") must match any
    // previously stated total headcount ("5 log") — silently overwriting a conflicting total would hide a
    // real discrepancy, so this asks for clarification instead of guessing which number is right.
    const passengerConflict = this.applyPassengerReconciliation(extracted);
    if (passengerConflict) return this.tag("passenger_composition_conflict", passengerConflict);

    // "Start a new trip" resets trip DETAILS, never onboarding — the traveler already introduced
    // themselves once this conversation; asking their name again just because they want to plan a
    // different destination would be exactly the robotic re-asking this workflow exists to avoid.
    const baseEntities =
      intent === "start_new_trip"
        ? { ...EMPTY_TRAVEL_ENTITIES, customerName: this.lastEntities.customerName }
        : this.lastEntities;
    const baseConfirmation =
      intent === "start_new_trip"
        ? this.confirmation.customerName
          ? { customerName: this.confirmation.customerName }
          : EMPTY_TRAVEL_ENTITY_CONFIRMATION
        : this.confirmation;
    const { values: mergedValues, confirmation: mergedConfirmation, destinationChanged } = mergeConfirmedEntities(
      baseEntities,
      baseConfirmation,
      extracted,
      intent
    );
    // Year clarification/correction ("2027 me", "year is 2027"): apply the year to a known date, and roll
    // back any budget the same value was previously mis-inferred as (see the "2027 -> USD 2,027" defect).
    // Dependent derived state (feasibility, the stored estimate) is recomputed downstream from the corrected
    // entities, so clearing the bad budget here is enough to invalidate the false "over budget" result.
    const yearClarification = detectYearClarification(currentText);
    if (yearClarification !== null) {
      if (this.pendingDepartureDate) {
        const pending = this.pendingDepartureDate;
        mergedValues.departureDate = `${yearClarification}-${String(pending.month).padStart(2, "0")}-${String(pending.day).padStart(2, "0")}`;
        mergedValues.travelMonth = titleCase(MONTHS[pending.month - 1] ?? "");
        mergedConfirmation.departureDate = {
          source: "USER_EXPLICIT",
          confidence: 1,
          confirmed: true,
          updatedAt: new Date().toISOString()
        };
        this.pendingDepartureDate = null;
        if (this.pendingInputAction === "AWAITING_TRAVEL_YEAR") this.pendingInputAction = null;
      }
      if (mergedValues.departureDate) {
        const corrected = withYear(mergedValues.departureDate, yearClarification);
        if (corrected) mergedValues.departureDate = corrected;
      }
      if (mergedValues.budget === yearClarification && !hasMonetaryContext(currentText)) {
        mergedValues.budget = null;
        mergedValues.budgetCurrency = null;
        this.budgetMode = "UNKNOWN";
        delete mergedConfirmation.budget;
        delete mergedConfirmation.budgetCurrency;
      }
    }
    // Stage 9G: when the destination changes without modify_trip intent, the user is starting a
    // contextually new trip — clear all trip-specific entity fields inherited from the previous
    // destination unless they were explicitly provided in this turn's message. Fields explicitly
    // extracted this turn (e.g. a new budget in "Tokyo 200000 INR ka trip") survive; old fields
    // the user didn't re-state are dropped so the new trip starts with a clean slate.
    //
    // Never when planningAction === "ADD_TRIP_LEG": that is a structured, deterministic signal (parsed
    // separately, before this point) that the destination change is a CONTINUATION of the same connected
    // multi-city journey ("london se newyork jana hai" after Delhi->London), not an ambiguous "did they
    // abandon the whole trip" case — the two are mutually exclusive by construction. Without this
    // exclusion, passenger count (adults/children/infants) — a whole-journey attribute that cannot
    // plausibly differ leg to leg — was being wiped the instant a second leg started, so a later turn
    // ("ji") that should have executed the connected-journey search instead saw a bogus missing "adults"
    // field, fell through to a generic LLM reply, and never searched at all. `startNewJourneyLeg` already
    // resets the fields that genuinely are per-leg (dates/duration/budget) on its own terms; this block
    // must not additionally reset trip-wide ones.
    if (destinationChanged && intent !== "modify_trip" && planningAction !== "ADD_TRIP_LEG") {
      const newTripEntityKeys: Array<keyof TravelEntities> = [
        "originCity", "travelMonth", "departureDate", "returnDate",
        "days", "nights", "totalTravellers", "adults", "children", "infants",
        "budget", "budgetCurrency", "cabinClass", "hotelStars", "tripType",
        "visaRequired", "passportStatus", "tripPurpose"
      ];
      for (const key of newTripEntityKeys) {
        if ((extracted as unknown as Record<string, unknown>)[key] == null) {
          (mergedValues as unknown as Record<string, unknown>)[key] = null;
          (mergedConfirmation as unknown as Record<string, unknown>)[key] = undefined;
        }
      }
      this.lastBudgetEstimate = null;
      this.lastGeneratedItinerary = null;
      this.budgetDiscussionCompleted = false;
      // Note: displayCurrency is intentionally NOT cleared — it only survives if the user
      // explicitly set it (e.g. "show in AED"); when null the fallback default is used.
    }
    const merged = deriveDurationFromDateRange(mergedValues);
    const changed = diffChangedFields(baseEntities, merged);
    this.diagnostics.changedFields = changed;
    this.lastEntities = merged;
    this.confirmation = mergedConfirmation;
    this.diagnostics.passengerState = computePassengerState(merged);
    // Sprint 6.5 — Part 15/28: package options already offered were priced/curated for the PRIOR trip
    // requirements — a material correction (destination, dates, travellers, nights, budget) after they
    // exist must invalidate them, or the traveler could go on to "book" a package that no longer matches
    // what they asked for. Only ever clears state that logically depends on the changed field; it never
    // resets the trip requirements themselves (those are already correctly updated by the merge above).
    if (this.pendingRecommendations?.length && hasMaterialPackageChange(changed)) {
      this.pendingRecommendations = null;
      this.selectedRecommendationId = null;
      if (PACKAGE_DEPENDENT_PENDING_ACTIONS.includes(this.pendingAction)) {
        this.pendingAction = null;
      }
    }

    if (
      this.pendingDepartureDate &&
      yearClarification === null &&
      parsePendingDepartureDate(currentText) !== null
    ) {
      this.lastStage = "ASK_MISSING_INFO";
      this.lastAskedField = "travelYear";
      this.pendingInputAction = "AWAITING_TRAVEL_YEAR";
      return this.tag(
        "partial_date_needs_year",
        textResult(
          `I have ${this.pendingDepartureDate.day} ${titleCase(MONTHS[this.pendingDepartureDate.month - 1] ?? "")}. Which year should I use?`
        )
      );
    }

    // Onboarding gate: the traveler's name is collected before any trip-detail question, per the
    // GREETING -> COLLECT_NAME -> trip-discovery workflow. A message that only states trip content
    // ("Delhi jana hai") is acknowledged (via `changed`/`merged` below) but still routed back to asking
    // for the name; a message that introduces the traveler (with or without trip content in the same
    // message) is never re-asked, since `customerName` is a normal confirmed entity once captured.
    if (!merged.customerName) {
      this.lastStage = "COLLECT_NAME";
      return this.tag("collect_name", textResult(this.buildNameGateReply(merged, changed)));
    }

    // Intent Discovery: right after the name is captured, if the traveler has not stated any trip
    // content at all yet (nothing in `merged` beyond the name itself — `baseEntities.customerName` being
    // null is what tells us the name was JUST captured this turn), offer the intent menu instead of
    // assuming a trip is being planned. A message that captures the name together with real trip content
    // skips this and proceeds straight into slot collection, exactly as before. Shown exactly once per
    // conversation: once the name is known from a prior turn, this branch is never reached again.
    const justLearnedName = !baseEntities.customerName;
    const hasStatedTripContent =
      ENTITY_SCALAR_KEYS.some((key) => key !== "customerName" && merged[key] !== null) ||
      merged.preferences.length > 0;
    if (justLearnedName && !hasStatedTripContent) {
      this.lastStage = "DISCOVER_INTENT";
      return this.tag(
        "discover_intent",
        textResult(buildIntentDiscoveryMessage(merged.customerName, this.responseLanguage))
      );
    }

    // ADD_TRIP_LEG: "continue to New York" / "London se New York ka plan continue karo" finalizes the leg
    // that was in progress (using the pre-merge snapshot, not `merged`) and starts a fresh one — never a
    // destination correction to the SAME leg, and never a reason to run a search. Must run before the
    // destinationChanged check below, which would otherwise misread the new destination as a same-leg swap.
    if (planningAction === "ADD_TRIP_LEG") {
      // A single message can describe more than one new leg at once ("Washington se London aur fir London
      // se Delhi") — parsed and handled together so neither is silently dropped; a single parsed leg (or
      // none, e.g. plain "continue to New York" with no chain of known cities) keeps the existing flow.
      const parsedLegs = parseJourneyLegChain(currentText);
      // Compound intent: the SAME message that describes the new leg(s) can also ask for the total cost
      // and/or the return date ("Tokyo me 3 days, phir London me 2 days, then back to Delhi. Total kharcha
      // batao aur kis date ko Delhi land karunga?") — both must be answered from the now-finalized journey
      // in this SAME response, never deferred to a follow-up.
      const legResult =
        parsedLegs.length >= 2
          ? this.startMultipleJourneyLegs(priorEntitiesSnapshot, parsedLegs, currentText)
          : await this.startNewJourneyLeg(priorEntitiesSnapshot, currentText, isFirstTurn);
      return this.tag(
        parsedLegs.length >= 2 ? "add_multiple_trip_legs" : "add_trip_leg",
        this.journey ? this.appendCompoundJourneyAnswers(legResult, currentText) : legResult
      );
    }

    // Deterministic budget-mode signal, independent of LLM intent classification: "you suggest your
    // budget" / "you suggest" / "recommend a budget" -> AGENT_RECOMMENDED; "no budget" / "flexible
    // budget" -> FLEXIBLE. A numeric budget captured this turn (visible in `changed`) means the traveler
    // gave a specific target, which always means USER_DEFINED regardless of any earlier mode.
    const budgetSignal = detectBudgetModeSignal(currentText);
    if (budgetSignal) this.budgetMode = budgetSignal;
    else if (changed.some((entry) => entry.startsWith("budget="))) this.budgetMode = "USER_DEFINED";

    const missing = computeMissingEntityFields(merged, this.budgetMode);
    const itineraryAlreadyPresented = wasItineraryPresented(messages);
    // Reasoning validation, computed once per turn: flight prices depend on the departure city, which
    // has no safe default, so nothing downstream may estimate or search flights without it.
    const canEstimateFlights = validateBudgetEstimateInputs(merged).canEstimateFlights;
    const readyToSearch = missing.length === 0 && canEstimateFlights;

    // Business feasibility, computed once the trip is otherwise fully specified and a numeric budget was
    // explicitly stated — entirely separate from technical execution. Never call a search tool solely
    // because the budget is below minimum; that's decided below in `searchOrBelowMinimumHandoff`.
    const feasibility: BudgetFeasibilityResult | null =
      this.budgetMode === "USER_DEFINED" && merged.budget !== null && readyToSearch
        ? classifyBudgetFeasibility(merged.budget, estimateBudgetRange(merged, this.config))
        : null;
    this.diagnostics.feasibility = feasibility;

    // SUBMIT_ENQUIRY/CREATE_LEAD and REQUEST_CALLBACK are terminal lead-capture handoffs, never a reason
    // to touch travel.search_flights/search_hotels — and must run before the `request_human` intent check
    // below, since an LLM has been observed to misread "ask anyone to call" as wanting a human-agent
    // escalation, which would otherwise return nothing but a support-contact message instead of actually
    // acting. Both always use the built-in TravelLead capture (see `beginOrResumeLeadCapture`) — never
    // gated on, or dependent on, an external CRM connector being configured.
    if (planningAction === "SUBMIT_ENQUIRY" || planningAction === "CREATE_LEAD") {
      return this.tag(
        planningAction === "SUBMIT_ENQUIRY" ? "submit_enquiry" : "create_lead",
        this.beginOrResumeLeadCapture(currentText)
      );
    }
    if (planningAction === "REQUEST_CALLBACK") {
      return this.tag("request_callback", this.beginOrResumeLeadCapture(currentText));
    }

    if (intent === "request_human" && !wasEscalated(messages)) {
      this.lastStage = "ESCALATED";
      if (toolAvailable(request.tools, "travel.escalate"))
        return this.tag("escalate", toolResult("travel.escalate", { reason: currentText.slice(0, 500) }));
      return this.tag("escalate", textResult(buildEscalationMessage(this.config, this.responseLanguage)));
    }

    // Destination replacement: a confirmed destination was just explicitly swapped for a different one.
    // Acknowledge the specific change and keep every other confirmed field — never a silent state rebuild.
    if (destinationChanged && itineraryAlreadyPresented) {
      this.lastStage = "RECOMMEND_OPTIONS";
      this.lastWorkflowPhase = "OPTIONS_PRESENTED";
      this.lastAskedField = null;
      return this.tag(
        "destination_changed",
        textResult(
          buildDestinationChangedMessage(destinationChanged.from, destinationChanged.to, this.responseLanguage)
        )
      );
    }

    // GENERATE_COMPLETE_TRIP_PLAN: "complete end to end plan" asks for everything (flights, hotels, budget,
    // day-wise itinerary) in one message — never just the day-wise schedule alone (see buildCompleteTripPlanMessage).
    if (planningAction === "GENERATE_COMPLETE_TRIP_PLAN") {
      // Journey is the authoritative source for every complete plan, single- or multi-leg: a single-leg
      // trip is represented as a journey holding exactly one leg (the existing, already-tested
      // single-BudgetEstimate render below is reused unchanged for that case); 2+ legs route into the
      // dedicated multi-leg builder, which is never fed from a single BudgetEstimate or bare
      // originCity/destinationCity alone.
      const journey = this.ensureJourney(merged);
      const legs = this.collectAllJourneyLegs(journey, merged);
      // The missing-fields gate only applies to the single-leg path: once 2+ legs already exist, the
      // journey itself is the completeness signal (exactly like CALCULATE_JOURNEY_BUDGET's own policy) — a
      // trailing connecting/return leg legitimately has no stay duration of its own and must never block
      // the whole journey's plan on that account.
      if (legs.length < 2 && !hasItineraryFields(merged)) {
        const missingForPlan: string[] = [];
        if (!merged.destinationCity) missingForPlan.push("destinationCity");
        if (!merged.travelMonth && !merged.departureDate) missingForPlan.push("travelDates");
        if (merged.days === null && merged.nights === null) missingForPlan.push("duration");
        this.lastStage = stageForMissingEntityField(missingForPlan[0] ?? "");
        this.lastWorkflowPhase = "COLLECTING_DETAILS";
        this.lastAskedField = missingForPlan[0] ?? null;
        const reply = await this.safeGenerateReply(merged, missingForPlan, changed, currentText, isFirstTurn, false);
        return this.tag("complete_trip_plan_needs_details", textResult(reply));
      }
      this.pendingAction = null;
      this.lastStage = "ITINERARY_SUMMARY";
      this.lastWorkflowPhase = "OPTIONS_PRESENTED";
      this.lastAskedField = null;
      if (legs.length >= 2) {
        return this.tag(
          "generate_journey_complete_trip_plan",
          await this.buildJourneyCompleteTripPlanResult(journey, legs, currentText)
        );
      }
      const itinerary = await this.safeGenerateItinerary(merged, currentText);
      this.lastGeneratedItinerary = itinerary;
      const estimate = estimateBudgetRange(merged, this.config, this.effectiveDisplayCurrency(merged));
      this.storeEstimate(merged, "INDICATIVE");
      return this.tag(
        "generate_complete_trip_plan",
        textResult(buildCompleteTripPlanMessage(merged, itinerary, estimate, this.responseLanguage))
      );
    }

    if (planningAction === "GENERATE_ITINERARY") {
      // Passenger composition (and budget) must never block this — only destination/duration/dates are
      // real requirements; composition merely personalizes the plan when it happens to be known.
      if (!hasItineraryFields(merged)) {
        const missingForItinerary: string[] = [];
        if (!merged.destinationCity) missingForItinerary.push("destinationCity");
        if (!merged.travelMonth && !merged.departureDate) missingForItinerary.push("travelDates");
        if (merged.days === null && merged.nights === null) missingForItinerary.push("duration");
        this.lastStage = stageForMissingEntityField(missingForItinerary[0] ?? "");
        this.lastWorkflowPhase = "COLLECTING_DETAILS";
        this.lastAskedField = missingForItinerary[0] ?? null;
        const reply = await this.safeGenerateReply(merged, missingForItinerary, changed, currentText, isFirstTurn, false);
        return this.tag("itinerary_needs_details", textResult(reply));
      }
      // Clear any pending action (e.g. a stale budget-reminder or search state) now that the traveler has
      // moved on to a distinct, explicit request.
      this.pendingAction = null;
      this.lastStage = "ITINERARY_SUMMARY";
      this.lastWorkflowPhase = "OPTIONS_PRESENTED";
      this.lastAskedField = null;
      const itinerary = await this.safeGenerateItinerary(merged, currentText);
      this.lastGeneratedItinerary = itinerary;
      return this.tag("generate_itinerary", textResult(itinerary));
    }

    // BOOK_FLIGHT/BOOK_HOTEL: an explicit booking go-ahead must persist across every clarification and
    // collect only booking-required fields — never budget. See `continueBookingFlow`.
    if (planningAction === "BOOK_FLIGHT" || planningAction === "BOOK_HOTEL") {
      return this.tag(
        planningAction === "BOOK_FLIGHT" ? "book_flight" : "book_hotel",
        await this.continueBookingFlow(planningAction, merged, feasibility, request.tools, changed, currentText, isFirstTurn)
      );
    }

    // CONVERT_ESTIMATE_CURRENCY: currency preferences ("give in INR", "share in USD", bare "usd") are fully
    // resolved earlier, by the high-priority currency-preference branch above (see `handleCurrencyPreference`),
    // before extraction or any other routing. This defensive delegation only ever runs if a message was
    // classified as a currency request by `classifyPlanningAction` but not by `detectPreference` — the two
    // share the same detector, so in practice it never fires. Kept so the two can never silently disagree.
    if (planningAction === "CONVERT_ESTIMATE_CURRENCY") {
      const preference = currencyService.detectPreference(currentText);
      if (preference) return this.tag("currency_preference", this.handleCurrencyPreference(preference));
    }

    // GENERATE_HOTEL_RECOMMENDATIONS: "recommend hotels", "suggest hotels near Marina" — indicative
    // hotel-only guidance, never a live tool call. Produces a hotel-only response (no flights, no airport
    // guidance, no budget-feasibility replay) using the trip's destination from current context. When the
    // user explicitly names a specific area ("near Marina", "in Dubai Marina", "around JBR"), the area
    // is extracted and passed to produce area-focused guidance instead of the generic area list.
    if (planningAction === "GENERATE_HOTEL_RECOMMENDATIONS") {
      this.lastWorkflowPhase = readyToSearch ? "READY_TO_SEARCH" : "COLLECTING_DETAILS";
      const estimate = estimateBudgetRange(merged, this.config, this.effectiveDisplayCurrency(merged));
      this.storeEstimate(merged, "INDICATIVE");
      const requestedArea = extractHotelArea(currentText, merged.destinationCity);
      return this.tag(
        requestedArea ? "generate_hotel_recommendations_area" : "generate_hotel_recommendations",
        textResult(buildHotelRecommendationsMessage(merged, estimate, this.responseLanguage, requestedArea))
      );
    }
    // GENERATE_FLIGHT_RECOMMENDATIONS: "recommend flights", "recommendations bhejo" — indicative guidance
    // only, never a live tool call. Shows combined flight+hotel recommendations for a generic ask.
    if (planningAction === "GENERATE_FLIGHT_RECOMMENDATIONS") {
      this.lastWorkflowPhase = readyToSearch ? "READY_TO_SEARCH" : "COLLECTING_DETAILS";
      const estimate = estimateBudgetRange(merged, this.config, this.effectiveDisplayCurrency(merged));
      this.storeEstimate(merged, "INDICATIVE");
      return this.tag(
        "generate_indicative_recommendations",
        textResult(buildIndicativeRecommendationsMessage(merged, estimate, this.responseLanguage, false))
      );
    }

    if (
      planningAction === "RECOMMEND_ATTRACTIONS" ||
      planningAction === "RECOMMEND_FOOD" ||
      planningAction === "RECOMMEND_TRANSPORT"
    ) {
      const reply = await this.safeGenerateContextualReply(merged, missing, itineraryAlreadyPresented, currentText);
      this.lastWorkflowPhase = readyToSearch ? "READY_TO_SEARCH" : "COLLECTING_DETAILS";
      return this.tag(`recommend_${planningAction.slice("RECOMMEND_".length).toLowerCase()}`, textResult(reply));
    }

    // SEARCH_LIVE_OPTIONS: an explicit "live/current" ask always forces a fresh provider call, even right
    // after a recent failure — the one deliberate override to the provider-failure gate below.
    if (planningAction === "SEARCH_LIVE_OPTIONS" && canEstimateFlights) {
      this.pendingAction = null;
      this.providerFailure = null;
      return this.tag("search_live_options", this.searchOrBelowMinimumHandoff(merged, feasibility, request.tools, true));
    }

    // Budget-relevant requests (hotel/flights/budget) must always re-evaluate and re-show feasibility when
    // still BELOW_MINIMUM, regardless of whether it was already explained once — per policy, these three
    // (plus an explicit budget change, handled via `budgetSignal` below) are the only things that repeat it.
    if ((planningAction === "SEARCH_HOTELS" || planningAction === "SEARCH_FLIGHTS") && canEstimateFlights) {
      this.pendingAction = null;
      // An explicit search/show/find ask is itself a fresh attempt — clear any stale failure record rather
      // than leaving it to block a LATER vague follow-up even after this attempt succeeds.
      this.providerFailure = null;
      return this.tag(
        planningAction === "SEARCH_HOTELS" ? "search_hotels" : "search_flights",
        this.searchOrBelowMinimumHandoff(merged, feasibility, request.tools, true)
      );
    }
    // CALCULATE_JOURNEY_BUDGET: a multi-leg journey's budget ask — "estimate full trip budget", "you
    // suggest the budget" once 2+ legs exist, etc. Calculates directly from whatever journey data already
    // exists (no missing-field gate, per policy): a leg with no known dates/duration simply contributes no
    // hotel/food/transport cost, it never blocks the whole journey's estimate.
    if (planningAction === "CALCULATE_JOURNEY_BUDGET") {
      this.pendingAction = null;
      this.budgetDiscussionCompleted = true;
      const journey = this.ensureJourney(merged);
      const legs = this.collectAllJourneyLegs(journey, merged);
      const journeyEstimate = estimateJourneyBudgetRange(legs, journey.travellerProfile, this.config);
      // Compound intent: "total kharcha batao aur kis date ko Delhi land karunga" asks for BOTH the total
      // and the return date in one breath — both are answered from this SAME journey snapshot in one
      // response, never forcing a single-intent choice or a second, possibly conflicting, LLM call.
      let content = buildJourneyBudgetMessage(legs, journeyEstimate, this.responseLanguage);
      if (this.pendingDepartureDate) {
        const partialDate = `${this.pendingDepartureDate.day} ${titleCase(MONTHS[this.pendingDepartureDate.month - 1] ?? "")}`;
        content +=
          this.responseLanguage === "HINGLISH"
            ? `\n\n${partialDate} note kiya hai, lekin date-dependent live pricing ke liye travel year abhi bhi required hai.`
            : `\n\nI have the ${partialDate} departure date, but the travel year is still required for date-dependent live pricing.`;
      }
      if (RETURN_DATE_QUESTION_PATTERN.test(currentText)) {
        const projection = projectJourneyReturnDate(legs);
        content = `${content}\n\n${buildReturnDateProjectionMessage(projection, journey.travellerProfile.originCity, this.responseLanguage)}`;
      }
      return this.tag("calculate_journey_budget", textResult(content));
    }
    // A standalone return-date/"when will I land" ask about the existing journey — answered directly from
    // structured journey state (never routed to knowledge/RAG search, and never blocked on the current
    // leg's own missing fields, mirroring CALCULATE_JOURNEY_BUDGET's policy).
    if (
      planningAction === null &&
      RETURN_DATE_QUESTION_PATTERN.test(currentText) &&
      (this.journey?.legs.length ?? 0) + (merged.destinationCity ? 1 : 0) >= 1
    ) {
      const journey = this.ensureJourney(merged);
      const legs = this.collectAllJourneyLegs(journey, merged);
      const projection = projectJourneyReturnDate(legs);
      return this.tag(
        "journey_return_date_projection",
        textResult(buildReturnDateProjectionMessage(projection, journey.travellerProfile.originCity, this.responseLanguage))
      );
    }
    if (planningAction === "CALCULATE_BUDGET" && canEstimateFlights) {
      // A budget aside must never erase an in-progress booking — answer it, but leave BOOK_FLIGHT pending
      // so the next turn's resume-check picks the booking flow back up instead of losing the intent.
      if (this.pendingAction !== "BOOK_FLIGHT") this.pendingAction = null;
      if (missing.length > 0) {
        this.lastStage = stageForMissingEntityField(missing[0] ?? "");
        this.lastAskedField = missing[0] ?? null;
      }
      this.lastWorkflowPhase = readyToSearch ? "READY_TO_SEARCH" : "COLLECTING_DETAILS";
      return this.tag(
        "calculate_budget",
        textResult(this.showBudgetGuidance(merged))
      );
    }

    // Resume a previously blocked structured action the instant its blocking field arrives — this must
    // win over this turn's own fresh classification, so e.g. a plain "Kolkata" reply after "you suggest
    // your budget" -> "which city are you departing from?" resumes budget guidance immediately instead of
    // falling into generic missing-field collection and forgetting what was actually being asked for.
    if (this.pendingAction === "GENERATE_BUDGET_GUIDANCE" && canEstimateFlights) {
      this.pendingAction = null;
      this.lastStage = "RECOMMEND_OPTIONS";
      this.lastWorkflowPhase = readyToSearch ? "READY_TO_SEARCH" : "COLLECTING_DETAILS";
      this.lastAskedField = null;
      return this.tag(
        "resume_budget_guidance",
        textResult(this.showBudgetGuidance(merged))
      );
    }
    if (this.pendingAction === "SEARCH_OPTIONS" && readyToSearch) {
      this.pendingAction = null;
      if (this.providerFailure && !isExplicitLiveOptionsRequest(currentText)) {
        const estimate = estimateBudgetRange(merged, this.config, this.effectiveDisplayCurrency(merged));
        this.storeEstimate(merged, "INDICATIVE");
        return this.tag(
          "resume_search_indicative_after_failure",
          textResult(buildIndicativeRecommendationsMessage(merged, estimate, this.responseLanguage, true))
        );
      }
      return this.tag("resume_search", this.searchOrBelowMinimumHandoff(merged, feasibility, request.tools));
    }
    if (this.pendingAction === "GENERATE_ITINERARY" && hasItineraryFields(merged)) {
      this.pendingAction = null;
      const itinerary = await this.safeGenerateItinerary(merged, currentText);
      this.lastGeneratedItinerary = itinerary;
      return this.tag("resume_generate_itinerary", textResult(itinerary));
    }
    if (this.pendingAction === "MODIFY_HOTEL_BUDGET" && readyToSearch && itineraryAlreadyPresented) {
      this.pendingAction = null;
      return this.tag("resume_hotel_modification", this.handleHotelBudgetModification(merged));
    }
    if (this.pendingAction === "BOOK_FLIGHT" || this.pendingAction === "BOOK_HOTEL") {
      const kind = this.pendingAction;
      return this.tag(
        kind === "BOOK_FLIGHT" ? "resume_book_flight" : "resume_book_hotel",
        await this.continueBookingFlow(kind, merged, feasibility, request.tools, changed, currentText, isFirstTurn)
      );
    }

    // A deterministic, phrase-based budget-mode request ("you suggest your budget", "no budget") must
    // never fall into free-form LLM chat, and must never ask for a numeric amount. If the departure city
    // isn't known yet, it's parked as a pending action and resumed automatically above once it arrives.
    if (budgetSignal) {
      if (!canEstimateFlights) {
        this.pendingAction = "GENERATE_BUDGET_GUIDANCE";
        this.lastStage = "ASK_MISSING_INFO";
        this.lastWorkflowPhase = "COLLECTING_DETAILS";
        this.lastAskedField = "originCity";
        return this.tag("budget_mode_needs_origin", textResult(buildOriginRequiredMessage(this.responseLanguage)));
      }
      this.pendingAction = null;
      if (missing.length > 0) {
        this.lastStage = stageForMissingEntityField(missing[0] ?? "");
        this.lastAskedField = missing[0] ?? null;
      }
      this.lastWorkflowPhase = readyToSearch ? "READY_TO_SEARCH" : "COLLECTING_DETAILS";
      return this.tag(
        "budget_mode_guidance",
        textResult(this.showBudgetGuidance(merged))
      );
    }

    // Reply to the three-way recovery menu shown after a provider failure — checked only when a failure is
    // actually outstanding, so a bare "1"/"2" elsewhere (e.g. "2 adults", already consumed by extraction
    // long before this point) can never be misread as a menu pick. Priority: this sits below every explicit
    // planning action and pending-action resume above, and below the budget reminder just handled — it is
    // the "Provider failure" tier, checked only once nothing higher already resolved the turn.
    if (isRecoveryMenuActive(this.providerFailure)) {
      const selection = detectProviderFailureRecoverySelection(currentText);
      if (selection === "RETRY_LIVE_SEARCH") {
        this.providerFailure = null;
        this.pendingAction = null;
        return this.tag(
          "provider_failure_retry",
          this.searchOrBelowMinimumHandoff(merged, feasibility, request.tools, true)
        );
      }
      if (selection === "CALLBACK" && this.providerFailure) {
        this.providerFailure.selectedRecoveryAction = "CALLBACK";
        return this.tag("provider_failure_callback", this.beginOrResumeLeadCapture(currentText));
      }
      if (selection === "INDICATIVE_RECOMMENDATIONS" && this.providerFailure) {
        this.providerFailure.selectedRecoveryAction = "INDICATIVE_RECOMMENDATIONS";
        // Real UAT bug: accepting the indicative numbers used to just acknowledge ("Anything else you'd
        // like to adjust?") and dead-end there — the traveler then had to separately type an explicit
        // "book my flight" to ever see bookable options. Accepting IS the traveler saying "let's move
        // forward with this" — go straight to the same structured, selectable Option 1/2/3 package set the
        // explicit booking-intent trigger below produces, exactly as if they'd asked to book. Only when a
        // required field is somehow still missing (the indicative estimate can be computed with less than
        // everything a real booking option needs) does this fall back to the old plain acknowledgement.
        if (determineMissingFields(this.lastEntities).length === 0) {
          const options = generateSimulatedPackageOptions(this.lastEntities, this.config, packageOptionSeed(this.lastEntities));
          this.pendingAction = "AWAITING_OPTION_SELECTION" as TravelPendingAction;
          this.pendingRecommendations = options;
          this.selectedRecommendationId = null;
          return this.tag("provider_failure_continue_to_options", textResult(formatPackageOptionsMessage(options)));
        }
        return this.tag(
          "provider_failure_continue_indicative",
          textResult(buildRecoveryContinuationMessage(this.responseLanguage))
        );
      }
    }

    // Bare numeric input ("3") with no active option list must not fall through to LLM classification,
    // which could generate inappropriate responses (e.g. repeating a travel reference). The recovery menu
    // above is the ONLY valid numbered option list — if it wasn't active, a bare number is not actionable.
    // However, a bare number IS valid when the system is actively waiting for a specific numeric input
    // such as a year clarification ("2026"), passenger count ("5"), budget amount, or contact number.
    if (/^\s*\d+(?:\.\d+)?\s*$/.test(currentText)) {
      const numericAccepted =
        this.pendingInputAction === "AWAITING_TRAVEL_YEAR" ||
        this.pendingInputAction === "AWAITING_PASSENGER_COMPOSITION" ||
        this.pendingInputAction === "AWAITING_LEAD_CONTACT" ||
        this.lastAskedField === "travelYear" ||
        this.lastAskedField === "passengerComposition" ||
        this.lastAskedField === "budget" ||
        this.lastAskedField === "duration" ||
        detectYearClarification(currentText) !== null ||
        isRecoveryMenuActive(this.providerFailure);
      if (!numericAccepted) {
        return this.tag(
          "unexpected_numeric_reply",
          textResult(
            this.responseLanguage === "HINGLISH"
              ? "Kripya apna response text mein share karein."
              : this.responseLanguage === "HINDI"
                ? "कृपया अपना उत्तर पाठ में साझा करें।"
                : "Please share your response in text."
          )
        );
      }
    }

    // Deterministic MODIFY_HOTEL_BUDGET action: recognized from phrasing directly, not from LLM intent,
    // so the orchestrator — not the model — decides whether this structured action runs. Always local,
    // deterministic repricing (never a `travel.search_hotels` tool call) — hotel trimming alone is never a
    // reason to call an external tool, and is never reported as a technical failure even when no hotel
    // tier can make the budget feasible. If an itinerary already exists but a required field (almost
    // always origin) is missing, park it instead of silently dropping the request.
    if (isHotelBudgetModificationRequest(currentText)) {
      if (itineraryAlreadyPresented && readyToSearch)
        return this.tag("hotel_modification", this.handleHotelBudgetModification(merged));
      if (itineraryAlreadyPresented && !canEstimateFlights) {
        this.pendingAction = "MODIFY_HOTEL_BUDGET";
        this.lastStage = "ASK_MISSING_INFO";
        this.lastWorkflowPhase = "COLLECTING_DETAILS";
        this.lastAskedField = "originCity";
        return this.tag(
          "hotel_modification_needs_origin",
          textResult(buildOriginRequiredMessage(this.responseLanguage))
        );
      }
    }

    // A valid contextual question or comment must be answered on its own terms — the state machine
    // still governs workflow progression, but it must not force a generic "next stage" response here.
    if (intent === "ask_budget_guidance") {
      if (!canEstimateFlights) {
        this.pendingAction = "GENERATE_BUDGET_GUIDANCE";
        this.lastStage = "ASK_MISSING_INFO";
        this.lastWorkflowPhase = "COLLECTING_DETAILS";
        this.lastAskedField = "originCity";
        return this.tag(
          "ask_budget_guidance_needs_origin",
          textResult(buildOriginRequiredMessage(this.responseLanguage))
        );
      }
      this.pendingAction = null;
      if (missing.length > 0) {
        this.lastStage = stageForMissingEntityField(missing[0] ?? "");
        this.lastAskedField = missing[0] ?? null;
      }
      this.lastWorkflowPhase = readyToSearch ? "READY_TO_SEARCH" : "COLLECTING_DETAILS";
      return this.tag(
        "ask_budget_guidance",
        textResult(this.showBudgetGuidance(merged))
      );
    }

    // Once every required field is known, explicit authorization or a recommendation/confirmation-style
    // ask must execute the search tools immediately — never a conversational "would you like me to..."
    // deflection. This is the fix for the reported loop: the LLM's intent label is a hint, not a veto —
    // deterministic phrasing (isExecutionRequest) always wins when the workflow is ready to act. A budget
    // that is BELOW_MINIMUM is redirected to the sales-handoff flow instead of an automatic search.
    if (readyToSearch && !itineraryAlreadyPresented) {
      const wantsExecution =
        isExecutionRequest(currentText) ||
        intent === "ask_recommendation" ||
        intent === "request_plan" ||
        intent === "confirm_plan";
      if (wantsExecution) {
        // A vague "go ahead"/"yes"/ask_recommendation-style follow-up must never blindly retry a live
        // provider that just failed — only an explicit "live/current" ask (handled above as
        // SEARCH_LIVE_OPTIONS) forces a fresh attempt. Offer indicative recommendations instead.
        if (this.providerFailure && !isExplicitLiveOptionsRequest(currentText)) {
          this.lastWorkflowPhase = "READY_TO_SEARCH";
          const estimate = estimateBudgetRange(merged, this.config, this.effectiveDisplayCurrency(merged));
          this.storeEstimate(merged, "INDICATIVE");
          return this.tag(
            "execute_search_indicative_after_failure",
            textResult(buildIndicativeRecommendationsMessage(merged, estimate, this.responseLanguage, true))
          );
        }
        this.lastWorkflowPhase = "READY_TO_SEARCH";
        return this.tag("execute_search", this.searchOrBelowMinimumHandoff(merged, feasibility, request.tools));
      }
    }

    // ask_recommendation / request_plan are actionable planning requests, not small talk — when the
    // workflow isn't ready yet they must be handled deterministically (ask for the one specific missing
    // field, resuming automatically above once satisfied) rather than routed to free-form LLM chat, which
    // previously produced generic, unrelated replies (e.g. sightseeing tips) instead of progressing the plan.
    if ((intent === "ask_recommendation" || intent === "request_plan") && !readyToSearch) {
      this.pendingAction = "SEARCH_OPTIONS";
      if (!canEstimateFlights) {
        this.lastStage = "ASK_MISSING_INFO";
        this.lastWorkflowPhase = "COLLECTING_DETAILS";
        this.lastAskedField = "originCity";
        return this.tag("plan_request_needs_origin", textResult(buildOriginRequiredMessage(this.responseLanguage)));
      }
      this.lastStage = stageForMissingEntityField(missing[0] ?? "");
      this.lastWorkflowPhase = "COLLECTING_DETAILS";
      this.lastAskedField = missing[0] ?? null;
      const reply = await this.safeGenerateReply(merged, missing, changed, currentText, isFirstTurn, false);
      return this.tag("plan_request_ask_missing", textResult(reply));
    }

    if (intent === "ask_question" || intent === "casual_conversation") {
      const reply = await this.safeGenerateContextualReply(merged, missing, itineraryAlreadyPresented, currentText);
      this.lastWorkflowPhase = readyToSearch ? "READY_TO_SEARCH" : "COLLECTING_DETAILS";
      return this.tag("contextual_reply", textResult(reply));
    }
    if (intent === "reject_plan" && itineraryAlreadyPresented && missing.length === 0) {
      this.lastStage = "RECOMMEND_OPTIONS";
      this.lastWorkflowPhase = "COLLECTING_DETAILS";
      return this.tag("reject_plan", textResult(buildRejectPlanMessage(this.responseLanguage)));
    }

    if (missing.length === 0) {
      // A correction to an already-presented trip (e.g. "not London, Paris") must re-run recommendations
      // immediately — the plan having been shown once already implies authorization for a refined re-show,
      // unlike a cold completion that was never asked for (handled below).
      if (itineraryAlreadyPresented && intent === "modify_trip") {
        return this.tag("execute_search", this.searchOrBelowMinimumHandoff(merged, feasibility, request.tools));
      }
      if (itineraryAlreadyPresented) {
        // Sprint 6.6 — Part 38/19 (parity with the no-LLM engine's equivalent fix above): `intent ===
        // "modify_trip"` already wins ahead of this branch in the normal case (Sprint 6.5's
        // `detectExplicitFieldCorrection` forces it whenever a differing literal value is found), but this
        // is a defense-in-depth guard for the same "kar do" ⇒ universal-confirmation false positive —
        // never treat an actual CORRECTION as a booking confirmation just because `isBookingConfirmation`'s
        // pattern also happens to match.
        const overridesBookingConfirmation =
          classifyUserInput(currentText, { hasPendingQuestion: true }).semantic === "CORRECTION";
        if (intent === "confirm_plan" || (isBookingConfirmation(currentText) && !overridesBookingConfirmation)) {
          this.lastWorkflowPhase = "AWAITING_CONFIRMATION";
          return this.tag("confirm_booking_lead_capture", this.beginOrResumeLeadCapture(currentText));
        }
        this.lastStage = "CONFIRM_BOOKING";
        this.lastWorkflowPhase = "AWAITING_CONFIRMATION";
        return this.tag("confirm_prompt", textResult(buildConfirmPrompt(this.responseLanguage)));
      }
      if (!canEstimateFlights) {
        this.lastStage = "ASK_MISSING_INFO";
        this.lastWorkflowPhase = "COLLECTING_DETAILS";
        this.lastAskedField = "originCity";
        return this.tag("ready_needs_origin", textResult(buildOriginRequiredMessage(this.responseLanguage)));
      }
      // A necessary clarification (passenger composition) or a business result (BELOW_MINIMUM feasibility)
      // must still surface immediately — neither is "calling a search tool", so neither needs explicit
      // authorization. Only the actual travel.search_flights/search_hotels call does (below).
      if (computePassengerState(merged) === "TOTAL_ONLY") {
        this.lastWorkflowPhase = "COLLECTING_DETAILS";
        this.lastAskedField = "passengerComposition";
        this.pendingInputAction = "AWAITING_PASSENGER_COMPOSITION";
        if (this.diagnostics) this.diagnostics.passengerClarificationRequired = true;
        return this.tag(
          "ready_needs_composition",
          textResult(buildPassengerCompositionClarificationMessage(merged.totalTravellers, this.responseLanguage))
        );
      }
      if (feasibility?.classification === "BELOW_MINIMUM") {
        return this.tag("execute_search", this.searchOrBelowMinimumHandoff(merged, feasibility, request.tools));
      }
      // Fields just became complete for the first time, without an explicit search/options request this
      // turn. Per policy, "all fields complete" is not itself authorization to call
      // travel.search_flights/search_hotels — offer instead of acting, and park SEARCH_OPTIONS so an
      // explicit go-ahead resumes it above.
      this.pendingAction = "SEARCH_OPTIONS";
      this.lastStage = "RECOMMEND_OPTIONS";
      this.lastWorkflowPhase = "READY_TO_SEARCH";
      return this.tag("ready_awaiting_authorization", textResult(buildReadyToSearchPromptMessage(this.responseLanguage)));
    }

    this.lastStage = stageForMissingEntityField(missing[0] ?? "");
    this.lastWorkflowPhase = "COLLECTING_DETAILS";
    this.lastAskedField = missing[0] ?? null;
    // Always ask for the next missing detail through the real provider (when one is configured) so every
    // turn — not just the first — gets a warm, varied, human-sounding reply per buildGenerationSystemPrompt,
    // instead of the deterministic bullet-list template. `safeGenerateReply` itself is the safety net: if
    // the provider call genuinely fails or returns nothing, it falls back to buildFallbackAskMessage there.
    // Previously this skipped the provider entirely once the conversation was "established" (a latency/cost
    // optimization) — which is exactly why established-conversation turns sounded robotic even with a
    // correctly configured, working AI provider: the LLM was never being called for them at all.
    const reply = await this.safeGenerateReply(
      merged, missing, changed, currentText, isFirstTurn, intent === "start_new_trip"
    );
    return this.tag("ask_missing_field", textResult(reply));
  }

  /**
   * Applies the confidence-based clarification policy to any city field the model returned a rich
   * interpretation for. High confidence lets the value flow through untouched; medium/low confidence
   * withholds it from this turn's extraction and returns a "Did you mean...?" / open clarification reply
   * instead, so an uncertain correction is never silently accepted into confirmed state.
   */
  private applyCityConfidenceGate(
    cityInterpretations: Partial<Record<"originCity" | "destinationCity", CityInterpretation>>,
    extracted: Partial<TravelEntities>
  ): AiCompletionResult | null {
    for (const field of ["originCity", "destinationCity"] as const) {
      const interpretation = cityInterpretations[field];
      if (!interpretation || !interpretation.normalizedValue) continue;
      const action = classifyCityConfidence(interpretation.confidence);
      if (action === "accept") continue;
      extracted[field] = null;
      this.lastAskedField = field;
      if (action === "confirm") {
        this.pendingClarification = {
          field,
          proposedValue: interpretation.normalizedValue,
          rawValue: interpretation.rawValue,
          confidence: interpretation.confidence
        };
        return textResult(buildCityConfirmationMessage(field, interpretation.normalizedValue, this.responseLanguage));
      }
      return textResult(buildCityClarificationMessage(field, interpretation.rawValue, this.responseLanguage));
    }
    return null;
  }

  /**
   * Reconciles a freshly extracted composition breakdown ("2 adults, 2 kids, 1 infant") against any
   * previously stated ambiguous total ("5 log"). If they agree (or no prior total exists), the total is
   * derived from the breakdown and merged alongside it. If they conflict, neither is merged this turn —
   * silently overwriting a conflicting total would hide a real discrepancy, so this asks instead.
   */
  /**
   * Reconciles a freshly extracted composition field (or fields) against any previously stated ambiguous
   * total ("5 log") — and, per policy, against a previously proposed but conflicting candidate breakdown.
   * A single-field correction like "1 infant" after a conflict patches only that field onto the stored
   * candidate (see {@link PendingPassengerConflict}) rather than being interpreted in isolation with no
   * memory of the adults/children already proposed. Only asks again if the (possibly patched) breakdown
   * still doesn't add up; never silently overwrites either number.
   */
  private applyPassengerReconciliation(extracted: Partial<TravelEntities>): AiCompletionResult | null {
    // `parseExtractedEntities` (and the deterministic fallback) always fill an unmentioned field with
    // `null`, never leave it `undefined` — so "was this actually touched this turn" must check for a real
    // value (neither null nor undefined), not merely "the key is present".
    const touchedComposition = extracted.adults != null || extracted.children != null || extracted.infants != null;
    if (!touchedComposition) {
      const explicitTotal = extracted.totalTravellers;
      if (
        explicitTotal != null &&
        this.lastEntities.adults != null &&
        explicitTotal !==
          this.lastEntities.adults + (this.lastEntities.children ?? 0) + (this.lastEntities.infants ?? 0)
      ) {
        const priorTotal =
          this.lastEntities.adults + (this.lastEntities.children ?? 0) + (this.lastEntities.infants ?? 0);
        this.pendingPassengerConflict = {
          expectedTotal: explicitTotal,
          candidateAdults: this.lastEntities.adults,
          candidateChildren: this.lastEntities.children,
          candidateInfants: this.lastEntities.infants
        };
        extracted.totalTravellers = null;
        this.lastAskedField = "passengerComposition";
        this.pendingInputAction = "AWAITING_PASSENGER_COMPOSITION";
        if (this.diagnostics) this.diagnostics.passengerClarificationRequired = true;
        return textResult(
          `Earlier you said ${this.lastEntities.adults} adults and ${this.lastEntities.children ?? 0} child${this.lastEntities.children === 1 ? "" : "ren"}, which is ${priorTotal} travellers. Did you add one more traveller, making the total ${explicitTotal}?`
        );
      }
      return null;
    }

    const mode = detectPassengerCorrectionMode(extracted);

    // FULL_REPLACEMENT: two or more categories mentioned together is an unambiguous, complete breakdown —
    // any category not mentioned this turn becomes zero (never carried forward from a stale candidate or
    // prior entities), and it commits immediately. There is nothing left to reconcile against a previously
    // stated total: the traveler has just told us, definitively, what the new total is.
    if (mode === "FULL_REPLACEMENT") {
      const candidateAdults = extracted.adults ?? 0;
      const candidateChildren = extracted.children ?? 0;
      const candidateInfants = extracted.infants ?? 0;
      this.pendingPassengerConflict = null;
      if (this.pendingInputAction === "AWAITING_PASSENGER_COMPOSITION")
        this.pendingInputAction = null;
      extracted.adults = candidateAdults;
      extracted.children = candidateChildren;
      extracted.infants = candidateInfants;
      extracted.totalTravellers = candidateAdults + candidateChildren + candidateInfants;
      return null;
    }

    // PATCH: exactly one category mentioned — patch just that field onto the existing candidate/entities
    // and re-check against any previously stated total, since a single-field correction alone doesn't tell
    // us whether the rest of the breakdown still adds up.
    const pending = this.pendingPassengerConflict;
    const candidateAdults = extracted.adults ?? pending?.candidateAdults ?? this.lastEntities.adults;
    const candidateChildren = extracted.children ?? pending?.candidateChildren ?? this.lastEntities.children;
    const candidateInfants = extracted.infants ?? pending?.candidateInfants ?? this.lastEntities.infants;
    if (candidateAdults === null || candidateAdults === undefined) return null;

    const newTotal = candidateAdults + (candidateChildren ?? 0) + (candidateInfants ?? 0);
    const expectedTotal = pending?.expectedTotal ?? this.lastEntities.totalTravellers;

    if (expectedTotal !== null && expectedTotal !== newTotal) {
      if (this.diagnostics) this.diagnostics.passengerClarificationRequired = true;
      this.pendingPassengerConflict = {
        expectedTotal,
        candidateAdults,
        candidateChildren: candidateChildren ?? null,
        candidateInfants: candidateInfants ?? null
      };
      extracted.adults = null;
      extracted.children = null;
      extracted.infants = null;
      this.lastAskedField = "passengerComposition";
      this.pendingInputAction = "AWAITING_PASSENGER_COMPOSITION";
      return textResult(buildPassengerCompositionConflictMessage(expectedTotal, newTotal, this.responseLanguage));
    }

    this.pendingPassengerConflict = null;
    if (this.pendingInputAction === "AWAITING_PASSENGER_COMPOSITION")
      this.pendingInputAction = null;
    extracted.adults = candidateAdults;
    extracted.children = candidateChildren ?? null;
    extracted.infants = candidateInfants ?? null;
    extracted.totalTravellers = newTotal;
    return null;
  }

  /**
   * BOOK_FLIGHT/BOOK_HOTEL's collection/resume logic, shared by the fresh-classification branch and the
   * pending-action resume-check: booking intent must survive every clarification (city confirmation,
   * passenger conflict, an intervening budget aside), and must only ever collect booking-required fields —
   * never budget. Once ready, "book it" is itself explicit authorization to search, so this hands off
   * directly rather than parking a SEARCH_OPTIONS offer first. Both kinds share this logic because the
   * underlying tool pipeline (`executeSearch`) already calls flights and hotels together in one pass —
   * there is no separate hotel-only booking tool for BOOK_HOTEL to call instead.
   */
  private async continueBookingFlow(
    kind: "BOOK_FLIGHT" | "BOOK_HOTEL",
    merged: TravelEntities,
    feasibility: BudgetFeasibilityResult | null,
    tools: readonly AiToolDefinition[] | undefined,
    changed: string[],
    currentText: string,
    isFirstTurn: boolean
  ): Promise<AiCompletionResult> {
    this.pendingAction = kind;
    const canEstimateFlights = validateBudgetEstimateInputs(merged).canEstimateFlights;
    if (!canEstimateFlights) {
      this.lastStage = "ASK_MISSING_INFO";
      this.lastWorkflowPhase = "COLLECTING_DETAILS";
      this.lastAskedField = "originCity";
      return textResult(buildOriginRequiredMessage(this.responseLanguage));
    }
    const missingForBooking = missingBookingFields(merged);
    if (missingForBooking.length > 0) {
      this.lastStage = stageForMissingEntityField(missingForBooking[0] ?? "");
      this.lastWorkflowPhase = "COLLECTING_DETAILS";
      this.lastAskedField = missingForBooking[0] ?? null;
      const reply = await this.safeGenerateReply(merged, missingForBooking, changed, currentText, isFirstTurn, false);
      return textResult(reply);
    }
    if (computePassengerState(merged) === "TOTAL_ONLY") {
      this.lastWorkflowPhase = "COLLECTING_DETAILS";
      this.lastAskedField = "passengerComposition";
      this.pendingInputAction = "AWAITING_PASSENGER_COMPOSITION";
      if (this.diagnostics) this.diagnostics.passengerClarificationRequired = true;
      return textResult(buildPassengerCompositionClarificationMessage(merged.totalTravellers, this.responseLanguage));
    }
    this.pendingAction = null;
    // An explicit booking go-ahead (or its resume, once the blocking field arrives) is itself a fresh
    // attempt — clear any stale failure record rather than leaving it to block a LATER vague follow-up.
    this.providerFailure = null;
    this.lastWorkflowPhase = "READY_TO_SEARCH";
    return this.searchOrBelowMinimumHandoff(merged, feasibility, tools, true);
  }

  /** Lazily creates the journey the first time it's needed — most single-leg conversations never need one. */
  private ensureJourney(entities: TravelEntities): Journey {
    if (!this.journey) {
      this.journey = {
        id: randomUUID(),
        version: 1,
        travellerProfile: {
          originCity: entities.originCity,
          cabinClass: entities.cabinClass,
          hotelStars: entities.hotelStars,
          preferences: entities.preferences
        },
        status: "DRAFT",
        legs: []
      };
    }
    return this.journey;
  }

  /**
   * The complete, ordered list of legs to consider for CRM submission or journey-level budgeting: every
   * already-finalized leg, plus the current in-progress one — unless the current entities already mirror
   * the last finalized leg exactly (as they do right after a multi-leg parse finalizes everything at once,
   * see `startMultipleJourneyLegs`), in which case appending it again would double-count that leg.
   */
  private collectAllJourneyLegs(journey: Journey, currentEntities: TravelEntities): JourneyLeg[] {
    const lastLeg = journey.legs[journey.legs.length - 1];
    const cityKey = (city: string | null): string | null => {
      const normalized = normalizeCityName(city)?.toLowerCase().replace(/\s+/g, "") ?? null;
      return normalized === "newdelhi" ? "delhi" : normalized;
    };
    const currentMirrorsLastLeg =
      lastLeg !== undefined &&
      cityKey(lastLeg.origin) === cityKey(currentEntities.originCity) &&
      cityKey(lastLeg.destination) === cityKey(currentEntities.destinationCity) &&
      lastLeg.duration.days === currentEntities.days &&
      lastLeg.duration.nights === currentEntities.nights;
    const currentIsDegenerate =
      cityKey(currentEntities.originCity) !== null &&
      cityKey(currentEntities.originCity) === cityKey(currentEntities.destinationCity);
    const currentAlreadyFinalized =
      lastLeg !== undefined &&
      cityKey(lastLeg.destination) === cityKey(currentEntities.destinationCity) &&
      currentEntities.days === null &&
      currentEntities.nights === null;
    if (
      currentMirrorsLastLeg ||
      currentIsDegenerate ||
      currentAlreadyFinalized ||
      !currentEntities.destinationCity
    )
      return [...journey.legs];
    return [
      ...journey.legs,
      toJourneyLeg(currentEntities, this.lastGeneratedItinerary, this.lastBudgetEstimate, journey.legs.length + 1)
    ];
  }

  /**
   * GENERATE_COMPLETE_TRIP_PLAN for a 2+ leg journey: generates each leg's own day-wise itinerary (one LLM
   * call per leg, using that leg's own destination/duration/passengers — never the whole journey's), then
   * builds and validates the full multi-leg plan via `buildJourneyCompleteTripPlan`/
   * `validateJourneyCompleteTripPlan`. Fails loudly (never ships a silently incomplete plan) if validation
   * somehow doesn't pass — mirrors the single-leg `buildCompleteTripPlanMessage`'s own defensive throw.
   */
  private async buildJourneyCompleteTripPlanResult(
    journey: Journey,
    legs: readonly JourneyLeg[],
    userMessage: string
  ): Promise<AiCompletionResult> {
    const perLegItineraries = await Promise.all(
      legs.map((leg) => this.safeGenerateItinerary(legToEntities(leg, journey.travellerProfile), userMessage))
    );
    legs.forEach((leg, index) => {
      leg.itinerary = perLegItineraries[index] ?? leg.itinerary;
    });
    const journeyEstimate = estimateJourneyBudgetRange(legs, journey.travellerProfile, this.config);
    const plan = buildJourneyCompleteTripPlan(journey, legs, perLegItineraries, journeyEstimate, this.responseLanguage);
    const validation = validateJourneyCompleteTripPlan(plan, legs);
    if (!validation.valid) {
      throw new Error(
        `JourneyCompleteTripPlan failed validation — missing: [${validation.missingSections.join(", ")}], duplicate: [${validation.duplicateSections.join(", ")}]`
      );
    }
    this.lastGeneratedItinerary = perLegItineraries[perLegItineraries.length - 1] ?? null;
    this.lastBudgetEstimate = null;
    return textResult(renderJourneyCompleteTripPlan(plan));
  }

  /**
   * ADD_TRIP_LEG: finalizes the leg that was in progress before this turn and starts a fresh one. Uses
   * `priorEntities` — a snapshot taken before this turn's merge ran — rather than `this.lastEntities`,
   * because the merge step may have already reset the trip (e.g. if the LLM misread "continue to New York"
   * as `start_new_trip`); reading the pre-merge snapshot means that misclassification can never lose the
   * leg that's supposed to be finalized. Passenger mix, cabin class, and preferences carry over onto the
   * new leg (the same travel party is continuing); dates, duration, and budget reset — each leg has its own.
   */
  private async startNewJourneyLeg(priorEntities: TravelEntities, currentText: string, isFirstTurn: boolean): Promise<AiCompletionResult> {
    // The same message that introduces the next leg sometimes also restates/corrects the duration of the
    // leg being finalized here — e.g. "Tokyo me 3 days, phir London me 2 days..." — which `deriveNextLeg`/
    // route-chain logic can't attach to `priorEntities` on its own (see `extractStayOverrideForCity`).
    const stayOverride = extractStayOverrideForCity(currentText, priorEntities.destinationCity);
    const finalizedPriorEntities: TravelEntities = stayOverride
      ? { ...priorEntities, days: stayOverride.days ?? priorEntities.days, nights: stayOverride.nights ?? priorEntities.nights }
      : priorEntities;

    const journey = this.ensureJourney(finalizedPriorEntities);
    if (finalizedPriorEntities.destinationCity) {
      const before = JSON.stringify(journey.legs);
      journey.legs = reconcileJourneyLegs(
        journey.legs,
        [toJourneyLeg(finalizedPriorEntities, this.lastGeneratedItinerary, this.lastBudgetEstimate, journey.legs.length + 1)],
        journey.travellerProfile.originCity
      );
      if (JSON.stringify(journey.legs) !== before) journey.version = (journey.version ?? 1) + 1;
    }
    journey.status = "PLANNING";

    const fromDestination = finalizedPriorEntities.destinationCity;
    // The new leg's origin defaults to the leg just finalized ("phir Delhi wapas" continues FROM Tokyo/
    // London, not from wherever `this.lastEntities.originCity` was last merged to) — unless the traveler
    // explicitly restated a different origin this turn, in which case that restatement wins.
    const originExplicitlyRestated = this.lastEntities.originCity !== priorEntities.originCity;
    const newLeg: TravelEntities = {
      ...this.lastEntities,
      originCity: originExplicitlyRestated ? this.lastEntities.originCity : fromDestination,
      departureDate: null,
      travelMonth: null,
      returnDate: null,
      days: null,
      nights: null,
      budget: null,
      budgetCurrency: null
    };
    this.lastEntities = newLeg;
    // Drop confirmation entries for the fields that were just reset — otherwise "confirmed entity
    // immutability" would block the new leg's dates/duration/budget from ever being collected again.
    const resetConfirmationKeys: readonly ConfirmableEntityKey[] = [
      "departureDate",
      "travelMonth",
      "returnDate",
      "days",
      "nights",
      "budget",
      "budgetCurrency"
    ];
    this.confirmation = Object.fromEntries(
      Object.entries(this.confirmation).filter(
        ([key]) => !(resetConfirmationKeys as readonly string[]).includes(key)
      )
    ) as TravelEntityConfirmation;
    this.lastBudgetEstimate = null;
    this.lastGeneratedItinerary = null;
    this.budgetDiscussionCompleted = false;
    this.pendingAction = null;

    this.lastWorkflowPhase = "COLLECTING_DETAILS";
    const missingForLeg = computeMissingEntityFields(newLeg, this.budgetMode);
    this.lastStage = stageForMissingEntityField(missingForLeg[0] ?? "");
    this.lastAskedField = missingForLeg[0] ?? null;
    const reply = await this.safeGenerateReply(newLeg, missingForLeg, [], currentText, isFirstTurn, false);
    return textResult(`${buildTripLegAddedMessage(fromDestination, newLeg.destinationCity, this.responseLanguage)}\n\n${reply}`);
  }

  /**
   * ADD_TRIP_LEG when the message describes TWO OR MORE new legs at once (see `parseJourneyLegChain`) —
   * e.g. "Washington se London aur fir London se Delhi". Unlike `startNewJourneyLeg` (which leaves the
   * newest leg "in progress" as `this.lastEntities`, not yet in `journey.legs`, since the conversation is
   * presumably still collecting details for it), every parsed leg here — including the last — is finalized
   * into `journey.legs` immediately: the traveler has already stated origin+destination (and sometimes a
   * stay) for all of them in one breath, so there is nothing left to "collect" before finalizing. The last
   * leg's entities also become the new `this.lastEntities`, so an immediate follow-up (e.g. a budget
   * question) has a sensible "current trip" to refer to, without that duplicating anything in `journey.legs`
   * (see `collectAllJourneyLegs`'s current-mirrors-last-leg check).
   */
  private startMultipleJourneyLegs(
    priorEntities: TravelEntities,
    parsedLegs: readonly ParsedJourneyLeg[],
    currentText = ""
  ): AiCompletionResult {
    // Same fix as `startNewJourneyLeg`: "Tokyo me 3 days, phir London me 2 days, then back to Delhi" states
    // the finalized leg's duration inline, where "Tokyo" only ever appears as the ORIGIN of the new
    // Tokyo->London leg and so is never attached by `parseJourneyLegChain` itself.
    const stayOverride = extractStayOverrideForCity(currentText, priorEntities.destinationCity);
    const finalizedPriorEntities: TravelEntities = stayOverride
      ? { ...priorEntities, days: stayOverride.days ?? priorEntities.days, nights: stayOverride.nights ?? priorEntities.nights }
      : priorEntities;

    const journey = this.ensureJourney(finalizedPriorEntities);
    if (finalizedPriorEntities.destinationCity) {
      const before = JSON.stringify(journey.legs);
      journey.legs = reconcileJourneyLegs(
        journey.legs,
        [toJourneyLeg(finalizedPriorEntities, this.lastGeneratedItinerary, this.lastBudgetEstimate, journey.legs.length + 1)],
        journey.travellerProfile.originCity
      );
      if (JSON.stringify(journey.legs) !== before) journey.version = (journey.version ?? 1) + 1;
    }
    journey.status = "PLANNING";

    // A tentative departure date for the FIRST new leg is derived from the leg that was just finalized
    // (its own departure date + stay duration); each SUBSEQUENT new leg then chains forward from the
    // previous new leg's own (possibly already-derived) date — always surfaced as an assumption, never as
    // a stated fact, since none of this was actually said by the traveler.
    let priorDepartureDate = finalizedPriorEntities.departureDate;
    let priorDays = finalizedPriorEntities.days;
    let priorNights = finalizedPriorEntities.nights;
    const derivedLegPlans: DerivedJourneyLegPlan[] = [];

    let lastLegEntities: TravelEntities = priorEntities;
    for (const parsedLeg of parsedLegs) {
      const derivedDate = deriveNextLegDepartureDate({
        departureDate: priorDepartureDate,
        days: priorDays,
        nights: priorNights
      });
      const legEntities: TravelEntities = {
        ...EMPTY_TRAVEL_ENTITIES,
        customerName: priorEntities.customerName,
        originCity: parsedLeg.origin,
        destinationCity: parsedLeg.destination,
        departureDate: derivedDate.departureDate,
        days: parsedLeg.days,
        nights: parsedLeg.nights,
        adults: priorEntities.adults,
        children: priorEntities.children,
        infants: priorEntities.infants,
        totalTravellers: priorEntities.totalTravellers,
        cabinClass: priorEntities.cabinClass,
        hotelStars: priorEntities.hotelStars,
        tripType: priorEntities.tripType,
        preferences: priorEntities.preferences
      };
      const before = JSON.stringify(journey.legs);
      journey.legs = reconcileJourneyLegs(
        journey.legs,
        [toJourneyLeg(legEntities, null, null, journey.legs.length + 1, derivedDate.isAssumption)],
        journey.travellerProfile.originCity
      );
      if (JSON.stringify(journey.legs) !== before) journey.version = (journey.version ?? 1) + 1;
      derivedLegPlans.push({
        ...parsedLeg,
        departureDate: derivedDate.departureDate,
        departureDateIsAssumption: derivedDate.isAssumption
      });
      lastLegEntities = legEntities;
      priorDepartureDate = derivedDate.departureDate;
      priorDays = parsedLeg.days;
      priorNights = parsedLeg.nights;
    }

    this.lastEntities = lastLegEntities;
    this.confirmation = EMPTY_TRAVEL_ENTITY_CONFIRMATION;
    this.lastBudgetEstimate = null;
    this.lastGeneratedItinerary = null;
    this.budgetDiscussionCompleted = false;
    this.pendingAction = null;
    this.lastWorkflowPhase = "COLLECTING_DETAILS";
    return textResult(buildMultiLegAddedMessage(derivedLegPlans, this.responseLanguage));
  }

  /**
   * MULTILEG_CORRECTION: a bare "bhai multileg hai" (no new route stated) telling us the turns already
   * exchanged should have been chained into one journey. If the origin has already implicitly drifted away
   * from the traveler's home city (e.g. an earlier continuation like "London se New York jana hai" that
   * wasn't auto-detected as an extension), the journey is already structurally multi-leg even though it was
   * never split into `journey.legs` — split it now using the best information still available, rather than
   * asking the traveler to restate anything. Never resets budget/detail collection.
   */
  private acknowledgeMultilegCorrection(priorEntities: TravelEntities): AiCompletionResult {
    const journey = this.ensureJourney(priorEntities);
    journey.status = "PLANNING";
    const homeOrigin = journey.travellerProfile.originCity;
    if (
      journey.legs.length === 0 &&
      homeOrigin &&
      priorEntities.originCity &&
      priorEntities.originCity.toLowerCase() !== homeOrigin.toLowerCase()
    ) {
      journey.legs.push(
        toJourneyLeg({ ...EMPTY_TRAVEL_ENTITIES, originCity: homeOrigin, destinationCity: priorEntities.originCity }, null, null, 1)
      );
    }
    const legs = this.collectAllJourneyLegs(journey, priorEntities);
    return textResult(buildMultilegCorrectionMessage(legs, this.responseLanguage));
  }

  /**
   * Appends a total-cost and/or return-date answer to an already-built result when the SAME message that
   * triggered it also asked for one — compound-intent handling for the ADD_TRIP_LEG paths. Never mutates a
   * tool-call result (there's nothing to append text to), and always computes fresh from the current
   * journey snapshot rather than replaying anything cached.
   */
  private appendCompoundJourneyAnswers(result: AiCompletionResult, currentText: string): AiCompletionResult {
    if (!this.journey || result.toolCalls.length > 0) return result;
    const wantsBudget = BUDGET_ACTION_PATTERN.test(currentText) || JOURNEY_BUDGET_PATTERN.test(currentText);
    const wantsReturnDate = RETURN_DATE_QUESTION_PATTERN.test(currentText);
    if (!wantsBudget && !wantsReturnDate) return result;
    const legs = this.collectAllJourneyLegs(this.journey, this.lastEntities);
    let extra = "";
    if (wantsBudget) {
      const journeyEstimate = estimateJourneyBudgetRange(legs, this.journey.travellerProfile, this.config);
      extra += `\n\n${buildJourneyBudgetMessage(legs, journeyEstimate, this.responseLanguage)}`;
      this.budgetDiscussionCompleted = true;
    }
    if (wantsReturnDate) {
      const projection = projectJourneyReturnDate(legs);
      extra += `\n\n${buildReturnDateProjectionMessage(projection, this.journey.travellerProfile.originCity, this.responseLanguage)}`;
    }
    return { ...result, content: `${result.content}${extra}` };
  }

  /**
   * Single entry point for every "customer wants to be contacted" signal — an explicit SUBMIT_ENQUIRY/
   * CREATE_LEAD ask, REQUEST_CALLBACK ("call me", "request a callback"), or confirming a presented plan.
   * Always uses the built-in {@link TravelLead} capture (`travel.create_lead`) — never gated on, blocked
   * by, or dependent on an external CRM connector being configured. If the traveler's message already
   * contains a phone number, captures immediately; otherwise politely asks for one first. Idempotent: once
   * a lead has already been captured this conversation, a repeat ask just re-confirms it.
   */
  private beginOrResumeLeadCapture(currentText: string): AiCompletionResult {
    if (this.completionStage === "CAPTURED" && this.capturedLeadReference) {
      return textResult(buildLeadAlreadyCapturedMessage(this.capturedLeadReference, this.responseLanguage));
    }
    const phone = extractPhoneNumber(currentText);
    if (phone) {
      this.pendingLeadCapture = true;
      return toolResult("travel.create_lead", this.buildTravelLeadPayload(phone));
    }
    this.completionStage = "AWAITING_CONTACT";
    this.pendingInputAction = "AWAITING_LEAD_CONTACT";
    this.pendingAction = null;
    this.lastStage = "AWAITING_CONTACT";
    return textResult(buildContactRequestMessage(this.responseLanguage));
  }

  /**
   * Resolves a "yes" answer to an in-flight city clarification ("Did you mean Sydney?"). Per policy, this
   * is never itself authorization to run tools: it commits the field, preserves every other confirmed
   * value, and only resumes a structured action if one was already pending from an earlier, separate user
   * request. Otherwise it responds with a plain, natural acknowledgement and stops there.
   */
  private async resolveCityClarificationYes(
    pending: PendingCityClarification,
    tools: readonly AiToolDefinition[] | undefined,
    // Sprint 6.6 — Part 12/29: when a decline supplied its own replacement in the same breath ("No,
    // Dubai"), the caller commits THAT value here instead of `pending.proposedValue` — a literal
    // catalog-known city match, so `source: "USER_EXPLICIT"` (not "llm") and full confidence, matching
    // the convention explicit corrections already use elsewhere in this file.
    override?: { value: string; confidence: number }
  ): Promise<AiCompletionResult> {
    const now = new Date().toISOString();
    const resolvedValue = override?.value ?? pending.proposedValue;
    this.lastEntities = { ...this.lastEntities, [pending.field]: resolvedValue };
    this.confirmation = {
      ...this.confirmation,
      [pending.field]: {
        source: override ? "USER_EXPLICIT" : "llm",
        confidence: override?.confidence ?? pending.confidence,
        confirmed: true,
        updatedAt: now
      }
    };
    this.pendingClarification = null;

    const merged = this.lastEntities;
    const canEstimateFlights = validateBudgetEstimateInputs(merged).canEstimateFlights;
    const missing = computeMissingEntityFields(merged, this.budgetMode);
    const readyToSearch = missing.length === 0 && canEstimateFlights;

    // Per policy, resolving a clarification is never itself authorization to search — only an already
    // explicitly stored pending action may resume here, and each resumes its own specific action.
    if (this.pendingAction === "GENERATE_BUDGET_GUIDANCE" && canEstimateFlights) {
      this.pendingAction = null;
      this.lastStage = "RECOMMEND_OPTIONS";
      return textResult(this.showBudgetGuidance(merged));
    }
    if (this.pendingAction === "SEARCH_OPTIONS" && readyToSearch) {
      this.pendingAction = null;
      const feasibility: BudgetFeasibilityResult | null =
        this.budgetMode === "USER_DEFINED" && merged.budget !== null
          ? classifyBudgetFeasibility(merged.budget, estimateBudgetRange(merged, this.config))
          : null;
      return this.searchOrBelowMinimumHandoff(merged, feasibility, tools);
    }
    if (this.pendingAction === "GENERATE_ITINERARY" && hasItineraryFields(merged)) {
      this.pendingAction = null;
      const itinerary = await this.safeGenerateItinerary(merged, resolvedValue);
      this.lastGeneratedItinerary = itinerary;
      return textResult(itinerary);
    }
    // `MODIFY_HOTEL_BUDGET` is only ever parked once an itinerary has already been presented (see the
    // main turn handler), and message history only grows — so by the time it's resumable here, that
    // precondition still holds without needing to re-inspect the transcript.
    if (this.pendingAction === "MODIFY_HOTEL_BUDGET" && readyToSearch) {
      this.pendingAction = null;
      return this.handleHotelBudgetModification(merged);
    }
    if (this.pendingAction === "BOOK_FLIGHT" || this.pendingAction === "BOOK_HOTEL") {
      const kind = this.pendingAction;
      const feasibilityForBooking: BudgetFeasibilityResult | null =
        this.budgetMode === "USER_DEFINED" && merged.budget !== null
          ? classifyBudgetFeasibility(merged.budget, estimateBudgetRange(merged, this.config))
          : null;
      return this.continueBookingFlow(kind, merged, feasibilityForBooking, tools, [], resolvedValue, false);
    }
    // No pending action to resume — acknowledge the field update and stop there.
    return textResult(buildClarificationConfirmedMessage(pending.field, resolvedValue, this.responseLanguage));
  }

  /**
   * The single decision point for "the workflow wants to run a search now": redirects to the deterministic,
   * non-technical BELOW_MINIMUM sales-handoff flow instead of calling a search tool whenever the stated
   * budget is materially insufficient — a low budget must never surface as a technical/tool failure.
   */
  /**
   * The single decision point for "the workflow wants to run a search now": redirects to the deterministic
   * BELOW_MINIMUM sales-handoff flow instead of calling a search tool whenever the stated budget is
   * materially insufficient. Budget feasibility is a business result, not a global conversation blocker —
   * once already explained (`budgetDiscussionCompleted`), a GENERIC completion of the trip proceeds to the
   * actual search rather than repeating the same explanation. Pass `forceReminder: true` for an explicit,
   * budget-relevant re-ask (hotel/flights/budget/changed budget), which must always re-show it.
   */
  private searchOrBelowMinimumHandoff(
    merged: TravelEntities,
    feasibility: BudgetFeasibilityResult | null,
    tools: readonly AiToolDefinition[] | undefined,
    forceReminder = false
  ): AiCompletionResult {
    if (
      feasibility?.classification === "BELOW_MINIMUM" &&
      !this.budgetOverrideAccepted &&
      (forceReminder || !this.budgetDiscussionCompleted)
    ) {
      if (this.diagnostics) this.diagnostics.toolExecutionSkippedForFeasibility = true;
      return this.handleBelowMinimumFeasibility(merged, feasibility, tools);
    }
    // A multi-leg journey's search/recommendation must cover EVERY leg, never just the currently active
    // one — a single-leg live tool call (or single-leg placeholder) can only ever answer for one leg. Every
    // execute/search/confirm path funnels through this one method, so fixing it here fixes all of them at
    // once, including a bare Hinglish "ji" confirming a multi-city journey.
    if ((this.journey?.legs.length ?? 0) + (merged.destinationCity ? 1 : 0) >= 2) {
      const journey = this.ensureJourney(merged);
      const legs = this.collectAllJourneyLegs(journey, merged);
      return this.executeJourneySearch(journey, legs);
    }
    return this.executeSearch(merged, tools);
  }

  /** Placeholder flight/hotel options for EVERY leg of a journey, plus the combined budget — see {@link buildJourneyRecommendationMessage}. */
  private executeJourneySearch(journey: Journey, legs: readonly JourneyLeg[]): AiCompletionResult {
    this.lastWorkflowPhase = "OPTIONS_PRESENTED";
    const journeyEstimate = estimateJourneyBudgetRange(legs, journey.travellerProfile, this.config);
    const perLeg: JourneyLegRecommendation[] = legs.map((leg) => {
      const passengers =
        (leg.passengers.adults ?? leg.passengers.totalTravellers ?? 1) + (leg.passengers.children ?? 0);
      const { flightOptions } = generatePlaceholderFlights({
        destination: leg.destination ?? "your destination",
        travelMonth: leg.dates.travelMonth,
        passengers
      });
      const { hotelOptions } = generatePlaceholderHotels({
        destination: leg.destination ?? "your destination",
        travelMonth: leg.dates.travelMonth,
        hotelStars: journey.travellerProfile.hotelStars
      });
      return { leg, flights: flightOptions, hotels: hotelOptions };
    });
    return textResult(buildJourneyRecommendationMessage(perLeg, journeyEstimate, this.responseLanguage));
  }

  /**
   * BELOW_MINIMUM business result: explains the shortfall and alternatives in the conversation's language,
   * then — if a CRM-lead tool is available — ALSO saves/updates the external enquiry tagged
   * BUDGET_BELOW_MINIMUM / SALES_FOLLOW_UP_REQUIRED (that callback promise is only ever made after that
   * save actually succeeds — see the `pendingSalesHandoff` resolution in `continueAfterTool`); this never
   * calls a search tool. Independent of whether a CRM tool exists, this always invites a phone number and
   * puts the conversation into the SAME `AWAITING_CONTACT` state every other lead-capture entry point uses
   * (see `beginOrResumeLeadCapture`) — the internal {@link TravelLead} record must never depend on whether
   * an external CRM connector happens to be configured for this organization.
   */
  private handleBelowMinimumFeasibility(
    merged: TravelEntities,
    feasibility: BudgetFeasibilityResult,
    tools: readonly AiToolDefinition[] | undefined
  ): AiCompletionResult {
    this.lastStage = "RECOMMEND_OPTIONS";
    this.lastWorkflowPhase = "OPTIONS_PRESENTED";
    this.budgetDiscussionCompleted = true;
    this.storeEstimate(merged, "INDICATIVE");
    const message = buildBelowMinimumMessage(merged, feasibility, this.responseLanguage);
    // Fix (Travel Booking UAT correction pass — budget-override bug): whenever there's enough trip detail
    // to actually generate the three simulated package options, offer them via an explicit, priced yes/no
    // question instead of jumping straight to the lead-capture offer — the traveler must be able to say
    // "yes, show me options above budget" and get exactly that, not another round of the same explanation.
    // Only reachable when `!this.budgetOverrideAccepted` (see `searchOrBelowMinimumHandoff`), so this never
    // re-asks a traveler who has already said yes earlier in the conversation.
    //
    // Fix (Travel Booking Closure Pass — Phase 1 regression fix): PLATFORM_MANAGED-only. The override
    // question's "decline" path relies on WorkflowCoordinator/TRIP_SUBMISSION (PLATFORM_MANAGED-only
    // infrastructure) to actually capture the lead — STANDALONE_COMPATIBILITY mode's own doc comment
    // below explicitly promises its legacy CRM-tool sales-handoff behavior is "preserved unchanged for
    // direct-construction callers/tests" (e.g. travel.llm.spec.ts's own BELOW_MINIMUM regression suite,
    // which constructs the orchestrator directly with no execution mode — defaulting to
    // STANDALONE_COMPATIBILITY — and asserts the ORIGINAL immediate lead-capture-offer text). Gating this
    // branch to PLATFORM_MANAGED keeps that promise instead of silently breaking it.
    if (this.executionMode === "PLATFORM_MANAGED" && determineMissingFields(merged).length === 0) {
      const options = generateSimulatedPackageOptions(merged, this.config, packageOptionSeed(merged));
      const lowest = options.length
        ? options.reduce((min, option) => (option.totalAmount < min.totalAmount ? option : min), options[0]!)
        : null;
      if (lowest) {
        this.pendingAction = "AWAITING_BUDGET_OVERRIDE_CONFIRMATION" as TravelPendingAction;
        this.pendingRecommendations = options;
        this.selectedRecommendationId = null;
        // `completionStage` deliberately stays untouched here — see `isReadyForCompletionOffer`'s own guard
        // for why, and why mutating it to "OFFERED" here would be wrong (it has a distinct, special meaning
        // to ContactCaptureWorkflowService.shouldStart).
        const overrideQuestion = buildBudgetOverrideQuestion(
          feasibility,
          lowest.totalAmount,
          lowest.currency,
          this.responseLanguage
        );
        return textResult(`${message}\n\n${overrideQuestion}`);
      }
    }
    // Stage 9E: in PLATFORM_MANAGED mode this ALSO emits a typed signal (below) that gives
    // WorkflowCoordinator real workflow authority over the next turn's contact reply — the legacy memory
    // transition itself stays unchanged (rather than skipped) in both modes: `dispatchPendingWorkflowTurn`
    // always intercepts a turn once a real WorkflowExecution row exists, so this field is inert bookkeeping
    // once the signal is dispatched, and it is what makes `WorkflowCoordinator.migrateHistoricalContactState`
    // a safe, self-healing fallback on the rare turn the signal dispatch itself fails.
    if (this.completionStage !== "CAPTURED") {
      this.completionStage = "AWAITING_CONTACT";
      this.pendingInputAction = "AWAITING_LEAD_CONTACT";
      this.pendingAction = null;
      this.providerFailure = null;
    }
    if (this.executionMode === "PLATFORM_MANAGED") {
      // Stage 9E.1: the CRM-tool sales-handoff variant (calling a CRM connector tool directly as the
      // PRIMARY action, with no internal TravelLead) is converged onto the SAME TRIP_SUBMISSION signal as
      // the common case. TRIP_SUBMISSION creates the internal TravelLead and AgentService's existing
      // `syncLeadToCrmBestEffort` (already used for every workflow-captured lead) mirrors it to whatever
      // CRM connector is installed, tracked via TravelLeadCrmSyncStatus (SYNCED/FAILED/SKIPPED) on that
      // lead row — internal persistence and external CRM sync remain distinguishable via that field, and
      // this response text never claims a CRM save, truthful regardless of sync outcome. Travel Runtime
      // never calls a CRM tool directly in this mode, whether or not one happens to be granted/available.
      this.pendingWorkflowSignal = { signalType: "START_TRIP_SUBMISSION", trigger: "BELOW_MINIMUM_BUDGET" };
      return textResult(`${message}\n\n${buildContactRequestMessage(this.responseLanguage)}`);
    }
    // STANDALONE_COMPATIBILITY only: the original legacy CRM-tool sales-handoff mechanism, preserved
    // unchanged for direct-construction callers/tests (e.g. travel.llm.spec.ts).
    const crmTool = findCrmLeadTool(tools);
    if (!crmTool) return textResult(`${message}\n\n${buildContactRequestMessage(this.responseLanguage)}`);
    this.pendingSalesHandoff = { feasibilityMessage: message };
    return toolResult(
      crmTool.name,
      buildCrmLeadPayload(toLegacySlots(merged), "Budget below minimum — sales follow-up required", {
        originCity: merged.originCity,
        hotelStars: merged.hotelStars,
        cabinClass: merged.cabinClass,
        preferences: merged.preferences,
        adults: merged.adults,
        children: merged.children,
        infants: merged.infants,
        budgetStatus: "BUDGET_BELOW_MINIMUM",
        followUp: "SALES_FOLLOW_UP_REQUIRED"
      })
    );
  }

  /**
   * Validates the tool context is complete, then either calls the real `travel.search_flights` tool or,
   * if unavailable, synthesizes placeholder flights/hotels directly — the single execution path shared by
   * every branch that decides "the workflow is ready, go find real options now."
   */
  private executeSearch(
    merged: TravelEntities,
    tools: readonly AiToolDefinition[] | undefined
  ): AiCompletionResult {
    const validation = validateToolTripContext(merged);
    if (!validation.valid) {
      this.lastStage = "ASK_MISSING_INFO";
      this.lastWorkflowPhase = "COLLECTING_DETAILS";
      this.lastAskedField = "originCity";
      return textResult(buildOriginRequiredMessage(this.responseLanguage));
    }
    // Tool policy: an ambiguous total headcount is enough to stop asking "how many travelers?" (see
    // computeMissingEntityFields), but an actual flight search needs age categories for real pricing —
    // never assume a raw total means "N adults". Ask for the breakdown instead of guessing or proceeding.
    if (computePassengerState(merged) === "TOTAL_ONLY") {
      this.lastWorkflowPhase = "COLLECTING_DETAILS";
      this.lastAskedField = "passengerComposition";
      this.pendingInputAction = "AWAITING_PASSENGER_COMPOSITION";
      if (this.diagnostics) this.diagnostics.passengerClarificationRequired = true;
      return textResult(buildPassengerCompositionClarificationMessage(merged.totalTravellers, this.responseLanguage));
    }
    this.lastStage = "RECOMMEND_OPTIONS";
    this.lastAskedField = null;
    if (toolAvailable(tools, "travel.search_flights")) {
      this.lastWorkflowPhase = "SEARCHING";
      return toolResult("travel.search_flights", this.buildToolTripContext(merged));
    }
    const legacy = toLegacySlots(merged);
    const flights = generatePlaceholderFlights({
      destination: legacy.destination ?? "your destination",
      travelMonth: legacy.travelMonth,
      passengers: legacy.passengers
    });
    const hotels = generatePlaceholderHotels({
      destination: legacy.destination ?? "your destination",
      travelMonth: legacy.travelMonth,
      hotelStars: merged.hotelStars
    });
    this.lastWorkflowPhase = "OPTIONS_PRESENTED";
    // Recommendations have been presented — persist the structured estimate snapshot so a later currency
    // request converts these figures instead of re-running the search.
    this.storeEstimate(merged, "INDICATIVE");
    return textResult(
      this.appendBudgetFeasibility(
        merged,
        buildRecommendationMessage(
          legacy,
          flights.flightOptions,
          hotels.hotelOptions,
          this.config,
          this.recommendationOptions(merged, hotels.starNote)
        )
      )
    );
  }

  /**
   * Deterministic, non-technical budget-feasibility note (see {@link buildBudgetFeasibilityNote}) appended
   * to a recommendation message whenever a numeric budget is known. A low budget (e.g. USD 1000 for a
   * long-haul trip) is a planning constraint to explain, never a technical failure — the cheapest options
   * found are still shown, alongside the shortfall against a realistic estimate.
   */
  private appendBudgetFeasibility(entities: TravelEntities, message: string): string {
    // Feasibility is compared in the trip's BUDGET currency (not the display currency) — see
    // `effectiveDisplayCurrency`'s doc: budget vs. minimum must be normalized to one currency, and that is
    // always the currency the traveler actually stated their budget in.
    const note = buildBudgetFeasibilityNote(entities, estimateBudgetRange(entities, this.config), this.responseLanguage);
    return note ? `${message}\n\n${note}` : message;
  }

  /** The currency cost figures should be shown to the traveler in: an explicit display preference wins,
   * else the trip's budget currency, else the config default. Kept separate from the budget currency so a
   * "share in USD" request changes only the display, never the original budget constraint. */
  private effectiveDisplayCurrency(entities: TravelEntities): string {
    return this.displayCurrency ?? entities.budgetCurrency ?? this.config.defaultCurrency;
  }

  /**
   * Persists a structured snapshot of the estimate that was just shown, in its canonical source currency,
   * so a later currency request can convert and re-render it without recomputing or re-running any search.
   * Idempotent and cheap — safe to call from every path that presents flight/hotel/budget figures.
   */
  private storeEstimate(entities: TravelEntities, availabilityType: "LIVE" | "INDICATIVE"): void {
    if (!validateBudgetEstimateInputs(entities).canEstimateFlights) return;
    const canonical = estimateBudgetRange(entities, this.config, PRICING_SOURCE_CURRENCY);
    this.lastBudgetEstimate = toStoredBudgetEstimate(
      canonical,
      entities,
      new Date().toISOString(),
      this.effectiveDisplayCurrency(entities),
      availabilityType
    );
  }

  /**
   * Renders the last stored estimate in `targetCurrency` for a currency-preference response — converting
   * the canonical snapshot exactly once, never recomputing or re-running a search. Returns null when there
   * is no estimate to convert yet.
   */
  /**
   * Deterministic, state-aware handler for an explicit currency preference. Never re-runs a search, never
   * re-asks for missing slots, never resets completed recommendation/trip state, and is idempotent for a
   * repeated request. Behavior:
   *  - Unsupported currency: explain (name the supported ones), change nothing, no loop.
   *  - Persist the display preference; the original budget/currency is left untouched.
   *  - An estimate already exists -> convert the stored snapshot exactly once and show it (or, if live FX
   *    is unavailable, offer it in its original currency — never a fabricated or mislabeled number).
   *  - No estimate yet, a search confirmation still pending -> acknowledge the currency and re-ask the
   *    confirmation once (only when the currency actually changed).
   *  - Otherwise -> acknowledge the display change and continue from the current state.
   */
  private handleCurrencyPreference(preference: CurrencyPreference): AiCompletionResult {
    if (preference.kind === "UNSUPPORTED") {
      // Deliberately does not change the display currency — we can't service it — but must not loop.
      return textResult(buildUnsupportedCurrencyMessage(this.responseLanguage));
    }
    const target = preference.currency;
    const previous = (this.displayCurrency ?? this.lastEntities.budgetCurrency ?? this.config.defaultCurrency).toUpperCase();
    const alreadyInTarget = previous === target;
    this.displayCurrency = target;

    if (this.lastBudgetEstimate) {
      const shown = convertStoredBudgetEstimateSafe(this.lastBudgetEstimate, target);
      if (!shown) {
        // Live conversion unavailable — keep the recorded preference, never fabricate a rate, offer the
        // estimate in its original currency instead of looping.
        return textResult(buildConversionUnavailableMessage(target, this.lastBudgetEstimate, this.responseLanguage));
      }
      // Keep the canonical snapshot; only its display preference moves. This preserves single-hop
      // conversions and never mutates the completed recommendation/trip state.
      this.lastBudgetEstimate = { ...this.lastBudgetEstimate, displayCurrency: target };
      const body = buildConvertedEstimateMessage(shown, this.responseLanguage);
      return textResult(
        alreadyInTarget ? `${buildAlreadyInCurrencyMessage(target, this.responseLanguage)}\n\n${body}` : body
      );
    }

    // No estimate yet. If a search confirmation is genuinely still pending (and nothing has been searched),
    // acknowledge the currency and re-ask it once — but never after recommendations already exist, and
    // never repeatedly for an unchanged currency (idempotent).
    if (this.pendingAction === "SEARCH_OPTIONS" && !alreadyInTarget) {
      return textResult(buildCurrencyAckWithSearchPromptMessage(target, this.responseLanguage));
    }
    return textResult(buildDisplayCurrencySetMessage(target, this.responseLanguage));
  }

  /**
   * Builds the budget-guidance message and persists the estimate it was computed from (see
   * {@link StoredBudgetEstimate}) so a later "give in INR" converts these exact numbers with one FX rate
   * instead of silently recomputing (which could disagree) or merely relabeling the currency.
   */
  private showBudgetGuidance(entities: TravelEntities): string {
    this.storeEstimate(entities, "INDICATIVE");
    return buildBudgetGuidanceMessage(entities, this.config, this.responseLanguage, this.effectiveDisplayCurrency(entities));
  }

  /**
   * The MODIFY_HOTEL_BUDGET action: lowers the hotel category by one catalog tier, recalculates the total
   * estimate from the new hotel prices, and reports the saving and whether the target budget is now
   * achievable — while every other trip entity is carried forward unchanged. Always deterministic and
   * local (placeholder repricing, never a `travel.search_hotels` tool call) — per policy, hotel trimming
   * alone is never a reason to call an external tool, so this can never surface as a technical failure,
   * even when no hotel tier can make the budget feasible.
   */
  private handleHotelBudgetModification(entities: TravelEntities): AiCompletionResult {
    const oldEstimate = estimateBudgetRange(entities, this.config);
    const { newStars, hitFloor } = lowerHotelStarCategory(entities.hotelStars);
    const updated: TravelEntities = { ...entities, hotelStars: newStars };
    this.lastEntities = updated;
    this.lastStage = "RECOMMEND_OPTIONS";
    this.lastWorkflowPhase = "OPTIONS_PRESENTED";
    const hotels = generatePlaceholderHotels({
      destination: updated.destinationCity ?? "your destination",
      travelMonth: updated.travelMonth,
      hotelStars: newStars
    });
    return textResult(
      buildHotelModificationMessage(updated, oldEstimate, hotels.hotelOptions, hitFloor, this.responseLanguage)
    );
  }

  private async safeExtractAndClassify(message: string): Promise<{
    entities: Partial<TravelEntities>;
    intent: TravelIntent;
    cityInterpretations: Partial<Record<"originCity" | "destinationCity", CityInterpretation>>;
    turnProposal: SemanticTurnProposal;
  }> {
    if (!message.trim())
      return {
        entities: {},
        intent: "provide_trip_details",
        cityInterpretations: {},
        turnProposal: {
          answersPendingAction: false,
          supersedesPendingAction: false,
          preservePendingAction: true,
          confidence: 0
        }
      };
    let rawEntities: Partial<TravelEntities>;
    let intent: TravelIntent;
    let turnProposal: SemanticTurnProposal = {
      answersPendingAction: false,
      supersedesPendingAction: false,
      preservePendingAction: true,
      confidence: 0
    };
    let cityInterpretations: Partial<Record<"originCity" | "destinationCity", CityInterpretation>> = {};

    // Fast path: use the deterministic regex extractor for simple field-level inputs where the system
    // is explicitly expecting a specific value. This avoids a ~200-500ms provider call for every simple
    // field capture (budget, dates, passengers, name, year) without changing entity extraction semantics.
    // Only fires when lastAskedField or pendingInputAction narrows the expected input to one field type.
    const deterministic = deterministicExtractFallback(message);
    const askedField = this.lastAskedField;
    const pendingAction = this.pendingInputAction;
    // A message that also states an explicit route ("Delhi to Dubai on 12 August for 2 adults for 5 days")
    // is never a "simple field-level input", even if it happens to also answer whatever field was last
    // asked — the deterministic extractor here has no route/city-pair handling of its own (that lives in
    // `reconcileRouteFromMessage`, only reached via the full LLM extraction path below), so taking the fast
    // path would silently drop the stated origin city and demote a full date to a bare month. Real UAT bug:
    // "delhi to dubai on 12 august..." answered the pending "travel dates" question, took the fast path, and
    // lost the origin city and exact date entirely.
    const statesExplicitRoute = findConnectedRoutePair(message) !== null;
    // Sprint 6.5 — Part 5/16: a pending question is EVIDENCE about what the assistant expects, never
    // authority to force-fit unrelated text into it. The type-matching conditions below already made this
    // fast path safe in practice (a destination string never satisfies `askedField === "budget"`) — this
    // is an explicit, testable, shared-vocabulary version of that same guarantee: an obvious correction,
    // domain pivot, action command, or farewell always falls through to the full extraction/routing path
    // below (which already handles all four correctly), even on the rare chance it also happens to contain
    // a same-typed value.
    const pendingSemantic = (askedField || pendingAction)
      ? classifyUserInput(message, { hasPendingQuestion: true }).semantic
      : "UNKNOWN";
    const overridesPendingField =
      pendingSemantic === "CORRECTION" ||
      pendingSemantic === "DOMAIN_PIVOT" ||
      pendingSemantic === "ACTION" ||
      pendingSemantic === "FAREWELL";
    if ((askedField || pendingAction) && !statesExplicitRoute && !overridesPendingField) {
      // Sprint 6.5 — Part 7/29: "from Delhi" (or a bare "Delhi") deterministically answers a DEDICATED
      // "where are you traveling from?" question — see `resolveOriginReplyDeterministically`'s own doc
      // comment for why the bare-city fallback is safe only in this specific context.
      const originReply = askedField === "originCity" ? resolveOriginReplyDeterministically(message) : null;
      const matchByField =
        (askedField === "budget" && deterministic.budget !== null) ||
        (askedField === "adults" && deterministic.adults !== null) ||
        (askedField === "totalTravellers" && deterministic.totalTravellers !== null) ||
        (askedField === "duration" && (deterministic.days !== null || deterministic.nights !== null)) ||
        (askedField === "travelDates" && (deterministic.travelMonth !== null || deterministic.departureDate !== null)) ||
        (askedField === "passengerComposition" && (deterministic.adults !== null || deterministic.children !== null || deterministic.infants !== null)) ||
        (askedField === "customerName" && deterministic.customerName !== null) ||
        (askedField === "travelYear" && /\b20[2-9]\d\b/.test(message)) ||
        (askedField === "originCity" && originReply !== null) ||
        (pendingAction === "AWAITING_TRAVEL_YEAR") ||
        (pendingAction === "AWAITING_PASSENGER_COMPOSITION" && (deterministic.adults !== null || deterministic.children !== null || deterministic.infants !== null));
      if (matchByField) {
        // A bare-city origin reply reuses `extractDestination`'s own city scan (see
        // `resolveOriginReplyDeterministically`) — `deterministic.destinationCity` may have matched the
        // SAME text and must be cleared here, or the traveler's origin would also corrupt the confirmed
        // destination.
        rawEntities = originReply !== null ? { ...deterministic, originCity: originReply, destinationCity: null } : deterministic;
        intent = classifyIntentDeterministically(message);
        return { entities: rawEntities, intent, cityInterpretations, turnProposal };
      }
    }

    // Also skip the LLM for explicit escalation requests — the deterministic classifier handles this
    // correctly and no entity extraction is needed.
    if (isEscalationRequest(message)) {
      rawEntities = deterministic;
      intent = classifyIntentDeterministically(message);
      return { entities: rawEntities, intent, cityInterpretations, turnProposal };
    }

    try {
      const result = await this.realProvider.complete({
        messages: [
          { role: "system", content: TRAVEL_ENTITY_EXTRACTION_SYSTEM_PROMPT },
          {
            role: "user",
            content: buildTravelExtractionUserPrompt(this.lastEntities, message, {
              workflowPhase: this.lastWorkflowPhase,
              lastAskedField: this.lastAskedField,
              pendingInputAction: this.pendingInputAction
            })
          }
        ],
        maxOutputTokens: 400,
        temperature: 0
      });
      rawEntities = parseExtractedEntities(result.content);
      intent = parseIntent(result.content);
      turnProposal = parseSemanticTurnProposal(result.content);
      const originInterp = parseCityInterpretation(result.content, "originCity");
      if (originInterp) cityInterpretations = { ...cityInterpretations, originCity: originInterp };
      const destinationInterp = parseCityInterpretation(result.content, "destinationCity");
      if (destinationInterp) cityInterpretations = { ...cityInterpretations, destinationCity: destinationInterp };
    } catch {
      rawEntities = deterministicExtractFallback(message);
      intent = classifyIntentDeterministically(message);
    }
    // Deterministic values from the user's literal wording outrank model inference. Sparse overlay only:
    // fields absent from this turn remain absent and are therefore preserved by mergeConfirmedEntities.
    // The `deterministic` variable was already computed above for the fast-path check — reuse it here.
    const explicitKeys = Object.fromEntries(
      Object.entries(deterministic).filter(
        ([key, value]) =>
          key !== "customerName" &&
          key !== "originCity" &&
          key !== "destinationCity" &&
          value !== null &&
          value !== undefined
      )
    ) as Partial<TravelEntities>;
    rawEntities = { ...rawEntities, ...explicitKeys };
    const withShortAnswer = resolveShortAnswerForLastAskedField(message, this.lastAskedField, rawEntities);
    // Deterministic parser guards, in dependency order: an explicit full date (with year) wins over a bare
    // month; a bare/clarified year is never a budget; "N rat"/"N raat"/"N nights" is a night count, never a
    // hotel star tier; then the existing natural-date and return-date guards.
    const dayMonthMentions =
      message.match(
        /\b(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2})\b/gi
      ) ?? [];
    const partialDate =
      parseExplicitTravelDate(message) || RETURN_DATE_SIGNAL_PATTERN.test(message) || dayMonthMentions.length > 1
        ? null
        : parsePendingDepartureDate(message);
    if (partialDate) {
      this.pendingDepartureDate = partialDate;
      this.pendingInputAction = "AWAITING_TRAVEL_YEAR";
      withShortAnswer.departureDate = null;
      withShortAnswer.travelMonth = titleCase(MONTHS[partialDate.month - 1] ?? "");
    }
    const explicitDated = augmentWithExplicitDate(message, withShortAnswer);
    const yearGuarded = guardYearNotBudget(message, explicitDated);
    const nightsGuarded = guardNightsVsHotelStars(message, yearGuarded);
    const dateAugmented = augmentWithDatePhrase(message, nightsGuarded);
    const dateGuarded = guardReturnDateAssumption(message, dateAugmented);
    const entities = reconcileRouteFromMessage(message, dateGuarded, this.lastAskedField);
    // Sprint 6.5 — Part 13/35: Stage 9F's "a bare, explicit budget restatement always wins" rule
    // (`detectExplicitFieldCorrection`, below) generalized to every correctable scalar field — passengers,
    // nights/days, and dates — not just budget. Without this, a no-LLM environment (`classifyIntentDeterministically`
    // never returns "modify_trip" on its own for these fields) could never process "Actually make it 3
    // adults" or "Sorry, I meant October" as a correction: `mergeConfirmedEntities`'s "never silently
    // overwrite an already-confirmed field" guard would keep the stale value forever, exactly the
    // "AED 5,000 survives an AED 10,000 correction" UAT defect this pattern was originally built to fix —
    // just for one field instead of all of them. Skips when the turn was already classified as
    // "start_new_trip" — a differing value there is an independent trip's own value, not a correction to
    // the current one, and must never be reclassified into "modify_trip" (see the new-trip isolation
    // guarantee `classifyRouteRelationship`/Stage 9G already provide).
    const explicitFieldCorrection =
      intent !== "start_new_trip" && detectExplicitFieldCorrection(deterministic, this.lastEntities);
    return { entities, intent: explicitFieldCorrection ? "modify_trip" : intent, cityInterpretations, turnProposal };
  }

  private async safeGenerateReply(
    entities: TravelEntities,
    missing: string[],
    changed: string[],
    userMessage: string,
    isFirstTurn: boolean,
    startingNewTrip: boolean
  ): Promise<string> {
    const justLearnedName = changed.some((entry) => entry.startsWith("customerName=")) ? entities.customerName : null;
    // Known before this turn (not just-captured — `justLearnedName` covers that case separately) — true
    // for a name seeded from a Receptionist handoff, which never appears in `changed` since it was never
    // "extracted" from this turn's text at all.
    const nameAlreadyKnown = Boolean(entities.customerName) && !justLearnedName;
    // Sprint 6.5 — Part 12: computed once, applied to whichever reply (LLM or deterministic fallback)
    // actually gets used, so the required wording is guaranteed even when no LLM provider is configured.
    const dateWindowAck = buildDateWindowAcknowledgment(entities, userMessage, this.responseLanguage);
    const withDateWindowAck = (text: string): string => (dateWindowAck ? `${dateWindowAck} ${text}` : text);
    try {
      const result = await this.realProvider.complete({
        messages: [
          {
            role: "system",
            content: buildGenerationSystemPrompt(
              this.config,
              entities,
              missing,
              changed,
              isFirstTurn,
              startingNewTrip,
              this.responseLanguage
            )
          },
          { role: "user", content: userMessage }
        ],
        maxOutputTokens: 200,
        temperature: 0.4
      });
      const text = result.content?.trim();
      return withDateWindowAck(
        text ||
          buildFallbackAskMessage(
            missing,
            this.config,
            isFirstTurn,
            this.responseLanguage,
            justLearnedName,
            nameAlreadyKnown
          )
      );
    } catch {
      return withDateWindowAck(
        buildFallbackAskMessage(
          missing,
          this.config,
          isFirstTurn,
          this.responseLanguage,
          justLearnedName,
          nameAlreadyKnown
        )
      );
    }
  }

  private async safeGenerateContextualReply(
    entities: TravelEntities,
    missing: string[],
    itineraryAlreadyPresented: boolean,
    userMessage: string
  ): Promise<string> {
    try {
      const result = await this.realProvider.complete({
        messages: [
          {
            role: "system",
            content: buildContextualSystemPrompt(
              this.config,
              entities,
              missing,
              itineraryAlreadyPresented,
              this.responseLanguage
            )
          },
          { role: "user", content: userMessage }
        ],
        maxOutputTokens: 220,
        temperature: 0.5
      });
      const text = result.content?.trim();
      if (text) return text;
      return this.responseLanguage === "HINGLISH"
        ? "Bilkul help karunga — thoda aur bata sakte hain aap kya jaanna chahte hain?"
        : this.responseLanguage === "HINDI"
          ? "बिल्कुल मदद करूँगा — कृपया थोड़ा और बताएं कि आप क्या जानना चाहते हैं?"
          : "Happy to help with that — could you tell me a little more about what you'd like to know?";
    } catch {
      return this.responseLanguage === "HINGLISH"
        ? "Bilkul — batayein aap trip planning aage kaise continue karna chahenge."
        : this.responseLanguage === "HINDI"
          ? "बिल्कुल — बताइए आप यात्रा योजना आगे कैसे जारी रखना चाहेंगे।"
          : "Happy to help with that — let me know if you'd like to continue planning your trip.";
    }
  }

  /**
   * GENERATE_ITINERARY: a concrete day-by-day sightseeing/timing plan, grounded only in destination,
   * duration, and dates — deliberately independent of budget feasibility, hotel, or flight state, so an
   * infeasible budget never blocks producing a plan.
   */
  /**
   * Generates the itinerary, then runs it through `validateItineraryText` — a purely structural check
   * (never a claim about real opening hours or live flight times). An LLM-generated schedule that
   * overlaps, duplicates a named attraction, overloads the arrival day, or leaves no departure-day airport
   * buffer is swapped for the deterministic fallback template rather than shown to the traveler; the
   * caught issue codes are recorded on `this.diagnostics` for observability, never silently dropped.
   */
  private async safeGenerateItinerary(entities: TravelEntities, userMessage: string): Promise<string> {
    const fallback = (): string => buildFallbackItineraryMessage(entities, this.responseLanguage);
    let generated: string;
    try {
      const result = await this.realProvider.complete({
        messages: [
          { role: "system", content: buildItinerarySystemPrompt(this.config, entities, this.responseLanguage) },
          { role: "user", content: userMessage }
        ],
        maxOutputTokens: 500,
        temperature: 0.5
      });
      const text = result.content?.trim();
      if (!text) return fallback();
      generated = text;
    } catch {
      return fallback();
    }
    const validation = validateItineraryText(generated, {
      hasChildren: (entities.children ?? 0) > 0,
      hasInfants: (entities.infants ?? 0) > 0
    });
    if (!validation.valid) {
      if (this.diagnostics) {
        this.diagnostics.itineraryFallbackUsed = true;
        this.diagnostics.itineraryValidationIssues = [
          ...this.diagnostics.itineraryValidationIssues,
          ...validation.issues.map((issue) => issue.code)
        ];
      }
      return fallback();
    }
    return generated;
  }

  private continueAfterTool(
    messages: readonly AiMessage[],
    last: AiMessage,
    tools: readonly AiToolDefinition[] | undefined
  ): AiCompletionResult {
    const output = safeParseJson(last.content);
    if (output.escalated) {
      this.lastStage = "ESCALATED";
      return textResult(buildEscalationMessage(this.config, this.responseLanguage));
    }
    if (typeof output.resendResult === "boolean") return textResult(buildResendTicketReply(output));
    // A failed travel.search_flights/search_hotels call (fed back here by the caller instead of a flat,
    // dead-end recovery message) resolves here: persist the failure so a later vague follow-up doesn't
    // blindly retry it, and answer with provider-independent indicative recommendations instead. Every
    // failure recorded this way is a transient technical one, never a permanent business result — those
    // are BELOW_MINIMUM feasibility, handled entirely separately.
    if (output.error === true) {
      const provider = typeof output.toolName === "string" ? output.toolName : "travel.search_flights";
      // `failedAction` is recorded as SEARCH_LIVE_OPTIONS regardless of whether this call was originally
      // triggered by BOOK_FLIGHT, BOOK_HOTEL, or an explicit live-search ask — by the time a tool call
      // resolves, `pendingAction` has already been cleared to authorize it, and all three ultimately call
      // the exact same travel.search_flights/search_hotels pipeline, so there is nothing more specific to
      // attribute the failure to.
      const now = Date.now();
      this.providerFailure = {
        failedAction: "SEARCH_LIVE_OPTIONS",
        provider,
        failedAt: new Date(now).toISOString(),
        retryable: true,
        selectedRecoveryAction: null,
        menuActive: true,
        menuExpiresAt: new Date(now + PROVIDER_FAILURE_MENU_TTL_MS).toISOString()
      };
      this.pendingAction = null;
      this.lastWorkflowPhase = "COLLECTING_DETAILS";
      const estimate = estimateBudgetRange(this.lastEntities, this.config);
      return textResult(buildIndicativeRecommendationsMessage(this.lastEntities, estimate, this.responseLanguage, true));
    }
    // Every lead-capture entry point (the proactive offer, an explicit "submit this request"/"generate
    // lead", or a callback ask) resolves the same way here — the built-in, always-available
    // `travel.create_lead` tool call, never gated on or dependent on an external CRM connector.
    if (this.pendingLeadCapture) {
      this.pendingLeadCapture = false;
      const reference = typeof output.reference === "string" ? output.reference : null;
      this.lastStage = "RECOMMEND_OPTIONS";
      if (!reference) {
        this.completionStage = "DECLINED";
        this.pendingInputAction = null;
        this.pendingContactValue = null;
        return textResult(buildGenericContinuationMessage(this.responseLanguage));
      }
      this.completionStage = "CAPTURED";
      this.pendingInputAction = null;
      this.pendingContactValue = null;
      this.conversationClosed = false;
      this.capturedLeadReference = reference;
      if (this.journey) this.journey.status = "ENQUIRY_SUBMITTED";
      return textResult(buildLeadCapturedMessage(this.lastEntities.customerName, reference, this.responseLanguage));
    }
    const legacy = toLegacySlots(this.lastEntities);
    if (Array.isArray(output.flightOptions)) {
      if (toolAvailable(tools, "travel.search_hotels")) {
        this.lastWorkflowPhase = "SEARCHING";
        return toolResult("travel.search_hotels", this.buildToolTripContext(this.lastEntities));
      }
      const hotels = generatePlaceholderHotels({
        destination: legacy.destination ?? "your destination",
        travelMonth: legacy.travelMonth,
        hotelStars: this.lastEntities.hotelStars
      });
      this.lastWorkflowPhase = "OPTIONS_PRESENTED";
      this.storeEstimate(this.lastEntities, "LIVE");
      return textResult(
        this.appendBudgetFeasibility(
          this.lastEntities,
          buildRecommendationMessage(
            legacy,
            output.flightOptions as FlightOption[],
            hotels.hotelOptions,
            this.config,
            this.recommendationOptions(this.lastEntities, hotels.starNote)
          )
        )
      );
    }
    if (Array.isArray(output.hotelOptions)) {
      const flights = (findPriorToolValue(messages, "flightOptions") as FlightOption[] | undefined) ?? [];
      const starNote = typeof output.starNote === "string" ? output.starNote : null;
      this.lastWorkflowPhase = "OPTIONS_PRESENTED";
      this.storeEstimate(this.lastEntities, "LIVE");
      return textResult(
        this.appendBudgetFeasibility(
          this.lastEntities,
          buildRecommendationMessage(
            legacy,
            flights,
            output.hotelOptions as HotelOption[],
            this.config,
            this.recommendationOptions(this.lastEntities, starNote)
          )
        )
      );
    }
    // The BELOW_MINIMUM sales-handoff CRM-lead call resolves here — only after this succeeds (or is known
    // to have failed) may the assistant promise, or decline to promise, a callback from the sales team.
    if (this.pendingSalesHandoff) {
      const pending = this.pendingSalesHandoff;
      this.pendingSalesHandoff = null;
      this.lastStage = "RECOMMEND_OPTIONS";
      const succeeded = typeof output.reference === "string" && output.reference.startsWith("LEAD-");
      const followUp = succeeded
        ? buildSalesHandoffConfirmedMessage(this.responseLanguage)
        : buildSalesHandoffFallbackMessage(this.responseLanguage);
      return textResult(`${pending.feasibilityMessage}\n\n${followUp}`);
    }
    return textResult(buildGenericContinuationMessage(this.responseLanguage));
  }
}
