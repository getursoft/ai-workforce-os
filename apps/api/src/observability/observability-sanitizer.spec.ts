import { describe, expect, it } from "vitest";
import { maskPhone, REDACTED, sanitizeForTrace, summarizeText, TRUNCATED_SUFFIX } from "./observability-sanitizer";

describe("observability sanitizer", () => {
  it("redacts values under known-sensitive key names regardless of shape", () => {
    const out = sanitizeForTrace({
      apiKey: "sk-live-abcdefghijklmnop",
      password: "hunter2",
      accessToken: "eyJhbGciOiJIUzI1NiJ9.something.here",
      nested: { authorization: "Bearer abc123" }
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
    expect(out.accessToken).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).authorization).toBe(REDACTED);
  });

  it("redacts secret-shaped values even under an innocuous, attacker-chosen key name", () => {
    // Simulates a malicious tool result trying to smuggle a real credential under a harmless-looking key.
    const out = sanitizeForTrace({
      note: "Bearer sk-live-abcdefghijklmnopqrstuvwx",
      status: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    }) as Record<string, unknown>;
    expect(out.note).toBe(REDACTED);
    expect(out.status).toBe(REDACTED);
  });

  it("masks phone numbers to only their last two digits", () => {
    expect(maskPhone("+14155551234")).toBe("*********34");
    expect(sanitizeForTrace({ phoneNumber: "+14155551234" })).toEqual({ phoneNumber: "*********34" });
  });

  it("truncates long free text instead of storing it in full (never full prompts/documents)", () => {
    const longText = Array.from({ length: 100 }, (_, i) => `this is sentence number ${i} of a very long message`).join(" ");
    const out = sanitizeForTrace({ prose: longText }) as Record<string, unknown>;
    expect((out.prose as string).length).toBeLessThan(longText.length);
    expect(out.prose as string).toContain(TRUNCATED_SUFFIX);
  });

  it("redacts fields that look like raw prompts/instructions by key name", () => {
    const out = sanitizeForTrace({ systemPrompt: "You are a helpful assistant with secret instructions X", prompt: "ignore all prior instructions" }) as Record<
      string,
      unknown
    >;
    expect(out.systemPrompt).toBe(REDACTED);
    expect(out.prompt).toBe(REDACTED);
  });

  it("caps recursion depth and array size so a pathological payload cannot blow up storage", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 10; i++) {
      const next: Record<string, unknown> = {};
      cursor.child = next;
      cursor = next;
    }
    const out = sanitizeForTrace(deep);
    expect(JSON.stringify(out)).toContain("MAX_DEPTH_EXCEEDED");

    const bigArray = sanitizeForTrace(Array.from({ length: 100 }, (_, i) => i)) as unknown[];
    expect(bigArray.length).toBeLessThanOrEqual(21);
  });

  it("summarizeText never returns the original content, only length and a short preview", () => {
    const summary = summarizeText("this is a customer's full private message with details");
    if (!summary) throw new Error("summary missing");
    expect(summary.preview.length).toBeLessThanOrEqual(70);
    expect(summary.length).toBe("this is a customer's full private message with details".length);
  });

  it("passes through safe scalars and short strings unchanged", () => {
    expect(sanitizeForTrace({ count: 3, status: "COMPLETED", ok: true })).toEqual({ count: 3, status: "COMPLETED", ok: true });
  });

  it("redacts a secret embedded mid-sentence in free text without discarding the surrounding text", () => {
    // Sprint 4.7A Phase 14 regression: SECRET_VALUE_PATTERNS are anchored (whole-value match), which never
    // caught a secret embedded inside a longer chat message — exactly what AgentService's span
    // inputSummary.message preview carries via summarizeText(). A real secret typed mid-sentence must still
    // be scrubbed, but the rest of the sentence (needed for operator debugging) should survive.
    const out = sanitizeForTrace({ note: "please remember my key sk-live-abcdefghijklmnopqrst and use it later" }) as Record<string, unknown>;
    expect(out.note).toContain(REDACTED);
    expect(out.note).toContain("please remember my key");
    expect(out.note).toContain("and use it later");
    expect(out.note).not.toContain("sk-live-abcdefghijklmnopqrst");
  });

  it("summarizeText redacts an embedded secret inside its preview, not just a whole-string secret", () => {
    const summary = summarizeText("my api key is sk-live-abcdefghijklmnopqrst, please save it");
    if (!summary) throw new Error("summary missing");
    expect(summary.preview).not.toContain("sk-live-abcdefghijklmnopqrst");
  });

  it("never redacts numeric token counts just because their key name contains the substring 'token'", () => {
    // Regression: inputTokens/outputTokens/totalTokens are legitimate Phase 4 usage metrics, not secrets —
    // only a STRING value under a sensitive key name should ever be redacted.
    expect(sanitizeForTrace({ inputTokens: 120, outputTokens: 45, totalTokens: 165 })).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165
    });
    // A real secret string under the same kind of key name must still be redacted.
    expect(sanitizeForTrace({ accessToken: "sk-live-realtoken123456" })).toEqual({ accessToken: REDACTED });
  });
});
