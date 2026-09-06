import { describe, expect, it, vi } from "vitest";
import { mulawBase64FromNormalizedFrame } from "./voice-audio-codec";
import { MAX_MESSAGE_BYTES, VoiceStreamConnectionHandler } from "./voice-stream-connection.handler";

function harness() {
  const engine = {
    startStream: vi.fn().mockResolvedValue(undefined),
    handleInboundAudio: vi.fn(),
    handleMark: vi.fn(),
    endStream: vi.fn().mockResolvedValue(undefined)
  };
  const sent: Array<Record<string, unknown>> = [];
  const closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = [];
  const sink = {
    send: (json: Record<string, unknown>) => sent.push(json),
    close: (code?: number, reason?: string) => closeCalls.push({ code, reason })
  };
  const session = { id: "voice-1", organizationId: "tenant-a", providerCallId: "CA123", externalCallerId: "+1555" };
  const handler = new VoiceStreamConnectionHandler(engine as never, session, "Hi there!", sink);
  return { handler, engine, sent, closeCalls };
}

function frame(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("VoiceStreamConnectionHandler", () => {
  it("ignores a connected frame", () => {
    const { handler, closeCalls } = harness();
    handler.handleMessage(frame({ event: "connected", protocol: "Call", version: "1.0.0" }));
    expect(closeCalls).toHaveLength(0);
  });

  it("starts the engine stream only once a start event with a matching CallSid arrives", () => {
    const { handler, engine, closeCalls } = harness();
    handler.handleMessage(
      frame({
        event: "start",
        streamSid: "MZ1",
        start: {
          streamSid: "MZ1",
          callSid: "CA123",
          accountSid: "AC1",
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }
        }
      })
    );
    expect(engine.startStream).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceSessionId: "voice-1",
        organizationId: "tenant-a",
        providerStreamId: "MZ1",
        greetingText: "Hi there!"
      })
    );
    expect(closeCalls).toHaveLength(0);
  });

  it("rejects a start event whose CallSid does not match the correlated session", () => {
    const { handler, engine, closeCalls } = harness();
    handler.handleMessage(
      frame({
        event: "start",
        streamSid: "MZ1",
        start: {
          streamSid: "MZ1",
          callSid: "CA-WRONG",
          accountSid: "AC1",
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }
        }
      })
    );
    expect(engine.startStream).not.toHaveBeenCalled();
    expect(closeCalls[0]?.reason).toBe("CALL_SID_MISMATCH");
  });

  it("ignores media frames received before start (out-of-protocol) instead of crashing", () => {
    const { handler, engine } = harness();
    const payload = mulawBase64FromNormalizedFrame({ pcm16: new Int16Array(160), sampleRateHz: 8000 });
    handler.handleMessage(frame({ event: "media", streamSid: "MZ1", media: { track: "inbound", chunk: "1", timestamp: "0", payload } }));
    expect(engine.handleInboundAudio).not.toHaveBeenCalled();
  });

  it("decodes and forwards media frames to the engine once started", () => {
    const { handler, engine } = harness();
    handler.handleMessage(
      frame({
        event: "start",
        streamSid: "MZ1",
        start: { streamSid: "MZ1", callSid: "CA123", accountSid: "AC1", mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } }
      })
    );
    const payload = mulawBase64FromNormalizedFrame({ pcm16: new Int16Array(160), sampleRateHz: 8000 });
    handler.handleMessage(frame({ event: "media", streamSid: "MZ1", media: { track: "inbound", chunk: "1", timestamp: "0", payload } }));
    expect(engine.handleInboundAudio).toHaveBeenCalledWith("voice-1", expect.objectContaining({ sampleRateHz: 8000 }));
  });

  it("forwards mark events to the engine", () => {
    const { handler, engine } = harness();
    handler.handleMessage(frame({ event: "mark", streamSid: "MZ1", mark: { name: "checkpoint-1" } }));
    expect(engine.handleMark).toHaveBeenCalledWith("voice-1", "checkpoint-1");
  });

  it("ends the stream and closes the socket on a stop event", () => {
    const { handler, engine, closeCalls } = harness();
    handler.handleMessage(frame({ event: "stop", streamSid: "MZ1", stop: { accountSid: "AC1", callSid: "CA123" } }));
    expect(engine.endStream).toHaveBeenCalledWith("voice-1", "CALLER_HANGUP");
    expect(closeCalls).toHaveLength(1);
  });

  it("ends the stream on socket close, and a repeated close is a harmless no-op", () => {
    const { handler, engine } = harness();
    handler.handleClose();
    handler.handleClose();
    expect(engine.endStream).toHaveBeenCalledTimes(1);
    expect(engine.endStream).toHaveBeenCalledWith("voice-1", "STREAM_DISCONNECTED");
  });

  it("rejects a non-JSON message", () => {
    const { handler, closeCalls } = harness();
    handler.handleMessage("not json{{{");
    expect(closeCalls[0]?.reason).toBe("INVALID_JSON");
  });

  it("rejects an unknown/malformed event", () => {
    const { handler, closeCalls } = harness();
    handler.handleMessage(frame({ event: "not-a-real-event" }));
    expect(closeCalls[0]?.reason).toBe("INVALID_EVENT");
  });

  it("rejects an oversized message rather than buffering it unbounded", () => {
    const { handler, closeCalls } = harness();
    handler.handleMessage("x".repeat(MAX_MESSAGE_BYTES + 1));
    expect(closeCalls[0]?.reason).toBe("MESSAGE_TOO_LARGE");
  });

  it("rate-limits a burst of messages beyond the sanity threshold", () => {
    const { handler, closeCalls } = harness();
    for (let i = 0; i < 150; i++) {
      handler.handleMessage(frame({ event: "mark", streamSid: "MZ1", mark: { name: `m${i}` } }));
    }
    expect(closeCalls.some((c) => c.reason === "RATE_LIMITED")).toBe(true);
  });

  it("relays outbound engine audio through the sink with the correlated streamSid", () => {
    const { handler, engine, sent } = harness();
    handler.handleMessage(
      frame({
        event: "start",
        streamSid: "MZ1",
        start: { streamSid: "MZ1", callSid: "CA123", accountSid: "AC1", mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } }
      })
    );
    const startCall = engine.startStream.mock.calls[0]?.[0] as { sink: { sendFrame: (f: unknown) => void } };
    startCall.sink.sendFrame({ event: "media", payload: { media: { payload: "AAAA" } } });
    expect(sent).toContainEqual({ event: "media", streamSid: "MZ1", media: { payload: "AAAA" } });
  });
});
