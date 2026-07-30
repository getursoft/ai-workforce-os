/**
 * Deterministic, non-LLM classification of an explicit "yes, proceed" reply to the BOOKING_HANDOFF
 * confirmation question. Intentionally narrow — an ambiguous reply is treated as NOT confirmed so the
 * workflow asks again rather than guessing at consent for saving a booking request.
 */
const AFFIRMATIVE_PATTERN =
  /^\s*(?:yes|yeah|yep|yup|confirm(?:ed)?|go\s*ahead|please\s*proceed|proceed|sure|ok|okay)\b/i;

const NEGATIVE_PATTERN = /^\s*(?:no|nope|not\s*now|don'?t|do\s*not)\b/i;

export function isExplicitBookingConfirmation(text: string): boolean {
  return AFFIRMATIVE_PATTERN.test(text.trim()) && !NEGATIVE_PATTERN.test(text.trim());
}
