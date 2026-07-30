/**
 * Conversation Completion & Lead Capture — platform-level, employee-agnostic framework (no NestJS DI, no
 * employee-domain imports) so any current or future AI Employee (Travel, Sales, Hospital, HR, Insurance,
 * ...) can plug in the same proactive "offer -> consent -> contact -> persisted record" flow without
 * duplicating the state machine, phone validation, or consent-detection logic. `travel.runtime.ts` is its
 * first consumer: it owns the actual `TravelLead` persistence shape and the localized message text, and
 * only calls into this module for the domain-agnostic mechanics. A future employee follows the same split
 * — its own lead/record model and message copy, this module's stage type, consent detection, phone
 * validation, and reference generator.
 */

/**
 * Where a single conversation is in the completion flow:
 * - NOT_OFFERED: no offer has been made yet (or the trip/task isn't ready for one).
 * - OFFERED: the assistant just asked "would you like to submit this...", awaiting a yes/no.
 * - AWAITING_CONTACT: the customer said yes; the assistant is waiting for a valid phone number.
 * - CAPTURED: a lead/record was persisted for this conversation — never offered again.
 * - DECLINED: the customer said no — normal conversation continues, and the offer is never repeated.
 */
export type ConversationCompletionStage = "NOT_OFFERED" | "OFFERED" | "AWAITING_CONTACT" | "CAPTURED" | "DECLINED";

/** One item in a Goal Engine's context-aware "what next" menu — deliberately just a label: which actions
 * are relevant is entirely domain knowledge the calling employee owns. */
export interface SuggestedAction {
  label: string;
}

/** Renders a suggested-actions list the way a helpful human consultant would offer them — a short,
 * optional aside, never a form. Returns "" (nothing to append) when there are no suggestions. */
export function formatSuggestedActions(actions: readonly SuggestedAction[], heading = "You might also like:"): string {
  if (!actions.length) return "";
  return ["", heading, ...actions.map((action) => `• ${action.label}`)].join("\n");
}

// Deliberately plain, everyday consent words — not booking/domain-specific vocabulary (that stays with
// whatever confirmation pattern the calling employee already uses for its own domain actions), so this
// stays reusable for a "submit this appointment request?" or "file this claim?" style offer too.
const AFFIRMATIVE_PATTERN = /\b(yes|yeah|yep|yup|sure|ok(?:ay)?|please\s+do|go\s+ahead|sounds?\s+good|why\s+not|do\s+it|submit\s+it|haan|ji\s+han)\b/i;
const NEGATIVE_PATTERN = /\b(no|nah|nope|not\s+(?:now|yet|really|interested)|maybe\s+later|skip|don'?t|never\s?mind|nahi)\b/i;

/** True only when the reply reads as a clear "yes" and not also a "no" (e.g. "no thanks" never counts as
 * affirmative even though "thanks" alone would). */
export function isAffirmativeResponse(text: string): boolean {
  return AFFIRMATIVE_PATTERN.test(text) && !NEGATIVE_PATTERN.test(text);
}

/** True only when the reply reads as a clear "no" and not also a "yes". */
export function isNegativeResponse(text: string): boolean {
  return NEGATIVE_PATTERN.test(text) && !AFFIRMATIVE_PATTERN.test(text);
}

// Accepts a leading "+" (E.164-style) or a bare national number; 7-15 digits total covers every real
// national numbering plan (ITU-T E.164's own bound) without hard-coding any specific country's format.
const PHONE_CANDIDATE_PATTERN = /\+?[\d][\d\s\-().]{5,18}\d/g;
const PHONE_SHAPE_PATTERN = /^\+?[1-9]\d{6,14}$/;

/** Normalizes a single free-text phone candidate (strips spaces/dashes/parens/dots) and validates its
 * shape. Returns null — never a guess — when it doesn't look like a real phone number. Never fabricates a
 * leading "+": a national number typed without a country code is stored exactly as given. */
export function normalizePhoneNumber(raw: string): string | null {
  const cleaned = raw.trim().replace(/[\s\-().]/g, "");
  return PHONE_SHAPE_PATTERN.test(cleaned) ? cleaned : null;
}

/** Finds and normalizes the first plausible phone number anywhere in free text — e.g. "it's +91 98765
 * 43210, thanks" -> "+919876543210". Returns null when nothing in the message looks like a real number, so
 * callers never mistake an unrelated number (a budget, a date) for a phone number. */
export function extractPhoneNumber(text: string): string | null {
  for (const candidate of text.match(PHONE_CANDIDATE_PATTERN) ?? []) {
    const normalized = normalizePhoneNumber(candidate);
    if (normalized) return normalized;
  }
  return null;
}

/** Generates a short, human-readable reference for a newly captured lead/record — e.g.
 * `generateLeadReference("TRV")` -> "TRV-4F2B91". Uniqueness is enforced by the caller's own storage (a
 * unique constraint on the reference column), not by this generator alone. */
export function generateLeadReference(prefix: string): string {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, "0");
  return `${prefix}-${suffix}`;
}
