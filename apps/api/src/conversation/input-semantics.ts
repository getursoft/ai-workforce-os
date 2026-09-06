import { ACKNOWLEDGEMENT_WORDS, ACTION_VERBS, FAREWELL_WORDS, REJECTION_WORDS } from "./identity-capture";

/**
 * Sprint 6.5 — Part 3: a structured classification of "what is the user doing with this message,"
 * shared by the Receptionist and every AI Employee. This is deliberately NOT a per-employee or
 * per-field parser — it never decides which employee owns a domain pivot (that stays entirely with
 * `receptionist-routing.service.ts`'s own keyword/domain scoring) and never decides which entity field
 * a correction targets (that stays with each employee's own deterministic extractors). Its only job is
 * to classify the message BEFORE any state mutation happens, so callers know whether it's safe to:
 *   - assign the text to a pending field ("ANSWER"/"INFORMATION"),
 *   - overwrite an existing value ("CORRECTION"),
 *   - execute a workflow action ("ACTION"),
 *   - do nothing to state at all ("ACKNOWLEDGEMENT"/"REJECTION"/"FAREWELL"),
 *   - or defer to routing because the user has moved on to a different need ("DOMAIN_PIVOT").
 *
 * Classification order matters (first confident match wins) and is deliberately conservative: on
 * genuine ambiguity this returns "UNKNOWN", and every caller in this codebase must treat "UNKNOWN" the
 * same way `identity-capture.ts` treats a failed name match — do not mutate state, do not guess.
 */
export type UserInputSemantic =
  | "INFORMATION"
  | "ANSWER"
  | "CORRECTION"
  | "ACTION"
  | "ACKNOWLEDGEMENT"
  | "REJECTION"
  | "DOMAIN_PIVOT"
  | "FAREWELL"
  | "UNKNOWN";

export interface InputSemanticContext {
  /** True when the assistant's previous turn asked the user a specific question. */
  hasPendingQuestion: boolean;
  /** Optional extra words a caller knows are "value" words, not chatter (e.g. KNOWN_DESTINATIONS) —
   *  used only to strengthen the INFORMATION/ANSWER heuristic, never required. */
  knownValueWords?: readonly string[];
  /** Sprint 6.6 — Part 14: whichever typed pending-question identifier the caller already tracks (e.g. a
   *  `TravelPendingAction`/`TravelPendingInputAction` literal). Deliberately a bare `string`, not a new
   *  enum — the brief is explicit that a caller's own existing pending-field metadata is the "question
   *  type," not a second one defined here. Not consulted by `classifyUserInput` itself today (classifying
   *  WHAT the user is doing stays independent of WHICH question is pending — see the module doc comment);
   *  carried through purely so a caller can log/branch on it without a second lookup. */
  pendingQuestionType?: string;
}

export interface InputSemanticResult {
  semantic: UserInputSemantic;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
}

// Closing/no-more-needed phrasing. Deliberately phrase-level (not bare "thanks", which is an
// ACKNOWLEDGEMENT on its own) so an ordinary mid-conversation "thanks" never gets misread as ending
// the conversation.
const FAREWELL_PHRASE_PATTERN =
  /\b(?:that'?s all|nothing else|no more (?:questions?|help)(?: needed)?|see you|talk (?:later|soon)|have a good (?:day|one)|i'?m done(?: here)?)\b/i;
const FAREWELL_WORD_PATTERN = new RegExp(`^\\s*(?:${FAREWELL_WORDS.join("|")})[.!\\s]*$`, "i");

// Bare declines and soft "not now" phrasing — distinct from a CORRECTION, which restates a *different*
// value rather than merely declining.
const REJECTION_PHRASE_PATTERN =
  /\b(?:no thanks|not now|maybe later|don'?t (?:book|want|need)|i don'?t want (?:that|this)|not interested)\b/i;
const REJECTION_WORD_PATTERN = new RegExp(`^\\s*(?:${REJECTION_WORDS.join("|")})[.!\\s]*$`, "i");

// A generalized version of the narrow negation-marker regex Travel's `classifyRouteRelationship`
// already used at one call site (`travel.runtime.ts`'s route-relationship check) — exported here so
// that site (and every other correction-sensitive call site) reuses ONE pattern instead of each
// maintaining its own drifting copy. Extended with "change X to Y" / "make it N" / "sorry, I meant X"
// and Hinglish trailing-imperative markers ("kar do" / "karo" / "kardo") which restate a value with the
// correction cue at the END of the sentence rather than the start.
export const CORRECTION_MARKER_PATTERN =
  /^\s*(?:not|nahi|no\s*,|instead\s+of|actually|galti\s+se|correction[:\s]|i\s+meant|sorry,?\s+i\s+meant)\b|\bchange\s+(?:the\s+)?\w+(?:\s+\w+)?\s+to\b|\bmake\s+(?:it|that|the\s+\w+)\b|\bkar\s*do\b|\bkaro\b|\bkardo\b/i;

