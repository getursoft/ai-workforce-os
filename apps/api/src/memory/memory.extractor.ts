import type { ExtractedMemory, MemoryExtractionRule } from "./memory.types";

/**
 * Sprint 4.5: configurable, deterministic memory extraction rules.
 *
 * When a user says "Remember that I prefer vegetarian food", "My preferred airline is Emirates",
 * "I live in Bangalore", "My passport expires in 2029", the platform automatically stores the fact as
 * a USER-scoped memory without any AI Employee carrying custom memory code. Rules are plain data, so a
 * future LLM-based extraction pass can be added alongside them (source: LLM_EXTRACTION) without
 * touching this file's contract.
 */

const DEFAULT_IMPORTANCE = "HIGH" as const;

/** Normalizes a captured group into a clean, single-space value. */
function cleaned(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/^[.\-,\s]+|[.\-,\s]+$/g, "");
}

function titleCase(value: string): string {
  return cleaned(value)
    .split(/\s+/)
    .map((word) => {
      const first = word.charAt(0);
      return word.length > 1 && first ? first.toUpperCase() + word.slice(1) : word;
    })
    .join(" ");
}

/** Builds a USER-scoped extracted memory from a rule + captured value. */
function memory(
  rule: MemoryExtractionRule,
  value: string | number | boolean
): ExtractedMemory | null {
  const trimmed = typeof value === "string" ? value.trim() : value;
  if (typeof trimmed === "string" && trimmed.length < 1) return null;
  return {
    key: rule.key,
    category: rule.category,
    value: typeof trimmed === "string" ? titleCase(trimmed) : trimmed,
    importance: rule.importance,
    confidence: rule.confidence,
    source: rule.source,
    scope: "USER"
  };
}

/**
 * The rule table. Order matters: more specific rules run first and later rules never override an
 * earlier successful extraction for the same fact (see `extractMemories`). `extract` is declared with
 * method shorthand so `this` is bound to the rule itself.
 */
