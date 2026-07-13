import { describe, expect, it } from "vitest";
import { ApiKeyCrypto } from "./api-key.crypto";
describe("ApiKeyCrypto", () => {
  const crypto = new ApiKeyCrypto("x".repeat(32));
  it("generates, parses, hashes and timing-safely verifies keys", () => {
    const key = crypto.generate("live");
    expect(key.plaintext).toMatch(/^awo_live_/);
    const parsed = crypto.parse(key.plaintext);
    if (!parsed) throw new Error("Generated key did not parse");
    expect(parsed?.publicId).toBe(key.publicId);
    expect(crypto.verify(parsed.secret, key.secretHash)).toBe(true);
    expect(crypto.verify("A".repeat(43), key.secretHash)).toBe(false);
    expect(key.maskedValue).not.toContain(parsed.secret);
  });
  it("rejects malformed keys", () => expect(crypto.parse("awo_live_bad")).toBeNull());
});
