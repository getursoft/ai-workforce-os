import { describe, expect, it } from "vitest";
import {
  extractPhoneNumber,
  formatSuggestedActions,
  generateLeadReference,
  isAffirmativeResponse,
  isNegativeResponse,
  normalizePhoneNumber
} from "./conversation-completion";

describe("formatSuggestedActions", () => {
  it("returns an empty string when there are no suggestions", () => {
    expect(formatSuggestedActions([])).toBe("");
  });

  it("renders a short bulleted aside under a heading", () => {
    const formatted = formatSuggestedActions([{ label: "Create itinerary" }, { label: "Recommend hotels" }]);
    expect(formatted).toContain("You might also like:");
    expect(formatted).toContain("• Create itinerary");
    expect(formatted).toContain("• Recommend hotels");
  });

  it("accepts a custom heading", () => {
    expect(formatSuggestedActions([{ label: "Weather" }], "Anything else?")).toContain("Anything else?");
  });
});

describe("isAffirmativeResponse / isNegativeResponse", () => {
  it.each(["yes", "Yes please", "sure", "go ahead", "okay", "submit it", "haan"])(
    "%j is affirmative, not negative",
    (text) => {
      expect(isAffirmativeResponse(text)).toBe(true);
      expect(isNegativeResponse(text)).toBe(false);
    }
  );

  it.each(["no", "no thanks", "not now", "maybe later", "skip it", "nah"])(
    "%j is negative, not affirmative",
    (text) => {
      expect(isNegativeResponse(text)).toBe(true);
      expect(isAffirmativeResponse(text)).toBe(false);
    }
  );

  it("an unrelated message is neither affirmative nor negative", () => {
    expect(isAffirmativeResponse("what's the weather in Paris")).toBe(false);
    expect(isNegativeResponse("what's the weather in Paris")).toBe(false);
  });

  it("'no thanks' is never misread as affirmative just because it contains a pleasantry", () => {
    expect(isAffirmativeResponse("no thanks, not interested")).toBe(false);
    expect(isNegativeResponse("no thanks, not interested")).toBe(true);
  });
});

describe("normalizePhoneNumber / extractPhoneNumber", () => {
  it.each([
    ["+919876543210", "+919876543210"],
    ["+91 98765 43210", "+919876543210"],
    ["(987) 654-3210", "9876543210"],
    ["987-654-3210", "9876543210"],
    ["+1 555 123 4567", "+15551234567"]
  ])("normalizes %j to %j", (raw, expected) => {
    expect(normalizePhoneNumber(raw)).toBe(expected);
  });

  it.each(["", "12345", "abc", "0044"])("rejects %j as too short/invalid", (raw) => {
    expect(normalizePhoneNumber(raw)).toBeNull();
  });

  it("extracts a phone number embedded in a full sentence", () => {
    expect(extractPhoneNumber("Sure, it's +91 98765 43210, thanks!")).toBe("+919876543210");
    expect(extractPhoneNumber("You can reach me at 987-654-3210")).toBe("9876543210");
  });

  it("returns null when no phone-shaped run of digits is present", () => {
    expect(extractPhoneNumber("my budget is 2000 dollars")).toBeNull();
  });

  it("never mistakes an unrelated short number (a budget, a year) for a phone number", () => {
    expect(extractPhoneNumber("2000")).toBeNull();
    expect(extractPhoneNumber("in 2026")).toBeNull();
  });

  it("never mistakes a large, unformatted budget figure embedded in a sentence for a phone number (reproduces the Bali/IDR UAT bug)", () => {
    expect(
      extractPhoneNumber(
        "Plan trip to Bali from Jakarta, 5 November 2026, 6 days, 2 adults, round trip, budget IDR 20000000"
      )
    ).toBeNull();
    expect(extractPhoneNumber("my budget is 6000000 yen")).toBeNull();
  });

  it("still extracts a bare, unformatted digit string when it IS the entire message (the normal direct reply to a phone prompt)", () => {
    expect(extractPhoneNumber("9876543210")).toBe("9876543210");
    expect(extractPhoneNumber("  9876543210  ")).toBe("9876543210");
  });
});

describe("generateLeadReference", () => {
  it("uses the given prefix and a 6-character suffix", () => {
    const reference = generateLeadReference("TRV");
    expect(reference).toMatch(/^TRV-[A-Z0-9]{6}$/);
  });

  it("is not the same value twice in a row (extremely unlikely collision, not guaranteed uniqueness)", () => {
    const a = generateLeadReference("TRV");
    const b = generateLeadReference("TRV");
    expect(a).not.toBe(b);
  });
});
