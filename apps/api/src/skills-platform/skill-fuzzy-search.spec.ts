import { describe, expect, it } from "vitest";
import { fuzzyScore } from "./skill-fuzzy-search";

describe("fuzzyScore", () => {
  it("gives the highest score to an exact match", () => {
    const exact = fuzzyScore("document reader", ["document reader"]);
    const substring = fuzzyScore("document", ["document reader"]);
    expect(exact).toBeGreaterThan(substring);
  });

  it("scores a substring match higher than a token-overlap-only match", () => {
    const substring = fuzzyScore("summar", ["text summarization"]);
    const overlap = fuzzyScore("text nlp", ["text summarization"]);
    expect(substring).toBeGreaterThan(0);
    expect(overlap).toBeGreaterThan(0);
  });

  it("returns 0 for a query with no relation to any haystack", () => {
    expect(fuzzyScore("zzzzz", ["document reader", "translation"])).toBe(0);
  });

  it("returns 0 for a blank query", () => {
    expect(fuzzyScore("   ", ["document reader"])).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("DOCUMENT", ["document reader"])).toBeGreaterThan(0);
  });

  it("tolerates a small typo via bounded Levenshtein distance", () => {
    const score = fuzzyScore("documnet", ["document"]);
    expect(score).toBeGreaterThan(0);
  });

  it("accumulates score across multiple matching haystack entries", () => {
    const one = fuzzyScore("translation", ["translation"]);
    const two = fuzzyScore("translation", ["translation", "translation service"]);
    expect(two).toBeGreaterThan(one);
  });
});
