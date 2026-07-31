import {
  extractBudget,
  extractCustomerName,
  extractDestination,
  extractDurationDays,
  extractTravelMonth,
  extractPassengerComposition,
  parseExplicitTravelDate,
  KNOWN_DESTINATIONS,
  type TravelEntities,
  type TravelSlots
} from "./travel.runtime";

export const SPRINT_4_4B_VERSION = "1.0.0";

export type ConversationPhase =
  | "COLLECTING_DETAILS"
  | "READY_FOR_RECOMMENDATION"
  | "RECOMMENDATION_PRESENTED"
  | "AWAITING_SELECTION"
  | "BOOKING_APPROVAL_PENDING"
  | "BOOKING_IN_PROGRESS"
  | "BOOKED"
  | "CANCELLATION_APPROVAL_PENDING"
  | "CANCELLED";

export type SprintIntent =
  | "BUDGET_CHANGE"
  | "BUDGET_FLEXIBLE"
  | "BUDGET_REMOVE_LIMIT"
  | "BOOKING_INTENT"
  | "CANCELLATION_INTENT"
  | "RE_EVALUATION_REQUEST"
  | "SELECT_RECOMMENDATION"
  | "NONE";

export interface SprintDecision {
  intent: SprintIntent;
  confidence: number;
  payload?: Record<string, unknown>;
}

export function detectSprintIntent(text: string, phase: ConversationPhase): SprintDecision {
  const lower = text.toLowerCase().trim();

  if (/\bcancel\b/.test(lower)) {
    return { intent: "CANCELLATION_INTENT", confidence: 1 };
  }

  const bookingPatterns = [
    /\bbook\s+(?:the\s+|this\s+|my\s+|that\s+)?(?:ticket|trip|flight|booking|itinerary|option|package|hotels?|flights?|hotels?\s+and\s+flights?)/i,
    /\bbook\s+(?:a\s+|my\s+)?round\s+trip/i,
    /\bconfirm\s+(?:this|the)\s+(?:option|booking|trip|itinerary)/i,
    /\bproceed\s+(?:with\s+)?(?:booking|this|the\s+trip)/i,
    /\breserve\s+(?:this|the)\s+itinerary/i,
    /\bi\s+want\s+(?:to\s+)?book/i,
    /\bgo\s+ahead/i,
    /\b(?:option|pick)\s*(?:1|2|one|two)\b/i,
    /\bconfirm\s+my\s+trip/i,
    // A bare "book"/"book it"/"please book now" reply — the single most natural thing a traveler types
    // once a recommendation is on screen. Anchored to the whole message (not \b-bounded mid-sentence) so
    // it can't fire on unrelated text that merely contains the word "book".
    /^\s*(?:ok(?:ay)?[,.]?\s*)?(?:please\s+)?book\s*(?:it|this|now)?\s*[!.]?\s*$/i
  ];
  if (bookingPatterns.some(p => p.test(text)) && phase !== "BOOKED" && phase !== "BOOKING_APPROVAL_PENDING") {
    return { intent: "BOOKING_INTENT", confidence: 0.95 };
  }

  if (/\b(?:i\s+(?:am|can|will)\s+(?:okay\s+to\s+)?increase\s+(?:the\s+)?budget|budget\s+(?:is\s+)?flexible|increase\s+(?:it\s+)?to|revise\s+(?:the\s+)?budget)\b/i.test(lower)) {
    const budget = extractBudget(text);
    if (budget) {
      return { intent: "BUDGET_CHANGE", confidence: 1, payload: { budget } };
    }
    if (/\bbudget\s+(?:is\s+)?flexible\b|\bno\s+(?:fixed\s+)?budget\b/i.test(lower)) {
      return { intent: "BUDGET_FLEXIBLE", confidence: 0.95 };
    }
    return { intent: "BUDGET_CHANGE", confidence: 0.9 };
  }

  if (/\bremove\s+(?:the\s+)?budget\s+limit\b|\bno\s+(?:fixed\s+)?budget\b|\bunlimited\s+budget\b/i.test(lower)) {
    return { intent: "BUDGET_REMOVE_LIMIT", confidence: 0.95 };
  }

  if (
    /\b(?:i\s+told\s+you\s+earlier|already\s+told\s+you|maine\s+pehle\s+bata|sab\s+pehle\s+bataya|already\s+shared|upar\s+dekh|same\s+details?|pehle\s+hi\s+de|already\s+gave)\b/i.test(lower)
  ) {
    return { intent: "RE_EVALUATION_REQUEST", confidence: 0.98 };
  }

  if (
    /\b(?:select|choose|pick|i'?ll?\s+take|go\s+with|i\s+like)\b.{0,40}(?:option|recommendation|first|second|1|2)\b|\b(?:option|recommendation)\s*(?:1|2|one|two)\b/i.test(lower)
  ) {
    return { intent: "SELECT_RECOMMENDATION", confidence: 0.85 };
  }

  return { intent: "NONE", confidence: 0 };
}

function matchKnownCity(candidate: string): string | null {
  const lowerCandidate = candidate.toLowerCase();
  for (const dest of KNOWN_DESTINATIONS) {
    if (lowerCandidate === dest || lowerCandidate.includes(dest) || dest.includes(lowerCandidate)) {
      const found = KNOWN_DESTINATIONS.find(
        (d: string) => d.toLowerCase() === lowerCandidate || lowerCandidate.includes(d) || d.includes(lowerCandidate)
      );
      if (found) {
        return found.split(" ").map((word: string) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
      }
    }
  }
  return null;
}

export function extractOriginCity(text: string): string | null {
  const fromPattern = /\bfrom\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})\b/i;
  const fromMatch = fromPattern.exec(text);
  if (fromMatch && fromMatch[1]) {
    const result = matchKnownCity(fromMatch[1]);
    if (result) return result;
  }

  const sePattern = /\b(\w+(?:\s+\w+){0,2})\s+se\b/i;
  const seMatch = sePattern.exec(text);
  if (seMatch && seMatch[1]) {
    const result = matchKnownCity(seMatch[1].trim());
    if (result) return result;
  }

  const departureCityPattern = /\b(?:depart(?:ure)?\s+(?:city|from|location|airport)|leaving\s+from|starting\s+from)\b.{0,30}?([A-Za-z]+(?:\s+[A-Za-z]+){0,2})\b/i;
  const depMatch = departureCityPattern.exec(text);
  if (depMatch && depMatch[1]) {
    const result = matchKnownCity(depMatch[1]);
    if (result) return result;
  }

  return null;
}

