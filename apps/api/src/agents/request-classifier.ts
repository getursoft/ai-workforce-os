import {
  classifyPlanningAction,
  extractDestination,
  isBookingConfirmation,
  looksLikePhoneOrContact,
  parseJourneyLegChain
} from "../travel/travel.runtime";
import { looksLikeKnowledgeQuery } from "../knowledge/knowledge.search";

/**
 * The single, central classification of every inbound message — the first stage of the orchestration
 * pipeline (Incoming Message -> Request Classification -> Domain Routing -> Knowledge Decision -> Action
 * Decision -> Memory Update -> Response Builder -> LLM -> Validation -> Final Response). Every future AI
 * Employee (Hospital, HR, Sales, Finance, ...) reuses this same taxonomy; only the domain-specific
 * signals feeding TASK_EXECUTION/domain-planning detection are employee-aware today (see
 * `RequestClassifierContext`), everything else is domain-agnostic.
 *
 * - KNOWLEDGE_QUERY: an informational/policy question — the only category allowed to reach the
 *   knowledge-grounded-answer bypass (see "Knowledge fallback" in docs/enterprise-knowledge.md).
 * - TASK_EXECUTION: an explicit, concrete action command (book the flight, search hotels, submit an
 *   enquiry, generate a lead, request a callback) — always routes to the domain runtime's tool path,
 *   never to knowledge.
 * - TRAVEL_PLANNING: a trip-planning statement that isn't yet a specific tool command (an explicit
 *   route, "plan the trip", a general continuation) — routes to the domain (travel) runtime.
 * - SLOT_UPDATE: a bare fragment (a date, a duration, a passenger count) that only makes sense as a
 *   continuation of an in-progress domain conversation.
 * - CORRECTION: an explicit correction utterance ("no, actually...", "instead...", "change X to Y") —
 *   routed the same as the active domain's planning flow (a correction is meaningless without domain
 *   context), but labeled distinctly for explainability/diagnostics.
 * - CONFIRMATION: an explicit go-ahead ("yes", "confirm", "sounds good") in a domain context.
 * - GENERAL_CHAT: ordinary conversation with no domain or knowledge signal — falls through to the
 *   employee's normal conversational behavior.
 * - UNKNOWN: empty/unparseable input.
 */
export type RequestIntent =
  | "LEAD_STATUS_QUERY"
  | "KNOWLEDGE_QUERY"
  | "TASK_EXECUTION"
  | "TRAVEL_PLANNING"
  | "SLOT_UPDATE"
  | "GENERAL_CHAT"
  | "CONFIRMATION"
  | "CORRECTION"
  | "UNKNOWN";

/** Every category except KNOWLEDGE_QUERY must never trigger the knowledge-grounded-answer bypass or its
 * "I could not find this information in the uploaded knowledge." fallback — see AgentService.execute. */
export function isKnowledgeEligible(intent: RequestIntent): boolean {
  return intent === "KNOWLEDGE_QUERY";
}

export interface RequestClassifierContext {
  /** Whether the current AI Employee is the Travel Employee — the only domain with planning/slot/task
   * signals wired in today. A future domain (Hospital, HR, ...) would add its own context flag and
   * signal set here, following the same pattern, without touching the taxonomy or the knowledge/general
   * fallback logic below. */
  isTravelEmployee: boolean;
  /** Whether the current AI Employee is one of the shared-engine domain employees (HR, Finance, IT
   * Support, Sales, Marketing, Legal, Customer Support). These employees reuse the same deterministic
   * intent taxonomy; they never trigger travel planning/slot signals, but contact replies and corrections
   * still route to the employee runtime instead of the knowledge fallback. */
  isEmployeeDomain?: boolean;
}

// A message that is only ever a slot fragment continuing an in-progress domain conversation — "10
// december", "5 days", "2 adults" — never a knowledge question or a fresh planning ask on its own.
const BARE_SLOT_DATE_PATTERN = /^\s*\d{1,2}(?:st|nd|rd|th)?[\s-]+[a-z]+(?:\s+\d{2,4})?\s*$/i;
const BARE_SLOT_DURATION_PATTERN = /^\s*\d{1,3}\s*(?:days?|nights?)\s*$/i;
const BARE_SLOT_PASSENGER_PATTERN = /^\s*\d{1,2}\s*(?:adults?|passengers?|people|log|travell?ers?|pax)\s*$/i;

