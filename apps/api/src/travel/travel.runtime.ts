import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiMessage,
  AiProvider,
  AiToolDefinition
} from "@ai-workforce-os/plugin-sdk";

export const TRAVEL_EMPLOYEE_PLUGIN_SLUG = "travel-employee";
export const TRAVEL_TRIP_STATE_MEMORY_KEY = "travel.trip_state";

export type TravelStage =
  | "GREETING"
  | "COLLECT_DESTINATION"
  | "COLLECT_DATES"
  | "COLLECT_PASSENGERS"
  | "COLLECT_BUDGET"
  | "ASK_MISSING_INFO"
  | "RECOMMEND_OPTIONS"
  | "ITINERARY_SUMMARY"
  | "CONFIRM_BOOKING"
  | "BOOKING_CONFIRMED"
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
  stage: TravelStage;
  missingFields: string[];
}

/**
 * Extended trip entity schema captured via LLM-based extraction (see {@link TravelEmployeeLlmOrchestrator}).
 * Superset of {@link TravelSlots} so a single stored state document stays readable by both engines.
 */
export interface TravelEntities {
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
  preferences: string[];
}

export const EMPTY_TRAVEL_ENTITIES: TravelEntities = {
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
export type EntitySource = "user" | "llm" | "default";

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
  | "GENERATE_ITINERARY"
  | "BOOK_FLIGHT"
  | "SEARCH_FLIGHTS"
  | "SEARCH_HOTELS"
  | "CALCULATE_BUDGET"
  | "CONVERT_ESTIMATE_CURRENCY"
  | "RECOMMEND_ATTRACTIONS"
  | "RECOMMEND_FOOD"
  | "RECOMMEND_TRANSPORT"
  | null;

// Broad on purpose: natural itinerary asks rarely say the word "itinerary" — "trip wise day optimise",
// "din ka plan", "day wise plan mera trip" all mean the same thing. Budget/composition must never gate
// this; it is checked before every other planning action.
const ITINERARY_ACTION_PATTERN =
  /\b(day\s*[-]?\s*plan|itinerary|plan\s+(?:my|the|our|mera|humara)?\s*(?:day|din)\b|daily\s+(?:plan|schedule)|schedule\s+for\s+the\s+day|din\s+(?:ka\s+)?plan|din\s*[-]?\s*wise|day\s*[-]?\s*wise|trip\s*[-]?\s*wise|(?:day|din)\b.{0,25}\boptimi[sz]e|optimi[sz]e.{0,25}\b(?:day|din)\b)\b/i;
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
  /\b(what(?:'s| is) (?:the |my )?budget|how much (?:will|does|is)|package\s+cost|total\s+cost|cost\s+of\s+(?:the\s+)?(?:trip|package)|budget\s+(?:kitna|batao|check)|calculate\s+(?:the\s+)?budget|check\s+(?:the\s+)?budget)\b/i;
const ATTRACTIONS_ACTION_PATTERN =
  /\b(ghumne\s+layak|ghumne\s+ke\s+liye|ghumna\s+chahiye|kaha\s+ghum\w*|places?\s+to\s+(?:see|visit)|sightseeing|attractions?|things?\s+to\s+do|what\s+(?:all\s+)?(?:is|are)\s+(?:worth\s+)?(?:seeing|visiting|there\s+to\s+do))\b/i;
const FOOD_ACTION_PATTERN = /\b(food|restaurants?|cuisine|where\s+to\s+eat|khane\s+ke\s+liye|khana)\b/i;
const TRANSPORT_ACTION_PATTERN =
  /\b(transport(?:ation)?|getting\s+around|local\s+travel|commute|taxi|metro|train\s+pass)\b/i;

const CURRENCY_WORD_TO_CODE: Record<string, string> = {
  inr: "INR",
  rupee: "INR",
  rupees: "INR",
  usd: "USD",
  dollar: "USD",
  dollars: "USD",
  eur: "EUR",
  euro: "EUR",
  euros: "EUR",
  gbp: "GBP",
  pound: "GBP",
  pounds: "GBP"
};
const CURRENCY_CONVERSION_PATTERN =
  /\b(?:give(?:\s+it)?\s+in|show(?:\s+it)?\s+in|tell\s+me\s+in|convert(?:\s+it)?\s+to|batao\s+in)\s+(inr|usd|eur|gbp|rupees?|dollars?|euros?|pounds?)\b|\b(inr|usd|eur|gbp|rupees?)\s+me(?:in)?\s+batao\b/i;

/**
 * Deterministic detection of an explicit request to convert the last shown estimate to a different
 * currency ("give in INR", "INR me batao", "convert to rupees") — this is never a request for a new
 * budget amount, and must never be confused with `detectBudgetModeSignal` or the plain CALCULATE_BUDGET ask.
 */
export function detectCurrencyConversionRequest(text: string): { targetCurrency: string } | null {
  const match = CURRENCY_CONVERSION_PATTERN.exec(text);
  if (!match) return null;
  const word = (match[1] ?? match[2] ?? "").toLowerCase();
  const code = CURRENCY_WORD_TO_CODE[word];
  return code ? { targetCurrency: code } : null;
}

/**
 * Deterministic classification of the traveler's current planning request, independent of LLM intent —
 * order matters: itinerary/currency-conversion/hotel/flight/budget are checked before the more general
 * informational asks (attractions/food/transport). A hotel-budget-modification request ("trim hotels",
 * "reduce hotel cost") is deliberately excluded here — that has its own dedicated, more specific flow.
 */
export function classifyPlanningAction(text: string): TravelPlanningAction {
  if (ITINERARY_ACTION_PATTERN.test(text)) return "GENERATE_ITINERARY";
  // A booking go-ahead is a stronger, more definite intent than a browse/search ask — must be checked
  // before the generic flight-search pattern so it is never miscategorized as a mere options request.
  if (BOOK_FLIGHT_ACTION_PATTERN.test(text)) return "BOOK_FLIGHT";
  if (detectCurrencyConversionRequest(text)) return "CONVERT_ESTIMATE_CURRENCY";
  if (isHotelBudgetModificationRequest(text)) return null;
  if (HOTEL_SEARCH_ACTION_PATTERN.test(text)) return "SEARCH_HOTELS";
  if (FLIGHT_SEARCH_ACTION_PATTERN.test(text)) return "SEARCH_FLIGHTS";
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
}

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

export const EMPTY_TRAVEL_CONVERSATION_MEMORY: TravelConversationMemory = {
  confirmation: EMPTY_TRAVEL_ENTITY_CONFIRMATION,
  pendingClarification: null,
  lastAskedField: null,
  budgetMode: "UNKNOWN",
  pendingAction: null,
  responseLanguage: "ENGLISH",
  budgetDiscussionCompleted: false,
  lastBudgetEstimate: null,
  pendingPassengerConflict: null
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
  welcomeMessage: "Hi! I'm your AI travel assistant. Where would you like to travel to?",
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

const KNOWN_DESTINATIONS = [
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
  "new delhi"
];

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

export function extractTravelMonth(text: string): string | null {
  const lower = text.toLowerCase();
  for (const month of MONTHS) if (new RegExp(`\\b${month}\\b`, "i").test(lower)) return titleCase(month);
  return null;
}

export function extractDurationDays(text: string): number | null {
  const match = /(\d{1,3})[\s-]*(?:days?|nights?)\b/i.exec(text);
  return match?.[1] ? Number(match[1]) : null;
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
  const lakh = /(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)\s*lakhs?/i.exec(text);
  if (lakh?.[1])
    return { amount: Math.round(parseFloat(lakh[1].replace(/,/g, "")) * 100_000), currency: "INR" };
  const dollars = /\$\s*([\d,]+(?:\.\d+)?)|(?:usd)\s*([\d,]+(?:\.\d+)?)/i.exec(text);
  if (dollars)
    return {
      amount: Math.round(parseFloat((dollars[1] ?? dollars[2] ?? "0").replace(/,/g, ""))),
      currency: "USD"
    };
  const rupees = /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)/i.exec(text);
  if (rupees?.[1])
    return { amount: Math.round(parseFloat(rupees[1].replace(/,/g, ""))), currency: "INR" };
  const euros = /€\s*([\d,]+(?:\.\d+)?)|(?:eur)\s*([\d,]+(?:\.\d+)?)/i.exec(text);
  if (euros)
    return {
      amount: Math.round(parseFloat((euros[1] ?? euros[2] ?? "0").replace(/,/g, ""))),
      currency: "EUR"
    };
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

const CONFIRMATION_PATTERN =
  /\b(yes|confirm(?:ed)?|book it|go ahead|sounds good|let'?s book|proceed|okay|ok)\b/i;
export function isBookingConfirmation(text: string): boolean {
  return CONFIRMATION_PATTERN.test(text);
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
  const missing = missingFields(slots);
  let stage: TravelStage;
  if (wasEscalated(messages)) stage = "ESCALATED";
  else if (wasBookingConfirmed(messages)) stage = "BOOKING_CONFIRMED";
  else if (missing.length > 0) stage = stageForMissingField(missing[0] ?? "");
  else if (wasItineraryPresented(messages)) stage = "CONFIRM_BOOKING";
  else stage = "RECOMMEND_OPTIONS";
  return { ...slots, stage, missingFields: missing };
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

function greetingPrefix(isFirstTurn: boolean, config: TravelEmployeeRuntimeConfig): string {
  return isFirstTurn ? `${config.welcomeMessage}\n\n` : "";
}

export function buildAskMessage(
  field: string,
  slots: TravelSlots,
  isFirstTurn: boolean,
  config: TravelEmployeeRuntimeConfig
): string {
  const prefix = greetingPrefix(isFirstTurn, config);
  if (field === "destination") return `${prefix}Where would you like to travel to?`;
  if (field === "travelMonth")
    return `${prefix}Great${slots.destination ? `, ${slots.destination} it is!` : ""} When are you planning to travel (which month), and for how many days?`;
  if (field === "passengers") return `${prefix}How many travelers should I plan for?`;
  if (field === "budgetAmount")
    return `${prefix}What's your approximate budget (in ${config.defaultCurrency})?`;
  return `${prefix}Could you share a bit more detail so I can help plan your trip?`;
}

const MISSING_FIELD_LABELS: Record<string, string> = {
  destination: "your destination",
  travelMonth: "your travel dates",
  passengers: "the number of travelers",
  budgetAmount: "your budget"
};

export function buildMissingInfoMessage(missing: string[], config: TravelEmployeeRuntimeConfig): string {
  const items = missing.map(
    (field) =>
      MISSING_FIELD_LABELS[field] ?? field
  );
  const budgetIndex = missing.indexOf("budgetAmount");
  if (budgetIndex >= 0) items[budgetIndex] = `your budget (in ${config.defaultCurrency})`;
  return `I still need a bit more information to help plan your trip: ${items.join(", ")}. Could you share that?`;
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
  if (language === "HINGLISH")
    return "Mere paas aapki trip ki saari details hain — kya main abhi flight aur hotel options dhoondh loon?";
  if (language === "HINDI") return "मेरे पास आपकी यात्रा की सारी जानकारी है — क्या मैं अभी फ्लाइट और होटल विकल्प खोजूँ?";
  return "I have everything I need for your trip — would you like me to look up flight and hotel options now?";
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

/** Deterministic, non-LLM closing line for a tool-continuation turn that matched no known output shape. */
export function buildGenericContinuationMessage(language: TravelResponseLanguage = "ENGLISH"): string {
  if (language === "HINGLISH") return "Dhanyavad — batayein aapki trip ke saath aage kaise badhna hai.";
  if (language === "HINDI") return "धन्यवाद — बताइए आपकी यात्रा के साथ आगे कैसे बढ़ना है।";
  return "Thanks — let me know how you'd like to proceed with your trip.";
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

function toolAvailable(tools: readonly AiToolDefinition[] | undefined, name: string): boolean {
  return Boolean(tools?.some((tool) => tool.name === name));
}
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
 * Deterministic, code-driven conversation engine for the Travel Employee. Runs through the same
 * AiProvider contract and tool-calling loop as any other AI employee, so dashboard chat and the
 * WhatsApp channel share this without duplication. It never claims a booking occurred.
 */
export class TravelEmployeeProvider implements AiProvider {
  constructor(private readonly config: TravelEmployeeRuntimeConfig) {}

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const messages = request.messages;
    const last = messages.at(-1);
    const userMessages = messages.filter((message) => message.role === "user").map((message) => message.content);
    const currentText = userMessages.at(-1) ?? "";
    const slots = extractTravelSlots(userMessages, this.config.defaultCurrency);

    if (last?.role === "tool") return this.continueAfterTool(messages, last, slots, request.tools);

    if (isEscalationRequest(currentText) && !wasEscalated(messages)) {
      if (toolAvailable(request.tools, "travel.escalate"))
        return toolResult("travel.escalate", { reason: currentText.slice(0, 500) });
      return textResult(buildEscalationMessage(this.config));
    }

    const missing = missingFields(slots);
    if (missing.length === 0) {
      if (wasItineraryPresented(messages)) {
        if (isBookingConfirmation(currentText)) {
          const crmTool = findCrmLeadTool(request.tools);
          if (crmTool) return toolResult(crmTool.name, buildCrmLeadPayload(slots, currentText));
          return textResult(buildBookingConfirmedMessage(null));
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

    const priorSlots = extractTravelSlots(userMessages.slice(0, -1), this.config.defaultCurrency);
    const gainedNewInfo = JSON.stringify(priorSlots) !== JSON.stringify(slots);
    const isFirstTurn = userMessages.length <= 1;
    if (!gainedNewInfo && !isFirstTurn) return textResult(buildMissingInfoMessage(missing, this.config));
    return textResult(buildAskMessage(missing[0] ?? "destination", slots, isFirstTurn, this.config));
  }

  private continueAfterTool(
    messages: readonly AiMessage[],
    last: AiMessage,
    slots: TravelSlots,
    tools: readonly AiToolDefinition[] | undefined
  ): AiCompletionResult {
    const output = safeParseJson(last.content);
    if (output.escalated) return textResult(buildEscalationMessage(this.config));
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
  "hotelStars"
];

const ENTITY_MISSING_LABELS: Record<string, string> = {
  destinationCity: "your destination",
  travelDates: "your travel dates (a month or specific date)",
  duration: "how many days or nights",
  adults: "the number of travelers",
  budget: "your approximate budget"
};

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
  '  "preferences": string[],',
  '  "intent": string',
  "}",
  "",
  "City fields: prefer the rich object shape. `normalizedValue` is your best-guess canonical spelling",
  '(e.g. rawValue "sidni" -> normalizedValue "Sydney"); `confidence` is 0-1 reflecting how sure you are;',
  '`inferred` is true whenever you corrected or guessed rather than the user spelling it correctly;',
  "`correctionReason` is a short human-readable reason (e.g. \"Likely phonetic misspelling of Sydney\").",
  "A plain string or null is also accepted and is treated as full confidence.",
  "",
  "Extraction rules:",
  "- Parse compact currency/amount shorthand: \"$5k\" = 5000 USD; \"₹2 lakh\" = 200000 INR;",
  '  "INR 1,50,000" = 150000 INR; "budget 10000 USD" = 10000 USD.',
  '- budgetCurrency is a 3-letter ISO 4217 code (USD, INR, EUR, ...).',
  '- "5 days 4 nights" => days=5, nights=4.',
  '- Traveler count is ambiguous unless a breakdown is given — NEVER assume a raw headcount means "N adults".',
  '  "5 log", "hum 5 log hain", "5 people", "total 5", "family of 5" => totalTravellers=5, adults/children/',
  '  infants stay null (composition unknown). Only set adults/children/infants when the message actually',
  '  breaks the group down, e.g. "2 adults, 2 kids, 1 infant" => adults=2, children=2, infants=1 (and leave',
  "  totalTravellers null — the deterministic layer reconciles it against any previously stated total).",
  "- Interpret natural dates: \"today\", \"tomorrow\", \"next Friday\", \"August 15\", \"mid-September\",",
  '  "for one week" (=> a 7-day duration). Populate departureDate/travelMonth/days accordingly.',
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
  "message contains no question or request beyond stating facts."
].join("\n");

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
  context?: { workflowPhase?: TravelWorkflowPhase; lastAskedField?: string | null }
): string {
  return [
    `Confirmed trip state so far (JSON): ${JSON.stringify(known)}`,
    context?.workflowPhase ? `Current workflow phase: ${context.workflowPhase}` : null,
    context?.lastAskedField ? `Field last asked about (use this to disambiguate a bare short answer): ${context.lastAskedField}` : null,
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
  const currency = str("budgetCurrency");
  return {
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
      (merged[key] as string | number) = value;
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
  return [
    `You are ${config.persona}`,
    `Tone: ${config.brandTone}. Speak like an experienced, warm human travel consultant — concise and conversational, never like a form. Reply in under 60 words, plain text, no markdown, no lists.`,
    isFirstTurn && !startingNewTrip && !firstTurnCapturedSomething
      ? `This is the first message of the conversation — begin the reply with: "${config.welcomeMessage}"`
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
    missingLabels.length
      ? `Ask ONLY for this one next missing detail: ${missingLabels[0]}. Do not ask about anything else.`
      : "All required details are known — do not ask any further questions.",
    "Only use the confirmed trip facts listed above — never invent or assume a duration, traveler count,",
    "price, or option that isn't explicitly listed.",
    "Never claim a booking was made, a payment was taken, or that prices are live/final.",
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
  const nextStep = missingLabels.length
    ? `If it flows naturally, gently ask for ${missingLabels[0]} next — but do not force it if it would feel abrupt.`
    : itineraryAlreadyPresented
      ? "If it flows naturally, invite them to confirm the plan or say what they'd like changed — but do not mechanically repeat 'reply confirm'."
      : "If it flows naturally, invite them to continue planning.";
  return [
    `You are ${config.persona}`,
    `Tone: ${config.brandTone}. Speak like an experienced, warm human travel consultant — concise, natural, conversational. Reply in under 80 words, plain text, no markdown, no lists.`,
    "The traveler just asked a question or made a comment. Answer it directly and helpfully first, using only the trip context given below — never invent specific prices, flight numbers, or hotel names.",
    known.length
      ? `Already known about this trip: ${known.join(", ")}. Never ask for any of these again.`
      : "Nothing about the trip is known yet.",
    nextStep,
    "Never say \"Just checking\", and never repeat \"Reply confirm\" unless the user is actually confirming.",
    "Only use the confirmed trip facts listed above — never invent or assume a duration, traveler count,",
    "price, or option that isn't explicitly listed.",
    "Never claim a booking was made, a payment was taken, or that prices are live/final.",
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
  return [
    `You are ${config.persona}`,
    `Tone: ${config.brandTone}. Produce a concrete, practical day-by-day itinerary for ${destination}, ${days} day(s), for ${travelers}.`,
    'Format strictly as "Day N" on its own line, followed by lines of "HH:MM Activity" (24-hour time), one activity per line, using well-known real attractions/areas for the destination where you can name them confidently.',
    "Include a short duration note where it helps (e.g. \"2 hours\") but keep each line brief. Plain text, no markdown, no numbered lists beyond the day/time structure itself.",
    dateNote,
    infantNote,
    "Personalize activity choices to the traveler mix above — do not invent prices or bookings while doing so.",
    "Mention once, briefly, that some attractions' opening hours vary by season and should be verified locally closer to the travel date.",
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
 * advice" -> AGENT_RECOMMENDED; "no budget" / "no fixed budget" / "flexible budget" -> FLEXIBLE.
 */
const AGENT_RECOMMENDED_BUDGET_PATTERN =
  /\b(you suggest(?:\s+(?:a|the|your)\s+budget)?|(?:can\s+)?you\s+recommend(?:\s+(?:a|the)\s+budget)?|recommend(?:ed)?\s+a\s+budget|suggest\s+a\s+budget|i\s+need\s+budget\s+advice|budget\s+advice|guide\s+me\s+(?:about|on)\s+budget|what(?:'s| is) a good budget)\b/i;
const FLEXIBLE_BUDGET_PATTERN =
  /\b(no\s+(?:fixed\s+)?budget|flexible\s+budget|budget\s+is\s+flexible|no\s+budget\s+in\s+mind|not\s+sure\s+(?:about|on)\s+(?:the\s+)?budget)\b/i;

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

/**
 * Deterministic fallback used only when the configured real LLM is unavailable (no provider configured,
 * or the extraction call itself throws) — reuses the regex-based extractors and the typo catalog so the
 * Travel Employee degrades gracefully instead of losing every entity on a transient provider failure.
 */
export function deterministicExtractFallback(message: string): Partial<TravelEntities> {
  const destination = normalizeCityName(extractDestination(message));
  const travelMonth = extractTravelMonth(message);
  const days = extractDurationDays(message);
  // extractPassengers only ever recognizes an ambiguous headcount ("5 people", "family of 5") — it can
  // never tell adults/children/infants apart, so it must never be assigned to `adults` directly.
  const totalTravellers = extractPassengers(message);
  const budget = extractBudget(message);
  const dateGuess = interpretDatePhrase(message);
  return {
    destinationCity: destination,
    travelMonth: travelMonth ?? dateGuess.travelMonth,
    departureDate: dateGuess.normalizedDate,
    days: days ?? dateGuess.durationDays,
    totalTravellers,
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
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}
function monthNameOf(date: Date): string {
  return titleCase(MONTHS[date.getUTCMonth()] ?? "");
}

/**
 * Deterministic natural-date normalizer: "today", "tomorrow", "next Friday", "August 15", "mid-September",
 * and "for N day(s)/week(s)" durations. Accepts an injectable reference date so behavior is testable
 * without depending on the real current date. Never overwrites a confirmed date on its own — callers only
 * apply the result when the corresponding field is not already confirmed.
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
  const midMonth = /\bmid[- ]?([a-z]+)\b/.exec(text);
  if (midMonth?.[1] && MONTHS.includes(midMonth[1])) {
    const monthIndex = MONTHS.indexOf(midMonth[1]);
    const year = base.getUTCMonth() <= monthIndex ? base.getUTCFullYear() : base.getUTCFullYear() + 1;
    const target = new Date(Date.UTC(year, monthIndex, 15));
    return { ...empty, normalizedDate: toIsoDate(target), travelMonth: titleCase(midMonth[1]) };
  }
  const monthDay = /\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text);
  if (monthDay?.[1] && monthDay[2] && MONTHS.includes(monthDay[1])) {
    const monthIndex = MONTHS.indexOf(monthDay[1]);
    const day = Number(monthDay[2]);
    const year = base.getUTCMonth() <= monthIndex ? base.getUTCFullYear() : base.getUTCFullYear() + 1;
    const target = new Date(Date.UTC(year, monthIndex, day));
    return { ...empty, normalizedDate: toIsoDate(target), travelMonth: titleCase(monthDay[1]) };
  }
  return empty;
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
}
export interface BudgetEstimate {
  currency: string;
  low: number;
  high: number;
  breakdown: BudgetEstimateLine[];
}

/**
 * A snapshot of the last budget estimate actually shown to the traveler — source currency, every category
 * range, the total range, a short human-readable summary of the assumptions it was computed under, and
 * when it was computed. Persisted so a later "give in INR" can convert the SAME numbers rather than
 * silently recomputing (which could disagree) or merely relabeling the currency without converting.
 */
export interface StoredBudgetEstimate {
  currency: string;
  low: number;
  high: number;
  breakdown: BudgetEstimateLine[];
  assumptions: string;
  computedAt: string;
}

/**
 * Fixed, documented FX rates (units of currency per 1 USD) — deterministic placeholder data, not a live
 * feed, consistent with the rest of this engine's placeholder pricing. Used only to convert an already
 * computed estimate's numbers between currencies; never to invent new prices.
 */
const FX_RATE_PER_USD: Record<string, number> = {
  USD: 1,
  INR: 83,
  EUR: 0.92,
  GBP: 0.79
};

/** Converts one amount from `from` to `to` using a single fixed rate — never a partial/mixed conversion. */
export function convertCurrencyAmount(amount: number, from: string, to: string): number {
  const fromRate = FX_RATE_PER_USD[from.toUpperCase()] ?? 1;
  const toRate = FX_RATE_PER_USD[to.toUpperCase()] ?? 1;
  return Math.round((amount / fromRate) * toRate);
}

/**
 * Converts every number in a stored estimate to `targetCurrency` using one consistent FX rate. Never
 * relabels unchanged amounts: if the target currency is the same as the source, the estimate (numbers and
 * all) is returned unchanged rather than merely re-stamped.
 */
export function convertStoredBudgetEstimate(estimate: StoredBudgetEstimate, targetCurrency: string): StoredBudgetEstimate {
  const target = targetCurrency.toUpperCase();
  if (estimate.currency.toUpperCase() === target) return estimate;
  return {
    ...estimate,
    currency: target,
    low: convertCurrencyAmount(estimate.low, estimate.currency, target),
    high: convertCurrencyAmount(estimate.high, estimate.currency, target),
    breakdown: estimate.breakdown.map((line) => ({
      ...line,
      low: convertCurrencyAmount(line.low, estimate.currency, target),
      high: convertCurrencyAmount(line.high, estimate.currency, target)
    }))
  };
}

/** Builds the persisted snapshot of an estimate right after it was computed and shown to the traveler. */
function toStoredBudgetEstimate(estimate: BudgetEstimate, entities: TravelEntities, now: string): StoredBudgetEstimate {
  const travelers = describeTravelerMix(entities.adults, entities.children, entities.infants, entities.totalTravellers);
  const days = entities.days ?? entities.nights ?? 5;
  const destination = entities.destinationCity ?? "the destination";
  return {
    currency: estimate.currency,
    low: estimate.low,
    high: estimate.high,
    breakdown: estimate.breakdown,
    assumptions: `${travelers}, ${days} day(s) to ${destination}, economy class`,
    computedAt: now
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

export function estimateBudgetRange(
  entities: TravelEntities,
  config: TravelEmployeeRuntimeConfig
): BudgetEstimate {
  const adults = entities.adults ?? entities.totalTravellers ?? 1;
  // Fare-/cost-paying headcount: children occupy a seat, a bed, and a plate, so they must factor into
  // every priced category — only infants (typically lap/free) are excluded from per-head multipliers.
  // Falls back to an ambiguous `totalTravellers` count (a documented approximation) when composition is
  // still unknown — see {@link resolveFarePayers}.
  const farePayers = resolveFarePayers(entities);
  const days = entities.days ?? entities.nights ?? 5;
  const nights = entities.nights ?? Math.max(days - 1, 1);
  const currency = entities.budgetCurrency ?? config.defaultCurrency;
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
  const hotelLow = Math.min(...hotelPrices) * rooms * nights;
  const hotelHigh = Math.max(...hotelPrices) * rooms * nights;

  const foodLow = farePayers * days * 25;
  const foodHigh = farePayers * days * 40;

  const localTransportLow = farePayers * days * 10;
  const localTransportHigh = farePayers * days * 18;

  const activitiesLow = farePayers * days * 15;
  const activitiesHigh = farePayers * days * 30;

  const visaLow = farePayers * 40;
  const visaHigh = farePayers * 80;

  const insuranceLow = farePayers * 20;
  const insuranceHigh = farePayers * 40;

  const subtotalLow = flightsLow + hotelLow + foodLow + localTransportLow + activitiesLow + visaLow + insuranceLow;
  const subtotalHigh = flightsHigh + hotelHigh + foodHigh + localTransportHigh + activitiesHigh + visaHigh + insuranceHigh;
  const contingencyLow = Math.round(subtotalLow * 0.05);
  const contingencyHigh = Math.round(subtotalHigh * 0.08);

  const breakdown: BudgetEstimateLine[] = [
    { label: "Flights", low: flightsLow, high: flightsHigh },
    { label: "Hotel", low: hotelLow, high: hotelHigh },
    { label: "Food", low: foodLow, high: foodHigh },
    { label: "Local transport", low: localTransportLow, high: localTransportHigh },
    { label: "Activities", low: activitiesLow, high: activitiesHigh },
    { label: "Visa", low: visaLow, high: visaHigh },
    { label: "Insurance", low: insuranceLow, high: insuranceHigh },
    { label: "Contingency", low: contingencyLow, high: contingencyHigh }
  ];
  return {
    currency,
    low: breakdown.reduce((sum, line) => sum + line.low, 0),
    high: breakdown.reduce((sum, line) => sum + line.high, 0),
    breakdown
  };
}

function formatAmount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
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
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const estimate = estimateBudgetRange(entities, config);
  const days = entities.days ?? entities.nights ?? 5;
  const destination = entities.destinationCity ?? "your destination";
  const travelers = describeTravelerMix(
    entities.adults,
    entities.children,
    entities.infants,
    entities.totalTravellers
  );
  const introLine =
    language === "HINGLISH"
      ? `${entities.originCity ? `${entities.originCity} se ${destination}` : destination} trip ke liye (${travelers}, ${days} din), ek practical economy estimate lagbhag ${estimate.currency} ${formatAmount(estimate.low)}–${formatAmount(estimate.high)} hai:`
      : language === "HINDI"
        ? `${entities.originCity ? `${entities.originCity} से ${destination}` : destination} यात्रा के लिए (${travelers}, ${days} दिन), एक व्यावहारिक इकोनॉमी अनुमान लगभग ${estimate.currency} ${formatAmount(estimate.low)}–${formatAmount(estimate.high)} है:`
        : `Sure — for ${travelers} travelling ${entities.originCity ? `from ${entities.originCity} to ${destination}` : `to ${destination}`} for ${days} day${days === 1 ? "" : "s"}, a practical estimate in economy would be around ${estimate.currency} ${formatAmount(estimate.low)}–${formatAmount(estimate.high)}:`;
  const footerNote =
    language === "HINGLISH"
      ? "Ye estimates indicative hain jab tak live booking provider connect nahi hota — actual prices alag ho sakte hain."
      : language === "HINDI"
        ? "जब तक लाइव बुकिंग प्रोवाइडर कनेक्ट नहीं होता, ये अनुमान सांकेतिक हैं — वास्तविक कीमतें अलग हो सकती हैं।"
        : "These are indicative estimates until a live booking provider is connected — actual prices will vary.";
  const lines = [
    introLine,
    ...estimate.breakdown.map((line) => `• ${line.label}: ${estimate.currency} ${formatAmount(line.low)}–${formatAmount(line.high)}`),
    "",
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

function buildFallbackAskMessage(
  missing: string[],
  config: TravelEmployeeRuntimeConfig,
  isFirstTurn: boolean,
  language: TravelResponseLanguage = "ENGLISH"
): string {
  const prefix = isFirstTurn ? `${config.welcomeMessage}\n\n` : "";
  const label = ENTITY_MISSING_LABELS[missing[0] ?? ""] ?? "a few more trip details";
  if (language === "HINGLISH") return `${prefix}Kya aap ${label} bata sakte hain?`;
  if (language === "HINDI") return `${prefix}क्या आप ${label} बता सकते हैं?`;
  return `${prefix}Could you share ${label}?`;
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
    ...entities,
    ...(memory
      ? {
          entityConfirmation: memory.confirmation,
          pendingClarification: memory.pendingClarification,
          lastAskedField: memory.lastAskedField,
          budgetMode: memory.budgetMode,
          pendingAction: memory.pendingAction,
          responseLanguage: memory.responseLanguage,
          budgetDiscussionCompleted: memory.budgetDiscussionCompleted,
          lastBudgetEstimate: memory.lastBudgetEstimate,
          pendingPassengerConflict: memory.pendingPassengerConflict
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
  "BOOK_FLIGHT"
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
  return {
    confirmation,
    pendingClarification,
    lastAskedField,
    budgetMode,
    pendingAction,
    responseLanguage,
    budgetDiscussionCompleted,
    lastBudgetEstimate,
    pendingPassengerConflict
  };
}

/** Reconstructs entities from a stored state document, tolerating older documents that only have legacy TravelSlots fields. */
export function entitiesFromStoredState(value: Record<string, unknown> | null | undefined): TravelEntities {
  if (!value) return EMPTY_TRAVEL_ENTITIES;
  const str = (key: string): string | null => (typeof value[key] === "string" ? (value[key] as string) : null);
  const num = (key: string): number | null => (typeof value[key] === "number" ? (value[key] as number) : null);
  const adults = num("adults");
  // `passengers` is the legacy TravelSlots mirror — only meaningful as an ambiguous total fallback for a
  // document that predates `totalTravellers` and has no real composition either. Never read it into
  // `adults`, or a stored ambiguous total would silently become "N adults" on the next load.
  const totalTravellers = num("totalTravellers") ?? (adults === null ? num("passengers") : null);
  return {
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
  /** The language every user-facing reply must be composed in — see {@link TravelResponseLanguage}. */
  responseLanguage: TravelResponseLanguage;
  /** Whether the BELOW_MINIMUM explanation has already been shown at least once. Persisted across turns. */
  budgetDiscussionCompleted: boolean;
  /** The last budget estimate actually shown, if any — see {@link StoredBudgetEstimate}. Persisted across turns. */
  lastBudgetEstimate: StoredBudgetEstimate | null;
  /** A composition breakdown awaiting reconciliation against a previously stated total. Persisted across turns. */
  pendingPassengerConflict: PendingPassengerConflict | null;
  /** Set while a BELOW_MINIMUM sales handoff is awaiting its CRM-lead tool response. Not persisted across requests. */
  private pendingSalesHandoff: { feasibilityMessage: string } | null = null;
  /** Structured per-turn trace for observability — see {@link TravelTurnDiagnostics}. Not persisted. */
  private diagnostics: TravelTurnDiagnostics | null = null;

  constructor(
    private readonly realProvider: AiProvider,
    private readonly config: TravelEmployeeRuntimeConfig,
    priorEntities: TravelEntities,
    priorMemory: TravelConversationMemory = EMPTY_TRAVEL_CONVERSATION_MEMORY
  ) {
    this.lastEntities = priorEntities;
    this.confirmation = priorMemory.confirmation;
    this.pendingClarification = priorMemory.pendingClarification;
    this.lastAskedField = priorMemory.lastAskedField;
    this.budgetMode = priorMemory.budgetMode;
    this.pendingAction = priorMemory.pendingAction;
    this.responseLanguage = priorMemory.responseLanguage;
    this.budgetDiscussionCompleted = priorMemory.budgetDiscussionCompleted;
    this.lastBudgetEstimate = priorMemory.lastBudgetEstimate;
    this.pendingPassengerConflict = priorMemory.pendingPassengerConflict;
  }

  /** Snapshot of everything besides plain entity values that must be persisted between turns. */
  get lastMemory(): TravelConversationMemory {
    return {
      confirmation: this.confirmation,
      pendingClarification: this.pendingClarification,
      lastAskedField: this.lastAskedField,
      budgetMode: this.budgetMode,
      pendingAction: this.pendingAction,
      responseLanguage: this.responseLanguage,
      budgetDiscussionCompleted: this.budgetDiscussionCompleted,
      lastBudgetEstimate: this.lastBudgetEstimate,
      pendingPassengerConflict: this.pendingPassengerConflict
    };
  }

  /** Structured diagnostic trace for the most recently completed turn — see {@link TravelTurnDiagnostics}. */
  get lastDiagnostics(): TravelTurnDiagnostics | null {
    return this.diagnostics;
  }

  /** Tags the branch this turn resolved to and the tool calls it attempted, then returns the result unchanged. */
  private tag(branch: string, result: AiCompletionResult): AiCompletionResult {
    if (this.diagnostics) {
      this.diagnostics.branch = branch;
      this.diagnostics.toolCallsAttempted = result.toolCalls.map((call) => call.name);
    }
    return result;
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

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const messages = request.messages;
    const last = messages.at(-1);
    const currentText = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const isFirstTurn = messages.filter((message) => message.role === "user").length <= 1;

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
      budgetDiscussionCompletedBefore: this.budgetDiscussionCompleted
    };

    if (last?.role === "tool") return this.tag("tool_continuation", this.continueAfterTool(messages, last, request.tools));

    // Resolve an in-flight "Did you mean X?" before anything else — the reply to that question is not a
    // new trip detail, it's a yes/no about a value already proposed last turn. A bare "yes" here is only
    // ever a clarification answer, never authorization to run tools — that decision is entirely delegated
    // to `resolveCityClarificationYes`, which only resumes a pending action the user separately asked for.
    if (this.pendingClarification) {
      const pending = this.pendingClarification;
      if (/^\s*(no|nope|not\s+quite|wrong|incorrect)\b/i.test(currentText)) {
        this.pendingClarification = null;
        return this.tag(
          "city_clarify_declined",
          textResult(buildCityClarificationMessage(pending.field, pending.rawValue, this.responseLanguage))
        );
      }
      if (/^\s*(yes|yeah|yep|correct|that'?s\s+right|right|confirm(?:ed)?|haan|ji|theek)\b/i.test(currentText))
        return this.tag("clarification_confirmed", await this.resolveCityClarificationYes(pending, request.tools));
      // Anything else drops the pending clarification and lets this turn's own extraction reinterpret
      // the message fresh, rather than forcing a yes/no reading onto an unrelated reply.
      this.pendingClarification = null;
    }

    if (isEscalationRequest(currentText) && !wasEscalated(messages)) {
      this.lastStage = "ESCALATED";
      if (toolAvailable(request.tools, "travel.escalate"))
        return this.tag("escalate", toolResult("travel.escalate", { reason: currentText.slice(0, 500) }));
      return this.tag("escalate", textResult(buildEscalationMessage(this.config, this.responseLanguage)));
    }

    const { entities: extracted, intent, cityInterpretations } = await this.safeExtractAndClassify(currentText);
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

    const baseEntities = intent === "start_new_trip" ? EMPTY_TRAVEL_ENTITIES : this.lastEntities;
    const baseConfirmation = intent === "start_new_trip" ? EMPTY_TRAVEL_ENTITY_CONFIRMATION : this.confirmation;
    const { values: merged, confirmation: mergedConfirmation, destinationChanged } = mergeConfirmedEntities(
      baseEntities,
      baseConfirmation,
      extracted,
      intent
    );
    const changed = diffChangedFields(baseEntities, merged);
    this.diagnostics.changedFields = changed;
    this.lastEntities = merged;
    this.confirmation = mergedConfirmation;
    this.diagnostics.passengerState = computePassengerState(merged);

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

    // The traveler's explicit current request always wins over stale state — budget feasibility (or any
    // other pending action) must never hijack an unrelated ask like "day plan" or "what's worth seeing".
    // This deterministic classification runs before pending-action resumption and before any budget logic.
    const planningAction = classifyPlanningAction(currentText);
    if (this.diagnostics) this.diagnostics.planningAction = planningAction;

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
      return this.tag("generate_itinerary", textResult(itinerary));
    }

    // BOOK_FLIGHT: an explicit booking go-ahead ("flight book kar do") must persist across every
    // clarification and collect only booking-required fields — never budget. See `continueBookFlightFlow`.
    if (planningAction === "BOOK_FLIGHT") {
      return this.tag(
        "book_flight",
        await this.continueBookFlightFlow(merged, feasibility, request.tools, changed, currentText, isFirstTurn)
      );
    }

    // CONVERT_ESTIMATE_CURRENCY: "give in INR" / "convert to rupees" converts the LAST STORED estimate
    // with one FX rate — this is never a request to state a new budget amount, and must run before any
    // budget-guidance/signal logic that would otherwise misread it as one.
    if (planningAction === "CONVERT_ESTIMATE_CURRENCY") {
      const conversion = detectCurrencyConversionRequest(currentText);
      const targetCurrency = conversion?.targetCurrency ?? this.lastEntities.budgetCurrency ?? this.config.defaultCurrency;
      if (!this.lastBudgetEstimate) {
        return this.tag("convert_estimate_no_estimate", textResult(buildNoEstimateToConvertMessage(this.responseLanguage)));
      }
      const converted = convertStoredBudgetEstimate(this.lastBudgetEstimate, targetCurrency);
      this.lastBudgetEstimate = converted;
      return this.tag(
        "convert_estimate_currency",
        textResult(buildConvertedEstimateMessage(converted, this.responseLanguage))
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

    // Budget-relevant requests (hotel/flights/budget) must always re-evaluate and re-show feasibility when
    // still BELOW_MINIMUM, regardless of whether it was already explained once — per policy, these three
    // (plus an explicit budget change, handled via `budgetSignal` below) are the only things that repeat it.
    if ((planningAction === "SEARCH_HOTELS" || planningAction === "SEARCH_FLIGHTS") && canEstimateFlights) {
      this.pendingAction = null;
      return this.tag(
        planningAction === "SEARCH_HOTELS" ? "search_hotels" : "search_flights",
        this.searchOrBelowMinimumHandoff(merged, feasibility, request.tools, true)
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
      return this.tag("resume_search", this.searchOrBelowMinimumHandoff(merged, feasibility, request.tools));
    }
    if (this.pendingAction === "GENERATE_ITINERARY" && hasItineraryFields(merged)) {
      this.pendingAction = null;
      const itinerary = await this.safeGenerateItinerary(merged, currentText);
      return this.tag("resume_generate_itinerary", textResult(itinerary));
    }
    if (this.pendingAction === "MODIFY_HOTEL_BUDGET" && readyToSearch && itineraryAlreadyPresented) {
      this.pendingAction = null;
      return this.tag("resume_hotel_modification", this.handleHotelBudgetModification(merged));
    }
    if (this.pendingAction === "BOOK_FLIGHT") {
      return this.tag(
        "resume_book_flight",
        await this.continueBookFlightFlow(merged, feasibility, request.tools, changed, currentText, isFirstTurn)
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
        if (intent === "confirm_plan" || isBookingConfirmation(currentText)) {
          const crmTool = findCrmLeadTool(request.tools);
          if (crmTool) {
            this.lastWorkflowPhase = "AWAITING_CONFIRMATION";
            return this.tag(
              "confirm_booking_crm",
              toolResult(
                crmTool.name,
                buildCrmLeadPayload(toLegacySlots(merged), currentText, {
                  originCity: merged.originCity,
                  hotelStars: merged.hotelStars,
                  cabinClass: merged.cabinClass,
                  preferences: merged.preferences,
                  adults: merged.adults,
                  children: merged.children,
                  infants: merged.infants
                })
              )
            );
          }
          this.lastStage = "BOOKING_CONFIRMED";
          this.lastWorkflowPhase = "AWAITING_CONFIRMATION";
          return this.tag("confirm_booking", textResult(buildBookingConfirmedMessage(null, this.responseLanguage)));
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
    const reply = await this.safeGenerateReply(
      merged,
      missing,
      changed,
      currentText,
      isFirstTurn,
      intent === "start_new_trip"
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
    if (!touchedComposition) return null;

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
      return textResult(buildPassengerCompositionConflictMessage(expectedTotal, newTotal, this.responseLanguage));
    }

    this.pendingPassengerConflict = null;
    extracted.adults = candidateAdults;
    extracted.children = candidateChildren ?? null;
    extracted.infants = candidateInfants ?? null;
    extracted.totalTravellers = newTotal;
    return null;
  }

  /**
   * BOOK_FLIGHT's collection/resume logic, shared by the fresh-classification branch and the pending-action
   * resume-check: booking intent must survive every clarification (city confirmation, passenger conflict,
   * an intervening budget aside), and must only ever collect booking-required fields — never budget. Once
   * ready, "book it" is itself explicit authorization to search, so this hands off directly rather than
   * parking a SEARCH_OPTIONS offer first.
   */
  private async continueBookFlightFlow(
    merged: TravelEntities,
    feasibility: BudgetFeasibilityResult | null,
    tools: readonly AiToolDefinition[] | undefined,
    changed: string[],
    currentText: string,
    isFirstTurn: boolean
  ): Promise<AiCompletionResult> {
    this.pendingAction = "BOOK_FLIGHT";
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
      if (this.diagnostics) this.diagnostics.passengerClarificationRequired = true;
      return textResult(buildPassengerCompositionClarificationMessage(merged.totalTravellers, this.responseLanguage));
    }
    this.pendingAction = null;
    this.lastWorkflowPhase = "READY_TO_SEARCH";
    return this.searchOrBelowMinimumHandoff(merged, feasibility, tools, true);
  }

  /**
   * Resolves a "yes" answer to an in-flight city clarification ("Did you mean Sydney?"). Per policy, this
   * is never itself authorization to run tools: it commits the field, preserves every other confirmed
   * value, and only resumes a structured action if one was already pending from an earlier, separate user
   * request. Otherwise it responds with a plain, natural acknowledgement and stops there.
   */
  private async resolveCityClarificationYes(
    pending: PendingCityClarification,
    tools: readonly AiToolDefinition[] | undefined
  ): Promise<AiCompletionResult> {
    const now = new Date().toISOString();
    this.lastEntities = { ...this.lastEntities, [pending.field]: pending.proposedValue };
    this.confirmation = {
      ...this.confirmation,
      [pending.field]: { source: "llm", confidence: pending.confidence, confirmed: true, updatedAt: now }
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
      return textResult(await this.safeGenerateItinerary(merged, pending.proposedValue));
    }
    // `MODIFY_HOTEL_BUDGET` is only ever parked once an itinerary has already been presented (see the
    // main turn handler), and message history only grows — so by the time it's resumable here, that
    // precondition still holds without needing to re-inspect the transcript.
    if (this.pendingAction === "MODIFY_HOTEL_BUDGET" && readyToSearch) {
      this.pendingAction = null;
      return this.handleHotelBudgetModification(merged);
    }
    if (this.pendingAction === "BOOK_FLIGHT") {
      const feasibilityForBooking: BudgetFeasibilityResult | null =
        this.budgetMode === "USER_DEFINED" && merged.budget !== null
          ? classifyBudgetFeasibility(merged.budget, estimateBudgetRange(merged, this.config))
          : null;
      return this.continueBookFlightFlow(merged, feasibilityForBooking, tools, [], pending.proposedValue, false);
    }
    // No pending action to resume — acknowledge the field update and stop there.
    return textResult(buildClarificationConfirmedMessage(pending.field, pending.proposedValue, this.responseLanguage));
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
    if (feasibility?.classification === "BELOW_MINIMUM" && (forceReminder || !this.budgetDiscussionCompleted)) {
      if (this.diagnostics) this.diagnostics.toolExecutionSkippedForFeasibility = true;
      return this.handleBelowMinimumFeasibility(merged, feasibility, tools);
    }
    return this.executeSearch(merged, tools);
  }

  /**
   * BELOW_MINIMUM business result: explains the shortfall and alternatives in the conversation's language,
   * then — if a CRM-lead tool is available — saves/updates the enquiry tagged BUDGET_BELOW_MINIMUM /
   * SALES_FOLLOW_UP_REQUIRED. The callback promise is only ever made after that save actually succeeds
   * (see the `pendingSalesHandoff` resolution in `continueAfterTool`); this never calls a search tool.
   */
  private handleBelowMinimumFeasibility(
    merged: TravelEntities,
    feasibility: BudgetFeasibilityResult,
    tools: readonly AiToolDefinition[] | undefined
  ): AiCompletionResult {
    this.lastStage = "RECOMMEND_OPTIONS";
    this.lastWorkflowPhase = "OPTIONS_PRESENTED";
    this.budgetDiscussionCompleted = true;
    this.lastBudgetEstimate = toStoredBudgetEstimate(
      estimateBudgetRange(merged, this.config),
      merged,
      new Date().toISOString()
    );
    const message = buildBelowMinimumMessage(merged, feasibility, this.responseLanguage);
    const crmTool = findCrmLeadTool(tools);
    if (!crmTool) return textResult(message);
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
    const note = buildBudgetFeasibilityNote(entities, estimateBudgetRange(entities, this.config), this.responseLanguage);
    return note ? `${message}\n\n${note}` : message;
  }

  /**
   * Builds the budget-guidance message and persists the estimate it was computed from (see
   * {@link StoredBudgetEstimate}) so a later "give in INR" converts these exact numbers with one FX rate
   * instead of silently recomputing (which could disagree) or merely relabeling the currency.
   */
  private showBudgetGuidance(entities: TravelEntities): string {
    const estimate = estimateBudgetRange(entities, this.config);
    this.lastBudgetEstimate = toStoredBudgetEstimate(estimate, entities, new Date().toISOString());
    return buildBudgetGuidanceMessage(entities, this.config, this.responseLanguage);
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
  }> {
    if (!message.trim()) return { entities: {}, intent: "provide_trip_details", cityInterpretations: {} };
    let rawEntities: Partial<TravelEntities>;
    let intent: TravelIntent;
    let cityInterpretations: Partial<Record<"originCity" | "destinationCity", CityInterpretation>> = {};
    try {
      const result = await this.realProvider.complete({
        messages: [
          { role: "system", content: TRAVEL_ENTITY_EXTRACTION_SYSTEM_PROMPT },
          {
            role: "user",
            content: buildTravelExtractionUserPrompt(this.lastEntities, message, {
              workflowPhase: this.lastWorkflowPhase,
              lastAskedField: this.lastAskedField
            })
          }
        ],
        maxOutputTokens: 400,
        temperature: 0
      });
      rawEntities = parseExtractedEntities(result.content);
      intent = parseIntent(result.content);
      const originInterp = parseCityInterpretation(result.content, "originCity");
      if (originInterp) cityInterpretations = { ...cityInterpretations, originCity: originInterp };
      const destinationInterp = parseCityInterpretation(result.content, "destinationCity");
      if (destinationInterp) cityInterpretations = { ...cityInterpretations, destinationCity: destinationInterp };
    } catch {
      // The real LLM is unavailable — degrade to deterministic regex extraction and the typo catalog
      // rather than silently dropping every entity for this turn.
      rawEntities = deterministicExtractFallback(message);
      intent = classifyIntentDeterministically(message);
    }
    const withShortAnswer = resolveShortAnswerForLastAskedField(message, this.lastAskedField, rawEntities);
    const entities = augmentWithDatePhrase(message, withShortAnswer);
    return { entities, intent, cityInterpretations };
  }

  private async safeGenerateReply(
    entities: TravelEntities,
    missing: string[],
    changed: string[],
    userMessage: string,
    isFirstTurn: boolean,
    startingNewTrip: boolean
  ): Promise<string> {
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
      return text || buildFallbackAskMessage(missing, this.config, isFirstTurn, this.responseLanguage);
    } catch {
      return buildFallbackAskMessage(missing, this.config, isFirstTurn, this.responseLanguage);
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
  private async safeGenerateItinerary(entities: TravelEntities, userMessage: string): Promise<string> {
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
      return text || buildFallbackItineraryMessage(entities, this.responseLanguage);
    } catch {
      return buildFallbackItineraryMessage(entities, this.responseLanguage);
    }
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
    if (typeof output.reference === "string" && output.reference.startsWith("LEAD-")) {
      this.lastStage = "BOOKING_CONFIRMED";
      return textResult(buildBookingConfirmedMessage(output.reference, this.responseLanguage));
    }
    return textResult(buildGenericContinuationMessage(this.responseLanguage));
  }
}