export const MEMORY_EXTRACTION_RULES: readonly MemoryExtractionRule[] = [
  {
    id: "food.vegetarian",
    category: "PREFERENCE",
    key: "food.preference",
    importance: DEFAULT_IMPORTANCE,
    confidence: 0.99,
    source: "RULE_EXTRACTION",
    pattern:
      /\b(?:i\s+(?:am|'m)\s+(?:a\s+)?(?:pure\s+|strict\s+)?(vegetarian|vegan)|(?:i\s+)?(?:prefer|like|love|eat)\s+(?:vegetarian|vegan)\s+(?:food|meal|meals|options?|diet)?|remember\b.*\b(?:vegetarian|vegan)\b)/i,
    extract(_text, match) {
      return memory(this, match[1] ?? "Vegetarian");
    }
  },
  {
    id: "food.preference.generic",
    category: "PREFERENCE",
    key: "food.preference",
    importance: DEFAULT_IMPORTANCE,
    confidence: 0.9,
    source: "RULE_EXTRACTION",
    pattern: /\b(?:my\s+)?(?:food|meal|diet)\s+preference\s*(?:is|:)?\s*([a-z][a-z\s]{1,40})/i,
    extract(_text, match) {
      return match[1] ? memory(this, match[1]) : null;
    }
  },
  {
    id: "airline.preferred",
    category: "PREFERENCE",
    key: "preferred.airline",
    importance: DEFAULT_IMPORTANCE,
    confidence: 0.98,
    source: "RULE_EXTRACTION",
    pattern:
      /\b(?:my\s+)?preferred?\s+airline\s*(?:is|:)?\s*([a-z][a-z .'-]{1,40})|\b(?:i\s+)?fly\s+(?:with|on)\s+([a-z][a-z .'-]{1,40})|\b(?:i\s+)?prefer\s+(?:flying\s+)?([a-z][a-z .'-]{0,40}(?:\s+airlines?)?)\s+airlines?\b|\bremember\s+(?:that\s+)?(?:i\s+)?prefer\s+([a-z][a-z .'-]{1,40})(?=\s|$)/i,
    extract(_text, match) {
      const raw = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (!raw) return null;
      // Never capture a food/meal description as an airline ("prefer vegetarian food").
      if (/\b(?:vegetarian|vegan|veg|food|meal|diet|non-veg)\b/i.test(raw)) return null;
      return memory(this, raw);
    }
  },
  {
    id: "airline.frequentFlyer",
    category: "TRAVEL",
    key: "preferred.frequentFlyerNumber",
    importance: "MEDIUM",
    confidence: 0.9,
    source: "RULE_EXTRACTION",
    pattern: /\bfrequent\s+flyer\s+(?:number|no|id)?\s*(?:is|:)?\s*([a-z0-9-]{6,30})/i,
    extract(_text, match) {
      return match[1] ? memory(this, match[1].toUpperCase()) : null;
    }
  },
  {
    id: "seat.preference",
    category: "PREFERENCE",
    key: "seat.preference",
    importance: DEFAULT_IMPORTANCE,
    confidence: 0.97,
    source: "RULE_EXTRACTION",
    pattern:
      /\bseat\s+preference\s*(?:is|:)?\s*(window|aisle|middle)|\b(?:i\s+)?prefer\s+(?:a\s+)?(window|aisle|middle)\s+seat\b/i,
    extract(_text, match) {
      const value = match[1] ?? match[2];
      return value ? memory(this, `${value} seat`) : null;
    }
  },
  {
    id: "cabin.preference",
    category: "TRAVEL",
    key: "travel.cabin",
    importance: DEFAULT_IMPORTANCE,
    confidence: 0.95,
    source: "RULE_EXTRACTION",
    pattern:
      /\b(?:always\s+|prefer\s+(?:to\s+)?travel\s+)?(?:travel|fly)\s+(?:in\s+)?(business|economy|first)\s+class\b/i,
    extract(_text, match) {
      return match[1] ? memory(this, `${match[1]} class`) : null;
    }
  },
  {
    id: "hotel.preferred",
    category: "PREFERENCE",
    key: "preferred.hotel",
    importance: DEFAULT_IMPORTANCE,
    confidence: 0.9,
    source: "RULE_EXTRACTION",
    pattern: /\bpreferred\s+hotel\s*(?:is|:)?\s*([a-z][a-z .'-]{1,50})/i,
    extract(_text, match) {
      return match[1] ? memory(this, match[1]) : null;
    }
  },
  {
    id: "location.city",
    category: "PERSONAL",
    key: "location.city",
    importance: "MEDIUM",
    confidence: 0.92,
    source: "RULE_EXTRACTION",
    pattern:
      /\b(?:i\s+)?(?:live|reside|stay|am\s+based)\s+in\s+([a-z][a-z .'-]{2,40})|\bi(?:'m|'am)\s+(?:based\s+in|from)\s+([a-z][a-z .'-]{2,40})/i,
    extract(_text, match) {
      const value = match[1] ?? match[2];
      return value ? memory(this, value) : null;
    }
  },
  {
    id: "passport.expiry",
    category: "TRAVEL",
    key: "travel.passport.expiry",
    importance: DEFAULT_IMPORTANCE,
    confidence: 0.98,
    source: "RULE_EXTRACTION",
    pattern: /\bpassport\s+(?:expires|expiry)\s*(?:in|is|:)?\s*(\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i,
    extract(_text, match) {
      if (!match[1]) return null;
      const base = memory(this, match[1]);
      return base ? { ...base, metadata: { sensitive: true } } : null;
    }
  },
  {
    id: "gst.number",
    category: "FINANCE",
    key: "tax.gst",
    importance: DEFAULT_IMPORTANCE,
    confidence: 0.97,
    source: "RULE_EXTRACTION",
    pattern: /\b(?:my\s+)?gst\s+(?:number|no|in|identification)?\s*(?:is|:)?\s*([0-9a-z]{15})/i,
    extract(_text, match) {
      if (!match[1]) return null;
      const base = memory(this, match[1].toUpperCase());
      return base ? { ...base, metadata: { sensitive: true } } : null;
    }
  },
  {
    id: "payment.preferred",
    category: "FINANCE",
    key: "payment.preferred",
    importance: "MEDIUM",
    confidence: 0.9,
    source: "RULE_EXTRACTION",
    pattern: /\bpreferred\s+payment\s+(?:method|mode)?\s*(?:is|:)?\s*([a-z][a-z\s]{1,30})/i,
    extract(_text, match) {
      return match[1] ? memory(this, match[1]) : null;
    }
  },
  {
    id: "language.preferred",
    category: "PREFERENCE",
    key: "preferred.language",
    importance: "MEDIUM",
    confidence: 0.9,
    source: "RULE_EXTRACTION",
    pattern: /\bpreferred\s+language\s*(?:is|:)?\s*([a-z][a-z-]{1,20})/i,
    extract(_text, match) {
      return match[1] ? memory(this, match[1]) : null;
    }
  },
  {
    id: "contact.phone",
    category: "CONTACT",
    key: "contact.phone",
    importance: DEFAULT_IMPORTANCE,
    confidence: 0.95,
    source: "RULE_EXTRACTION",
    pattern:
      /\b(?:my\s+)?(?:phone|mobile|whatsapp|contact)\s+(?:number|no)?\s*(?:is|:)?\s*(\+?\d[\d\s()-]{8,18})/i,
    extract(_text, match) {
      if (!match[1]) return null;
      const base = memory(this, match[1].replace(/[\s()-]/g, ""));
      return base ? { ...base, metadata: { sensitive: true } } : null;
    }
  },
  {
    id: "contact.email",
    category: "CONTACT",
    key: "contact.email",
    importance: DEFAULT_IMPORTANCE,
    confidence: 0.95,
    source: "RULE_EXTRACTION",
    pattern: /\b(?:my\s+)?email\s+(?:address|id)?\s*(?:is|:)?\s*([\w.+-]+@[\w-]+\.[\w.-]{2,})/i,
    extract(_text, match) {
      if (!match[1]) return null;
      const base = memory(this, match[1]);
      return base ? { ...base, metadata: { sensitive: true } } : null;
    }
  },
  {
    id: "travel.currentHotel",
    category: "TRAVEL",
    key: "travel.current.hotel",
    importance: "MEDIUM",
    confidence: 0.9,
    source: "RULE_EXTRACTION",
    pattern: /\b(?:my\s+)?hotel\s+today\s*(?:is|:)?\s*([a-z][a-z .'-]{1,50})/i,
    extract(_text, match) {
      if (!match[1]) return null;
      const base = memory(this, match[1]);
      if (!base) return null;
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);
      return { ...base, scope: "CONVERSATION", expiresAt: endOfDay };
    }
  },
  {
    id: "trip.itinerary",
    category: "TRAVEL",
    key: "travel.trip.context",
    importance: "MEDIUM",
    confidence: 0.85,
    source: "RULE_EXTRACTION",
    pattern:
      /\b(?:i\s+(?:have\s+an?\s+|am\s+going\s+on\s+an?\s+|am\s+planning\s+an?\s+))?(?:upcoming\s+)?trip\s+to\s+([a-z][a-z .'-]{2,40})(?:\s+on\s+(\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}\s+\d{4}|\d{4}-\d{2}-\d{2}))?/i,
    extract(_text, match) {
      if (!match[1]) return null;
      const value = match[2] ? `${match[1].trim()} (${match[2].trim()})` : match[1].trim();
      const base = memory(this, value);
      if (!base) return null;
      const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
      return { ...base, scope: "CONVERSATION", expiresAt };
    }
  },
  {
    id: "generic.remember",
    category: "PREFERENCE",
    key: "preference.generic",
    importance: "MEDIUM",
    confidence: 0.8,
    source: "RULE_EXTRACTION",
    fallback: true,
    pattern: /\bremember\s+(?:that\s+)?(?:i\s+)?(?:prefer|like|love|use|want)\s+(.+)/i,
    extract(_text, match) {
      return match[1] ? memory(this, match[1]) : null;
    }
  }
];

const RULES_BY_ID = new Map(MEMORY_EXTRACTION_RULES.map((rule) => [rule.id, rule]));

/** Looks a rule up by id (used by tests + future config surfaces). */
export function memoryExtractionRule(id: string): MemoryExtractionRule | null {
  return RULES_BY_ID.get(id) ?? null;
}

/**
 * Runs every extraction rule against `text` and returns the distinct facts found. Rules run in table
 * order and a later rule never overrides an earlier extraction for the same (key, scope) pair — so a
 * generic "remember I prefer X" fallback never overwrites a precise airline/seat/food rule. The
 * fallback rule only fires when no specific rule matched the text at all.
 */
export function extractMemories(text: string): ExtractedMemory[] {
  if (!text?.trim()) return [];
  const seen = new Set<string>();
  const found: ExtractedMemory[] = [];
  let specificMatch = false;
  for (const rule of MEMORY_EXTRACTION_RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    const extracted = rule.extract(text, match);
    if (!extracted) continue;
    if (rule.fallback) continue;
    specificMatch = true;
    const signature = `${extracted.scope}:${extracted.key}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    found.push(extracted);
  }
  if (!specificMatch) {
    const fallback = MEMORY_EXTRACTION_RULES.find((rule) => rule.fallback);
    const match = fallback?.pattern.exec(text);
    const extracted = fallback && match ? fallback.extract(text, match) : null;
    if (extracted) found.push(extracted);
  }
  return found;
}

/** Whether the text looks like an explicit memory directive ("remember ...", "my X is ..."). */
export function looksLikeMemoryDirective(text: string): boolean {
  return /\bremember\b|\bpreferred\b|\bpreference\b|my\s+(?:passport|gst|seat|food|airline|hotel|payment|language|email|phone|mobile)/i.test(
    text
  );
}