/**
 * High-priority travel-state signal. Unlike the legacy BARE_SLOT_* expressions this deliberately accepts
 * several slots in one utterance ("4 rat ke liye 3 adult 1 kid") and state recall/correction fragments.
 * It is routing-only: the travel runtime remains the source of truth for extraction and validation.
 */
const TRAVEL_STATE_BEARING_PATTERN =
  /\b(?:\d{1,2}\s*(?:adults?|grownups?|children?|child|kids?|infants?|bab(?:y|ies)|passengers?|people|log|travell?ers?|pax|days?|din|nights?|raat|rat|rate)|(?:adults?|children?|kids?|infants?)\s*\d{1,2}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}|\d{1,2}(?:st|nd|rd|th)?(?:\s+|\/|-)(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2})|\b(?:sab\s+(?:piche|pehle)|already\s+told|shared\s+that\s+earlier|upar\s+dekh|details?\s+de\s+di|same\s+details?|kitne\s+log|kitni\s+raat|mera\s+route|maine\s+pehle)\b)/i;

// "plan the trip" doesn't match any of classifyPlanningAction's more specific action patterns (day-wise
// itinerary, booking, search, ...) — it's a generic continuation ask and needs its own narrow signal.
const PLANNING_CONTINUATION_PATTERN =
  /\bplan\s+(?:the|my|our|this)\s+trip\b|\bcontinue\s+(?:the|my|our|this)\s+(?:trip|booking|planning)\b|\bproceed\s+with\s+(?:the|my|our|this)\s+trip\b/i;

// Deliberately narrow, structural correction phrasing ("no, actually...", "instead...", "change X to
// Y", "replace X with Y") — not a business-vocabulary list, so it generalizes to any future domain's
// slot-correction utterances without modification.
const CORRECTION_SIGNAL_PATTERN =
  /\b(?:no,|actually|instead|change\s+\w+(?:\s+\w+)?\s+to\b|update\s+\w+(?:\s+\w+)?\s+to\b|replace\s+\w+\s+with\b)/i;

// A routing-only safety net: a generic "suggest/estimate/create X" travel ask that doesn't match any of
// `classifyPlanningAction`'s more specific patterns (e.g. "suggest hotels" with no "flights" mentioned,
// "estimate budget" with no restated "trip") must still never fall through to the knowledge-question
// check below — bare travel nouns like "hotels"/"budget" would otherwise trip `looksLikeKnowledgeQuery`'s
// generic topic-term heuristic (see its TERM_GROUPS) and get answered from RAG, silently discarding
// everything already known about the trip. Deliberately just a routing decision, not an action classifier
// — it never changes how the travel engine itself handles the message (that stays entirely up to
// `classifyPlanningAction`/`isExecutionRequest`/the LLM's own intent, unchanged), only whether the
// knowledge bypass is even allowed to run.
const GENERIC_TRAVEL_ACTION_PATTERN =
  /\b(?:suggest|recommend|estimate|create|generate|build|make)\s+(?:me\s+|us\s+|a\s+|an\s+|the\s+|some\s+|good\s+)*(?:hotels?|flights?|itinerary|budget)\b/i;

// A transactional travel-booking request — bare "hotel and flight for round trip", "show flight/hotel/
// package options", "round-trip options", or an option-selection/booking-confirmation reply ("option 2",
// "confirm option 1"). None of these carry a verb `classifyPlanningAction`/`GENERIC_TRAVEL_ACTION_PATTERN`
// already recognize (no "book"/"search"/"suggest"/"recommend"), so without this guard they fall through
// to `looksLikeKnowledgeQuery` — a bare mention of "hotel" alone satisfies its generic topic-vocabulary
// check (see knowledge.search.ts's TERM_GROUPS HOTEL_GROUP), silently routing a live transaction request
// into the knowledge/RAG "I could not find this information" fallback instead of the travel engine. A
// travel transaction request must never be answered from knowledge just because no document matches it.
const TRAVEL_TRANSACTION_GUARD_PATTERN =
  /\b(?:hotels?\s*(?:and|&|\+)\s*flights?|flights?\s*(?:and|&|\+)\s*hotels?)\b|\bshow\s+(?:me\s+)?(?:flight|hotel|package)\s+options?\b|\bround[\s-]?trip\s+options?\b|\b(?:confirm|select|choose|pick|go\s+with|proceed\s+with)\s+option\s*(?:\d+|one|two|three|first|second|third)\b|\boption\s*(?:\d+|one|two|three)\b|\bbook\s+(?:my\s+|our\s+|the\s+)?trip\b/i;

