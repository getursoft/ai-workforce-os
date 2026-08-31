import { describe, expect, it } from "vitest";
import { buildDateWindowAcknowledgment, EMPTY_TRAVEL_ENTITIES, interpretDatePhrase } from "./travel.runtime";

/**
 * Sprint 6.5 — Parts 9-11/25: deterministic relative-date understanding. Every test below passes an
 * explicit, FIXED reference date — never the real current date — so these never depend on the day they
 * happen to run (Part 25's own requirement).
 */

// A Wednesday, well clear of any month boundary, used for most "simple" phrase tests.
const WED_AUG_12_2026 = new Date(Date.UTC(2026, 7, 12));
// The last day of the year, used to prove December -> next January rollover for "next month".
const DEC_31_2026 = new Date(Date.UTC(2026, 11, 31));
// A Sunday, used to prove the "this weekend" edge case (the weekend already includes today).
const SUN_AUG_16_2026 = new Date(Date.UTC(2026, 7, 16));

describe("interpretDatePhrase — Sprint 6.5 deterministic temporal understanding", () => {
  it("today", () => {
    const result = interpretDatePhrase("today", WED_AUG_12_2026);
    expect(result.normalizedDate).toBe("2026-08-12");
    expect(result.windowType).toBeUndefined();
  });

  it("tomorrow", () => {
    const result = interpretDatePhrase("tomorrow", WED_AUG_12_2026);
    expect(result.normalizedDate).toBe("2026-08-13");
  });

  it("day after tomorrow — and is not swallowed by the bare 'tomorrow' check", () => {
    const result = interpretDatePhrase("day after tomorrow", WED_AUG_12_2026);
    expect(result.normalizedDate).toBe("2026-08-14");
  });

  it("next week — Monday-Sunday of the following calendar week, as a WEEK window, never a fake precise date", () => {
    const result = interpretDatePhrase("next week", WED_AUG_12_2026);
    expect(result.normalizedDate).toBeNull();
    expect(result.windowType).toBe("WEEK");
    expect(result.windowStart).toBe("2026-08-17"); // Monday after this week
    expect(result.windowEnd).toBe("2026-08-23"); // Sunday
  });

  it("this weekend from a midweek reference — the upcoming Saturday/Sunday", () => {
    const result = interpretDatePhrase("this weekend", WED_AUG_12_2026);
    expect(result.windowType).toBe("WEEK");
    expect(result.windowStart).toBe("2026-08-15");
    expect(result.windowEnd).toBe("2026-08-16");
  });

  it("this weekend when today IS Sunday — the weekend already includes today, not a week away", () => {
    const result = interpretDatePhrase("this weekend", SUN_AUG_16_2026);
    expect(result.windowStart).toBe("2026-08-15");
    expect(result.windowEnd).toBe("2026-08-16");
  });

  it("next weekend — one week past this weekend", () => {
    const result = interpretDatePhrase("next weekend", WED_AUG_12_2026);
    expect(result.windowStart).toBe("2026-08-22");
    expect(result.windowEnd).toBe("2026-08-23");
  });

  it("this month — a MONTH window, not a fabricated day", () => {
    const result = interpretDatePhrase("this month", WED_AUG_12_2026);
    expect(result.normalizedDate).toBeNull();
    expect(result.windowType).toBe("MONTH");
    expect(result.windowStart).toBe("2026-08-01");
    expect(result.windowEnd).toBe("2026-08-31");
    expect(result.travelMonth).toBe("August");
  });

  it("next month — a MONTH window within the same year", () => {
    const result = interpretDatePhrase("next month", WED_AUG_12_2026);
    expect(result.windowType).toBe("MONTH");
    expect(result.windowStart).toBe("2026-09-01");
    expect(result.windowEnd).toBe("2026-09-30");
    expect(result.travelMonth).toBe("September");
  });

  it("next month from a December reference rolls over into January of the FOLLOWING year", () => {
    const result = interpretDatePhrase("next month", DEC_31_2026);
    expect(result.windowType).toBe("MONTH");
    expect(result.windowStart).toBe("2027-01-01");
    expect(result.windowEnd).toBe("2027-01-31");
    expect(result.travelMonth).toBe("January");
  });

  it("first week of next month", () => {
    const result = interpretDatePhrase("first week of next month", WED_AUG_12_2026);
    expect(result.windowType).toBe("WEEK");
    expect(result.windowStart).toBe("2026-09-01");
    expect(result.windowEnd).toBe("2026-09-07");
    // Must NOT collapse to the whole-month window a bare "next month" would produce.
    expect(result.windowEnd).not.toBe("2026-09-30");
  });

  it("second week of October — a named month, not 'next'/'this'", () => {
    const result = interpretDatePhrase("second week of October", WED_AUG_12_2026);
    expect(result.windowType).toBe("WEEK");
    expect(result.windowStart).toBe("2026-10-08");
    expect(result.windowEnd).toBe("2026-10-14");
  });

  it("second week of a month already passed this year rolls into next year", () => {
    // Reference is August 2026; "second week of March" must resolve to March 2027, not the past.
    const result = interpretDatePhrase("second week of March", WED_AUG_12_2026);
    expect(result.windowStart).toBe("2027-03-08");
  });

  it("end of September", () => {
    const result = interpretDatePhrase("end of September", WED_AUG_12_2026);
    expect(result.windowType).toBe("WEEK");
    expect(result.windowStart).toBe("2026-09-24");
    expect(result.windowEnd).toBe("2026-09-30");
  });

  it("end of February in a leap year resolves the correct last day (29th), via native Date rollover", () => {
    // Reference January 2028 (2028 is a leap year) so "end of February" targets Feb 2028.
    const result = interpretDatePhrase("end of February", new Date(Date.UTC(2028, 0, 15)));
    expect(result.windowEnd).toBe("2028-02-29");
  });

  it("mid-September (hyphenated) still resolves a precise day AND carries a WEEK window", () => {
    const result = interpretDatePhrase("mid-September", WED_AUG_12_2026);
    expect(result.normalizedDate).toBe("2026-09-15");
    expect(result.windowType).toBe("WEEK");
    expect(result.windowStart).toBe("2026-09-11");
    expect(result.windowEnd).toBe("2026-09-20");
  });

  it("mid October (space-separated) resolves the same way as the hyphenated form", () => {
    const result = interpretDatePhrase("mid October", WED_AUG_12_2026);
    expect(result.normalizedDate).toBe("2026-10-15");
  });

  it("15 October (explicit day + month, no year) resolves this year when not yet passed", () => {
    const result = interpretDatePhrase("15 October", WED_AUG_12_2026);
    expect(result.normalizedDate).toBe("2026-10-15");
  });

  it("October alone (month name with no day) still yields a travelMonth via the existing month-day branch fallback path is out of scope here — covered by extractTravelMonth elsewhere", () => {
    // interpretDatePhrase itself requires a day number for the explicit month/day branch; a bare month
    // name with no day is handled by `extractTravelMonth`, not this function — documented, not a gap.
    const result = interpretDatePhrase("October", WED_AUG_12_2026);
    expect(result.normalizedDate).toBeNull();
  });

  it("an unresolvable, genuinely ambiguous phrase (a lunar festival) never fabricates a date", () => {
    const result = interpretDatePhrase("around Diwali", WED_AUG_12_2026);
    expect(result.normalizedDate).toBeNull();
    expect(result.windowType).toBeUndefined();
  });

  it("for one week / for N weeks / for N days duration phrases are unaffected by the new window logic", () => {
    expect(interpretDatePhrase("for one week", WED_AUG_12_2026).durationDays).toBe(7);
    expect(interpretDatePhrase("for 3 weeks", WED_AUG_12_2026).durationDays).toBe(21);
    expect(interpretDatePhrase("for 5 days", WED_AUG_12_2026).durationDays).toBe(5);
  });
});

