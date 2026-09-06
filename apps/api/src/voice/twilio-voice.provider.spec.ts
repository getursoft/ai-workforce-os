import { describe, expect, it } from "vitest";
import { computeTwilioSignature } from "../channels/channel.runtime";
import { parseTwilioMediaStreamEvent, TwilioVoiceTransportProvider } from "./twilio-voice.provider";

const AUTH_TOKEN = "a".repeat(32);
const URL = "https://api.krevia.in/api/v1/channels/twilio/voice/channel-1/incoming";

describe("TwilioVoiceTransportProvider", () => {
  it("validates a correctly signed incoming call webhook", () => {
    const provider = new TwilioVoiceTransportProvider();
    const params = { CallSid: "CA123", From: "+15551234567", To: "+18005551234", CallStatus: "ringing" };
    const signature = computeTwilioSignature(AUTH_TOKEN, URL, params);
    expect(
      provider.validateIncomingWebhook(
        { params, requestUrl: URL, signatureHeader: signature },
        { authToken: AUTH_TOKEN }
      )
    ).toBe(true);
  });

  it("rejects a tampered/missing signature", () => {
    const provider = new TwilioVoiceTransportProvider();
    const params = { CallSid: "CA123", From: "+15551234567" };
    expect(
      provider.validateIncomingWebhook(
        { params, requestUrl: URL, signatureHeader: "not-a-real-signature" },
        { authToken: AUTH_TOKEN }
      )
    ).toBe(false);
    expect(
      provider.validateIncomingWebhook(
        { params, requestUrl: URL, signatureHeader: undefined },
        { authToken: AUTH_TOKEN }
      )
    ).toBe(false);
  });

  it("parses the caller/callee out of the webhook params", () => {
    const provider = new TwilioVoiceTransportProvider();
    const call = provider.parseIncomingCall({
      params: { CallSid: "CA123", From: "+15551234567", To: "+18005551234" },
      requestUrl: URL,
      signatureHeader: "x"
    });
    expect(call).toEqual({ providerCallId: "CA123", externalCallerId: "+15551234567", toAddress: "+18005551234" });
  });

  it("rejects a webhook without a CallSid rather than fabricating one", () => {
    const provider = new TwilioVoiceTransportProvider();
    expect(() =>
      provider.parseIncomingCall({ params: {}, requestUrl: URL, signatureHeader: "x" })
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("generates well-formed, escaped TwiML pointing at the given media stream URL", () => {
    const provider = new TwilioVoiceTransportProvider();
    const { contentType, body } = provider.createIncomingCallResponse({
      mediaStreamUrl: "wss://api.krevia.in/api/v1/channels/twilio/voice/stream?x=1&y=2",
      providerCallId: 'CA"123'
    });
    expect(contentType).toBe("text/xml");
    expect(body).toContain("<Connect><Stream url=\"wss://api.krevia.in/api/v1/channels/twilio/voice/stream?x=1&amp;y=2\">");
    expect(body).toContain("value=\"CA&quot;123\"");
    expect(body).not.toContain('CA"123');
  });

  it("frames outbound audio, clear, and does not fabricate a Twilio hangup frame", () => {
    const provider = new TwilioVoiceTransportProvider();
    const frame = provider.encodeOutboundAudio({ pcm16: new Int16Array(160), sampleRateHz: 8000 });
    expect(frame.event).toBe("media");
    expect(provider.clearAudioFrame()).toEqual({ event: "clear", payload: {} });
    expect(provider.closeCallFrame()).toBeNull();
  });
});

describe("parseTwilioMediaStreamEvent", () => {
  it("parses a valid start event", () => {
    const parsed = parseTwilioMediaStreamEvent({
      event: "start",
      streamSid: "MZ1",
      start: {
        streamSid: "MZ1",
        callSid: "CA1",
        accountSid: "AC1",
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }
      }
    });
    expect(parsed.event).toBe("start");
  });

  it("parses a valid media event", () => {
    const parsed = parseTwilioMediaStreamEvent({
      event: "media",
      streamSid: "MZ1",
      media: { track: "inbound", chunk: "1", timestamp: "0", payload: "AAAA" }
    });
    expect(parsed.event).toBe("media");
  });

  it("rejects an unknown event type", () => {
    expect(() => parseTwilioMediaStreamEvent({ event: "not-real" })).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("rejects a malformed start event missing required fields", () => {
    expect(() => parseTwilioMediaStreamEvent({ event: "start", streamSid: "MZ1" })).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("rejects a non-object frame", () => {
    expect(() => parseTwilioMediaStreamEvent("not-json")).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
    expect(() => parseTwilioMediaStreamEvent(null)).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });
});
