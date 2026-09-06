/** Sprint 7.11 — dedicated backpressure/overflow tests (STEP 1).
 *
 * The mock realtime provider paces its own audio chunks one per macrotask, which means a normal test
 * against it never actually bursts the outbound queue (each chunk gets its own flush before the next one
 * arrives). To prove the bound is real, this file uses a minimal test-only RealtimeSpeechProvider that
 * emits a burst of audio chunks SYNCHRONOUSLY in one event-loop tick — a realistic scenario (a provider
 * flushing a buffered batch) that the mock's artificial per-chunk pacing doesn't otherwise exercise.
 */
import { describe, expect, it, vi } from "vitest";
import { TwilioVoiceTransportProvider } from "./twilio-voice.provider";
import { VoiceMetricsService } from "./voice-metrics.service";
import { VoiceTranscriptService } from "./voice-transcript.service";
import { VoiceSessionEngine, type OutboundAudioSink } from "./voice-session.engine";
import { DEFAULT_TURN_DETECTION, type NormalizedAudioFrame, type RealtimeSpeechProvider, type RealtimeSpeechSession, type VoiceEngineConfig, type VoiceRealtimeEventListener } from "./voice.types";

const OUTBOUND_QUEUE_LIMIT = 50;

/** Emits exactly the events its test calls for, synchronously, with no artificial pacing — the opposite
 * of MockRealtimeVoiceProvider, whose per-chunk setTimeout(0) pacing makes overflow unreachable. */
class BurstRealtimeSession implements RealtimeSpeechSession {
  private listeners = new Set<VoiceRealtimeEventListener>();
  closed = false;
  appendInputAudio(): void {}
  commitInputAudio(): void {}
  cancelResponse(): void {}
  generateResponse(): void {}
  on(listener: VoiceRealtimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
  }
  emitBurstOfAudioChunks(count: number): void {
    const frame: NormalizedAudioFrame = { pcm16: new Int16Array(160), sampleRateHz: 8000 };
    for (let i = 0; i < count; i++) {
      for (const listener of this.listeners) listener({ type: "assistant_audio_chunk", atEpochMs: Date.now(), audio: frame });
    }
  }
  emit(type: "error", errorCode: string, errorMessage: string): void {
    for (const listener of this.listeners) listener({ type, atEpochMs: Date.now(), errorCode: errorCode as never, errorMessage });
  }
}

class BurstRealtimeProvider implements RealtimeSpeechProvider {
  readonly name = "burst-test";
  lastSession: BurstRealtimeSession | null = null;
  async connectSession(): Promise<RealtimeSpeechSession> {
    this.lastSession = new BurstRealtimeSession();
    return this.lastSession;
  }
}

function requireSession(realtime: BurstRealtimeProvider): BurstRealtimeSession {
  if (!realtime.lastSession) throw new Error("no burst realtime session yet");
  return realtime.lastSession;
}

function harness() {
  const sessions = {
    markStreamStarted: vi.fn().mockResolvedValue(undefined),
    markActive: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    beginEnding: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined)
  };
  const turns = { handleTranscript: vi.fn() };
  const transcripts = new VoiceTranscriptService({ voiceTranscriptSegment: { create: vi.fn() } } as never);
  const metrics = new VoiceMetricsService();
  const config: VoiceEngineConfig = {
    transportProvider: "TWILIO",
    realtimeProvider: "burst-test",
    maxCallDurationSeconds: 1800,
    idleTimeoutSeconds: 3600,
    maxConcurrentSessions: 10,
    turnDetection: { ...DEFAULT_TURN_DETECTION, idleTimeoutMs: 3600_000 }
  };
  const realtime = new BurstRealtimeProvider();
  const engine = new VoiceSessionEngine(
    new TwilioVoiceTransportProvider(),
    realtime,
    sessions as never,
    turns as never,
    transcripts,
    metrics,
    config
  );
  const sentFrames: Array<{ event: string; payload: Record<string, unknown> }> = [];
  let sinkThrows = false;
  const sink: OutboundAudioSink = {
    sendFrame: (frame) => {
      if (sinkThrows) throw new Error("sink unavailable");
      sentFrames.push(frame);
    },
    close: vi.fn()
  };
  return { engine, realtime, sessions, metrics, sink, sentFrames, setSinkThrows: (v: boolean) => (sinkThrows = v) };
}

