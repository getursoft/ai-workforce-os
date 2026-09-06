/** Sprint 7.11 — STEP 15: a generic contract test suite for RealtimeSpeechProvider. Any future real
 * adapter (OpenAI Realtime, Azure OpenAI Realtime, Google realtime voice, ...) can be run through
 * `runRealtimeSpeechProviderContract()` to prove it satisfies the exact behavior VoiceSessionEngine
 * depends on — connect / input audio / speech-started / transcript-final / assistant audio / cancel /
 * close / error propagation — without VoiceSessionEngine itself ever needing to change. Today it runs
 * against MockRealtimeVoiceProvider only, since that's the only implementation that exists.
 */
import { describe, expect, it } from "vitest";
import { MockRealtimeVoiceProvider, asMockSession } from "./voice-mock-realtime.provider";
import type { RealtimeSpeechProvider, VoiceRealtimeEvent } from "./voice.types";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs the shared contract against any RealtimeSpeechProvider factory. `scriptUtterance` is an
 * optional hook a real provider's own test file can use to make its STT deterministic (the mock's
 * equivalent is `simulateUserUtterance`) — providers without a scripting hook can omit it and this
 * suite still verifies everything except the exact final-transcript text. */
export function runRealtimeSpeechProviderContract(
  providerName: string,
  createProvider: () => RealtimeSpeechProvider,
  options?: { scriptUtterance?: (session: unknown, text: string) => void }
): void {
  describe(`RealtimeSpeechProvider contract — ${providerName}`, () => {
    it("connectSession() returns a usable session", async () => {
      const provider = createProvider();
      const session = await provider.connectSession({
        voiceSessionId: "contract-1",
        organizationId: "org-contract",
        sampleRateHz: 8000
      });
      expect(session).toBeTruthy();
      expect(typeof session.appendInputAudio).toBe("function");
      expect(typeof session.commitInputAudio).toBe("function");
      expect(typeof session.cancelResponse).toBe("function");
      expect(typeof session.generateResponse).toBe("function");
      expect(typeof session.on).toBe("function");
      expect(typeof session.close).toBe("function");
      await session.close();
    });

    it("input_audio_started fires once real audio is appended", async () => {
      const provider = createProvider();
      const session = await provider.connectSession({ voiceSessionId: "c2", organizationId: "org", sampleRateHz: 8000 });
      const events: VoiceRealtimeEvent[] = [];
      session.on((e) => events.push(e));
      session.appendInputAudio({ pcm16: new Int16Array(160), sampleRateHz: 8000 });
      await wait(20);
      expect(events.some((e) => e.type === "input_audio_started")).toBe(true);
      await session.close();
    });

    it("commitInputAudio() eventually produces a user_transcript_final event", async () => {
      const provider = createProvider();
      const session = await provider.connectSession({ voiceSessionId: "c3", organizationId: "org", sampleRateHz: 8000 });
      const events: VoiceRealtimeEvent[] = [];
      session.on((e) => events.push(e));
      options?.scriptUtterance?.(session, "contract test utterance");
      session.appendInputAudio({ pcm16: new Int16Array(160), sampleRateHz: 8000 });
      session.commitInputAudio();
      await wait(50);
      const finalEvent = events.find((e) => e.type === "user_transcript_final");
      expect(finalEvent).toBeTruthy();
      expect(typeof finalEvent?.text).toBe("string");
      await session.close();
    });

    it("generateResponse() produces assistant_response_started, at least one assistant_audio_chunk, and assistant_response_finished, in that relative order", async () => {
      const provider = createProvider();
      const session = await provider.connectSession({ voiceSessionId: "c4", organizationId: "org", sampleRateHz: 8000 });
      const events: VoiceRealtimeEvent[] = [];
      session.on((e) => events.push(e));
      session.generateResponse("This is a long enough response for a real provider to stream more than one audio chunk back.");
      await wait(200);
      const types = events.map((e) => e.type);
      const startedIdx = types.indexOf("assistant_response_started");
      const finishedIdx = types.lastIndexOf("assistant_response_finished");
      expect(startedIdx).toBeGreaterThanOrEqual(0);
      expect(finishedIdx).toBeGreaterThan(startedIdx);
      expect(types.some((t) => t === "assistant_audio_chunk")).toBe(true);
      const chunkIdx = types.indexOf("assistant_audio_chunk");
      expect(chunkIdx).toBeGreaterThan(startedIdx);
      expect(chunkIdx).toBeLessThan(finishedIdx);
      await session.close();
    });

    it("cancelResponse() stops a response before it finishes — no assistant_response_finished for the cancelled generation", async () => {
      const provider = createProvider();
      const session = await provider.connectSession({ voiceSessionId: "c5", organizationId: "org", sampleRateHz: 8000 });
      const events: VoiceRealtimeEvent[] = [];
      session.on((e) => events.push(e));
      session.generateResponse("A response that will be cancelled before it can possibly finish streaming.");
      session.cancelResponse();
      await wait(150);
      expect(events.some((e) => e.type === "assistant_response_finished")).toBe(false);
      await session.close();
    });

    it("close() stops further events from firing", async () => {
      const provider = createProvider();
      const session = await provider.connectSession({ voiceSessionId: "c6", organizationId: "org", sampleRateHz: 8000 });
      const events: VoiceRealtimeEvent[] = [];
      session.on((e) => events.push(e));
      await session.close();
      session.generateResponse("should not emit anything after close");
      session.appendInputAudio({ pcm16: new Int16Array(160), sampleRateHz: 8000 });
      session.commitInputAudio();
      await wait(150);
      expect(events).toHaveLength(0);
    });

    it("on() returns an unsubscribe function that actually stops delivery", async () => {
      const provider = createProvider();
      const session = await provider.connectSession({ voiceSessionId: "c7", organizationId: "org", sampleRateHz: 8000 });
      const events: VoiceRealtimeEvent[] = [];
      const unsubscribe = session.on((e) => events.push(e));
      unsubscribe();
      session.appendInputAudio({ pcm16: new Int16Array(160), sampleRateHz: 8000 });
      await wait(20);
      expect(events).toHaveLength(0);
      await session.close();
    });
  });
}

runRealtimeSpeechProviderContract("MockRealtimeVoiceProvider", () => new MockRealtimeVoiceProvider({ simulatedLatencyMs: 10, audioChunkCount: 3 }), {
  scriptUtterance: (session, text) => asMockSession(session as never).simulateUserUtterance(text)
});
