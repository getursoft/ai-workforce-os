/** Sprint 7 — Twilio's implementation of VoiceTransportProvider: inbound call webhook validation, TwiML
 * <Connect><Stream> generation, and Media Stream event DTOs/parsing. No Twilio SDK dependency — TwiML is
 * a few lines of well-known, escaped XML, and Twilio's Media Stream wire format is plain JSON over a
 * plain WebSocket (no Twilio-specific client library needed to speak it).
 */
import { Injectable } from "@nestjs/common";
import { verifyTwilioSignature } from "../channels/channel.runtime";
import { TWILIO_MEDIA_SAMPLE_RATE_HZ, mulawBase64FromNormalizedFrame } from "./voice-audio-codec";
import { VoiceError } from "./voice.types";
import type {
  IncomingVoiceCall,
  IncomingVoiceWebhookRequest,
  MediaConnectionHandshake,
  NormalizedAudioFrame,
  VoiceTransportProvider
} from "./voice.types";

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

@Injectable()
export class TwilioVoiceTransportProvider implements VoiceTransportProvider {
  readonly name = "TWILIO";

  validateIncomingWebhook(
    request: IncomingVoiceWebhookRequest,
    credentials: { authToken: string }
  ): boolean {
    return verifyTwilioSignature(
      credentials.authToken,
      request.requestUrl,
      request.params,
      request.signatureHeader
    );
  }

  parseIncomingCall(request: IncomingVoiceWebhookRequest): IncomingVoiceCall {
    const callSid = request.params.CallSid?.trim();
    if (!callSid) throw new VoiceError("INVALID_EVENT", "Twilio voice webhook missing CallSid");
    return {
      providerCallId: callSid,
      externalCallerId: request.params.From?.trim() || null,
      toAddress: request.params.To?.trim() || null
    };
  }

