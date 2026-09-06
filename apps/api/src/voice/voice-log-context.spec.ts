import { describe, expect, it } from "vitest";
import { voiceLogContext } from "./voice-log-context";

describe("voiceLogContext — sensitive-field redaction (Sprint 7.11 STEP 3)", () => {
  it("passes known, non-sensitive fields through unchanged", () => {
    const ctx = voiceLogContext({
      event: "VOICE_CALL_STARTED",
      organizationId: "org-1",
      voiceSessionId: "voice-1",
      providerCallId: "CA123",
      latencyMs: 42
    });
    expect(ctx).toEqual({
      event: "VOICE_CALL_STARTED",
      organizationId: "org-1",
      voiceSessionId: "voice-1",
      providerCallId: "CA123",
      latencyMs: 42
    });
  });

  it("drops any key that looks like a credential or secret, even if a caller passes one by mistake", () => {
    const ctx = voiceLogContext({
      event: "VOICE_PROVIDER_ERROR",
      organizationId: "org-1",
      authToken: "should-never-appear",
      TWILIO_AUTH_TOKEN: "should-never-appear",
      password: "should-never-appear",
      apiKey: "should-never-appear",
      Authorization: "Bearer should-never-appear",
      clientSecret: "should-never-appear"
    } as never);
    expect(JSON.stringify(ctx)).not.toContain("should-never-appear");
    expect(ctx).toEqual({ event: "VOICE_PROVIDER_ERROR", organizationId: "org-1" });
  });

  it("truncates an oversized string field instead of logging it in full", () => {
    const ctx = voiceLogContext({ event: "VOICE_CALL_FAILED", errorCode: "X".repeat(500) });
    expect(ctx.errorCode?.length).toBeLessThan(500);
    expect(ctx.errorCode).toContain("(truncated)");
  });

  it("never accepts a raw transcript or audio field — the type has no such field to begin with", () => {
    const ctx = voiceLogContext({
      event: "USER_TRANSCRIPT_FINAL",
      voiceSessionId: "voice-1"
      // no `text`/`transcript`/`audio` field exists on VoiceLogContext — this is a compile-time
      // guarantee, not just a runtime redaction, which this test documents.
    });
    expect(ctx).not.toHaveProperty("text");
    expect(ctx).not.toHaveProperty("transcript");
    expect(ctx).not.toHaveProperty("audio");
  });

  it("omits undefined fields entirely rather than logging them as null/undefined noise", () => {
    const ctx = voiceLogContext({ event: "VOICE_STREAM_STARTED", conversationId: undefined } as never);
    expect(ctx).not.toHaveProperty("conversationId");
  });
});
