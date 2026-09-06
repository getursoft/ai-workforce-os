import { describe, expect, it } from "vitest";
import { asMockSession, MockRealtimeVoiceProvider } from "./voice-mock-realtime.provider";
import type { VoiceRealtimeEvent } from "./voice.types";

async function connect() {
  const provider = new MockRealtimeVoiceProvider({ simulatedLatencyMs: 0, audioChunkCount: 3 });
  const session = await provider.connectSession({
    voiceSessionId: "voice-1",
    organizationId: "tenant-a",
    sampleRateHz: 8000
  });
  const events: VoiceRealtimeEvent[] = [];
  session.on((event) => events.push(event));
  return { session, events };
}

describe("MockRealtimeVoiceProvider", () => {
  it("produces a deterministic final transcript when a caller utterance is scripted", async () => {
    const { session, events } = await connect();
    asMockSession(session).simulateUserUtterance("I want to plan a trip to Dubai.");
    session.appendInputAudio({ pcm16: new Int16Array(160), sampleRateHz: 8000 });
    session.commitInputAudio();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const finalEvent = events.find((e) => e.type === "user_transcript_final");
    expect(finalEvent?.text).toBe("I want to plan a trip to Dubai.");
    expect(events.map((e) => e.type)).toEqual([
      "input_audio_started",
      "input_audio_stopped",
      "user_transcript_final"
    ]);
  });

  it("still produces a (non-crashing) transcript when no utterance was scripted", async () => {
    const { session, events } = await connect();
    session.appendInputAudio({ pcm16: new Int16Array(160), sampleRateHz: 8000 });
    session.commitInputAudio();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const finalEvent = events.find((e) => e.type === "user_transcript_final");
    expect(finalEvent?.text).toMatch(/mock transcript/);
  });

  it("streams a response as transcript + audio chunks + a finished event", async () => {
    const { session, events } = await connect();
    session.generateResponse("Hi, you've reached Krevia. How can I help you today?");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("assistant_response_started");
    expect(types).toContain("assistant_transcript_final");
    expect(types).toContain("assistant_audio_chunk");
    expect(types.at(-1)).toBe("assistant_response_finished");
  });

  it("cancelResponse() stops an in-flight generation before it finishes — no overlapping responses", async () => {
    const { session, events } = await connect();
    session.generateResponse("Your Dubai trip would cost approximately five thousand dollars.");
    session.cancelResponse();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const types = events.map((e) => e.type);
    expect(types).not.toContain("assistant_response_finished");
    expect(types).not.toContain("assistant_transcript_final");
  });

  it("close() prevents any further events from firing", async () => {
    const { session, events } = await connect();
    await session.close();
    session.appendInputAudio({ pcm16: new Int16Array(160), sampleRateHz: 8000 });
    session.commitInputAudio();
    session.generateResponse("should not emit");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toHaveLength(0);
  });
});
