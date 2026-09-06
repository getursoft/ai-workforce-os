/** Sprint 7 — builds the voice engine's runtime config from AppConfig, and resolves the public WSS URL
 * Twilio's TwiML <Stream> should connect to. Missing REAL provider credentials must never crash the app
 * when RECEPTIONIST_VOICE_ENABLED=false or VOICE_REALTIME_PROVIDER=mock (STEP 34) — this module has no
 * required fields and never throws for the mock path; it only fails fast if a non-mock realtime provider
 * is explicitly requested (checked at the module wiring site, not here).
 */
import type { AppConfig } from "../config/config.tokens";
import { DEFAULT_TURN_DETECTION, type VoiceEngineConfig } from "./voice.types";

export function buildVoiceEngineConfig(config: AppConfig): VoiceEngineConfig {
  return {
    transportProvider: config.string("VOICE_PROVIDER", "twilio"),
    realtimeProvider: config.string("VOICE_REALTIME_PROVIDER", "mock"),
    maxCallDurationSeconds: config.number("VOICE_MAX_CALL_DURATION_SECONDS", 1800),
    idleTimeoutSeconds: config.number("VOICE_IDLE_TIMEOUT_SECONDS", 30),
    maxConcurrentSessions: config.number("VOICE_MAX_CONCURRENT_SESSIONS", 50),
    turnDetection: {
      ...DEFAULT_TURN_DETECTION,
      idleTimeoutMs: config.number("VOICE_IDLE_TIMEOUT_SECONDS", 30) * 1000
    }
  };
}

/** wss://host/... — VOICE_PUBLIC_WS_URL wins when set; otherwise derived from apiPublicUrl
 * (http->ws, https->wss), matching the convention already used for API_PUBLIC_URL/WEB_APP_URL. */
export function resolveVoicePublicWsUrl(config: AppConfig, apiPublicUrl: string): string {
  const configured = config.string("VOICE_PUBLIC_WS_URL", "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  return apiPublicUrl.replace(/^http/, "ws").replace(/\/+$/, "");
}

/** Sprint 7.11 — STEP 17: production must never silently run real calls against the mock provider, and
 * must never silently fall back to mock if a real provider was requested but isn't actually implemented.
 * Pure/testable — called once at module-init time (voice.module.ts's VOICE_REALTIME_SPEECH_PROVIDER
 * factory), not on every request. */
export function validateVoiceRealtimeProviderSelection(input: {
  productionLike: boolean;
  requestedProvider: string;
  allowMockInProduction: boolean;
  implementedProviders: readonly string[];
}): void {
  const { productionLike, requestedProvider, allowMockInProduction, implementedProviders } = input;
  if (requestedProvider === "mock") {
    if (productionLike && !allowMockInProduction) {
      throw new Error(
        "VOICE_MOCK_PROVIDER_NOT_ALLOWED_IN_PRODUCTION: VOICE_REALTIME_PROVIDER=mock is disabled in " +
          "production by default — real calls must never silently be answered by a fake provider. Set " +
          "VOICE_ALLOW_MOCK_IN_PRODUCTION=true only for a deliberate, supervised smoke test, or configure " +
          "a real VOICE_REALTIME_PROVIDER."
      );
    }
    return;
  }
  if (!implementedProviders.includes(requestedProvider)) {
    throw new Error(
      `VOICE_REALTIME_PROVIDER_UNSUPPORTED: "${requestedProvider}" has no implementation yet. Use "mock", ` +
        `or implement RealtimeSpeechProvider for it and bind VOICE_REALTIME_SPEECH_PROVIDER accordingly.`
    );
  }
}

export interface VoicePrivacyConfig {
  /** Days after which transcript segments (VoiceTranscriptSegment rows) are eligible for deletion.
   * NOT enforced automatically yet — see docs/voice-calling.md's Privacy & Retention section. */
  transcriptRetentionDays: number;
  /** Days after which structured voice log events are eligible for deletion. NOT enforced
   * automatically yet — most deployments will rely on their log platform's own retention instead. */
  eventRetentionDays: number;
  /** Whether VoiceCallHistoryService masks externalCallerId before returning it (default true — the
   * raw value is still stored, since the provider needs it to route/re-dial; this only controls what
   * the Call History API and admin UI expose). */
  maskCallerId: boolean;
}

/** Sprint 7.11 — STEP 14: privacy/retention config points. Reads the three VOICE_* privacy env vars
 * into a single typed object so call sites (VoiceCallHistoryService today; a future retention job)
 * don't each re-read raw config. Pure/testable. */
export function resolveVoicePrivacyConfig(config: AppConfig): VoicePrivacyConfig {
  return {
    transcriptRetentionDays: config.number("VOICE_TRANSCRIPT_RETENTION_DAYS", 90),
    eventRetentionDays: config.number("VOICE_EVENT_RETENTION_DAYS", 90),
    maskCallerId: config.boolean("VOICE_MASK_CALLER_ID", true)
  };
}
