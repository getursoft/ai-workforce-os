/** Sprint 7 — per-connection Twilio Media Stream protocol handling, split out from the raw
 * WebSocket/HTTP wiring (voice-stream.gateway.ts) so it can be unit-tested without a real socket. Owns
 * exactly one call's message lifecycle: schema validation, CallSid correlation, message-size/rate
 * bounds, and dispatch into VoiceSessionEngine. No business logic lives here — everything real happens
 * in the engine.
 */
import { Logger } from "@nestjs/common";
import { normalizedFrameFromMulawBase64 } from "./voice-audio-codec";
import type { VoiceSessionEngine } from "./voice-session.engine";
import { parseTwilioMediaStreamEvent } from "./twilio-voice.provider";

export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_MESSAGES_PER_SECOND = 100;

export interface VoiceStreamSink {
  send(json: Record<string, unknown>): void;
  close(code?: number, reason?: string): void;
}

export interface VoiceStreamSessionContext {
  id: string;
  organizationId: string;
  providerCallId: string;
  externalCallerId: string | null;
}

export class VoiceStreamConnectionHandler {
  private static readonly logger = new Logger(VoiceStreamConnectionHandler.name);
  private started = false;
  private streamSid: string | null = null;
  private messageCountInWindow = 0;
  private windowStartedAtEpochMs = Date.now();
  private closed = false;

  constructor(
    private readonly engine: VoiceSessionEngine,
    private readonly session: VoiceStreamSessionContext,
    private readonly greetingText: string | null,
    private readonly sink: VoiceStreamSink
  ) {}

  handleMessage(raw: Buffer | string): void {
    if (this.closed) return;
    const byteLength = typeof raw === "string" ? Buffer.byteLength(raw) : raw.length;
    if (byteLength > MAX_MESSAGE_BYTES) {
      this.reject(1009, "MESSAGE_TOO_LARGE");
      return;
    }
    if (!this.withinRateLimit()) {
      this.reject(1008, "RATE_LIMITED");
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw.toString());
    } catch {
      this.reject(1003, "INVALID_JSON");
      return;
    }

    let event;
    try {
      event = parseTwilioMediaStreamEvent(parsedJson);
    } catch {
      this.reject(1003, "INVALID_EVENT");
      return;
    }

    switch (event.event) {
      case "connected":
        return;
      case "start": {
        if (event.start.callSid !== this.session.providerCallId) {
          this.reject(4001, "CALL_SID_MISMATCH");
          return;
        }
        this.started = true;
        this.streamSid = event.streamSid;
        void this.engine
          .startStream({
            voiceSessionId: this.session.id,
            organizationId: this.session.organizationId,
            providerStreamId: event.start.streamSid,
            externalCallerId: this.session.externalCallerId,
            sampleRateHz: event.start.mediaFormat.sampleRate,
            greetingText: this.greetingText,
            sink: {
              sendFrame: (frame) =>
                this.sink.send({ event: frame.event, streamSid: this.streamSid, ...frame.payload }),
              close: () => this.sink.close()
            }
          })
          .catch((error) => {
            VoiceStreamConnectionHandler.logger.warn(
              `startStream failed for ${this.session.id}: ${(error as Error).message}`
            );
            this.reject(1011, "START_FAILED");
          });
        return;
      }
      case "media": {
        if (!this.started) return; // media arriving before "start" is out-of-protocol — ignore, don't crash
        let frame;
        try {
          frame = normalizedFrameFromMulawBase64(event.media.payload);
        } catch {
          return; // a single malformed media chunk shouldn't tear down the whole call
        }
        this.engine.handleInboundAudio(this.session.id, frame);
        return;
      }
      case "mark":
        this.engine.handleMark(this.session.id, event.mark.name);
        return;
      case "stop":
        this.closed = true;
        void this.engine.endStream(this.session.id, "CALLER_HANGUP");
        this.sink.close();
        return;
    }
  }

  handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    void this.engine.endStream(this.session.id, "STREAM_DISCONNECTED");
  }

  private withinRateLimit(): boolean {
    const now = Date.now();
    if (now - this.windowStartedAtEpochMs > 1000) {
      this.windowStartedAtEpochMs = now;
      this.messageCountInWindow = 0;
    }
    this.messageCountInWindow++;
    return this.messageCountInWindow <= MAX_MESSAGES_PER_SECOND;
  }

  private reject(code: number, reason: string): void {
    this.closed = true;
    this.sink.close(code, reason);
  }
}
