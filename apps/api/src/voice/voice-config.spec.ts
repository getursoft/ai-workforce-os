import { describe, expect, it } from "vitest";
import { resolveVoicePrivacyConfig, resolveVoicePublicWsUrl, validateVoiceRealtimeProviderSelection } from "./voice-config";

describe("validateVoiceRealtimeProviderSelection (Sprint 7.11 STEP 17)", () => {
  it("allows mock in development/test with no opt-in required", () => {
    expect(() =>
      validateVoiceRealtimeProviderSelection({
        productionLike: false,
        requestedProvider: "mock",
        allowMockInProduction: false,
        implementedProviders: []
      })
    ).not.toThrow();
  });

  it("rejects mock in production without an explicit opt-in", () => {
    expect(() =>
      validateVoiceRealtimeProviderSelection({
        productionLike: true,
        requestedProvider: "mock",
        allowMockInProduction: false,
        implementedProviders: []
      })
    ).toThrowError(/VOICE_MOCK_PROVIDER_NOT_ALLOWED_IN_PRODUCTION/);
  });

  it("allows mock in production only with the explicit opt-in flag", () => {
    expect(() =>
      validateVoiceRealtimeProviderSelection({
        productionLike: true,
        requestedProvider: "mock",
        allowMockInProduction: true,
        implementedProviders: []
      })
    ).not.toThrow();
  });

  it("fails fast for an unimplemented real provider, in any environment — never silently falls back to mock", () => {
    expect(() =>
      validateVoiceRealtimeProviderSelection({
        productionLike: false,
        requestedProvider: "openai-realtime",
        allowMockInProduction: false,
        implementedProviders: []
      })
    ).toThrowError(/VOICE_REALTIME_PROVIDER_UNSUPPORTED/);
    expect(() =>
      validateVoiceRealtimeProviderSelection({
        productionLike: true,
        requestedProvider: "openai-realtime",
        allowMockInProduction: false,
        implementedProviders: []
      })
    ).toThrowError(/VOICE_REALTIME_PROVIDER_UNSUPPORTED/);
  });

  it("allows a real provider once it is registered as implemented", () => {
    expect(() =>
      validateVoiceRealtimeProviderSelection({
        productionLike: true,
        requestedProvider: "openai-realtime",
        allowMockInProduction: false,
        implementedProviders: ["openai-realtime"]
      })
    ).not.toThrow();
  });
});

describe("resolveVoicePrivacyConfig (Sprint 7.11 STEP 14)", () => {
  it("defaults to 90-day retention and masked caller ids when nothing is configured", () => {
    const config = { number: (_: string, fallback?: number) => fallback ?? 0, boolean: (_: string, fallback?: boolean) => fallback ?? false };
    expect(resolveVoicePrivacyConfig(config as never)).toEqual({
      transcriptRetentionDays: 90,
      eventRetentionDays: 90,
      maskCallerId: true
    });
  });

  it("reads explicit overrides for each field independently", () => {
    const values: Record<string, number | boolean> = {
      VOICE_TRANSCRIPT_RETENTION_DAYS: 30,
      VOICE_EVENT_RETENTION_DAYS: 14,
      VOICE_MASK_CALLER_ID: false
    };
    const config = {
      number: (name: string, fallback?: number) => (values[name] as number) ?? fallback ?? 0,
      boolean: (name: string, fallback?: boolean) => (values[name] as boolean) ?? fallback ?? false
    };
    expect(resolveVoicePrivacyConfig(config as never)).toEqual({
      transcriptRetentionDays: 30,
      eventRetentionDays: 14,
      maskCallerId: false
    });
  });
});

describe("resolveVoicePublicWsUrl", () => {
  it("prefers the explicit VOICE_PUBLIC_WS_URL override when set", () => {
    const config = { string: (name: string) => (name === "VOICE_PUBLIC_WS_URL" ? "wss://voice.example.com/" : "") };
    expect(resolveVoicePublicWsUrl(config as never, "https://api.example.com")).toBe("wss://voice.example.com");
  });

  it("derives ws(s):// from apiPublicUrl when unset", () => {
    const config = { string: () => "" };
    expect(resolveVoicePublicWsUrl(config as never, "https://api.example.com")).toBe("wss://api.example.com");
    expect(resolveVoicePublicWsUrl(config as never, "http://localhost:4000")).toBe("ws://localhost:4000");
  });
});
