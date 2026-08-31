/**
 * Sprint 6.5 — Parts 4-6: platform-level identity capture.
 *
 * Before this module, name capture existed in two independently-drifted places: Travel's own
 * `looksLikeBareNameReply`/`NAME_INTRO_PATTERN`/`NAME_IM_PATTERN` (travel.runtime.ts) and the generic
 * domain engine's much weaker `extractEmployeeName` (employees/employee-runtime.ts, which had almost no
 * stopword guard at all — a bare "Yes"/"Ok"/"Great" would become the customer's name there). Identity is
 * a conversation/customer-level concept, not a Travel concept or a generic-employee concept, so it now
 * lives here once, and both runtimes — plus the Receptionist, for the *unprompted* case this sprint adds
 * (see receptionist.service.ts) — delegate to it.
 *
 * Two confidence tiers, matching Part 5's "do not implement `words <= 3` -> name" instruction:
 *  - HIGH: an explicit self-introduction construction ("I'm Krishna", "My name is Krishna", "This is
 *    Krishna", "Krishna here", "Call me Krishna"). Safe to accept even when nothing was asked.
 *  - LOW: a bare short reply that merely *looks* name-shaped (alphabetic, 1-3 words) AND matches none of
 *    a deliberately broad stopword/known-value exclusion list. Callers decide whether LOW confidence is
 *    strong enough for their context (e.g. only when a name question is genuinely pending, or — the new
 *    Part 4 case — when identity is still completely unknown and nothing else competes for the message).
 */

export type IdentityCaptureConfidence = "HIGH" | "LOW";

export interface IdentityCaptureResult {
  name: string;
  confidence: IdentityCaptureConfidence;
}

// Categorized word lists — Sprint 6.5 Part 3/34: split out of what used to be one flat stopword list so
// `input-semantics.ts` (the new `classifyUserInput` layer) can reuse the SAME vocabulary instead of
// re-deriving a second, drifting copy of "what counts as an acknowledgement/rejection/farewell/action
// word." `IDENTITY_STOPWORDS` below is still the exact same union it always was — this is a reorganization,
// not a behavior change, so `identity-capture.spec.ts` keeps passing unchanged.
export const GREETING_WORDS = ["hi", "hello", "hey"] as const;
export const FAREWELL_WORDS = ["bye", "goodbye"] as const;
export const ACKNOWLEDGEMENT_WORDS = [
  "yes",
  "ok",
  "okay",
  "sure",
  "fine",
  "great",
  "got",
  "good",
  "looks",
  "perfect",
  "cool",
  "nice",
  "alright",
  "right",
  "correct",
  "yeah",
  "yep",
  "yup",
  "done",
  "thanks",
  "thank",
  "you",
  "later",
  // Hindi/Hinglish affirmatives
  "haan",
  "ji",
  "theek",
  "achha"
] as const;
export const REJECTION_WORDS = ["no", "nope", "not", "wrong", "now", "nahi"] as const;
export const ACTION_VERBS = [
  "book",
  "show",
  "options",
  "option",
  "share",
  "pdf",
  "confirm",
  "confirmed",
  "cancel",
  "proceed",
  "continue",
  "start",
  "stop",
  "skip",
  "back",
  "menu",
  "ahead",
  "help",
  "check",
  "review",
  // Hindi/Hinglish imperatives ("kar do" / "kijiye" = "go ahead and do it")
  "kar",
  "kijiye"
] as const;
export const CORRECTION_MARKER_WORDS = ["actually", "instead", "change", "make", "sorry", "meant"] as const;
// Sprint 6.5 — Part 4/6: identity is now PLATFORM-level, not Travel-specific, so the stopword list must
// cover every employee's ordinary request vocabulary, not just Travel's — "check this invoice"/"review
// this contract" are exactly 3 words each and would otherwise pass the bare-name length check.
export const CROSS_DOMAIN_NOUN_WORDS = [
  "invoice",
  "contract",
  "order",
  "campaign",
  "quote",
  "leave",
  "vpn"
] as const;

// Every word/short-phrase that must never be mistaken for a name: acknowledgements, declines, farewells,
// action/command verbs, trip vocabulary, dates, currencies, and known regressions from prior sprints
// ("share it here", "share the pdf", "no thanks", "looks good", "book it", "show options" — Sprint 6.3/6.4
// — plus "Great"/"Got it", the gap this sprint's own live UAT would otherwise reopen). One list, so a gap
// found in any one context (Travel, a generic employee, the Receptionist) is fixed for all three at once.
export const IDENTITY_STOPWORDS = new Set([
  ...GREETING_WORDS,
  ...FAREWELL_WORDS,
  ...ACKNOWLEDGEMENT_WORDS,
  ...REJECTION_WORDS,
  ...ACTION_VERBS,
  ...CORRECTION_MARKER_WORDS,
  ...CROSS_DOMAIN_NOUN_WORDS,
  // remaining acknowledgement/filler words not needed as their own category
  "it",
  "this",
  "wait",
  "maybe",
  "please",
  "next",
  // months / weekdays / time-of-day
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
  "december",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "morning",
  "evening",
  "afternoon",
  "night",
  "noon",
  "today",
  "tomorrow",
  "week",
  "weekend",
  "month",
  // currency
  "usd",
  "inr",
  "eur",
  "gbp",
  "aed",
  "dollars",
  "rupees",
  "euros",
  "pounds",
  "dirhams",
  // trip / booking vocabulary
  "business",
  "economy",
  "first",
  "premium",
  "flight",
  "flights",
  "hotel",
  "hotels",
  "budget",
  "adult",
  "adults",
  "child",
  "children",
  "infant",
  "infants",
  "domestic",
  "international",
  "solo",
  "couple",
  "family",
  "friends",
  "group",
  // Hindi/Hinglish equivalents not already covered by the category exports above
  "bhi",
  "abhi",
  "dhanyavad"
]);

