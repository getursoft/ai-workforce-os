import { describe, expect, it, vi } from "vitest";
import { computeTwilioSignature } from "../channels/channel.runtime";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
import { VoiceSessionService } from "../receptionist/voice-channel.adapter";
import { TwilioVoiceTransportProvider } from "./twilio-voice.provider";
import { VoiceWebhookController } from "./voice-webhook.controller";

const AUTH_TOKEN = "b".repeat(32);
const REQUEST_URL = "https://api.krevia.in/api/v1/channels/twilio/voice/channel-1/incoming";

function buildController(overrides?: { voiceEnabled?: boolean; channelStatus?: string }) {
  const encryption = new PluginSecretsEncryptionService(Buffer.alloc(32, 7));
  const encryptedSecrets = encryption.encrypt({ authToken: AUTH_TOKEN });

  const channelRow = {
    id: "channel-1",
    organizationId: "tenant-a",
    provider: "TWILIO",
    status: overrides?.channelStatus ?? "ACTIVE",
    voiceEnabled: overrides?.voiceEnabled ?? true,
    configuration: { accountSid: `AC${"1".repeat(32)}`, fromNumber: "whatsapp:+14155238886" },
    encryptedSecrets,
    pluginInstallation: { status: "ACTIVE" }
  };

  const prisma = {
    channelConnection: { findFirst: vi.fn().mockResolvedValue(channelRow) }
  };
  const sessions = new VoiceSessionService(
    { channelConnection: { findFirst: vi.fn().mockResolvedValue({ id: "channel-1", voiceEnabled: true }) }, voiceSession: { create: vi.fn().mockResolvedValue({ id: "voice-session-1" }) } } as never,
    { boolean: vi.fn().mockReturnValue(true) } as never
  );
  const auditLogger = { record: vi.fn() };
  const config = { string: vi.fn().mockReturnValue("") };
  const security = { apiPublicUrl: "https://api.krevia.in" };

  const controller = new VoiceWebhookController(
    prisma as never,
    encryption,
    sessions,
    new TwilioVoiceTransportProvider(),
    auditLogger as never,
    security as never,
    config as never
  );
  return { controller, prisma, auditLogger };
}

function requestFor(params: Record<string, string>, signature: string) {
  return {
    body: params,
    requestId: "req-1",
    header: (name: string) => (name === "x-twilio-signature" ? signature : undefined)
  } as never;
}

describe("VoiceWebhookController", () => {
  it("returns TwiML pointing at the media stream URL for a validly signed call", async () => {
    const { controller, auditLogger } = buildController();
    const params = { CallSid: "CA123", From: "+15551234567", To: "+18005551234", CallStatus: "ringing" };
    const signature = computeTwilioSignature(AUTH_TOKEN, REQUEST_URL, params);
    const body = await controller.incoming("channel-1", requestFor(params, signature));
    expect(body).toContain("<Connect><Stream url=\"wss://api.krevia.in/api/v1/channels/twilio/voice/stream/voice-session-1\">");
    expect(auditLogger.record).toHaveBeenCalledWith("VOICE_CALL_STARTED", "req-1", {
      organizationId: "tenant-a",
      targetId: "channel-1"
    });
  });

  it("rejects a call with an invalid Twilio signature", async () => {
    const { controller } = buildController();
    const params = { CallSid: "CA123", From: "+15551234567" };
    await expect(controller.incoming("channel-1", requestFor(params, "bad-signature"))).rejects.toThrow();
  });

  it("rejects a call on a channel that has not enabled voice", async () => {
    const { controller } = buildController({ voiceEnabled: false });
    const params = { CallSid: "CA123", From: "+15551234567" };
    const signature = computeTwilioSignature(AUTH_TOKEN, REQUEST_URL, params);
    await expect(controller.incoming("channel-1", requestFor(params, signature))).rejects.toThrow(
      "VOICE_CHANNEL_DISABLED"
    );
  });

  it("rejects a call on an inactive channel", async () => {
    const { controller } = buildController({ channelStatus: "DISABLED" });
    const params = { CallSid: "CA123", From: "+15551234567" };
    const signature = computeTwilioSignature(AUTH_TOKEN, REQUEST_URL, params);
    await expect(controller.incoming("channel-1", requestFor(params, signature))).rejects.toThrow(
      "CHANNEL_UNAVAILABLE"
    );
  });
});
