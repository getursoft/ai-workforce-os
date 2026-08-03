/**
 * Sprint 4.7 Phase 24: the ONLY path through which values reach ExecutionTrace.metadataJson,
 * ExecutionSpan.attributesJson/inputSummaryJson/outputSummaryJson, or ObservabilityAlert.detailsJson.
 * ObservabilityService calls this on every write — nothing else in the codebase should write raw values
 * into those columns directly. Defense in depth: both key-name matching (catches known-sensitive fields
 * regardless of value shape) and value-pattern matching (catches secrets/tokens/PII even under an
 * unexpected or attacker-chosen key name, e.g. a malicious tool result trying to smuggle a fake
 * "harmless" key holding a real credential).
 */

const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passwd|api[_-]?key|apikey|authorization|auth[_-]?header|access[_-]?key|private[_-]?key|credential|cvv|cvc|card[_-]?number|cardnumber|pan\b|ssn|social[_-]?security|passport|national[_-]?id|iban|routing[_-]?number|account[_-]?number|prompt|systemprompt|system_prompt|instructions|rawtext|raw_text|documentcontent|document_content|fileContent|file_content)/i;

const PHONE_KEY_PATTERN = /phone|mobile|whatsapp/i;
const EMAIL_KEY_PATTERN = /email/i;

/** Matches things that look like a secret/token by shape alone, independent of the key name they're under. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^Bearer\s+\S+/i,
  /^sk-[A-Za-z0-9_-]{10,}/, // covers sk-xxxx and multi-segment forms like sk-live-xxxx / sk-proj-xxxx
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, // JWT shape
  /^[A-Fa-f0-9]{32,}$/, // long hex (API keys, hashes, session tokens)
  /^[A-Za-z0-9+/]{40,}={0,2}$/ // long base64
];

/**
 * Sprint 4.7A Phase 14: SECRET_VALUE_PATTERNS above are anchored (^/$) — correct for a dedicated field
 * whose ENTIRE value is expected to be a secret (e.g. `accessToken: "sk-..."`), but useless against a
 * secret embedded mid-sentence inside free text (e.g. a chat message: "remember my key sk-live-abc123
 * please"), which is exactly what AgentService's span `inputSummary.message` preview carries via
 * summarizeText(). These non-anchored variants find and scrub a secret-shaped SUBSTRING anywhere in a
 * string without discarding the surrounding text (unlike looksLikeSecret's all-or-nothing redaction).
 */
const EMBEDDED_SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+\S+/gi,
  /sk-[A-Za-z0-9_-]{10,}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g
];

function redactEmbeddedSecrets(value: string): string {
  let result = value;
  for (const pattern of EMBEDDED_SECRET_PATTERNS) result = result.replace(pattern, REDACTED);
  return result;
}

const MAX_STRING_LENGTH = 400;
const MAX_ARRAY_ITEMS = 20;
const MAX_DEPTH = 4;
const MAX_KEYS = 40;

export const REDACTED = "[REDACTED]";
export const TRUNCATED_SUFFIX = "…[TRUNCATED]";

/** Masks a phone number to only its last 2 digits — enough to disambiguate in an operator's trace list
 *  without exposing the full number. */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length <= 2) return "*".repeat(digits.length);
  return `${"*".repeat(Math.max(digits.length - 2, 0))}${digits.slice(-2)}`;
}

function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return REDACTED;
  const local = value.slice(0, at);
  return `${local.slice(0, 1)}${"*".repeat(Math.max(local.length - 1, 1))}@${value.slice(at + 1)}`;
}

function looksLikeSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

function sanitizeString(key: string | null, value: string): string {
  if (key && PHONE_KEY_PATTERN.test(key) && /\d{5,}/.test(value)) return maskPhone(value);
  if (key && EMAIL_KEY_PATTERN.test(key)) return maskEmail(value);
  if (looksLikeSecret(value)) return REDACTED;
  const scrubbed = redactEmbeddedSecrets(value);
  if (scrubbed.length > MAX_STRING_LENGTH) return `${scrubbed.slice(0, MAX_STRING_LENGTH)}${TRUNCATED_SUFFIX}`;
  return scrubbed;
}

function sanitizeValue(key: string | null, value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  // Numbers/booleans can never themselves be a leaked credential — only gate on key name for string and
  // object/array values, so a legitimate numeric field like inputTokens/outputTokens/totalTokens (whose
  // name happens to contain "token") is never redacted just because of that substring collision.
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (key && SENSITIVE_KEY_PATTERN.test(key)) return REDACTED;
  if (typeof value === "string") return sanitizeString(key, value);
  if (depth >= MAX_DEPTH) return "[MAX_DEPTH_EXCEEDED]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(null, item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`…and ${value.length - MAX_ARRAY_ITEMS} more`);
    return items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS);
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sanitizeValue(k, v, depth + 1);
    if (Object.keys(value as Record<string, unknown>).length > MAX_KEYS) out.__truncatedKeys = true;
    return out;
  }
  return "[UNSUPPORTED_TYPE]";
}

/** Sanitizes an arbitrary value (span attributes, input/output summaries, alert details, trace metadata)
 *  before it is ever persisted. Safe to call with `undefined`/`null`. */
export function sanitizeForTrace<T>(value: T): T {
  if (value === undefined) return value;
  return sanitizeValue(null, value, 0) as T;
}

/** Builds a length/shape-only summary of free text (a user message, a prompt, a document) — the summary
 *  never contains the actual content, only facts safe to display in a trace: length and a content hash
 *  short enough to compare "same input" across traces without reconstructing the input. */
export function summarizeText(text: string | null | undefined): { length: number; preview: string } | null {
  if (text === null || text === undefined) return null;
  const preview = text.length > 60 ? `${text.slice(0, 60)}${TRUNCATED_SUFFIX}` : text;
  return { length: text.length, preview: sanitizeString(null, preview) };
}
