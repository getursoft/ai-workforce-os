/**
 * Currency Service — deliberately standalone (no NestJS DI, no travel-domain imports) so any current or
 * future AI Employee (Travel, Hospital, HR, Sales, ...) can reuse it for money detection/conversion/
 * formatting without pulling in travel-specific code. `travel.runtime.ts` is its first consumer, wired
 * in as a thin delegation layer that preserves its existing exported function signatures.
 */

export type CurrencyCode =
  "USD" | "INR" | "EUR" | "GBP" | "AED" | "THB" | "SGD" | "CAD" | "AUD" | "JPY";

export const SUPPORTED_CURRENCIES: readonly CurrencyCode[] = [
  "USD",
  "INR",
  "EUR",
  "GBP",
  "AED",
  "THB",
  "SGD",
  "CAD",
  "AUD",
  "JPY"
];

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(code.toUpperCase());
}

/**
 * Exchange-rate source, abstracted so the deterministic fallback below can later be replaced by a real
 * FX API-backed provider with no change to `CurrencyService` or any of its callers — just construct
 * `CurrencyService` with a different provider.
 */
export interface ExchangeRateProvider {
  /** Units of `currency` per 1 USD. Must return a finite, positive rate for every entry in
   * `SUPPORTED_CURRENCIES`. */
  getRatePerUsd(currency: CurrencyCode): number;
}

/**
 * Deterministic, documented placeholder rates (units per 1 USD) — never a live feed, consistent with the
 * rest of the Travel Employee's placeholder pricing engine. This is the default provider so conversion
 * always works even with no real FX API configured; a real provider is a drop-in replacement (same
 * `ExchangeRateProvider` interface), not a rewrite.
 */
export class DeterministicFallbackExchangeRateProvider implements ExchangeRateProvider {
  private static readonly RATES_PER_USD: Record<CurrencyCode, number> = {
    USD: 1,
    INR: 83,
    EUR: 0.92,
    GBP: 0.79,
    AED: 3.67,
    THB: 36,
    SGD: 1.35,
    CAD: 1.36,
    AUD: 1.52,
    JPY: 157
  };

  getRatePerUsd(currency: CurrencyCode): number {
    return DeterministicFallbackExchangeRateProvider.RATES_PER_USD[currency];
  }
}

const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  USD: "$",
  INR: "₹",
  EUR: "€",
  GBP: "£",
  AED: "AED ",
  THB: "฿",
  SGD: "S$",
  CAD: "C$",
  AUD: "A$",
  JPY: "¥"
};

/** Currencies conventionally quoted without minor units — amounts are always whole numbers. */
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<CurrencyCode> = new Set(["JPY"]);

/**
 * Free-text token -> currency code, used by the preference detector. Multi-word names are matched ahead of
 * their single-word suffix (e.g. "singapore dollars" before "dollars") so a qualified name is never
 * mis-read as plain USD. Deliberately a small, explicit vocabulary (not a business-name list) so it stays
 * domain-agnostic and free of false positives.
 */
const CURRENCY_TOKENS: ReadonlyArray<{ pattern: string; code: CurrencyCode }> = [
  // Multi-word names first (longest match wins).
  { pattern: "us dollars?", code: "USD" },
  { pattern: "singapore dollars?", code: "SGD" },
  { pattern: "canadian dollars?", code: "CAD" },
  { pattern: "australian dollars?", code: "AUD" },
  { pattern: "aussie dollars?", code: "AUD" },
  // ISO codes.
  { pattern: "usd", code: "USD" },
  { pattern: "inr", code: "INR" },
  { pattern: "eur", code: "EUR" },
  { pattern: "gbp", code: "GBP" },
  { pattern: "aed", code: "AED" },
  { pattern: "thb", code: "THB" },
  { pattern: "sgd", code: "SGD" },
  { pattern: "cad", code: "CAD" },
  { pattern: "aud", code: "AUD" },
  { pattern: "jpy", code: "JPY" },
  // Common single-word names.
  { pattern: "dollars?", code: "USD" },
  { pattern: "rupees?", code: "INR" },
  { pattern: "euros?", code: "EUR" },
  { pattern: "pounds?", code: "GBP" },
  { pattern: "sterling", code: "GBP" },
  { pattern: "dirhams?", code: "AED" },
  { pattern: "baht", code: "THB" },
  { pattern: "yen", code: "JPY" }
];

/**
 * Currency-shaped tokens we recognize but do NOT support — so a request like "show in ZWL" / "in yuan"
 * produces a clear "not supported" answer instead of being silently ignored (which is what looped in UAT).
 * Kept explicit (not "any 3 letters") so a place/word like "NYC" is never mistaken for a currency.
 */
