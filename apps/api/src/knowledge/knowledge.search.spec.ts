import { describe, expect, it } from "vitest";
import { headingPathMatchesQueryIntent, queryTermGroups } from "./knowledge.search";

describe("queryTermGroups — booking-gerund exclusion (Sprint 5.0B)", () => {
  it("does not treat 'booking' as a topical signal when used as a gerund after a preposition", () => {
    expect(queryTermGroups("what are the benefits of booking through your portal").size).toBe(0);
    expect(queryTermGroups("what should I know when booking a flight").size).toBe(0);
  });

  it("still treats 'booking' as a topical signal in a genuine booking-topic query", () => {
    expect(queryTermGroups("what are the booking requirements").size).toBeGreaterThan(0);
    expect(queryTermGroups("tell me about group booking policy").size).toBeGreaterThan(0);
  });

  it("still treats plural 'bookings' as a topical signal (only the gerund form is excluded)", () => {
    expect(queryTermGroups("how many bookings can I make").size).toBeGreaterThan(0);
  });

  it("an exact topical heading match is no longer rejected purely because the query incidentally says 'of booking'", () => {
    expect(
      headingPathMatchesQueryIntent("what are the benefits of booking through your portal", "Portal Benefits")
    ).toBe(true);
  });
});
