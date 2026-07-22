import { describe, expect, it } from "vitest";
import { parseTravelRecommendation } from "./itinerary";

const RECOMMENDATION = [
  "Here's a plan for your trip to London in September for 3 traveler(s), budget ~USD 10000:",
  "",
  "Flight options:",
  "  1. SkyLink Air — ~USD 370 (non-stop, ~4h)",
  "  2. GlobalWing Airways — ~USD 490 (1 stop(s), ~11h)",
  "",
  "Hotel options:",
  "  1. Harbor View Hotel — ~USD 90/night (rated 4.2/5)",
  "  2. Central Plaza Inn — ~USD 135/night (rated 4.5/5)",
  "",
  "Itinerary summary:",
  "Day 1: Arrive in London, settle in and explore nearby.",
  "Day 2–4: Guided sightseeing, local cuisine, and free time.",
  "Day 5: Final day at leisure and departure.",
  "",
  "This is placeholder planning data — no booking has been made, and prices or availability are not live and should be verified.",
  "",
  "Reply 'confirm' to proceed with this plan, or let me know what you'd like to change."
].join("\n");

describe("parseTravelRecommendation", () => {
  it("returns null for a plain conversational reply", () => {
    expect(parseTravelRecommendation("Great, London it is! Which month works for you?")).toBeNull();
  });

  it("splits the recommendation message into intro, flights, hotels, itinerary, and footer", () => {
    const parsed = parseTravelRecommendation(RECOMMENDATION);
    expect(parsed).not.toBeNull();
    expect(parsed?.intro).toContain("trip to London");
    expect(parsed?.flights).toEqual([
      "SkyLink Air — ~USD 370 (non-stop, ~4h)",
      "GlobalWing Airways — ~USD 490 (1 stop(s), ~11h)"
    ]);
    expect(parsed?.hotels).toEqual([
      "Harbor View Hotel — ~USD 90/night (rated 4.2/5)",
      "Central Plaza Inn — ~USD 135/night (rated 4.5/5)"
    ]);
    expect(parsed?.itineraryDays).toEqual([
      "Day 1: Arrive in London, settle in and explore nearby.",
      "Day 2–4: Guided sightseeing, local cuisine, and free time.",
      "Day 5: Final day at leisure and departure."
    ]);
    expect(parsed?.footer).toEqual([
      "This is placeholder planning data — no booking has been made, and prices or availability are not live and should be verified.",
      "Reply 'confirm' to proceed with this plan, or let me know what you'd like to change."
    ]);
  });

  it("handles empty flight or hotel result lists without crashing", () => {
    const parsed = parseTravelRecommendation(
      ["Plan for your trip:", "", "Flight options:", "", "Hotel options:", "", "Itinerary summary:", "Day 1: Arrive."].join(
        "\n"
      )
    );
    expect(parsed?.flights).toEqual([]);
    expect(parsed?.hotels).toEqual([]);
  });
});
