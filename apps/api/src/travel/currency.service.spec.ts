import { describe, expect, it } from "vitest";
import {
  CurrencyService,
  DeterministicFallbackExchangeRateProvider,
  formatMoney,
  isSupportedCurrency,
  SUPPORTED_CURRENCIES,
  type CurrencyCode,
  type ExchangeRateProvider
} from "./currency.service";

describe("CurrencyService", () => {
  it("actually converts values, not just relabels the currency", () => {
    const service = new CurrencyService();
    const converted = service.convert(6000, "USD", "INR");
    expect(converted).not.toBe(6000);
    expect(converted).toBe(6000 * 83);
  });

  it("converts between every pair of the 5 supported currencies without throwing", () => {
    const service = new CurrencyService();
    for (const from of SUPPORTED_CURRENCIES)
      for (const to of SUPPORTED_CURRENCIES) {
        const result = service.convert(1000, from, to);
        expect(Number.isFinite(result)).toBe(true);
        expect(result).toBeGreaterThan(0);
      }
  });

  it("is a no-op (still a real number, not corrupted) when converting a currency to itself", () => {
    const service = new CurrencyService();
    expect(service.convert(500, "EUR", "EUR")).toBe(500);
  });

  it("round-trips within rounding tolerance (USD -> AED -> USD)", () => {
    const service = new CurrencyService();
    const toAed = service.convert(1000, "USD", "AED");
    const backToUsd = service.convert(toAed, "AED", "USD");
    expect(Math.abs(backToUsd - 1000)).toBeLessThanOrEqual(1);
  });

  it("supports a pluggable ExchangeRateProvider — swapping providers changes the conversion, proving the abstraction is real", () => {
    const doubleUsdProvider: ExchangeRateProvider = {
      getRatePerUsd: (currency: CurrencyCode) => (currency === "INR" ? 200 : 1)
    };
    const service = new CurrencyService(doubleUsdProvider);
    expect(service.convert(10, "USD", "INR")).toBe(2000);
  });

  it("the deterministic fallback provider returns a finite positive rate for every supported currency", () => {
    const provider = new DeterministicFallbackExchangeRateProvider();
    for (const currency of SUPPORTED_CURRENCIES) {
      const rate = provider.getRatePerUsd(currency);
      expect(Number.isFinite(rate)).toBe(true);
      expect(rate).toBeGreaterThan(0);
    }
  });

  describe("detectRequestedCurrency", () => {
    it.each([
      ["show in INR", "INR"],
      ["give it in USD", "USD"],
      ["convert to euros", "EUR"],
      ["tell me in pounds", "GBP"],
      ["show in AED", "AED"],
      ["convert it to dirhams", "AED"],
      ["INR me batao", "INR"],
      // Regression: the reported bug — a natural request with words between the verb and "in <currency>"
      // ("these prices", "the total") was not recognized at all before, silently falling through to a
      // generic budget-recalculation response instead of converting the already-shown estimate.
      ["Give these prices in INR", "INR"],
      ["Show me the total in EUR", "EUR"],
      ["can you convert this to dirhams", "AED"],
      // Production UAT phrasings that previously failed detection and looped the search prompt.
      ["share in USD", "USD"],
      ["estimate in usd", "USD"],
      ["usd", "USD"],
      ["USD", "USD"],
      ["show in dollars", "USD"],
      ["convert it to dollars", "USD"],
      ["give the same estimate in AED", "AED"],
      ["show future costs in THB", "THB"],
      ["in yen", "JPY"],
      ["convert to canadian dollars", "CAD"],
      ["show in singapore dollars", "SGD"],
      ["show in aussie dollars", "AUD"],
      ["rupees please", "INR"],
      // Hinglish trailing forms with the abbreviated spellings real users type.
      ["usd me btao", "USD"],
      ["INR me batao", "INR"],
      ["usd mein bta do", "USD"],
      ["eur me dikhao", "EUR"],
      // Stage 9F UAT regression: "need"/"budget" as the cue verb — previously unrecognized, silently
      // falling through and re-triggering budget/estimate recalculation instead of converting display.
      ["I need in AED", "AED"],
      ["budget in AED", "AED"],
      ["I need this in USD", "USD"]
    ])("detects %j as %s", (text, expected) => {
      const service = new CurrencyService();
      expect(service.detectRequestedCurrency(text)).toBe(expected);
    });

    it.each([
      "what's the weather like",
      // A currency attached to a NUMBER is a budget amount, never a display-currency change.
      "plan within INR 50,000",
      "budget INR 50000",
      "I have 2000 dollars saved",
      "5 adults Delhi to Bangkok, 3 days 2 nights, 15 August 2026, plan within INR 50,000.",
      // Farewells must never be read as a currency request.
      "no thanks",
      "thanks, that's all",
      "bye",
      // Stage 9F: "need"/"budget" becoming cue words must never misread a stated amount as a display
      // change — the required "in/to/into/as <currency>" adjacency is broken by the number in between.
      "I need 5000 AED",
      "I need a budget of 5000 AED",
      "budget is 10000 AED"
    ])("returns null for %j (no display-currency request)", (text) => {
      const service = new CurrencyService();
      expect(service.detectRequestedCurrency(text)).toBeNull();
    });
  });

  describe("detectPreference (supported / unsupported / none)", () => {
    const service = new CurrencyService();
    it("returns a SUPPORTED result for a recognized currency request", () => {
      expect(service.detectPreference("share in USD")).toEqual({
        kind: "SUPPORTED",
        currency: "USD"
      });
      expect(service.detectPreference("usd")).toEqual({ kind: "SUPPORTED", currency: "USD" });
    });
    it.each(["show in ZWL", "convert to yuan", "in won", "give the estimate in pesos"])(
      "returns an UNSUPPORTED result for %j (recognized-but-unsupported currency, so the caller can explain instead of looping)",
      (text) => {
        const result = service.detectPreference(text);
        expect(result?.kind).toBe("UNSUPPORTED");
      }
    );
    it("returns null when there is no currency request at all", () => {
      expect(service.detectPreference("plan within INR 50,000")).toBeNull();
      expect(service.detectPreference("what's the weather")).toBeNull();
    });
  });

  describe("tryConvert (FX-failure-safe)", () => {
    it("returns null when the provider throws or returns an invalid rate, never a fabricated number", () => {
      const throwing = new CurrencyService({
        getRatePerUsd: () => {
          throw new Error("provider unavailable");
        }
      });
      expect(throwing.tryConvert(1000, "USD", "INR")).toBeNull();
      const invalid = new CurrencyService({ getRatePerUsd: () => Number.NaN });
      expect(invalid.tryConvert(1000, "USD", "INR")).toBeNull();
      const negative = new CurrencyService({ getRatePerUsd: () => -1 });
      expect(negative.tryConvert(1000, "USD", "INR")).toBeNull();
    });
    it("returns a converted amount when the provider is healthy", () => {
      const service = new CurrencyService();
      expect(service.tryConvert(1000, "USD", "INR")).toBe(83000);
      expect(service.tryConvert(1000, "USD", "USD")).toBe(1000);
    });
  });

  describe("format", () => {
    it.each([
      [83000, "INR", "₹83,000"],
      [6000, "USD", "$6,000"],
      [5500, "EUR", "€5,500"],
      [4200, "GBP", "£4,200"],
      [22000, "AED", "AED 22,000"],
      [180000, "THB", "฿180,000"],
      [8000, "SGD", "S$8,000"],
      [8000, "CAD", "C$8,000"],
      [9000, "AUD", "A$9,000"],
      [750000, "JPY", "¥750,000"]
    ])("formats %d %s as %s", (amount, currency, expected) => {
      const service = new CurrencyService();
      expect(service.format(amount, currency as CurrencyCode)).toBe(expected);
    });
  });
});

describe("formatMoney (shared formatter)", () => {
  it("uses the currency symbol convention for supported currencies", () => {
    expect(formatMoney(83000, "INR")).toBe("₹83,000");
    expect(formatMoney(6000, "usd")).toBe("$6,000");
  });
  it("falls back to a plain CODE amount for an unsupported currency, never throwing", () => {
    expect(formatMoney(1000, "ZWL")).toBe("ZWL 1,000");
  });
});

describe("isSupportedCurrency", () => {
  it.each([
    "USD",
    "INR",
    "EUR",
    "GBP",
    "AED",
    "THB",
    "SGD",
    "CAD",
    "AUD",
    "JPY",
    "usd",
    "inr",
    "thb",
    "jpy"
  ])("accepts %s", (code) => {
    expect(isSupportedCurrency(code)).toBe(true);
  });

  it.each(["ZWL", "CNY", "XYZ", ""])("rejects %s", (code) => {
    expect(isSupportedCurrency(code)).toBe(false);
  });
});