const KNOWN_UNSUPPORTED_CURRENCY_TOKENS: ReadonlyArray<string> = [
  "cny",
  "rmb",
  "yuan",
  "renminbi",
  "krw",
  "won",
  "chf",
  "francs?",
  "mxn",
  "pesos?",
  "brl",
  "reais",
  "myr",
  "ringgit",
  "rub",
  "roubles?",
  "rubles?",
  "zar",
  "rand",
  "zwl",
  "ngn",
  "naira",
  "idr",
  "rupiah",
  "php",
  "hkd",
  "nzd",
  "kwd",
  "sar",
  "riyals?",
  "qar",
  "bhd",
  "omr",
  "try",
  "lira",
  "kes",
  "shilling",
  "bdt",
  "taka",
  "lkr"
];

const SUPPORTED_TOKEN_ALTERNATION = CURRENCY_TOKENS.map((entry) => entry.pattern).join("|");
const UNSUPPORTED_TOKEN_ALTERNATION = KNOWN_UNSUPPORTED_CURRENCY_TOKENS.join("|");
// Whole-message forms (after trimming): a bare currency token, optionally prefixed by "in"/"as" and
// followed by a light politeness/filler word — e.g. "usd", "USD.", "in dollars", "rupees please".
const BARE_CURRENCY_PATTERN = new RegExp(
  `^\\s*(?:in\\s+|as\\s+)?(?:the\\s+)?(${SUPPORTED_TOKEN_ALTERNATION})\\b\\.?\\s*(?:please|pls|thanks?|thank\\s+you|now)?\\.?\\s*$`,
  "i"
);
const BARE_UNSUPPORTED_PATTERN = new RegExp(
  `^\\s*(?:in\\s+|as\\s+)?(?:the\\s+)?(${UNSUPPORTED_TOKEN_ALTERNATION})\\b\\.?\\s*(?:please|pls|thanks?|thank\\s+you|now)?\\.?\\s*$`,
  "i"
);
// A verb/cue that signals the user wants amounts DISPLAYED/CONVERTED in a currency (never a budget set).
// "need"/"budget" are cues too (e.g. "I need in AED", "budget in AED") — both stay safe against
// misreading a real budget amount ("I need 5000 AED", "budget of 5000 AED") because the pattern below
// still requires an explicit "in/to/into/as" preposition immediately before a BARE currency token, with
// no number in between; a stated amount always breaks that adjacency.
const CHANGE_CUE =
  "share|sharing|show|showing|shown|give|giving|tell|told|display|displaying|quote|quoting|convert|converting|converted|estimate|reflect|reflecting|switch|switching|change|changing|see|view|render|price|prices|priced|cost|costs|costed|report|express|breakdown|total|totals|need|needing|needs|budget";
// "<cue> ... (in|to|into|as) <currency>" — up to a handful of filler words between the cue and the
// preposition, and between the preposition and the currency.
const CUED_SUPPORTED_PATTERN = new RegExp(
  `\\b(?:${CHANGE_CUE})\\b(?:\\s+\\w+){0,6}?\\s+(?:in|into|to|as)\\s+(?:the\\s+)?(${SUPPORTED_TOKEN_ALTERNATION})\\b`,
  "i"
);
const CUED_UNSUPPORTED_PATTERN = new RegExp(
  `\\b(?:${CHANGE_CUE})\\b(?:\\s+\\w+){0,6}?\\s+(?:in|into|to|as)\\s+(?:the\\s+)?(${UNSUPPORTED_TOKEN_ALTERNATION})\\b`,
  "i"
);
// Hindi/Hinglish trailing form: "<currency> me/mein batao/btao/dikhao/dikhaao/bata do".
// Note the common abbreviated spellings ("btao", "bta do") that real users type.
const HINGLISH_CURRENCY_PATTERN = new RegExp(
  `\\b(${SUPPORTED_TOKEN_ALTERNATION})\\s+me(?:in)?\\s+(?:batao|bata\\s*o|btao|bta\\s*(?:o|do|de)|dikhao|dikhaao|dikha\\s*do|convert\\s+kar\\s*(?:o|do))\\b`,
  "i"
);

function resolveTokenToCode(raw: string): CurrencyCode | null {
  const token = raw.trim().toLowerCase();
  for (const entry of CURRENCY_TOKENS) {
    if (new RegExp(`^(?:${entry.pattern})$`, "i").test(token)) return entry.code;
  }
  return null;
}

/** The outcome of {@link CurrencyService.detectPreference}: a supported target, a recognized-but-
 * unsupported currency (so the caller can explain rather than loop), or null (no currency request). */
export type CurrencyPreference =
  { kind: "SUPPORTED"; currency: CurrencyCode } | { kind: "UNSUPPORTED"; token: string };

/**
 * Central money-handling service: detects a requested display/convert currency from free text, converts an
 * amount between two supported currencies using one consistent rate (never a partial/mixed conversion,
 * never a relabel-only "conversion"), and formats an amount for display.
 */
export class CurrencyService {
  constructor(
    private readonly provider: ExchangeRateProvider = new DeterministicFallbackExchangeRateProvider()
  ) {}

