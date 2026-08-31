import { describe, expect, it } from "vitest";
import {
  buildBookingConfirmationSummary,
  buildPassengerDetailsRequestMessage,
  computeReturnDate,
  detectOptionSelection,
  formatPackageOptionsMessage,
  generateSimulatedPackageOptions,
  isChangeOptionRequest,
  isExplicitBookingConfirmationReply,
  isOptionSetExpired,
  packageOptionSeed,
  parsePassengerDetailsReply
} from "./travel-package-options";
import { DEFAULT_TRAVEL_EMPLOYEE_CONFIG, EMPTY_TRAVEL_ENTITIES, type TravelEntities } from "./travel.runtime";

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a non-null value in test setup");
  return value;
}

// The exact trip state from the FAILED UAT conversation: Krishna, Delhi -> Dubai, 2026-08-12, 5 days,
// 3 adults, ROUND_TRIP, AED 100000 budget, vegetarian.
const KRISHNA_TRIP: TravelEntities = {
  ...EMPTY_TRAVEL_ENTITIES,
  customerName: "Krishna",
  originCity: "Delhi",
  destinationCity: "Dubai",
  departureDate: "2026-08-12",
  days: 5,
  adults: 3,
  tripType: "ROUND_TRIP",
  budget: 100000,
  budgetCurrency: "AED",
  preferences: ["vegetarian"]
};

describe("computeReturnDate", () => {
  it("derives return date from departureDate + (days - 1) nights", () => {
    expect(computeReturnDate(KRISHNA_TRIP)).toBe("2026-08-16");
  });

  it("prefers an explicitly stated returnDate over derivation", () => {
    expect(computeReturnDate({ ...KRISHNA_TRIP, returnDate: "2026-09-01" })).toBe("2026-09-01");
  });

  it("returns null without a departure date", () => {
    expect(computeReturnDate({ ...KRISHNA_TRIP, departureDate: null })).toBeNull();
  });

  it("returns null without a known duration", () => {
    expect(computeReturnDate({ ...KRISHNA_TRIP, days: null, nights: null })).toBeNull();
  });
});

describe("generateSimulatedPackageOptions", () => {
  it("generates exactly three options, numbered 1/2/3, tiered Value/Recommended/Premium", () => {
    const options = generateSimulatedPackageOptions(
      KRISHNA_TRIP,
      DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
      packageOptionSeed(KRISHNA_TRIP)
    );
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.optionNumber)).toEqual([1, 2, 3]);
    expect(options.map((o) => o.optionType)).toEqual(["VALUE", "RECOMMENDED", "PREMIUM"]);
  });

  it("is fully deterministic — the same trip state always regenerates identical options", () => {
    const seed = packageOptionSeed(KRISHNA_TRIP);
    const first = generateSimulatedPackageOptions(KRISHNA_TRIP, DEFAULT_TRAVEL_EMPLOYEE_CONFIG, seed);
    const second = generateSimulatedPackageOptions(KRISHNA_TRIP, DEFAULT_TRAVEL_EMPLOYEE_CONFIG, seed);
    expect(second.map((o) => ({ ...o, generatedAt: null, expiresAt: null }))).toEqual(
      first.map((o) => ({ ...o, generatedAt: null, expiresAt: null }))
    );
  });

  it("carries round-trip dates through to the flight and hotel", () => {
    const [value] = generateSimulatedPackageOptions(
      KRISHNA_TRIP,
      DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
      packageOptionSeed(KRISHNA_TRIP)
    );
    const option = must(value);
    expect(option.tripType).toBe("ROUND_TRIP");
    expect(option.outboundDate).toBe("2026-08-12");
    expect(option.returnDate).toBe("2026-08-16");
    expect(option.flight.returnFlightNumber).not.toBeNull();
    expect(option.hotel?.checkInDate).toBe("2026-08-12");
    expect(option.hotel?.checkOutDate).toBe("2026-08-16");
  });

  it("marks hotels vegetarian-friendly when the traveler's preferences say so", () => {
    const options = generateSimulatedPackageOptions(
      KRISHNA_TRIP,
      DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
      packageOptionSeed(KRISHNA_TRIP)
    );
    expect(options.every((o) => o.hotel?.vegetarianFriendly)).toBe(true);
  });

  it("prices tiers strictly ascending (Value < Recommended < Premium)", () => {
    const [value, recommended, premium] = generateSimulatedPackageOptions(
      KRISHNA_TRIP,
      DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
      packageOptionSeed(KRISHNA_TRIP)
    );
    expect(must(value).totalAmount).toBeLessThan(must(recommended).totalAmount);
    expect(must(recommended).totalAmount).toBeLessThan(must(premium).totalAmount);
  });
});

