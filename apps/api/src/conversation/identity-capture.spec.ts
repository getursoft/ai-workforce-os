import { describe, expect, it } from "vitest";
import { classifyIdentityCandidate } from "./identity-capture";

const KNOWN_DESTINATIONS = ["dubai", "singapore", "delhi", "paris", "goa", "kerala"];

describe("classifyIdentityCandidate", () => {
  describe("HIGH confidence — explicit self-introduction", () => {
    it.each([
      ["I'm Krishna", "Krishna"],
      ["My name is Krishna", "Krishna"],
      ["This is Krishna", "Krishna"],
      ["Krishna here", "Krishna"],
      ["Call me Krishna", "Krishna"],
      ["My name is Krishna and I want to visit Delhi", "Krishna"]
    ])("%s -> %s", (text, expected) => {
      const result = classifyIdentityCandidate(text, { knownValueWords: KNOWN_DESTINATIONS });
      expect(result?.name).toBe(expected);
      expect(result?.confidence).toBe("HIGH");
    });
  });

  describe("LOW confidence — bare name-shaped reply", () => {
    it.each(["Krishna", "Krishna Pandey"])("%s is accepted", (text) => {
      const result = classifyIdentityCandidate(text, { knownValueWords: KNOWN_DESTINATIONS });
      expect(result?.name).toBe(text);
      expect(result?.confidence).toBe("LOW");
    });
  });

  describe("Part 4/5/24-E — must NEVER become a name", () => {
    it.each([
      "book it",
      "show options",
      "no thanks",
      "share pdf",
      "share the pdf",
      "share it here",
      "looks good",
      "go ahead",
      "not now",
      "yes please",
      "Dubai please",
      "next month",
      "three adults",
      "Great",
      "Got it",
      "okay",
      "thanks",
      "sounds good",
      "sorry, I meant October",
      "actually make it 3 adults",
      // Sprint 6.5 — Part 6/24: identity is now platform-level, not Travel-specific — a genuine live
      // regression this exact test caught: other employees' own ordinary 3-word request phrasing was
      // being captured as the customer's name once unprompted capture ran on every turn, not just Travel's.
      "check this invoice",
      "review this contract"
    ])("%s", (text) => {
      const result = classifyIdentityCandidate(text, { knownValueWords: KNOWN_DESTINATIONS });
      expect(result).toBeNull();
    });
  });

  it("rejects a known destination even alone", () => {
    expect(classifyIdentityCandidate("Dubai", { knownValueWords: KNOWN_DESTINATIONS })).toBeNull();
  });

  it("rejects a message with digits", () => {
    expect(classifyIdentityCandidate("Krishna123", { knownValueWords: [] })).toBeNull();
    expect(classifyIdentityCandidate("5 nights", { knownValueWords: [] })).toBeNull();
  });

  it("returns null for empty/overlong input", () => {
    expect(classifyIdentityCandidate("", { knownValueWords: [] })).toBeNull();
    expect(
      classifyIdentityCandidate("a".repeat(60), { knownValueWords: [] })
    ).toBeNull();
  });
});