const LEAD_STATUS_QUERY_PATTERN =
  /\b(?:did\s+you\s+captur(?:e|ed)\s+(?:my\s+)?lead|have\s+you\s+created\s+(?:my\s+|the\s+)?lead|has\s+my\s+lead\s+been\s+created|(?:is|was)\s+my\s+(?:enquiry|inquiry|request)\s+(?:submitted|saved)|did\s+you\s+save\s+(?:my\s+)?(?:details|request)|what\s+is\s+my\s+(?:lead|enquiry|inquiry)\s+status|(?:give\s+me\s+|what\s+is\s+)?my\s+(?:lead\s+)?reference(?:\s+number)?|what\s+is\s+the\s+reference|mera\s+lead\s+bana|lead\s+bana\s+diya|lead\s+capture\s+hua|enquiry\s+submit\s+hui|request\s+save\s+hui|(?:reference|enquiry)\s+(?:number|id)\s+(?:kya\s+hai|batao))\b/i;

// Domain-topic replies for the shared-engine employees (HR, Finance, IT, Sales, Marketing, Legal,
// Customer Support). A message naming one of these topics while the employee is collecting domain fields
// must never fall through to the knowledge-question check (whose generic term heuristics — "policy",
// "tax", "support" — would otherwise route it to RAG and silently discard the field being collected).
// Deliberately routing-only, exactly like the travel guards above: it never changes how the employee
// engine itself handles the message.
const EMPLOYEE_DOMAIN_TOPIC_PATTERN =
  /\b(?:leave|onboarding|benefit|payroll|attendance|appraisal|grievance|reimburse|expense|invoice|budget|report|vpn|network|password|login|access|software|hardware|laptop|printer|product|pricing|quote|order|demo|trial|campaign|content|social|webinar|seo|notice|gst|income[\s-]?tax|scrutiny|show[\s-]?cause|compliance|regulatory|refund|return|billing|delivery|shipping|subscription|account)\b/i;

/**
 * Deterministic request routing, computed from the current message text alone — never from whether
 * knowledge search returned anything or how well it scored (see "Request routing" in
 * docs/enterprise-knowledge.md). Domain (travel) signals are checked before the knowledge-question shape
 * since they are more specific — a bare slot fragment, a correction, or an explicit route/booking ask
 * always wins over an incidental policy-vocabulary overlap (e.g. "travel" appearing in both "travel
 * policy" and "i want to travel delhi to mumbai").
 */
export function classifyRequestIntent(text: string, context: RequestClassifierContext): RequestIntent {
  if (!text.trim()) return "UNKNOWN";
  if (context.isTravelEmployee) {
    if (LEAD_STATUS_QUERY_PATTERN.test(text)) return "LEAD_STATUS_QUERY";
    if (isBookingConfirmation(text)) return "CONFIRMATION";
    if (classifyPlanningAction(text) !== null) return "TASK_EXECUTION";
    if (looksLikePhoneOrContact(text)) return "TASK_EXECUTION";
    if (GENERIC_TRAVEL_ACTION_PATTERN.test(text)) return "TASK_EXECUTION";
    if (TRAVEL_TRANSACTION_GUARD_PATTERN.test(text)) return "TASK_EXECUTION";
    if (CORRECTION_SIGNAL_PATTERN.test(text)) return "CORRECTION";
    if (extractDestination(text) !== null || parseJourneyLegChain(text).length > 0)
      return "TRAVEL_PLANNING";
    if (
      TRAVEL_STATE_BEARING_PATTERN.test(text) ||
      BARE_SLOT_DURATION_PATTERN.test(text) ||
      BARE_SLOT_PASSENGER_PATTERN.test(text) ||
      BARE_SLOT_DATE_PATTERN.test(text)
    )
      return "SLOT_UPDATE";
    if (
      PLANNING_CONTINUATION_PATTERN.test(text)
    )
      return "TRAVEL_PLANNING";
  }
  if (context.isEmployeeDomain) {
    if (looksLikePhoneOrContact(text)) return "TASK_EXECUTION";
    if (CORRECTION_SIGNAL_PATTERN.test(text)) return "CORRECTION";
    // A domain topic being shared while the employee collects fields must route to the employee engine,
    // never the knowledge fallback (whose generic term heuristics would otherwise swallow it).
    if (EMPLOYEE_DOMAIN_TOPIC_PATTERN.test(text)) return "TASK_EXECUTION";
  }
  if (looksLikeKnowledgeQuery(text)) return "KNOWLEDGE_QUERY";
  return "GENERAL_CHAT";
}
