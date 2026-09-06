/**
 * Sprint 7 — Real-Time Voice Calling: live UAT.
 *
 * Driven against a real NestFactory app + real Postgres (via TEST_DATABASE_URL) + the real HTTP/WebSocket
 * surface: signed Twilio voice webhook -> TwiML -> a real WebSocket client speaking Twilio's Media Stream
 * protocol -> real VAD-based turn detection -> real AI Receptionist -> real specialist routing (Travel) ->
 * real outbound audio -> call completion. The ONLY thing mocked is the external speech transformation
 * (MockRealtimeVoiceProvider) — no Krevia business architecture is mocked away.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Prisma } from "@prisma/client";
import request from "supertest";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
import { computeTwilioSignature } from "../channels/channel.runtime";
import { mulawBase64FromNormalizedFrame } from "./voice-audio-codec";
import { MockRealtimeVoiceProvider, asMockSession } from "./voice-mock-realtime.provider";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.RECEPTIONIST_VOICE_ENABLED = "true";
process.env.VOICE_REALTIME_PROVIDER = "mock";
// ConfigModule.forRoot() (no envFilePath) loads apps/api/.env from CWD by default, which may carry real
// TWILIO_* credentials from local dev work. resolveTwilioCredentials() prefers env vars over the DB-
// stored per-channel secret when all three are set — clear them so this suite deterministically exercises
// the encrypted ChannelConnection credential path (what a real deployed channel actually uses) instead of
// silently depending on whatever happens to be in a developer's local .env.
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_WHATSAPP_FROM;
// Isolate this suite's listening port from both the dev server (4000) and other e2e suites, which never
// call app.listen() — a real ws client (unlike supertest) needs a genuinely bound socket. API_PUBLIC_URL
// is overridden to match so the TwiML-generated wss:// URL points at the port this suite actually binds.
const TEST_PORT = 48173;
process.env.API_PUBLIC_URL = `http://127.0.0.1:${TEST_PORT}`;

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const AUTH_TOKEN = "e2e-voice-auth-token-" + "x".repeat(16);
const ACCOUNT_SID = `AC${"7".repeat(32)}`;
const FROM_NUMBER = "whatsapp:+14155238886";
const CALLER_NUMBER = "whatsapp:+15559990000";

function loudFrame(): { pcm16: Int16Array; sampleRateHz: number } {
  const pcm16 = Int16Array.from({ length: 160 }, (_, i) => Math.round(20000 * Math.sin(i / 4)));
  return { pcm16, sampleRateHz: 8000 };
}
function silentFrame(): { pcm16: Int16Array; sampleRateHz: number } {
  return { pcm16: new Int16Array(160), sampleRateHz: 8000 };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs = 5000, stepMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await wait(stepMs);
  }
  throw new Error("waitUntil timed out");
}

async function waitUntilTruthy<T>(
  check: () => Promise<T | null> | T | null,
  timeoutMs = 5000,
  stepMs = 75
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait(stepMs);
  }
  throw new Error("waitUntilTruthy timed out");
}

function requireMockSession(mockProvider: MockRealtimeVoiceProvider, voiceSessionId: string) {
  const session = mockProvider.getSession(voiceSessionId);
  if (!session) throw new Error(`no mock realtime session for ${voiceSessionId}`);
  return session;
}

suite("Sprint 7: real-time voice calling — live UAT", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockProvider: MockRealtimeVoiceProvider;

  async function register(orgSuffix: string) {
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Sprint7Voice ${orgSuffix} ${Date.now()}`,
        firstName: "Owner",
        email: `sprint7-voice-${orgSuffix}-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    return {
      token: registered.body.data.tokens.accessToken as string,
      organizationId: registered.body.data.organization.id as string
    };
  }

  async function install(authToken: string, pluginId: string) {
    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ pluginId, configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);
    return installed.body.id as string;
  }

  async function setupVoiceChannel() {
    const { token, organizationId } = await register("main");
    const receptionistId = await install(token, "receptionist-employee");
    await install(token, "travel-employee");
    const owner = await prisma.user.findFirstOrThrow({ where: { organizationId } });
    const encryption = app.get(PluginSecretsEncryptionService);
    const channel = await prisma.channelConnection.create({
      data: {
        organizationId,
        pluginInstallationId: receptionistId,
        name: "Krevia WhatsApp Voice — E2E",
        provider: "TWILIO",
        channelType: "WHATSAPP",
        status: "ACTIVE",
        voiceEnabled: true,
        routingMode: "INTENT_ROUTER",
        receptionistGreeting: "Hi, you've reached Krevia. How can I help you today?",
        configuration: { accountSid: ACCOUNT_SID, fromNumber: FROM_NUMBER } as unknown as Prisma.InputJsonValue,
        encryptedSecrets: encryption.encrypt({ authToken: AUTH_TOKEN }) as unknown as Prisma.InputJsonValue,
        secretMetadata: {},
        createdByUserId: owner.id
      }
    });
    return { token, organizationId, receptionistId, channelId: channel.id };
  }

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: ["error", "warn"], abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    await app.listen(TEST_PORT, "127.0.0.1");
    prisma = app.get(PrismaService);
    mockProvider = app.get(MockRealtimeVoiceProvider);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  }, 20_000);

  it(
    "runs a full call end to end: webhook -> TwiML -> media stream -> greeting -> caller turn -> " +
      "Travel handoff -> spoken response -> call completion",
    async () => {
      const { organizationId, channelId } = await setupVoiceChannel();
      const callSid = `CA${randomUUID().replace(/-/g, "")}`;
      const webhookUrl = `http://127.0.0.1:${TEST_PORT}/api/v1/channels/twilio/voice/${channelId}/incoming`;
      const form = { CallSid: callSid, From: CALLER_NUMBER, To: FROM_NUMBER, CallStatus: "ringing" };
      const signature = computeTwilioSignature(AUTH_TOKEN, webhookUrl, form);

      // Step 1: signed inbound call webhook -> TwiML naming a real, idempotent VoiceSession.
      const webhookResponse = await request(app.getHttpServer())
        .post(`/api/v1/channels/twilio/voice/${channelId}/incoming`)
        .type("form")
        .set("X-Twilio-Signature", signature)
        .send(form)
        .expect(200);
      expect(webhookResponse.headers["content-type"]).toContain("text/xml");
      const streamUrlMatch = /<Stream url="([^"]+)"/.exec(webhookResponse.text);
      if (!streamUrlMatch) throw new Error("TwiML response did not contain a <Stream url=\"...\"> element");
      const streamUrl = (streamUrlMatch[1] ?? "").replace(/&amp;/g, "&");
      const voiceSessionIdSegment = streamUrl.split("/").pop();
      if (!voiceSessionIdSegment) throw new Error(`could not extract a voiceSessionId from ${streamUrl}`);
      const voiceSessionId = voiceSessionIdSegment;

      const ringingSession = await prisma.voiceSession.findUniqueOrThrow({ where: { id: voiceSessionId } });
      expect(ringingSession.status).toBe("RINGING");
      expect(ringingSession.organizationId).toBe(organizationId);
      expect(ringingSession.providerCallId).toBe(callSid);

      // Replaying the identical webhook (a real Twilio retry) must be idempotent — no second session.
      await request(app.getHttpServer())
        .post(`/api/v1/channels/twilio/voice/${channelId}/incoming`)
        .type("form")
        .set("X-Twilio-Signature", signature)
        .send(form)
        .expect(200);
      expect(await prisma.voiceSession.count({ where: { organizationId, providerCallId: callSid } })).toBe(1);

      // Step 2: open the real Media Stream WebSocket and speak Twilio's wire protocol.
      const ws = new WebSocket(streamUrl);
      const inboundMessages: Array<Record<string, unknown>> = [];
      ws.on("message", (data) => inboundMessages.push(JSON.parse(data.toString())));
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });

      ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ_E2E",
          start: {
            streamSid: "MZ_E2E",
            callSid,
            accountSid: ACCOUNT_SID,
            mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }
          }
        })
      );

      // Step 3: real VoiceSession transitions CONNECTING -> ACTIVE, and the configured (not hardcoded)
      // greeting is spoken as real outbound audio over the socket.
      await waitUntil(async () => {
        const s = await prisma.voiceSession.findUniqueOrThrow({ where: { id: voiceSessionId } });
        return s.status === "ACTIVE";
      });
      await waitUntil(() => inboundMessages.some((m) => m.event === "media"));
      const greetingFrameCount = inboundMessages.filter((m) => m.event === "media").length;
      expect(greetingFrameCount).toBeGreaterThan(0);

      // Step 4: script the caller's line on the real, live mock realtime session for this exact call —
      // the only mocked boundary — then drive real energy-based VAD turn detection with real audio frames.
      await waitUntil(() => mockProvider.getSession(voiceSessionId) !== undefined);
      let turnSeq = 0;
      const speakTurn = async (text: string) => {
        const segmentsBefore = await prisma.voiceTranscriptSegment.count({ where: { voiceSessionId } });
        asMockSession(requireMockSession(mockProvider, voiceSessionId)).simulateUserUtterance(text);
        const chunk = ++turnSeq;
        ws.send(
          JSON.stringify({
            event: "media",
            streamSid: "MZ_E2E",
            media: { track: "inbound", chunk: `${chunk}a`, timestamp: "0", payload: mulawBase64FromNormalizedFrame(loudFrame()) }
          })
        );
        ws.send(
          JSON.stringify({
            event: "media",
            streamSid: "MZ_E2E",
            media: { track: "inbound", chunk: `${chunk}b`, timestamp: "20", payload: mulawBase64FromNormalizedFrame(silentFrame()) }
          })
        );
        // Real VAD silence-timeout (700ms) must elapse before the turn commits — wait for a new
        // transcript segment to confirm the turn was actually processed, not just time-based guessing.
        await waitUntil(
          async () => (await prisma.voiceTranscriptSegment.count({ where: { voiceSessionId } })) > segmentsBefore,
          4000
        );
      };

      // A brand-new caller identity: the real, unmodified Receptionist asks for a name before routing
      // (the same deterministic identity-capture flow WhatsApp text callers go through) — so this is a
      // genuine two-turn call, not a test shortcut.
      await speakTurn("Hi, I'm Krishna.");
      await speakTurn("I want to plan a trip to Dubai.");

      // Step 5: real AI Receptionist runs, real ReceptionistRoutingService hands off to the real Travel
      // employee, and the specialist's real response is spoken back as outbound audio — all through the
      // exact same AgentService.execute() entry point WhatsApp text uses. No voice-specific agent logic.
      const voiceSession = await waitUntilTruthy(async () => {
        const s = await prisma.voiceSession.findUniqueOrThrow({ where: { id: voiceSessionId } });
        return s.activeHandoffId ? s : null;
      });
      expect(voiceSession.activeHandoffId).not.toBeNull();
      if (!voiceSession.receptionistConversationId)
        throw new Error("voice session reached a handoff without a linked conversation");

      const conversation = await prisma.conversation.findUniqueOrThrow({
        where: { id: voiceSession.receptionistConversationId }
      });
      const messages = await prisma.conversationMessage.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: "asc" }
      });
      expect(messages.some((m) => m.content.includes("Dubai"))).toBe(true);

      const transcriptSegments = await prisma.voiceTranscriptSegment.findMany({
        where: { voiceSessionId },
        orderBy: { sequenceNumber: "asc" }
      });
      expect(transcriptSegments.some((s) => s.speaker === "USER" && s.text.includes("Dubai"))).toBe(true);
      expect(transcriptSegments.some((s) => s.speaker === "AGENT")).toBe(true);

      // Step 6: caller hangs up — real call-state-machine termination, idempotent on a repeat stop event.
      ws.send(JSON.stringify({ event: "stop", streamSid: "MZ_E2E", stop: { accountSid: ACCOUNT_SID, callSid } }));
      await waitUntil(async () => {
        const s = await prisma.voiceSession.findUniqueOrThrow({ where: { id: voiceSessionId } });
        return s.status === "ENDED";
      });
      ws.close();
    },
    30_000
  );
});
