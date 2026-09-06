/** Sprint 7 — MockRealtimeVoiceProvider: the only realtime speech provider that ships enabled by
 * default (VOICE_REALTIME_PROVIDER=mock). It requires no external credentials and exercises the REAL
 * VoiceSessionEngine, agent routing, conversation, and agent execution — only the external speech
 * transformation (STT/TTS) is faked, exactly as required. It implements RealtimeSpeechProvider honestly:
 * appendInputAudio/commitInputAudio work on real (silent, in tests) PCM frames and produce a transcript;
 * `simulateUserUtterance` is an additional, mock-only trigger the simulator/tests use to script a
 * specific caller line without having to synthesize real speech waveforms.
 */
import { Injectable, Optional } from "@nestjs/common";
import type {
  NormalizedAudioFrame,
  RealtimeSpeechProvider,
  RealtimeSpeechSession,
  VoiceRealtimeEvent,
  VoiceRealtimeEventListener
} from "./voice.types";

export interface MockRealtimeSessionOptions {
  /** Milliseconds of simulated processing latency before transcript/response events fire. 0 in tests. */
  simulatedLatencyMs?: number;
  /** Number of assistant_audio_chunk events generateResponse() splits its output into. */
  audioChunkCount?: number;
}

const SILENT_CHUNK: NormalizedAudioFrame = { pcm16: new Int16Array(160), sampleRateHz: 8000 };

class MockRealtimeSession implements RealtimeSpeechSession {
  private listeners = new Set<VoiceRealtimeEventListener>();
  private framesSinceCommit = 0;
  private speechStarted = false;
  private scriptedUtterance: string | null = null;
  private generationToken = 0;
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;
  private readonly latencyMs: number;
  private readonly audioChunkCount: number;

  constructor(
    public readonly voiceSessionId: string,
    options: MockRealtimeSessionOptions
  ) {
    this.latencyMs = options.simulatedLatencyMs ?? 0;
    this.audioChunkCount = Math.max(1, options.audioChunkCount ?? 2);
  }

  /** Mock-only: scripts the exact text the next commitInputAudio() reports as the caller's speech. Used
   * by the simulator and tests instead of synthesizing real waveforms. */
  simulateUserUtterance(text: string): void {
    this.scriptedUtterance = text;
  }

  appendInputAudio(frame: NormalizedAudioFrame): void {
    if (this.closed) return;
    this.framesSinceCommit += frame.pcm16.length;
    if (!this.speechStarted) {
      this.speechStarted = true;
      this.emit({ type: "input_audio_started", atEpochMs: Date.now() });
    }
  }

  commitInputAudio(): void {
    if (this.closed) return;
    this.speechStarted = false;
    this.emit({ type: "input_audio_stopped", atEpochMs: Date.now() });
    const text = this.scriptedUtterance ?? `[mock transcript: ${this.framesSinceCommit} samples]`;
    this.scriptedUtterance = null;
    this.framesSinceCommit = 0;
    this.after(this.latencyMs, () => {
      this.emit({ type: "user_transcript_final", atEpochMs: Date.now(), text, confidence: 0.92 });
    });
  }

  cancelResponse(): void {
    // Invalidate any in-flight generateResponse() loop so no further chunks/finish event fire —
    // guarantees no overlapping assistant responses (STEP 15).
    this.generationToken++;
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
  }

  generateResponse(instructionText = ""): void {
    if (this.closed) return;
    const token = ++this.generationToken;
    this.emit({ type: "assistant_response_started", atEpochMs: Date.now() });
    this.after(this.latencyMs, () => {
      if (token !== this.generationToken) return;
      this.emit({
        type: "assistant_transcript_final",
        atEpochMs: Date.now(),
        text: instructionText
      });
      this.streamAudioChunks(token, instructionText);
    });
  }

  private streamAudioChunks(token: number, text: string): void {
    const chunks = Math.max(1, Math.min(this.audioChunkCount, Math.ceil(text.length / 40) || 1));
    let sent = 0;
    const sendNext = () => {
      if (token !== this.generationToken) return;
      if (sent >= chunks) {
        this.emit({ type: "assistant_response_finished", atEpochMs: Date.now() });
        return;
      }
      sent++;
      this.emit({ type: "assistant_audio_chunk", atEpochMs: Date.now(), audio: SILENT_CHUNK });
      this.after(this.latencyMs, sendNext);
    };
    this.after(this.latencyMs, sendNext);
  }

  on(listener: VoiceRealtimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.generationToken++;
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    this.listeners.clear();
  }

  private emit(event: VoiceRealtimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Always defers via setTimeout, even at 0ms — a synchronous fast-path would make cancelResponse()
   * called "immediately after" generateResponse() unable to ever interrupt it (the whole chain would
   * already have run before cancelResponse() executes). Deferring preserves real interruptibility. */
  private after(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      fn();
    }, Math.max(0, ms));
    this.pendingTimers.add(timer);
  }
}

@Injectable()
export class MockRealtimeVoiceProvider implements RealtimeSpeechProvider {
  readonly name = "mock";
  private readonly sessionsById = new Map<string, MockRealtimeSession>();

  constructor(@Optional() private readonly options: MockRealtimeSessionOptions = {}) {}

  async connectSession(input: {
    voiceSessionId: string;
    organizationId: string;
    sampleRateHz: number;
    locale?: string;
  }): Promise<RealtimeSpeechSession> {
    const session = new MockRealtimeSession(input.voiceSessionId, this.options);
    this.sessionsById.set(input.voiceSessionId, session);
    return session;
  }

  /** Test/simulator-only: looks up the live mock session for a given call so a caller line can be
   * scripted against a real, running VoiceSessionEngine instance (e.g. from an e2e test driving the
   * real webhook + WebSocket surface) without any application code needing to know tests exist. */
  getSession(voiceSessionId: string): MockRealtimeSession | undefined {
    return this.sessionsById.get(voiceSessionId);
  }
}

/** Exposed for the simulator/tests, which need `simulateUserUtterance` beyond the public interface. */
export function asMockSession(session: RealtimeSpeechSession): MockRealtimeSession {
  return session as MockRealtimeSession;
}