describe("formatPackageOptionsMessage", () => {
  it("renders Option 1/2/3 headings and a selection prompt", () => {
    const options = generateSimulatedPackageOptions(
      KRISHNA_TRIP,
      DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
      packageOptionSeed(KRISHNA_TRIP)
    );
    const message = formatPackageOptionsMessage(options);
    expect(message).toMatch(/Option 1 — Value/);
    expect(message).toMatch(/Option 2 — Recommended/);
    expect(message).toMatch(/Option 3 — Premium/);
    // Fix (Travel Booking Closure Pass — Phase 17): natural phrasing over a numbered-menu prompt — see
    // formatPackageOptionsMessage's own doc comment for why "Option 1"/bare "1"/"value" etc. still parse.
    expect(message).toMatch(/Value, Recommended, or Premium/);
  });
});

describe("detectOptionSelection", () => {
  it.each([
    ["1", 1],
    ["option 1", 1],
    ["Option 2", 2],
    ["select 3", 3],
    ["go with option 1", 1],
    ["the 2nd one", 2],
    ["premium option", 3],
    ["option three", 3]
  ] as const)("parses %j as option %d", (text, expected) => {
    expect(detectOptionSelection(text)).toBe(expected);
  });

  it("returns null for unrelated text", () => {
    expect(detectOptionSelection("what's the weather")).toBeNull();
  });
});

describe("isOptionSetExpired", () => {
  it("is false for a freshly generated option set", () => {
    const options = generateSimulatedPackageOptions(
      KRISHNA_TRIP,
      DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
      packageOptionSeed(KRISHNA_TRIP)
    );
    expect(isOptionSetExpired(options)).toBe(false);
  });

  it("is true once the expiry window has passed", () => {
    const options = generateSimulatedPackageOptions(
      KRISHNA_TRIP,
      DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
      packageOptionSeed(KRISHNA_TRIP)
    );
    const later = new Date(Date.parse(must(options[0]).expiresAt) + 1000);
    expect(isOptionSetExpired(options, later)).toBe(true);
  });
});

describe("isChangeOptionRequest / isExplicitBookingConfirmationReply", () => {
  it.each(["change option", "show me other options", "a different package", "no, show other options"])(
    "recognizes %j as a change-option request",
    (text) => {
      expect(isChangeOptionRequest(text)).toBe(true);
    }
  );

  it.each(["confirm booking", "yes", "go ahead", "proceed", "book this option"])(
    "recognizes %j as an explicit booking confirmation",
    (text) => {
      expect(isExplicitBookingConfirmationReply(text)).toBe(true);
    }
  );

  it.each(["no", "not now", "don't book it"])("does not treat %j as a confirmation", (text) => {
    expect(isExplicitBookingConfirmationReply(text)).toBe(false);
  });
});

describe("buildBookingConfirmationSummary", () => {
  it("includes route, dates, travellers, flight, hotel, total, and the confirm/change prompt", () => {
    const [selected] = generateSimulatedPackageOptions(
      KRISHNA_TRIP,
      DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
      packageOptionSeed(KRISHNA_TRIP)
    );
    const summary = buildBookingConfirmationSummary(KRISHNA_TRIP, must(selected));
    expect(summary).toMatch(/Delhi.*Dubai.*Delhi/s);
    expect(summary).toMatch(/2026-08-12 to 2026-08-16/);
    expect(summary).toMatch(/3 traveller\(s\)/);
    expect(summary).toMatch(/Flight:/);
    expect(summary).toMatch(/Hotel:/);
    expect(summary).toMatch(/Total:/);
    expect(summary).toMatch(/Food preference: Vegetarian/);
    expect(summary).toMatch(/Reply 'Confirm booking' to proceed, or 'Change option' to choose another package\./);
  });

  it("lists every traveller's name/age/gender when passengers are provided", () => {
    const [selected] = generateSimulatedPackageOptions(
      KRISHNA_TRIP,
      DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
      packageOptionSeed(KRISHNA_TRIP)
    );
    const summary = buildBookingConfirmationSummary(KRISHNA_TRIP, must(selected), [
      { name: "Krishna Pandey", age: 34, gender: "MALE" },
      { name: "Anita Pandey", age: 32, gender: "FEMALE" }
    ]);
    expect(summary).toMatch(/Travellers:/);
    expect(summary).toMatch(/1\. Krishna Pandey, 34, MALE/);
    expect(summary).toMatch(/2\. Anita Pandey, 32, FEMALE/);
  });

  it("omits the Travellers section entirely when no passengers are provided (backward compatible default)", () => {
    const [selected] = generateSimulatedPackageOptions(
      KRISHNA_TRIP,
      DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
      packageOptionSeed(KRISHNA_TRIP)
    );
    const summary = buildBookingConfirmationSummary(KRISHNA_TRIP, must(selected));
    expect(summary).not.toMatch(/Travellers:/);
  });
});