// Explicit pivot language — coarse and employee-agnostic on purpose. Which employee the pivot goes to
// is entirely `receptionist-routing.service.ts`'s job; this only flags "the user is stating a different
// need," so a pending-field consumer knows not to force the text into its own field.
//
// Sprint 6.6 — Part 8/15: extended with Hinglish pivot markers ("X rehne do", "chhodo", "ab X chahiye",
// "se baat karni hai", "pe chalo") and broadened "forget this/that/it"/"never mind this/that" to not
// require a following "I need/have" — "Forget this, salary ka issue hai" (no "I need/have" at all) is a
// brief-mandated example that the original English-only, English-grammar-anchored pattern would have
// missed entirely.
const DOMAIN_PIVOT_PATTERN =
  /\bi need (?:help with )?\w+(?:\s+\w+)?\s*(?:help|support|question|issue)?\s*instead\b|\bforget\s+(?:this|that|it|about)\b|\bnever\s*mind\s+(?:that|this)\b|\binstead\s+i\s+(?:need|have)\b|\bleave\s+this\b|\b\w+\s+rehne\s+do\b|\bchhodo\b|\bab\s+\w+(?:\s+\w+)?\s+chahiye\b|\bse\s+baat\s+karni\s+hai\b|\bpe\s+chalo\b/i;

const ACTION_PHRASE_PATTERN =
  /\b(?:book it|go ahead|show options|share (?:the )?pdf|show me options|let'?s book|confirm (?:it|the booking)|cancel (?:it|the booking))\b/i;
const ACTION_WORD_PATTERN = new RegExp(`^\\s*(?:${ACTION_VERBS.join("|")})(?:\\s+it)?[.!\\s]*$`, "i");

const ACKNOWLEDGEMENT_PHRASE_PATTERN =
  /\b(?:sounds good|looks good|works for me|that works|got it|thank you)\b/i;
const ACKNOWLEDGEMENT_WORD_PATTERN = new RegExp(`^\\s*(?:${ACKNOWLEDGEMENT_WORDS.join("|")})[.!\\s]*$`, "i");

// Coarse "this looks like it's carrying data" signal for the INFORMATION fallback: digits, currency
// symbols/codes, or a capitalized word (a plausible place/proper name) all suggest slot-shaped content
// rather than idle chatter.
const SLOT_SHAPED_PATTERN = /\d|[$₹€]|\b(?:usd|inr|eur|gbp|aed)\b|\b[A-Z][a-z]{2,}\b/;

function result(
  semantic: UserInputSemantic,
  confidence: InputSemanticResult["confidence"],
  reason: string
): InputSemanticResult {
  return { semantic, confidence, reason };
}

export function classifyUserInput(text: string, context: InputSemanticContext): InputSemanticResult {
  const trimmed = text.trim();
  if (!trimmed) return result("UNKNOWN", "LOW", "empty message");

  if (FAREWELL_PHRASE_PATTERN.test(trimmed) || FAREWELL_WORD_PATTERN.test(trimmed))
    return result("FAREWELL", "HIGH", "closing phrase");

  if (REJECTION_PHRASE_PATTERN.test(trimmed) || REJECTION_WORD_PATTERN.test(trimmed))
    return result("REJECTION", "HIGH", "decline phrase");

  if (CORRECTION_MARKER_PATTERN.test(trimmed))
    return result("CORRECTION", "HIGH", "correction marker");

  if (DOMAIN_PIVOT_PATTERN.test(trimmed))
    return result("DOMAIN_PIVOT", "MEDIUM", "explicit pivot language");

  if (ACKNOWLEDGEMENT_PHRASE_PATTERN.test(trimmed) || ACKNOWLEDGEMENT_WORD_PATTERN.test(trimmed))
    return result("ACKNOWLEDGEMENT", "HIGH", "affirmative filler");

  if (ACTION_PHRASE_PATTERN.test(trimmed) || ACTION_WORD_PATTERN.test(trimmed))
    return result("ACTION", "HIGH", "command verb");

  const looksSlotShaped =
    SLOT_SHAPED_PATTERN.test(trimmed) ||
    (context.knownValueWords ?? []).some((word) => trimmed.toLowerCase().includes(word.toLowerCase()));

  if (context.hasPendingQuestion && (looksSlotShaped || trimmed.split(/\s+/).length <= 4))
    return result("ANSWER", "MEDIUM", "reply to pending question");

  if (looksSlotShaped) return result("INFORMATION", "MEDIUM", "slot-shaped content");

  return result("UNKNOWN", "LOW", "no confident signal");
}