  createIncomingCallResponse(input: {
    mediaStreamUrl: string;
    providerCallId: string;
  }): { contentType: string; body: string } {
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response><Connect><Stream url="${xmlEscape(input.mediaStreamUrl)}">` +
      `<Parameter name="providerCallId" value="${xmlEscape(input.providerCallId)}" /></Stream></Connect></Response>`;
    return { contentType: "text/xml", body };
  }

  validateMediaConnection(handshake: MediaConnectionHandshake): boolean {
    // Twilio does not authenticate at the WebSocket handshake — correlation happens via the signed
    // "start" event payload (see parseMediaStreamEvent + voice-stream.gateway.ts's CallSid lookup).
    // Always true here; real rejection happens once the "start" event's CallSid is checked against a
    // known, org-scoped VoiceSession.
    void handshake;
    return true;
  }

  encodeOutboundAudio(frame: NormalizedAudioFrame): { event: string; payload: Record<string, unknown> } {
    return {
      event: "media",
      payload: { media: { payload: mulawBase64FromNormalizedFrame(frame) } }
    };
  }

  clearAudioFrame(): { event: string; payload: Record<string, unknown> } {
    return { event: "clear", payload: {} };
  }

  closeCallFrame(): { event: string; payload: Record<string, unknown> } | null {
    // Twilio Media Streams has no explicit "close the call" WS frame — the call itself is torn down by
    // letting TwiML execution end / the underlying PSTN/WhatsApp leg hanging up. A future provider that
    // does support an explicit hangup frame can return one here.
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// Twilio Media Stream WebSocket event DTOs — https://www.twilio.com/docs/voice/media-streams/websocket
// ---------------------------------------------------------------------------------------------------

export interface TwilioMediaStreamConnectedEvent {
  event: "connected";
  protocol: string;
  version: string;
}

export interface TwilioMediaStreamStartEvent {
  event: "start";
  start: {
    streamSid: string;
    callSid: string;
    accountSid: string;
    mediaFormat: { encoding: string; sampleRate: number; channels: number };
    customParameters?: Record<string, string>;
  };
  streamSid: string;
}

export interface TwilioMediaStreamMediaEvent {
  event: "media";
  streamSid: string;
  media: { track: string; chunk: string; timestamp: string; payload: string };
}

export interface TwilioMediaStreamMarkEvent {
  event: "mark";
  streamSid: string;
  mark: { name: string };
}

export interface TwilioMediaStreamStopEvent {
  event: "stop";
  streamSid: string;
  stop: { accountSid: string; callSid: string };
}

export type TwilioMediaStreamEvent =
  | TwilioMediaStreamConnectedEvent
  | TwilioMediaStreamStartEvent
  | TwilioMediaStreamMediaEvent
  | TwilioMediaStreamMarkEvent
  | TwilioMediaStreamStopEvent;

const KNOWN_EVENTS = new Set(["connected", "start", "media", "mark", "stop"]);

/** Strict parser: unknown/malformed events are rejected rather than silently ignored (STEP 10 — reject
 * malformed start event / validate event schema), so the gateway can reject the connection outright
 * instead of processing partial/garbage state. */
export function parseTwilioMediaStreamEvent(raw: unknown): TwilioMediaStreamEvent {
  if (!raw || typeof raw !== "object") throw new VoiceError("INVALID_EVENT", "Media stream frame is not an object");
  const event = (raw as { event?: unknown }).event;
  if (typeof event !== "string" || !KNOWN_EVENTS.has(event))
    throw new VoiceError("INVALID_EVENT", `Unknown media stream event: ${String(event)}`);

  switch (event) {
    case "connected": {
      const r = raw as Partial<TwilioMediaStreamConnectedEvent>;
      if (typeof r.protocol !== "string" || typeof r.version !== "string")
        throw new VoiceError("INVALID_EVENT", "Malformed connected event");
      return { event: "connected", protocol: r.protocol, version: r.version };
    }
    case "start": {
      const r = raw as Partial<TwilioMediaStreamStartEvent>;
      const start = r.start as TwilioMediaStreamStartEvent["start"] | undefined;
      if (
        typeof r.streamSid !== "string" ||
        !start ||
        typeof start.streamSid !== "string" ||
        typeof start.callSid !== "string" ||
        typeof start.accountSid !== "string" ||
        !start.mediaFormat ||
        typeof start.mediaFormat.sampleRate !== "number"
      )
        throw new VoiceError("INVALID_EVENT", "Malformed start event");
      return { event: "start", streamSid: r.streamSid, start };
    }
    case "media": {
      const r = raw as Partial<TwilioMediaStreamMediaEvent>;
      if (typeof r.streamSid !== "string" || !r.media || typeof r.media.payload !== "string")
        throw new VoiceError("INVALID_EVENT", "Malformed media event");
      return { event: "media", streamSid: r.streamSid, media: r.media };
    }
    case "mark": {
      const r = raw as Partial<TwilioMediaStreamMarkEvent>;
      if (typeof r.streamSid !== "string" || !r.mark || typeof r.mark.name !== "string")
        throw new VoiceError("INVALID_EVENT", "Malformed mark event");
      return { event: "mark", streamSid: r.streamSid, mark: r.mark };
    }
    case "stop": {
      const r = raw as Partial<TwilioMediaStreamStopEvent>;
      if (typeof r.streamSid !== "string" || !r.stop || typeof r.stop.callSid !== "string")
        throw new VoiceError("INVALID_EVENT", "Malformed stop event");
      return { event: "stop", streamSid: r.streamSid, stop: r.stop };
    }
    default:
      throw new VoiceError("INVALID_EVENT", "Unreachable");
  }
}

export function assertTwilioMediaSampleRate(sampleRate: number): void {
  if (sampleRate !== TWILIO_MEDIA_SAMPLE_RATE_HZ)
    throw new VoiceError(
      "AUDIO_CODEC_ERROR",
      `Unexpected Twilio media sample rate ${sampleRate}, expected ${TWILIO_MEDIA_SAMPLE_RATE_HZ}`
    );
}
