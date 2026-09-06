/** Sprint 7 — VoiceSessionEngine: the core real-time orchestration layer.
 *
 * This is the ONLY place that ties transport (Twilio/mock/future providers), realtime speech
 * (mock/future STT+TTS or speech-to-speech), and the EXISTING agent execution pipeline
 * (VoiceReceptionistTurnService -> AgentService.execute()) together. It owns per-call in-memory state
 * (turn detection, backpressure-bounded outbound audio, idle/max-duration timers) — the WebSocket
 * gateway and webhook controller stay thin and delegate everything here (STEP 12).
 *
 * No business logic (routing, tools, memory, approvals) lives here — every user turn goes through the
 * exact same AgentService.execute() entry point web chat and WhatsApp text use.
 */
import { Injectable, Logger } from "@nestjs/common";
import { VoiceSessionService, VoiceReceptionistTurnService } from "../receptionist/voice-channel.adapter";
import { voiceLogContext } from "./voice-log-context";
import { VoiceMetricsService } from "./voice-metrics.service";
import { VoiceTranscriptService } from "./voice-transcript.service";
import {
  DEFAULT_TURN_DETECTION,
  VoiceError,
  type NormalizedAudioFrame,
  type NormalizedVoiceEvent,
  type NormalizedVoiceEventType,
  type RealtimeSpeechProvider,
  type RealtimeSpeechSession,
  type TurnDetectionConfig,
  type VoiceEngineConfig,
  type VoiceRealtimeEvent
} from "./voice.types";
import type { VoiceTransportProvider } from "./voice.types";

const MAX_OUTBOUND_QUEUE_LENGTH = 50;
const SLOW_TURN_ACKNOWLEDGEMENT_DELAY_MS = 2000;
const DEFAULT_SLOW_ACKNOWLEDGEMENT_TEXT = "Sure, I'm checking that for you.";
const DEFAULT_TURN_FAILURE_TEXT = "Sorry, I ran into an issue on my end. Could you say that again?";

/** Sprint 7.11 — failure taxonomy (STEP 10): termination reasons classified as a genuine failure
 * (VoiceSession -> FAILED, voice_calls_failed_total) rather than a normal completion (-> ENDED,
 * voice_calls_completed_total). CALLER_HANGUP / SERVER_SHUTDOWN / IDLE_TIMEOUT / MAX_DURATION_EXCEEDED
 * are policy/expected terminations, not failures — kept out of this set deliberately. */
export const FAILURE_TERMINATION_REASONS = new Set([
  "PROVIDER_ERROR",
  "AGENT_EXECUTION_ERROR",
  "REALTIME_PROVIDER_ERROR",
  "STREAM_DISCONNECTED",
  "AUTHENTICATION_ERROR",
  "AUDIO_CODEC_ERROR",
  "INVALID_EVENT"
]);

export interface OutboundAudioSink {
  sendFrame(frame: { event: string; payload: Record<string, unknown> }): void;
  close(): void;
}

export interface StartStreamInput {
  voiceSessionId: string;
  organizationId: string;
  providerStreamId: string;
  externalCallerId: string | null;
  sampleRateHz: number;
  /** From ChannelConnection.receptionistGreeting — configuration-driven, never hardcoded here. */
  greetingText: string | null;
  sink: OutboundAudioSink;
}

interface CallState {
  organizationId: string;
  voiceSessionId: string;
  realtimeSession: RealtimeSpeechSession;
  transport: VoiceTransportProvider;
  sink: OutboundAudioSink;
  unlisten: () => void;
  transcriptSeq: number;
  turnSeq: number;
  isAgentSpeaking: boolean;
  turnInFlight: boolean;
  outboundQueue: Array<{ event: string; payload: Record<string, unknown> }>;
  outboundFlushScheduled: boolean;
  speechActive: boolean;
  turnStartEpochMs: number;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  maxDurationTimer: ReturnType<typeof setTimeout> | null;
  externalCallerId: string | null;
  startedAtEpochMs: number;
  responseStartedAtEpochMs: number | null;
  firstAudioPendingThisResponse: boolean;
  agentExecutionStartedAtEpochMs: number | null;
  ended: boolean;
}

function computeRms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s = (pcm[i] ?? 0) / 32768;
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / pcm.length);
}

@Injectable()
export class VoiceSessionEngine {
  private readonly logger = new Logger(VoiceSessionEngine.name);
  private readonly calls = new Map<string, CallState>();
  private readonly eventListeners = new Set<(event: NormalizedVoiceEvent) => void>();
  private shuttingDown = false;
  private readonly turnDetection: TurnDetectionConfig;