describe("parsePassengerDetailsReply", () => {
  it("parses a semicolon-separated, numbered list", () => {
    const parsed = parsePassengerDetailsReply(
      "1. Krishna Pandey, 34, Male; 2. Anita Pandey, 32, Female; 3. Rohan Pandey, 8, Male"
    );
    expect(parsed).toEqual([
      { name: "Krishna Pandey", age: 34, gender: "MALE" },
      { name: "Anita Pandey", age: 32, gender: "FEMALE" },
      { name: "Rohan Pandey", age: 8, gender: "MALE" }
    ]);
  });

  it("parses a newline-separated list without numbering", () => {
    const parsed = parsePassengerDetailsReply("Krishna Pandey, 34, Male\nAnita Pandey, 32, Female");
    expect(parsed).toEqual([
      { name: "Krishna Pandey", age: 34, gender: "MALE" },
      { name: "Anita Pandey", age: 32, gender: "FEMALE" }
    ]);
  });

  it("accepts single-letter gender shorthand and an 'years'/'yrs' age suffix", () => {
    expect(parsePassengerDetailsReply("Krishna Pandey, 34 years, M")).toEqual([
      { name: "Krishna Pandey", age: 34, gender: "MALE" }
    ]);
    expect(parsePassengerDetailsReply("Anita Pandey, 32 yrs, F")).toEqual([
      { name: "Anita Pandey", age: 32, gender: "FEMALE" }
    ]);
  });

  it("normalizes 'other'/'non-binary' to OTHER", () => {
    expect(parsePassengerDetailsReply("Alex Rivera, 29, Non-binary")).toEqual([
      { name: "Alex Rivera", age: 29, gender: "OTHER" }
    ]);
  });

  it("silently skips a segment missing age or gender, rather than guessing", () => {
    expect(parsePassengerDetailsReply("Krishna Pandey")).toEqual([]);
    expect(parsePassengerDetailsReply("Krishna Pandey, 34")).toEqual([]);
    expect(parsePassengerDetailsReply("just some unrelated text")).toEqual([]);
  });

  it("rejects an out-of-range age", () => {
    expect(parsePassengerDetailsReply("Krishna Pandey, 200, Male")).toEqual([]);
    expect(parsePassengerDetailsReply("Krishna Pandey, 0, Male")).toEqual([]);
  });

  it("parses the valid segments and skips the invalid ones in a mixed list", () => {
    const parsed = parsePassengerDetailsReply("Krishna Pandey, 34, Male\nsomething unrelated\nAnita Pandey, 32, Female");
    expect(parsed).toEqual([
      { name: "Krishna Pandey", age: 34, gender: "MALE" },
      { name: "Anita Pandey", age: 32, gender: "FEMALE" }
    ]);
  });
});

describe("buildPassengerDetailsRequestMessage", () => {
  // Fix (Travel Booking Closure Pass — Phase 11/17): natural phrasing over an exposed-counter prompt
  // ("2 more traveller(s) (3 total)") — see the function's own doc comment. Authoritative facts (total
  // travellers, how many collected) are asserted via the SAME numbers still appearing naturally in text,
  // not by requiring one exact sentence.
  it("asks for all travellers when none are recorded yet", () => {
    const message = buildPassengerDetailsRequestMessage(3, []);
    expect(message).toMatch(/full name, age and gender/i);
    expect(message).not.toMatch(/Already recorded/);
    expect(message).not.toMatch(/\(\d+ total\)/);
  });

  it("asks for the remaining count and lists what's already recorded", () => {
    const message = buildPassengerDetailsRequestMessage(3, [{ name: "Krishna Pandey", age: 34, gender: "MALE" }]);
    expect(message).toMatch(/remaining 2 travellers/i);
    expect(message).toMatch(/Already recorded:/);
    expect(message).toMatch(/1\. Krishna Pandey, 34, MALE/);
  });

  it("uses singular phrasing for exactly one remaining traveller", () => {
    const message = buildPassengerDetailsRequestMessage(2, [{ name: "Krishna Pandey", age: 34, gender: "MALE" }]);
    expect(message).toMatch(/the last traveller/i);
  });

  it("uses singular phrasing for a single-traveller trip on the first ask", () => {
    const message = buildPassengerDetailsRequestMessage(1, []);
    expect(message).toMatch(/the traveller's full name/i);
  });
});
