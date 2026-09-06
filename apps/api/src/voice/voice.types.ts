/** Sprint 7 — provider-neutral contracts for real-time voice calling.
 *
 * These interfaces are the seam between transport/speech vendors (Twilio, a future SIP/WebRTC provider,
 * OpenAI/Azure/Sarvam realtime speech, ...) and the VoiceSessionEngine, which never imports a vendor SDK
 * or wire format directly. Business logic (routing, tools, memory, approvals) never sees any of this —
 * it only ever sees AgentService.execute() via VoiceReceptionistTurnService, exactly like WhatsApp text.
 */

/** Internal, normalized audio representation used everywhere above the transport boundary: 16-bit
 * signed PCM, mono, at `sampleRateHz`. Twilio's 8kHz mu-law is converted to/from this at the transport
 * edge (voice-audio-codec.ts) so codec details never leak into the session engine or realtime provider. */
export interface NormalizedAudioFrame {
  pcm16: Int16Array;
  sampleRateHz: number;
}

// ---------------------------------------------------------------------------------------------------
// Transport provider (telephony/call control) — Twilio implements this today.
// ---------------------------------------------------------------------------------------------------

export interface IncomingVoiceWebhookRequest {
  /** Raw form-encoded body fields as received (e.g. Twilio's CallSid/From/To/CallStatus). */
  params: Readonly<Record<string, string>>;
  /** The exact public URL Twilio was configured to POST to — required to recompute the signature. */
  requestUrl: string;
  signatureHeader: string | undefined;
}

export interface IncomingVoiceCall {
  providerCallId: string;
  externalCallerId: string | null;
  toAddress: string | null;
}