describe("buildDateWindowAcknowledgment — Sprint 6.5 Part 12", () => {
  it('asks naturally, not "provide an exact date", when a broad window was just given', () => {
    const entities = { ...EMPTY_TRAVEL_ENTITIES, travelMonth: "September" };
    const result = buildDateWindowAcknowledgment(entities, "next month", "ENGLISH");
    expect(result).toBe("September works. Do you have a preferred departure date, or should I look across the month?");
    expect(result).not.toMatch(/provide an exact/i);
  });

  it("returns null once a precise departureDate is already known — nothing to caveat", () => {
    const entities = { ...EMPTY_TRAVEL_ENTITIES, travelMonth: "September", departureDate: "2026-09-15" };
    expect(buildDateWindowAcknowledgment(entities, "next month", "ENGLISH")).toBeNull();
  });

  it("returns null when the phrase resolved to an exact date, not a window", () => {
    const entities = { ...EMPTY_TRAVEL_ENTITIES, travelMonth: "September" };
    expect(buildDateWindowAcknowledgment(entities, "15 September", "ENGLISH")).toBeNull();
  });

  it("Hinglish phrasing stays natural, not a literal translation", () => {
    const entities = { ...EMPTY_TRAVEL_ENTITIES, travelMonth: "September" };
    const result = buildDateWindowAcknowledgment(entities, "next month", "HINGLISH");
    expect(result).toContain("September");
    expect(result).toMatch(/dhoondhun|theek/i);
  });
});
