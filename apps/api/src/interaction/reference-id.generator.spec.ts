import { describe, expect, it } from "vitest";
import {
  normalizeReferenceId,
  REFERENCE_ID_CHARSET,
  ReferenceIdGenerator,
  spokenReferenceId
} from "./reference-id.generator";

describe("ReferenceIdGenerator — format (Sprint 7.12 STEP 2)", () => {
  it("produces PREFIX-SUFFIX with the configured length", () => {
    const generator = new ReferenceIdGenerator({ prefix: "KRV", length: 6 });
    const id = generator.generate();
    expect(id).toMatch(/^KRV-[A-Z0-9]{6}$/);
  });

  it("respects a custom prefix and length", () => {
    const generator = new ReferenceIdGenerator({ prefix: "ACME", length: 8 });
    const id = generator.generate();
    expect(id).toMatch(/^ACME-[A-Z0-9]{8}$/);
  });

  it("never uses ambiguous characters (0, O, 1, I, L) — voice-friendliness", () => {
    expect(REFERENCE_ID_CHARSET).not.toMatch(/[01ILO]/);
    const generator = new ReferenceIdGenerator();
    for (let i = 0; i < 200; i++) {
      const suffix = generator.generate().split("-")[1];
      expect(suffix).not.toMatch(/[01ILO]/);
    }
  });

  it("is never derived from a UUID — pure random charset draw, no hex/UUID shape leaking through", () => {
    const generator = new ReferenceIdGenerator();
    const id = generator.generate();
    expect(id).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/i);
  });
});

describe("ReferenceIdGenerator — uniqueness across many draws", () => {
  it("virtually never repeats across a large sample (31^6 candidate space)", () => {
    const generator = new ReferenceIdGenerator();
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(generator.generate());
    // Collisions are handled by the DB-level retry loop, not by the generator itself — this just
    // documents the candidate space is large enough that collisions are rare, not that they're impossible.
    expect(seen.size).toBeGreaterThan(1990);
  });
});

describe("normalizeReferenceId", () => {
  it("uppercases, strips separators/whitespace, and reinserts the canonical dash", () => {
    expect(normalizeReferenceId("krv 842731", 3)).toBe("KRV-842731");
    expect(normalizeReferenceId("KRV842731", 3)).toBe("KRV-842731");
    expect(normalizeReferenceId(" krv-842731 ", 3)).toBe("KRV-842731");
    expect(normalizeReferenceId("k r v - 8 4 2 7 3 1", 3)).toBe("KRV-842731");
  });

  it("handles a prefix of a different length", () => {
    expect(normalizeReferenceId("acme1234abcd", 4)).toBe("ACME-1234ABCD");
  });

  it("returns the cleaned string unchanged if shorter than the prefix", () => {
    expect(normalizeReferenceId("kr", 3)).toBe("KR");
  });
});

describe("spokenReferenceId (Sprint 7.12 STEP 11/45)", () => {
  it("spaces out every character and drops the dash, without mutating the stored id", () => {
    expect(spokenReferenceId("KRV-842731")).toBe("K R V 8 4 2 7 3 1");
  });
});