// A slightly wider list used only to decide where a multi-word capture from an explicit intro pattern
// ENDS — "My name is Krishna and I want to visit Delhi" must yield "Krishna", not "Krishna and I".
const IDENTITY_TRIM_STOPWORDS = new Set([
  ...IDENTITY_STOPWORDS,
  "and",
  "but",
  "or",
  "so",
  "because",
  "who",
  "which",
  "that",
  "to",
  "for",
  "from",
  "is",
  "am",
  "are",
  "was",
  "i",
  "my",
  "want",
  "wants",
  "wanting",
  "need",
  "needs",
  "needing",
  "looking",
  "travelling",
  "traveling",
  "here",
  "planning",
  // Hindi copula ("mera naam Krishna hai" = "my name is Krishna") — without these, "Krishna hai" is
  // captured as a two-word name instead of trimming at the copula the same way "is"/"am"/"are" already do.
  "hai",
  "hain",
  "ho"
]);

const IDENTITY_INTRO_PATTERN =
  /\b(?:my name is|i am called|call me|this is|naam)\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,2})/i;
// "I'm X" / "I am X" is only a name when X isn't a verb/adjective continuing the sentence
// ("I'm planning...", "I'm interested...").
const IDENTITY_IM_PATTERN = /\bi\s*(?:'m|am)\s+([A-Za-z][A-Za-z'-]*)\b/i;
const IDENTITY_IM_NON_MATCHES = new Set([
  "planning",
  "looking",
  "trying",
  "going",
  "interested",
  "not",
  "sure",
  "happy",
  "excited",
  "travelling",
  "traveling",
  "here",
  "back",
  "new",
  "done",
  "ready",
  "thinking",
  "wondering",
  "flexible",
  "open",
  "still"
]);
// "Krishna here" / "John here" — the trigger word comes AFTER the name. Anchored to the whole message (not
// just found anywhere in it) to keep this narrow: "share it here" must never match (and doesn't — "share"
// and "it" are both in IDENTITY_STOPWORDS, checked below).
const IDENTITY_HERE_PATTERN = /^\s*([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,1})\s+here\s*[.!]?\s*$/i;

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((word) => (word.length ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(" ");
}

function wordsClear(candidate: string, knownValueWords: readonly string[]): boolean {
  const words = candidate.trim().split(/\s+/);
  if (words.some((word) => IDENTITY_STOPWORDS.has(word.toLowerCase()))) return false;
  if (words.some((word) => knownValueWords.includes(word.toLowerCase()))) return false;
  return true;
}

/** Truncates a raw regex name capture at the first word that isn't actually part of the name. */
function trimIdentityCapture(raw: string): string {
  const words = raw.trim().split(/\s+/);
  const kept: string[] = [];
  for (const word of words) {
    if (IDENTITY_TRIM_STOPWORDS.has(word.toLowerCase())) break;
    kept.push(word);
  }
  return (kept.length ? kept : words.slice(0, 1)).join(" ");
}

/**
 * A bare 1-3 word alphabetic reply (no digits, no trip/date/currency/acknowledgement vocabulary, not a
 * known destination/value word) — LOW confidence: name-shaped, but with nothing explicit backing it up.
 */
function classifyBareNameCandidate(
  message: string,
  knownValueWords: readonly string[]
): string | null {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 40) return null;
  if (!/^[A-Za-z][A-Za-z'-]*(\s+[A-Za-z][A-Za-z'-]*){0,2}$/.test(trimmed)) return null;
  if (!wordsClear(trimmed, knownValueWords)) return null;
  return titleCase(trimmed);
}

/**
 * The single entry point every identity-capture call site should use. Checked in order of confidence:
 * explicit self-introduction constructions (HIGH) before a bare name-shaped reply (LOW). `knownValueWords`
 * lets a caller pass in domain-specific exclusions (e.g. Travel's `KNOWN_DESTINATIONS`) on top of the
 * shared stopword list — never the other way around, so the base vocabulary never has to be duplicated.
 */
export function classifyIdentityCandidate(
  text: string,
  options: { knownValueWords?: readonly string[] } = {}
): IdentityCaptureResult | null {
  const knownValueWords = options.knownValueWords ?? [];

  const intro = IDENTITY_INTRO_PATTERN.exec(text);
  if (intro?.[1]) {
    const trimmed = trimIdentityCapture(intro[1]);
    if (trimmed && wordsClear(trimmed, knownValueWords))
      return { name: titleCase(trimmed), confidence: "HIGH" };
  }

  const im = IDENTITY_IM_PATTERN.exec(text);
  const imCandidate = im?.[1]?.trim();
  if (
    imCandidate &&
    !IDENTITY_IM_NON_MATCHES.has(imCandidate.toLowerCase()) &&
    wordsClear(imCandidate, knownValueWords)
  )
    return { name: titleCase(imCandidate), confidence: "HIGH" };

  const here = IDENTITY_HERE_PATTERN.exec(text);
  if (here?.[1] && wordsClear(here[1], knownValueWords))
    return { name: titleCase(here[1]), confidence: "HIGH" };

  const bare = classifyBareNameCandidate(text, knownValueWords);
  if (bare) return { name: bare, confidence: "LOW" };

  return null;
}
