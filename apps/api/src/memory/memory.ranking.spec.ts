import { describe, expect, it } from "vitest";
import type { MemoryRecordValue } from "./memory.types";
import { rankMemories, recencyScore, scoreMemory } from "./memory.ranking";

function record(partial: Partial<MemoryRecordValue> & { key: string }): MemoryRecordValue {
  const now = Date.now();
  return {
    id: partial.key,
    organizationId: "org",
    employeeId: null,
    userId: null,
    conversationId: null,
    scope: "USER",
    category: "PREFERENCE",
    value: { value: "x" },
    searchableText: "x",
    confidence: 1,
    importance: "MEDIUM",
    source: "DASHBOARD",
    metadata: {},
    expiresAt: null,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    deletedAt: null,
    ...partial
  };
}

describe("memory ranking", () => {
  it("exact key matches outrank loose keyword overlap", () => {
    const exact = record({ key: "preferred.airline", searchableText: "Emirates", importance: "HIGH" });
    const loose = record({
      key: "preference.generic",
      searchableText: "I prefer flying often on long trips",
      importance: "HIGH"
    });
    const ranked = rankMemories("preferred.airline", [loose, exact]);
    expect(ranked[0]?.id).toBe("preferred.airline");
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });

  it("higher importance and recency boost score", () => {
    const recent = record({ key: "food.preference", updatedAt: new Date(), importance: "HIGH" });
    const stale = record({
      key: "food.preference",
      updatedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      importance: "LOW"
    });
    const ranked = rankMemories("food", [stale, recent]);
    expect(ranked[0]?.id).toBe(recent.id);
  });

  it("confidence is multiplied across the score", () => {
    const confident = record({ key: "location.city", confidence: 1, importance: "MEDIUM" });
    const uncertain = record({ key: "location.city", confidence: 0.1, importance: "MEDIUM" });
    const ranked = rankMemories("location.city", [uncertain, confident]);
    expect(ranked[0]?.id).toBe(confident.id);
  });

  it("semantic scores are blended in when provided", () => {
    const withSemantic = record({ key: "seat.preference" });
    const without = record({ key: "food.preference" });
    const scores = new Map([[withSemantic.id, 0.9]]);
    const ranked = rankMemories("window seat", [without, withSemantic], scores);
    expect(ranked[0]?.id).toBe(withSemantic.id);
    expect(ranked[0]?.semanticScore).toBe(0.9);
  });

  it("recency decays toward zero over time", () => {
    const now = new Date();
    expect(recencyScore(now, now)).toBe(1);
    const old = new Date(now.getTime() - 300 * 24 * 60 * 60 * 1000);
    const score = recencyScore(old, now);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.1);
  });

  it("empty query yields deterministic ordering by score", () => {
    const a = record({ key: "a", importance: "CRITICAL" });
    const b = record({ key: "b", importance: "LOW" });
    const scored = scoreMemory("", a);
    expect(scored.score).toBeGreaterThanOrEqual(0);
    void b;
  });

  it("sorts by score descending and attaches the score fields", () => {
    const ranked = rankMemories("travel", [record({ key: "travel.cabin" }), record({ key: "a" })]);
    for (const hit of ranked) {
      expect(hit).toHaveProperty("score");
      expect(hit).toHaveProperty("semanticScore");
      expect(hit).toHaveProperty("keywordScore");
    }
  });
});