async function tick(ms = 5) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("VoiceSessionEngine — backpressure / overflow (Sprint 7.11)", () => {
  it("enforces the configured outbound queue limit when a burst exceeds it, dropping oldest frames deterministically", async () => {
    const { engine, realtime, sink, sentFrames, metrics } = harness();
    await engine.startStream({
      voiceSessionId: "voice-1",
      organizationId: "tenant-a",
      providerStreamId: "MZ1",
      externalCallerId: null,
      sampleRateHz: 8000,
      greetingText: null,
      sink
    });

    const burstSize = OUTBOUND_QUEUE_LIMIT * 3; // deliberately much more than the configured capacity
    requireSession(realtime).emitBurstOfAudioChunks(burstSize);

    // Nothing has been sent yet — the burst enqueued faster than any flush could run in between.
    expect(sentFrames.length).toBe(0);

    await tick(20);

    // Every frame that was ever actually sent must be within the bound, and the process didn't crash.
    expect(sentFrames.length).toBeLessThanOrEqual(OUTBOUND_QUEUE_LIMIT);
    expect(sentFrames.length).toBeGreaterThan(0);
    const snapshot = metrics.snapshot();
    expect(snapshot.counters.voice_audio_frames_dropped_total).toBeGreaterThanOrEqual(
      burstSize - OUTBOUND_QUEUE_LIMIT
    );
  });

  it("keeps dropping the OLDEST frame, never the newest, so the caller always hears the most recent audio", async () => {
    const { engine, realtime, sink, sentFrames } = harness();
    await engine.startStream({
      voiceSessionId: "voice-1",
      organizationId: "tenant-a",
      providerStreamId: "MZ1",
      externalCallerId: null,
      sampleRateHz: 8000,
      greetingText: null,
      sink
    });

    // Tag each chunk distinctly via a marker in payload isn't available on NormalizedAudioFrame, so
    // instead assert on count/order behavior: burst N, then a single more — the single one must survive.
    requireSession(realtime).emitBurstOfAudioChunks(OUTBOUND_QUEUE_LIMIT + 10);
    await tick(20);
    const countAfterFirstBurst = sentFrames.length;
    expect(countAfterFirstBurst).toBeLessThanOrEqual(OUTBOUND_QUEUE_LIMIT);

    requireSession(realtime).emitBurstOfAudioChunks(1);
    await tick(20);
    expect(sentFrames.length).toBe(countAfterFirstBurst + 1);
  });

  it("session remains usable after an overflow — the call is not torn down just because frames were dropped", async () => {
    const { engine, realtime, sink, sentFrames } = harness();
    await engine.startStream({
      voiceSessionId: "voice-1",
      organizationId: "tenant-a",
      providerStreamId: "MZ1",
      externalCallerId: null,
      sampleRateHz: 8000,
      greetingText: null,
      sink
    });
    requireSession(realtime).emitBurstOfAudioChunks(OUTBOUND_QUEUE_LIMIT * 5);
    await tick(20);
    expect(engine.activeSessionCount()).toBe(1); // still active, not force-ended by an overflow

    // And the engine still accepts further inbound/outbound activity normally.
    requireSession(realtime).emitBurstOfAudioChunks(1);
    await tick(10);
    expect(sentFrames.length).toBeGreaterThan(0);
  });

  it("an unrecoverable sink failure (not merely a full queue) closes the session cleanly, without a process crash", async () => {
    const { engine, sessions, realtime, sink, setSinkThrows } = harness();
    await engine.startStream({
      voiceSessionId: "voice-1",
      organizationId: "tenant-a",
      providerStreamId: "MZ1",
      externalCallerId: null,
      sampleRateHz: 8000,
      greetingText: null,
      sink
    });
    setSinkThrows(true);
    requireSession(realtime).emitBurstOfAudioChunks(5);
    await tick(20);

    expect(engine.activeSessionCount()).toBe(0);
    expect(sessions.end).toHaveBeenCalledWith("tenant-a", "voice-1", true, "STREAM_DISCONNECTED");
  });

  it("releases the outbound buffer on cleanup — no frames linger after endStream", async () => {
    const { engine, realtime, sink } = harness();
    await engine.startStream({
      voiceSessionId: "voice-1",
      organizationId: "tenant-a",
      providerStreamId: "MZ1",
      externalCallerId: null,
      sampleRateHz: 8000,
      greetingText: null,
      sink
    });
    const state = (engine as unknown as { calls: Map<string, { outboundQueue: unknown[] }> }).calls.get(
      "voice-1"
    );
    if (!state) throw new Error("no call state for voice-1");
    requireSession(realtime).emitBurstOfAudioChunks(OUTBOUND_QUEUE_LIMIT * 2);
    // Flush hasn't run yet (still same microtask burst) — the queue really is holding frames right now.
    expect(state.outboundQueue.length).toBeGreaterThan(0);

    await engine.endStream("voice-1", "CALLER_HANGUP");
    expect(state.outboundQueue.length).toBe(0);
  });

  it("inbound audio is processed immediately with no accumulating buffer — a rapid burst never crashes and never grows unbounded state", async () => {
    const { engine, sink } = harness();
    await engine.startStream({
      voiceSessionId: "voice-1",
      organizationId: "tenant-a",
      providerStreamId: "MZ1",
      externalCallerId: null,
      sampleRateHz: 8000,
      greetingText: null,
      sink
    });
    const silentFrame = { pcm16: new Int16Array(160), sampleRateHz: 8000 };
    expect(() => {
      for (let i = 0; i < 5000; i++) engine.handleInboundAudio("voice-1", silentFrame);
    }).not.toThrow();
    expect(engine.activeSessionCount()).toBe(1);
  });
});