export interface MediaConnectionHandshake {
  /** The subprotocol/path-derived correlation the transport gives us at WebSocket connect time — for
   * Twilio this is nothing (correlation only arrives in the first "start" frame); the interface stays
   * generic so a future provider that DOES authenticate at connect time can use this. */
  headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface VoiceTransportProvider {
  readonly name: string;

  /** Verifies the inbound call webhook actually came from the provider. Never trusts obscurity of the
   * URL alone. */
  validateIncomingWebhook(
    request: IncomingVoiceWebhookRequest,
    credentials: { authToken: string }
  ): boolean;

  /** Parses the provider's webhook body into a normalized incoming-call description. */
  parseIncomingCall(request: IncomingVoiceWebhookRequest): IncomingVoiceCall;

  /** Builds the provider's call-control response (e.g. Twilio TwiML) instructing it to open a media
   * stream back to `mediaStreamUrl`. Pure string generation — no I/O, no credentials required. */
  createIncomingCallResponse(input: { mediaStreamUrl: string; providerCallId: string }): {
    contentType: string;
    body: string;
  };

  /** Best-effort validation of a freshly-opened media WebSocket connection before any frames are
   * trusted (e.g. header shape). Real correlation still happens via the provider's own "start" event. */
  validateMediaConnection(handshake: MediaConnectionHandshake): boolean;

  /** Encodes and frames a normalized audio chunk for outbound send over the media stream. */
  encodeOutboundAudio(frame: NormalizedAudioFrame): { event: string; payload: Record<string, unknown> };

  /** Frame instructing the transport to discard any buffered/queued outbound audio immediately —
   * used for barge-in (STEP 15). */
  clearAudioFrame(): { event: string; payload: Record<string, unknown> };

  /** Frame instructing the transport to end the call. */
  closeCallFrame(): { event: string; payload: Record<string, unknown> } | null;
}

// ---------------------------------------------------------------------------------------------------
// Realtime speech provider — either a speech-to-speech vendor or an STT -> LLM -> TTS pipeline. The
// VoiceSessionEngine treats both identically through this one interface.
// ---------------------------------------------------------------------------------------------------

export type VoiceEventType =
  | "input_audio_started"
  | "input_audio_stopped"
  | "user_transcript_partial"
  | "user_transcript_final"
  | "assistant_transcript_partial"
  | "assistant_transcript_final"
  | "assistant_audio_chunk"
  | "assistant_response_started"
  | "assistant_response_finished"
  | "error";

export interface VoiceRealtimeEvent {
  type: VoiceEventType;
  atEpochMs: number;
  text?: string;
  confidence?: number;
  audio?: NormalizedAudioFrame;
  errorCode?: VoiceErrorCode;
  errorMessage?: string;
}

export type VoiceRealtimeEventListener = (event: VoiceRealtimeEvent) => void;

/** One realtime speech session, scoped to a single VoiceSession/call. */
export interface RealtimeSpeechSession {
  appendInputAudio(frame: NormalizedAudioFrame): void;
  /** Signals a turn boundary (e.g. VAD/silence-timeout detected end of user speech) to providers that
   * require an explicit commit rather than continuous streaming. */
  commitInputAudio(): void;
  /** Cancels the assistant's in-flight response generation/playback — barge-in. */
  cancelResponse(): void;
  /** Asks the provider to produce a response for whatever has been committed so far (STT->LLM->TTS
   * pipelines call this explicitly; speech-to-speech providers may no-op if they auto-respond). */
  generateResponse(instructionText?: string): void;
  on(listener: VoiceRealtimeEventListener): () => void;
  close(): Promise<void>;
}

export interface RealtimeSpeechProvider {
  readonly name: string;
  connectSession(input: {
    voiceSessionId: string;
    organizationId: string;
    sampleRateHz: number;
    locale?: string;
  }): Promise<RealtimeSpeechSession>;
}

// ---------------------------------------------------------------------------------------------------
// Normalized domain events — the only vocabulary agent/business code (and observability) ever sees.
// Provider-specific event shapes are translated into these at the transport/realtime boundary.
// ---------------------------------------------------------------------------------------------------

export type NormalizedVoiceEventType =
  | "VOICE_CALL_STARTED"
  | "VOICE_STREAM_STARTED"
  | "USER_SPEECH_STARTED"
  | "USER_AUDIO_RECEIVED"
  | "USER_TRANSCRIPT_PARTIAL"
  | "USER_TRANSCRIPT_FINAL"
  | "AGENT_RESPONSE_STARTED"
  | "AGENT_AUDIO_STARTED"
  | "AGENT_AUDIO_COMPLETED"
  | "USER_INTERRUPTED_AGENT"
  | "VOICE_STREAM_ENDED"
  | "VOICE_CALL_ENDED"
  | "VOICE_CALL_FAILED";

export interface NormalizedVoiceEvent {
  type: NormalizedVoiceEventType;
  voiceSessionId: string;
  organizationId: string;
  atEpochMs: number;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------------
// Errors, turn detection, config
// ---------------------------------------------------------------------------------------------------

export type VoiceErrorCode =
  | "VOICE_PROVIDER_ERROR"
  | "REALTIME_PROVIDER_ERROR"
  | "AUDIO_CODEC_ERROR"
  | "AGENT_EXECUTION_ERROR"
  | "TOOL_EXECUTION_ERROR"
  | "STREAM_DISCONNECTED"
  | "AUTHENTICATION_ERROR"
  | "SESSION_NOT_FOUND"
  | "INVALID_EVENT"
  | "TIMEOUT";

export class VoiceError extends Error {
  constructor(
    public readonly code: VoiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "VoiceError";
  }
}

export interface TurnDetectionConfig {
  /** Below this energy/confidence threshold, incoming audio isn't treated as speech starting. */
  speechStartThreshold: number;
  /** Milliseconds of trailing silence after speech before a turn is considered complete. */
  speechEndSilenceMs: number;
  /** Hard cap on a single user turn, regardless of silence detection — protects against a stuck-open
   * mic/line. */
  maxTurnDurationMs: number;
  /** No audio/activity at all for this long -> the call is ended as idle. */
  idleTimeoutMs: number;
}

export const DEFAULT_TURN_DETECTION: TurnDetectionConfig = {
  speechStartThreshold: 0.02,
  speechEndSilenceMs: 700,
  maxTurnDurationMs: 30_000,
  idleTimeoutMs: 30_000
};

export interface VoiceEngineConfig {
  transportProvider: string;
  realtimeProvider: string;
  maxCallDurationSeconds: number;
  idleTimeoutSeconds: number;
  maxConcurrentSessions: number;
  turnDetection: TurnDetectionConfig;
}

/** DI tokens — the seam that makes both providers genuinely swappable (STEP 10/STEP 35): every consumer
 * (controller, gateway, engine) depends on these interfaces, never on TwilioVoiceTransportProvider or
 * MockRealtimeVoiceProvider by concrete class. */
export const VOICE_TRANSPORT_PROVIDER = Symbol("VoiceTransportProvider");
export const VOICE_REALTIME_SPEECH_PROVIDER = Symbol("VoiceRealtimeSpeechProvider");
