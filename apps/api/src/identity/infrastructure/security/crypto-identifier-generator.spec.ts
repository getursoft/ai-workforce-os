import { describe, expect, it } from "vitest";
import { CryptoIdentifierGenerator } from "./crypto-identifier-generator";

describe("CryptoIdentifierGenerator", () => {
  it("generates unique UUID identifiers", () => {
    const generator = new CryptoIdentifierGenerator();
    const first = generator.generate();
    const second = generator.generate();

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });
});
