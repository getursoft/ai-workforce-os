import { describe, expect, it, vi } from "vitest";
import { TwilioVoiceTransportProvider } from "./twilio-voice.provider";
import { asMockSession, MockRealtimeVoiceProvider } from "./voice-mock-realtime.provider";
import type { RealtimeSpeechSession } from "./voice.types";
import { VoiceMetricsService } from "./voice-metrics.service";
import { VoiceTranscriptService } from "./voice-transcript.service";
import { VoiceSessionEngine, type OutboundAudioSink } from "./voice-session.engine";
import { DEFAULT_TURN_DETECTION, type VoiceEngineConfig } from "./voice.types";

function harness(
  overrides?: Partial<VoiceEngineConfig>,
  realtimeOptions?: { simulatedLatencyMs?: number; audioChunkCount?: number }
) {
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
    realtimeProvider: "mock",
    maxCallDurationSeconds: 1800,
    idleTimeoutSeconds: 3600,
    maxConcurrentSessions: 2,
    turnDetection: { ...DEFAULT_TURN_DETECTION, speechEndSilenceMs: 20, idleTimeoutMs: 3600_000 },
    ...overrides
  };
  const realtime = new MockRealtimeVoiceProvider({
    simulatedLatencyMs: 0,
    audioChunkCount: 1,
    ...realtimeOptions
  });
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
  const sink: OutboundAudioSink = {
    sendFrame: (frame) => sentFrames.push(frame),
    close: vi.fn()
  };
  return { engine, sessions, turns, metrics, sink, sentFrames };
}

const AUDIO_FRAME = { pcm16: new Int16Array(160), sampleRateHz: 8000 };

/** Test-only: reaches into the engine's private call map to get at the realtime session for a given
 * voiceSessionId, so tests can script caller utterances via MockRealtimeVoiceProvider directly. */
function realtimeSessionFor(engine: unknown, voiceSessionId: string): RealtimeSpeechSession {
  const calls = (engine as { calls: Map<string, { realtimeSession: RealtimeSpeechSession }> }).calls;
  const state = calls.get(voiceSessionId);
  if (!state) throw new Error(`no call state for ${voiceSessionId}`);
  return state.realtimeSession;
}

function agentSpeakingFor(engine: unknown, voiceSessionId: string): boolean {
  const calls = (engine as { calls: Map<string, { isAgentSpeaking: boolean }> }).calls;
  return calls.get(voiceSessionId)?.isAgentSpeaking ?? false;
}