  constructor(
    private readonly transport: VoiceTransportProvider,
    private readonly realtime: RealtimeSpeechProvider,
    private readonly sessions: VoiceSessionService,
    private readonly turns: VoiceReceptionistTurnService,
    private readonly transcripts: VoiceTranscriptService,
    private readonly metrics: VoiceMetricsService,
    private readonly config: VoiceEngineConfig
  ) {
    this.turnDetection = config.turnDetection ?? DEFAULT_TURN_DETECTION;
  }

  onEvent(listener: (event: NormalizedVoiceEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  activeSessionCount(): number {
    return this.calls.size;
  }

  async startStream(input: StartStreamInput): Promise<void> {
    if (this.shuttingDown)
      throw new VoiceError("VOICE_PROVIDER_ERROR", "Server is shutting down; not accepting new voice streams");
    if (this.calls.size >= this.config.maxConcurrentSessions)
      throw new VoiceError("VOICE_PROVIDER_ERROR", "Maximum concurrent voice sessions reached");
    if (this.calls.has(input.voiceSessionId)) return; // idempotent: duplicate "start" event for the same stream

    await this.sessions.markStreamStarted(input.organizationId, input.voiceSessionId, input.providerStreamId);
    const realtimeSession = await this.realtime.connectSession({
      voiceSessionId: input.voiceSessionId,
      organizationId: input.organizationId,
      sampleRateHz: input.sampleRateHz
    });
    await this.sessions.markActive(input.organizationId, input.voiceSessionId);

    const state: CallState = {
      organizationId: input.organizationId,
      voiceSessionId: input.voiceSessionId,
      realtimeSession,
      transport: this.transport,
      sink: input.sink,
      unlisten: () => undefined,
      transcriptSeq: 0,
      turnSeq: 0,
      isAgentSpeaking: false,
      turnInFlight: false,
      outboundQueue: [],
      outboundFlushScheduled: false,
      speechActive: false,
      turnStartEpochMs: 0,
      silenceTimer: null,
      idleTimer: null,
      maxDurationTimer: null,
      externalCallerId: input.externalCallerId,
      startedAtEpochMs: Date.now(),
      responseStartedAtEpochMs: null,
      firstAudioPendingThisResponse: false,
      agentExecutionStartedAtEpochMs: null,
      ended: false
    };
    state.unlisten = realtimeSession.on((event) => this.handleRealtimeEvent(state, event));
    this.calls.set(input.voiceSessionId, state);
    this.metrics.increment("voice_calls_started_total");
    this.metrics.sessionStarted();
    this.armIdleTimer(state);
    state.maxDurationTimer = setTimeout(
      () => void this.endStream(state.voiceSessionId, "MAX_DURATION_EXCEEDED"),
      this.config.maxCallDurationSeconds * 1000
    );
    this.emit("VOICE_STREAM_STARTED", state);

    if (input.greetingText && input.greetingText.trim()) {
      realtimeSession.generateResponse(input.greetingText.trim());
    }
  }

  handleInboundAudio(voiceSessionId: string, frame: NormalizedAudioFrame): void {
    const state = this.calls.get(voiceSessionId);
    if (!state || state.ended) return;
    this.armIdleTimer(state);
    state.realtimeSession.appendInputAudio(frame);
    this.emit("USER_AUDIO_RECEIVED", state);

    const rms = computeRms(frame.pcm16);
    const isSpeech = rms > this.turnDetection.speechStartThreshold;
    if (isSpeech) {
      if (!state.speechActive) {
        state.speechActive = true;
        state.turnStartEpochMs = Date.now();
        this.emit("USER_SPEECH_STARTED", state);
      }
      if (state.silenceTimer) {
        clearTimeout(state.silenceTimer);
        state.silenceTimer = null;
      }
      if (Date.now() - state.turnStartEpochMs > this.turnDetection.maxTurnDurationMs) this.commitTurn(state);
    } else if (state.speechActive && !state.silenceTimer) {
      state.silenceTimer = setTimeout(() => {
        state.silenceTimer = null;
        this.commitTurn(state);
      }, this.turnDetection.speechEndSilenceMs);
    }
  }

  /** Explicit-commit turn detection mode (STEP 14) — also used by the simulator/push-to-talk UIs to
   * force a turn boundary deterministically instead of waiting on the silence timer. Independent of the
   * VAD-derived speechActive flag by design: an explicit commit is a distinct turn-detection mode, not
   * a shortcut through the silence-timeout path. */
  forceEndOfTurn(voiceSessionId: string): void {
    const state = this.calls.get(voiceSessionId);
    if (!state || state.ended) return;
    if (state.silenceTimer) {
      clearTimeout(state.silenceTimer);
      state.silenceTimer = null;
    }
    state.speechActive = false;
    state.realtimeSession.commitInputAudio();
  }

  /** VAD-derived silence-timeout commit — only fires if speech was actually detected first. */
  private commitTurn(state: CallState): void {
    if (state.silenceTimer) {
      clearTimeout(state.silenceTimer);
      state.silenceTimer = null;
    }
    if (!state.speechActive) return;
    state.speechActive = false;
    state.realtimeSession.commitInputAudio();
  }

  handleMark(voiceSessionId: string, markName: string): void {
    // Twilio's "mark" acknowledges a previously-sent audio checkpoint reached playback. Not required for
    // correctness today (barge-in cancellation is handled via the realtime provider's own generation
    // token, not mark-based timing) — intentionally a documented no-op rather than a TODO stub.
    void voiceSessionId;
    void markName;
  }

  async endStream(voiceSessionId: string, reason: string): Promise<void> {
    const state = this.calls.get(voiceSessionId);
    if (!state || state.ended) return; // idempotent — repeated stop/disconnect events are harmless
    state.ended = true;
    this.calls.delete(voiceSessionId);
    if (state.idleTimer) clearTimeout(state.idleTimer);
    if (state.maxDurationTimer) clearTimeout(state.maxDurationTimer);
    if (state.silenceTimer) clearTimeout(state.silenceTimer);
    // Null out (not just clear) — an explicit signal that cleanup fully released these, not just a
    // destroyed-but-still-referenced timer handle.
    state.idleTimer = null;
    state.maxDurationTimer = null;
    state.silenceTimer = null;
    state.outboundQueue.length = 0; // release buffered audio — nothing further is ever sent after cleanup
    state.unlisten();
    try {
      await state.realtimeSession.close();
    } catch (error) {
      this.logger.warn(
        voiceLogContext({
          event: "VOICE_REALTIME_SESSION_CLOSE_FAILED",
          organizationId: state.organizationId,
          voiceSessionId,
          errorCode: (error as Error).message
        })
      );
    }
    const failed = FAILURE_TERMINATION_REASONS.has(reason);
    try {
      await this.sessions.beginEnding(state.organizationId, voiceSessionId);
      await this.sessions.end(state.organizationId, voiceSessionId, failed, reason);
    } catch (error) {
      this.logger.warn(
        voiceLogContext({
          event: "VOICE_SESSION_PERSIST_END_FAILED",
          organizationId: state.organizationId,
          voiceSessionId,
          errorCode: (error as Error).message
        })
      );
    }
    this.metrics.increment(failed ? "voice_calls_failed_total" : "voice_calls_completed_total");
    this.metrics.observe("voice_call_duration_seconds", (Date.now() - state.startedAtEpochMs) / 1000);
    this.metrics.sessionEnded();
    this.emit(failed ? "VOICE_CALL_FAILED" : "VOICE_CALL_ENDED", state, { reason });
    try {
      state.sink.close();
    } catch {
      // caller already gone — nothing to do
    }
  }

  /** STEP 29 — graceful server shutdown: stop accepting new streams, cleanly end every active one. */
  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all([...this.calls.keys()].map((id) => this.endStream(id, "SERVER_SHUTDOWN")));
  }

  // -----------------------------------------------------------------------------------------------
  // Realtime provider events -> transcript persistence, outbound audio, and agent turns
  // -----------------------------------------------------------------------------------------------

  private handleRealtimeEvent(state: CallState, event: VoiceRealtimeEvent): void {
    switch (event.type) {
      case "input_audio_started":
      case "input_audio_stopped":
        return;
      case "user_transcript_partial":
        if (event.text) this.persistTranscript(state, "USER", event.text, false);
        this.emit("USER_TRANSCRIPT_PARTIAL", state, { text: event.text });
        return;
      case "user_transcript_final": {
        const text = event.text ?? "";
        this.persistTranscript(state, "USER", text, true, event.confidence);
        this.emit("USER_TRANSCRIPT_FINAL", state, { text });
        // Latency metrics (STEP 11): speech-start -> final-transcript. Only meaningful when this turn
        // actually went through VAD-detected speech (turnStartEpochMs > 0) — a forceEndOfTurn() commit
        // with no real audio has no genuine "speech start" to measure from.
        if (state.turnStartEpochMs > 0) {
          this.metrics.observe("voice_speech_to_transcript_latency_ms", event.atEpochMs - state.turnStartEpochMs);
        }
        void this.handleUserTurn(state, text, event.atEpochMs);
        return;
      }
      case "assistant_transcript_partial":
        return;
      case "assistant_transcript_final":
        if (event.text) this.persistTranscript(state, "AGENT", event.text, true);
        return;
      case "assistant_audio_chunk":
        if (event.audio) {
          if (state.firstAudioPendingThisResponse && state.responseStartedAtEpochMs !== null) {
            this.metrics.observe("voice_first_audio_latency_ms", Date.now() - state.responseStartedAtEpochMs);
            state.firstAudioPendingThisResponse = false;
          }
          this.pushOutbound(state, this.transport.encodeOutboundAudio(event.audio));
        }
        return;
      case "assistant_response_started":
        state.isAgentSpeaking = true;
        state.responseStartedAtEpochMs = Date.now();
        state.firstAudioPendingThisResponse = true;
        this.emit("AGENT_RESPONSE_STARTED", state);
        this.emit("AGENT_AUDIO_STARTED", state);
        return;
      case "assistant_response_finished":
        state.isAgentSpeaking = false;
        if (state.responseStartedAtEpochMs !== null) {
          this.metrics.observe("voice_response_latency_ms", Date.now() - state.responseStartedAtEpochMs);
          state.responseStartedAtEpochMs = null;
        }
        this.metrics.increment("voice_agent_turns_total");
        this.emit("AGENT_AUDIO_COMPLETED", state);
        return;
      case "error":
        this.logger.warn(
          voiceLogContext({
            event: "VOICE_REALTIME_PROVIDER_ERROR",
            organizationId: state.organizationId,
            voiceSessionId: state.voiceSessionId,
            errorCode: event.errorCode ?? event.errorMessage ?? "unknown_realtime_error"
          })
        );
        void this.endStream(state.voiceSessionId, "REALTIME_PROVIDER_ERROR");
        return;
    }
  }

  private persistTranscript(
    state: CallState,
    speaker: "USER" | "AGENT" | "SYSTEM",
    text: string,
    isFinal: boolean,
    confidence?: number
  ): void {
    const sequenceNumber = state.transcriptSeq++;
    void this.transcripts.append({
      organizationId: state.organizationId,
      voiceSessionId: state.voiceSessionId,
      speaker: speaker as never,
      text,
      isFinal,
      sequenceNumber,
      ...(confidence !== undefined ? { confidence } : {})
    });
  }

  private async handleUserTurn(state: CallState, text: string, speechEndedAtEpochMs: number): Promise<void> {
    if (!text.trim() || state.turnInFlight) return;
    state.turnInFlight = true;
    let slowAckTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      if (state.isAgentSpeaking) {
        // Barge-in (STEP 15): cancel generation, clear buffered outbound audio, tell the transport to
        // discard anything already sent-but-unplayed, and resume the session before processing the turn.
        try {
          await this.sessions.interrupt(state.organizationId, state.voiceSessionId);
        } catch (error) {
          this.logger.warn(
            voiceLogContext({
              event: "VOICE_SESSION_INTERRUPT_PERSIST_FAILED",
              organizationId: state.organizationId,
              voiceSessionId: state.voiceSessionId,
              errorCode: (error as Error).message
            })
          );
        }
        state.realtimeSession.cancelResponse();
        state.outboundQueue.length = 0;
        this.pushOutbound(state, this.transport.clearAudioFrame());
        state.isAgentSpeaking = false;
        this.metrics.increment("voice_interruptions_total");
        this.emit("USER_INTERRUPTED_AGENT", state);
        try {
          await this.sessions.resume(state.organizationId, state.voiceSessionId);
        } catch (error) {
          this.logger.warn(
            voiceLogContext({
              event: "VOICE_SESSION_RESUME_PERSIST_FAILED",
              organizationId: state.organizationId,
              voiceSessionId: state.voiceSessionId,
              errorCode: (error as Error).message
            })
          );
        }
      }

      this.metrics.increment("voice_user_turns_total");
      const requestId = `voice-${state.voiceSessionId}-${++state.turnSeq}`;
      slowAckTimer = setTimeout(() => {
        state.realtimeSession.generateResponse(DEFAULT_SLOW_ACKNOWLEDGEMENT_TEXT);
      }, SLOW_TURN_ACKNOWLEDGEMENT_DELAY_MS);

      state.agentExecutionStartedAtEpochMs = Date.now();
      const outcome = await this.turns.handleTranscript({
        organizationId: state.organizationId,
        sessionId: state.voiceSessionId,
        transcript: text,
        customerExternalId: state.externalCallerId ?? "unknown-caller",
        requestId,
        speechEndedAtEpochMs
      });
      if (state.agentExecutionStartedAtEpochMs !== null) {
        this.metrics.observe("voice_agent_execution_latency_ms", Date.now() - state.agentExecutionStartedAtEpochMs);
        state.agentExecutionStartedAtEpochMs = null;
      }
      if (slowAckTimer) {
        clearTimeout(slowAckTimer);
        slowAckTimer = null;
      }
      const response = (outcome.result as { response?: unknown } | undefined)?.response;
      const responseText = typeof response === "string" && response.trim() ? response : outcome.acknowledgement;
      state.realtimeSession.generateResponse(responseText);
    } catch (error) {
      if (slowAckTimer) clearTimeout(slowAckTimer);
      if (state.agentExecutionStartedAtEpochMs !== null) {
        this.metrics.observe("voice_agent_execution_latency_ms", Date.now() - state.agentExecutionStartedAtEpochMs);
        state.agentExecutionStartedAtEpochMs = null;
      }
      const message = error instanceof Error ? error.message : "unknown error";
      this.logger.warn(
        voiceLogContext({
          event: "VOICE_AGENT_EXECUTION_ERROR",
          organizationId: state.organizationId,
          voiceSessionId: state.voiceSessionId,
          errorCode: message
        })
      );
      const fatal = message === "VOICE_RECEPTIONIST_SCOPE_INVALID" || message === "RECEPTIONIST_VOICE_DISABLED";
      if (!fatal) state.realtimeSession.generateResponse(DEFAULT_TURN_FAILURE_TEXT);
      if (fatal) await this.endStream(state.voiceSessionId, "AGENT_EXECUTION_ERROR");
    } finally {
      state.turnInFlight = false;
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Backpressure-bounded outbound audio (STEP 16)
  // -----------------------------------------------------------------------------------------------

  /** Enqueues a frame and schedules (at most once per synchronous burst) a microtask to drain it. Not
   * flushing inline is deliberate: it's what makes the bound below actually reachable — a burst of N
   * chunks emitted synchronously (a realistic realtime-provider behavior, and exactly what the
   * dedicated overflow tests provoke) all enqueue before the first one is ever sent, so the drop-oldest
   * bound has something real to enforce instead of only ever seeing a queue of length 0 or 1. */
  private pushOutbound(state: CallState, frame: { event: string; payload: Record<string, unknown> }): void {
    if (state.outboundQueue.length >= MAX_OUTBOUND_QUEUE_LENGTH) {
      state.outboundQueue.shift();
      this.metrics.increment("voice_audio_frames_dropped_total");
      this.logger.warn(
        voiceLogContext({
          event: "VOICE_QUEUE_OVERFLOW",
          organizationId: state.organizationId,
          voiceSessionId: state.voiceSessionId,
          errorCode: `outbound_queue_limit_${MAX_OUTBOUND_QUEUE_LENGTH}`
        })
      );
    }
    state.outboundQueue.push(frame);
    if (!state.outboundFlushScheduled) {
      state.outboundFlushScheduled = true;
      queueMicrotask(() => {
        state.outboundFlushScheduled = false;
        this.flushOutbound(state);
      });
    }
  }

  private flushOutbound(state: CallState): void {
    while (state.outboundQueue.length > 0) {
      const frame = state.outboundQueue.shift();
      if (!frame) continue;
      try {
        state.sink.sendFrame(frame);
      } catch (error) {
        this.logger.warn(
          voiceLogContext({
            event: "VOICE_STREAM_ERROR",
            organizationId: state.organizationId,
            voiceSessionId: state.voiceSessionId,
            errorCode: (error as Error).message
          })
        );
        state.outboundQueue.length = 0;
        void this.endStream(state.voiceSessionId, "STREAM_DISCONNECTED");
        return;
      }
    }
  }

  private armIdleTimer(state: CallState): void {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(
      () => void this.endStream(state.voiceSessionId, "IDLE_TIMEOUT"),
      this.turnDetection.idleTimeoutMs
    );
  }

  private emit(
    type: NormalizedVoiceEventType,
    state: CallState,
    data?: Record<string, unknown>
  ): void {
    const event: NormalizedVoiceEvent = {
      type,
      voiceSessionId: state.voiceSessionId,
      organizationId: state.organizationId,
      atEpochMs: Date.now(),
      ...(data ? { data } : {})
    };
    for (const listener of this.eventListeners) listener(event);
  }
}
