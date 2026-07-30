/**
 * Deterministic validation for an Indian mobile number (Stage 9B). Indian mobile numbers are 10 digits
 * starting with 6, 7, 8, or 9 (TRAI numbering plan) — a standalone rule, distinct from the generic
 * cross-domain E.164-shaped check in conversation/conversation-completion.ts's normalizePhoneNumber,
 * which is deliberately broader (7-15 digits, any leading digit) and not usable to positively confirm
 * "this is a valid Indian mobile number".
 */
const INDIAN_MOBILE_PATTERN = /^[6-9]\d{9}$/;
const PHONE_CANDIDATE_PATTERN = /\+?[\d][\d\s\-().]{5,18}\d/g;

export interface PhoneValidationResult {
  valid: boolean;
  /** The 10-digit form with no country code, spaces, or punctuation — null unless valid. */
  normalized: string | null;
}

/**
 * Validates a single candidate string as an Indian mobile number. Strips spaces/dashes/parentheses and
 * an optional leading country code (+91, 0091, or a bare 91/0 prefix) before checking the remaining
 * digits. Never fabricates a country code onto the stored/displayed value — the normalized form is
 * always the plain 10-digit number the user is expected to recognize as their own.
 */
export function validateIndianMobileNumber(raw: string): PhoneValidationResult {
  const stripped = raw.trim().replace(/[\s\-().]/g, "");
  const withoutCountryCode = stripped
    .replace(/^\+91(?=\d{10}$)/, "")
    .replace(/^0091(?=\d{10}$)/, "")
    .replace(/^91(?=\d{10}$)/, "")
    .replace(/^0(?=\d{10}$)/, "");
  if (!INDIAN_MOBILE_PATTERN.test(withoutCountryCode)) return { valid: false, normalized: null };
  return { valid: true, normalized: withoutCountryCode };
}

/**
 * Extracts the first valid Indian mobile number found anywhere in a free-text turn (e.g. "my number is
 * 8380031193"), so a reply doesn't have to be nothing but the digits to be recognized. Returns null if
 * no candidate substring validates.
 */
export function extractIndianMobileNumber(text: string): PhoneValidationResult {
  const direct = validateIndianMobileNumber(text);
  if (direct.valid) return direct;
  for (const candidate of text.match(PHONE_CANDIDATE_PATTERN) ?? []) {
    const result = validateIndianMobileNumber(candidate);
    if (result.valid) return result;
  }
  return { valid: false, normalized: null };
}