async function tick(ms = 40) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("VoiceSessionEngine", () => {
  it("starts a stream, speaks the configured greeting, and marks the session active", async () => {
    const { engine, sessions, sink, sentFrames } = harness();
    await engine.startStream({
      voiceSessionId: "voice-1",
      organizationId: "tenant-a",
      providerStreamId: "MZ1",
      externalCallerId: "+15551234567",
      sampleRateHz: 8000,
      greetingText: "Hi, you've reached Krevia. How can I help you today?",
      sink
    });
    expect(sessions.markStreamStarted).toHaveBeenCalledWith("tenant-a", "voice-1", "MZ1");
    expect(sessions.markActive).toHaveBeenCalledWith("tenant-a", "voice-1");
    await tick();
    expect(sentFrames.length).toBeGreaterThan(0);
    expect(engine.activeSessionCount()).toBe(1);
  });

  it("runs a full turn: transcript -> AgentService -> spoken response -> outbound audio", async () => {
    const { engine, turns, sink, sentFrames } = harness();
    turns.handleTranscript.mockResolvedValue({
      acknowledgement: "Sure, I'm connecting you with the right specialist.",
      result: { response: "Sure — where are you travelling from?" }
    });
    await engine.startStream({
      voiceSessionId: "voice-1",
      organizationId: "tenant-a",
      providerStreamId: "MZ1",
      externalCallerId: "+15551234567",
      sampleRateHz: 8000,
      greetingText: null,
      sink
    });

    asMockSession(realtimeSessionFor(engine, "voice-1")).simulateUserUtterance(
      "I want to plan a trip to Dubai."
    );
    engine.handleInboundAudio("voice-1", AUDIO_FRAME);
    engine.forceEndOfTurn("voice-1");

    await tick(50);
    expect(turns.handleTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "tenant-a",
        sessionId: "voice-1",
        transcript: "I want to plan a trip to Dubai.",
        customerExternalId: "+15551234567"
      })
    );
    expect(sentFrames.some((f) => f.event === "media")).toBe(true);
  });

  it("barge-in: caller speech while the agent is talking cancels the response and clears outbound audio", async () => {
    // A slower, multi-chunk response deliberately keeps the agent "speaking" long enough for the test to
    // interrupt it mid-stream, instead of racing a same-tick response completion.
    const { engine, sessions, turns, sink, sentFrames } = harness(undefined, {
      simulatedLatencyMs: 40,
      audioChunkCount: 6
    });
    turns.handleTranscript.mockResolvedValue({
      acknowledgement: "ack",
      result: { response: "Your Dubai trip would cost approximately five thousand dollars and would include..." }
    });
    await engine.startStream({
      voiceSessionId: "voice-1",
      organizationId: "tenant-a",
      providerStreamId: "MZ1",
      externalCallerId: "+15551234567",
      sampleRateHz: 8000,
      greetingText: null,
      sink
    });
    const mockSession = asMockSession(realtimeSessionFor(engine, "voice-1"));

    mockSession.simulateUserUtterance("Plan a trip to Dubai.");
    engine.handleInboundAudio("voice-1", AUDIO_FRAME);
    engine.forceEndOfTurn("voice-1");
    // commit(40ms) -> transcript_final(+40ms) -> first audio chunk(+40ms) ≈ 120ms before any audio is
    // sent; the full 6-chunk response takes ≈360ms+ to finish, so 160ms is well within "still speaking".
    await tick(160);
    expect(sentFrames.some((f) => f.event === "media")).toBe(true);
    expect(agentSpeakingFor(engine, "voice-1")).toBe(true);

    // Caller interrupts mid-response.
    mockSession.simulateUserUtterance("Wait, make it three people.");
    engine.handleInboundAudio("voice-1", AUDIO_FRAME);
    engine.forceEndOfTurn("voice-1");
    // The interrupting turn's own commit -> user_transcript_final cycle also takes ≈40ms (latencyMs).
    await tick(60);

    expect(sessions.interrupt).toHaveBeenCalledWith("tenant-a", "voice-1");
    expect(sessions.resume).toHaveBeenCalledWith("tenant-a", "voice-1");
    expect(sentFrames.some((f) => f.event === "clear")).toBe(true);
  });

  it("rejects a new stream once the configured concurrency limit is reached", async () => {
    const { engine, sink } = harness({ maxConcurrentSessions: 1 });
    await engine.startStream({
      voiceSessionId: "voice-1",
      organizationId: "tenant-a",
      providerStreamId: "MZ1",
      externalCallerId: null,
      sampleRateHz: 8000,
      greetingText: null,
      sink
    });
    await expect(
      engine.startStream({
        voiceSessionId: "voice-2",
        organizationId: "tenant-a",
        providerStreamId: "MZ2",
        externalCallerId: null,
        sampleRateHz: 8000,
        greetingText: null,
        sink
      })
    ).rejects.toThrowError(expect.objectContaining({ code: "VOICE_PROVIDER_ERROR" }));
  });

  it("endStream is idempotent — a repeated stop event is a harmless no-op", async () => {
    const { engine, sessions, sink } = harness();
    await engine.startStream({
      voiceSessionId: "voice-1",
      organizationId: "tenant-a",
      providerStreamId: "MZ1",
      externalCallerId: null,
      sampleRateHz: 8000,
      greetingText: null,
      sink
    });
    await engine.endStream("voice-1", "CALLER_HANGUP");
    expect(sessions.end).toHaveBeenCalledTimes(1);
    await engine.endStream("voice-1", "CALLER_HANGUP");
    expect(sessions.end).toHaveBeenCalledTimes(1);
    expect(engine.activeSessionCount()).toBe(0);
  });

  it("shutdownAll ends every active session and stops accepting new streams", async () => {
    const { engine, sessions, sink } = harness({ maxConcurrentSessions: 5 });
    await engine.startStream({
      voiceSessionId: "voice-1",
      organizationId: "tenant-a",
      providerStreamId: "MZ1",
      externalCallerId: null,
      sampleRateHz: 8000,
      greetingText: null,
      sink
    });
    await engine.shutdownAll();
    expect(sessions.end).toHaveBeenCalledWith("tenant-a", "voice-1", false, "SERVER_SHUTDOWN");
    await expect(
      engine.startStream({
        voiceSessionId: "voice-2",
        organizationId: "tenant-a",
        providerStreamId: "MZ2",
        externalCallerId: null,
        sampleRateHz: 8000,
        greetingText: null,
        sink
      })
    ).rejects.toThrowError(expect.objectContaining({ code: "VOICE_PROVIDER_ERROR" }));
  });
});