export function isOriginQuestion(lastAssistantMessage: string | null): boolean {
  if (!lastAssistantMessage) return false;
  const lower = lastAssistantMessage.toLowerCase();
  return /\b(?:from|origin|departure|starting)\b.{0,30}?\?/i.test(lower) &&
    !/\bdestination\b/i.test(lower);
}

export function isDestinationQuestion(lastAssistantMessage: string | null): boolean {
  if (!lastAssistantMessage) return false;
  const lower = lastAssistantMessage.toLowerCase();
  return /\b(?:destination|where|going to|traveling to)\b.{0,30}?\?/i.test(lower) ||
    /\b(?:where\s+(?:are\s+)?(?:you\s+)?(?:going|traveling|headed))\b/i.test(lower);
}

export function mergeEntitiesWithPriorState(
  prior: TravelEntities,
  currentText: string,
  _allUserMessages: string[],
  lastAssistantMessage: string | null,
  fallbackCurrency: string
): TravelEntities {
  const result: TravelEntities = { ...prior };

  const name = extractCustomerName([currentText]);
  if (name) result.customerName = name;

  const askingOrigin = isOriginQuestion(lastAssistantMessage);
  const askingDestination = isDestinationQuestion(lastAssistantMessage);

  let originFromText = extractOriginCity(currentText);
  const destFromDestination = extractDestination(currentText);
  let destFromText = destFromDestination;

  if (originFromText && destFromText) {
    if (originFromText.toLowerCase() === destFromText.toLowerCase()) {
      if (askingOrigin) {
        result.originCity = originFromText;
      } else if (askingDestination) {
        result.destinationCity = destFromText;
      } else {
        result.originCity = originFromText;
      }
    } else {
      if (askingOrigin) {
        result.originCity = originFromText;
      } else if (askingDestination) {
        result.destinationCity = destFromText;
      } else {
        result.originCity = originFromText;
        result.destinationCity = destFromText;
      }
    }
  } else if (destFromText && !originFromText) {
    if (askingOrigin) {
      const fromHint = /\bfrom\s+([A-Za-z]+)/i.exec(currentText);
      if (fromHint && fromHint[1]) {
        const reExtracted = matchKnownCity(fromHint[1]);
        if (reExtracted) {
          originFromText = reExtracted;
          destFromText = null;
        }
      }
      if (originFromText) {
        result.originCity = originFromText;
      } else if (destFromText) {
        result.originCity = destFromText;
        if (result.destinationCity) {
        }
      }
    } else {
      result.destinationCity = destFromText;
    }
  } else if (originFromText && !destFromText) {
    if (askingDestination) {
      result.destinationCity = originFromText;
      if (result.originCity === originFromText) result.originCity = null;
    } else {
      result.originCity = originFromText;
    }
  }

  const month = extractTravelMonth(currentText);
  if (month && !askingOrigin && !askingDestination) {
    result.travelMonth = month;
  }

  // Was a hand-rolled regex requiring a FULL month name ("january"..."december") and a 4-digit year —
  // "1 Oct 2026" (abbreviated month) never matched, so `departureDate` silently stayed null and the
  // booking confirmation summary fell back to "dates to be confirmed" even though the traveler had already
  // given an exact date. `parseExplicitTravelDate` (travel.runtime.ts) is the same day/month/year parser
  // already used elsewhere in this codebase — it accepts abbreviations and 2-digit years too.
  const explicitDate = parseExplicitTravelDate(currentText);
  if (explicitDate) {
    result.departureDate = explicitDate.normalizedDate;
    result.travelMonth = explicitDate.travelMonth;
  }

  const durationDays = extractDurationDays(currentText);
  if (durationDays !== null) {
    result.days = durationDays;
    result.nights = durationDays - 1;
  }

  const composition = extractPassengerComposition(currentText);
  if (composition.adults !== null) result.adults = composition.adults;
  if (composition.children !== null) result.children = composition.children;
  if (composition.infants !== null) result.infants = composition.infants;
  if (composition.totalTravellers !== null) {
    if (composition.adults !== null) {
      result.totalTravellers = composition.totalTravellers;
    } else {
      result.totalTravellers = composition.totalTravellers;
    }
  }

  const budget = extractBudget(currentText, fallbackCurrency);
  if (budget) {
    result.budget = budget.amount;
    result.budgetCurrency = budget.currency ?? fallbackCurrency;
  }

  // "Hotel and flight for round trip" etc. — only ever SETS tripType when the message actually states one;
  // never clears an already-known tripType, and never touches any other field (see extractTripType).
  const tripType = extractTripType(currentText);
  if (tripType) result.tripType = tripType;

  return result;
}