  /** Converts `amount` from `from` to `to`. Same currency is a no-op (still rounds, never re-derives a
   * number that was already correct). */
  convert(amount: number, from: CurrencyCode, to: CurrencyCode): number {
    if (from === to) return Math.round(amount);
    const fromRate = this.provider.getRatePerUsd(from);
    const toRate = this.provider.getRatePerUsd(to);
    return Math.round((amount / fromRate) * toRate);
  }

  /**
   * Conversion that never throws or fabricates: returns the converted amount, or null when the (possibly
   * live) exchange-rate provider is unavailable / returns an invalid (non-finite, non-positive) rate.
   * Callers use the null to show a safe "live conversion unavailable" response instead of a made-up number
   * or a mislabeled one.
   */
  tryConvert(amount: number, from: CurrencyCode, to: CurrencyCode): number | null {
    try {
      if (from === to) return Math.round(amount);
      const fromRate = this.provider.getRatePerUsd(from);
      const toRate = this.provider.getRatePerUsd(to);
      if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0)
        return null;
      const result = (amount / fromRate) * toRate;
      return Number.isFinite(result) ? Math.round(result) : null;
    } catch {
      return null;
    }
  }

  /**
   * Deterministic detection of a request to DISPLAY or CONVERT amounts in a particular currency — the
   * single source of truth for currency-preference routing. Recognizes ISO codes, currency names, common
   * "share/show/convert ... in/to <currency>" phrasings, and a bare currency token ("usd"). Deliberately
   * ignores a currency that is attached to a number ("INR 50,000") — that is a budget amount, never a
   * display change. Returns a recognized-but-unsupported result (rather than null) for a currency-shaped
   * request we can't service, so the caller can explain instead of silently looping.
   */
  detectPreference(text: string): CurrencyPreference | null {
    if (!text.trim()) return null;

    // Bare currency token as the whole message ("usd", "in dollars", "rupees please").
    const bare = BARE_CURRENCY_PATTERN.exec(text);
    if (bare?.[1]) {
      const code = resolveTokenToCode(bare[1]);
      if (code) return { kind: "SUPPORTED", currency: code };
    }
    if (BARE_UNSUPPORTED_PATTERN.test(text)) {
      const token = BARE_UNSUPPORTED_PATTERN.exec(text)?.[1] ?? "";
      return { kind: "UNSUPPORTED", token };
    }

    // A currency attached to a number is a budget amount, not a display change — but only bail out when
    // there is no explicit "share/show/convert ... in <currency>" cue elsewhere in the message.
    const cued = CUED_SUPPORTED_PATTERN.exec(text);
    const hinglish = HINGLISH_CURRENCY_PATTERN.exec(text);
    if (cued?.[1] || hinglish?.[1]) {
      const raw = cued?.[1] ?? hinglish?.[1] ?? "";
      const code = resolveTokenToCode(raw);
      if (code) return { kind: "SUPPORTED", currency: code };
    }
    if (CUED_UNSUPPORTED_PATTERN.test(text)) {
      const token = CUED_UNSUPPORTED_PATTERN.exec(text)?.[1] ?? "";
      return { kind: "UNSUPPORTED", token };
    }

    // No cue and not bare — a currency attached to a number (e.g. "INR 50,000") is a budget amount, and
    // any other incidental currency mention with no display/convert cue is deliberately NOT treated as a
    // preference change (avoids false positives). Return null so normal intent handling proceeds.
    return null;
  }

  /**
   * Backwards-compatible detector used by the CONVERT_ESTIMATE_CURRENCY classifier: returns the supported
   * target currency for a display/convert request, or null. A recognized-but-unsupported currency also
   * returns null here (the richer {@link detectPreference} distinguishes the two for callers that care).
   */
  detectRequestedCurrency(text: string): CurrencyCode | null {
    const preference = this.detectPreference(text);
    return preference?.kind === "SUPPORTED" ? preference.currency : null;
  }

  /** Formats an amount with the currency's conventional symbol/prefix and thousands separators — e.g.
   * `format(83000, "INR")` -> "₹83,000". */
  format(amount: number, currency: CurrencyCode, locale = "en-US"): string {
    const rounded = ZERO_DECIMAL_CURRENCIES.has(currency) ? Math.round(amount) : Math.round(amount);
    return `${CURRENCY_SYMBOLS[currency]}${rounded.toLocaleString(locale)}`;
  }
}

const sharedCurrencyService = new CurrencyService();

/**
 * Shared, deterministic money formatter — a single place every customer-facing amount is rendered, so
 * rounding and symbol conventions never drift between call sites. Unsupported currencies fall back to a
 * plain "<CODE> <amount>" form rather than throwing.
 */
export function formatMoney(amount: number, currency: string, locale = "en-US"): string {
  if (isSupportedCurrency(currency)) {
    return sharedCurrencyService.format(amount, currency.toUpperCase() as CurrencyCode, locale);
  }
  return `${currency.toUpperCase()} ${Math.round(amount).toLocaleString(locale)}`;
}