export interface SprintState {
  phase: ConversationPhase;
  recommendationMade: boolean;
  bookingApprovalRequested: boolean;
  bookingId: string | null;
  cancellationApprovalRequested: boolean;
  cancellationId: string | null;
}

export function emptySprintState(): SprintState {
  return {
    phase: "COLLECTING_DETAILS",
    recommendationMade: false,
    bookingApprovalRequested: false,
    bookingId: null,
    cancellationApprovalRequested: false,
    cancellationId: null
  };
}

export function determineMissingFields(entities: TravelEntities): string[] {
  const missing: string[] = [];
  if (!entities.customerName) missing.push("customerName");
  if (!entities.originCity) missing.push("originCity");
  if (!entities.destinationCity) missing.push("destinationCity");
  if (!entities.departureDate && !entities.travelMonth) missing.push("departureDate");
  if (entities.days === null && entities.nights === null) missing.push("duration");
  if (entities.adults === null && entities.totalTravellers === null) missing.push("travellers");
  if (entities.budget === null) missing.push("budget");
  return missing;
}

export function buildTravelSlotsFromEntities(entities: TravelEntities): TravelSlots {
  return {
    destination: entities.destinationCity,
    travelMonth: entities.travelMonth,
    durationDays: entities.days ?? entities.nights,
    passengers: entities.adults ?? entities.totalTravellers,
    budgetAmount: entities.budget,
    budgetCurrency: entities.budgetCurrency
  };
}

export function extractRoundTrip(text: string): boolean {
  return /\b(?:round\s*trip|return\s+(?:ticket|flight|journey)|both\s+ways|aane?\s*(?:aur|or|and)\s+jaane?)\b/i.test(text);
}

export function extractTripType(text: string): "ROUND_TRIP" | "ONE_WAY" | null {
  if (extractRoundTrip(text)) return "ROUND_TRIP";
  if (/\b(?:one\s+way|single\s+(?:trip|ticket|journey))\b/i.test(text)) return "ONE_WAY";
  return null;
}
