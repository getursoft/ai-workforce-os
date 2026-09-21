/** Sprint 7.12 STEP 41 — real Postgres, real Receptionist voice pipeline (mock realtime provider only,
 * no Twilio/telephony credentials). Proves an Interaction is created at call start (before any transcript
 * turn), stays linked to the VoiceSession/Conversation throughout, completes on an in-call closing remark,
 * gets its reference spoken into the agent's own response, and triggers the notification orchestrator —
 * exactly the same Interaction hooks the WhatsApp text e2e test exercises, reused unchanged for voice.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Prisma } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
import { asMockSession, MockRealtimeVoiceProvider } from "../voice/voice-mock-realtime.provider";
import { VoiceSessionEngine, type OutboundAudioSink } from "../voice/voice-session.engine";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.RECEPTIONIST_VOICE_ENABLED = "true";
process.env.VOICE_REALTIME_PROVIDER = "mock";
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_WHATSAPP_FROM;

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function wait(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
async function waitUntilTruthy<T>(check: () => Promise<T | null> | T | null, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait(75);
  }
  throw new Error("waitUntilTruthy timed out");
}
function requireMockSession(mockProvider: MockRealtimeVoiceProvider, voiceSessionId: string) {
  const session = mockProvider.getSession(voiceSessionId);
  if (!session) throw new Error(`no mock realtime session for ${voiceSessionId}`);
  return session;
}

suite("Sprint 7.12: Interaction/reference lifecycle over a live voice call", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let engine: VoiceSessionEngine;
  let mockProvider: MockRealtimeVoiceProvider;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    engine = app.get(VoiceSessionEngine);
    mockProvider = app.get(MockRealtimeVoiceProvider);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  }, 20_000);

  async function register() {
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Voice Interaction ${Date.now()}`,
        firstName: "Owner",
        email: `voice-interaction-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    return {
      token: registered.body.data.tokens.accessToken as string,
      organizationId: registered.body.data.organization.id as string
    };
  }
  async function install(token: string, pluginId: string) {
    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId, configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);
    return installed.body.id as string;
  }

  it("creates an Interaction at call start, keeps one reference for the whole call, and completes+speaks it on a closing remark", async () => {
    const { token, organizationId } = await register();
    const receptionistId = await install(token, "receptionist-employee");
    await install(token, "travel-employee");
    const owner = await prisma.user.findFirstOrThrow({ where: { organizationId } });
    const encryption = app.get(PluginSecretsEncryptionService);
    const channel = await prisma.channelConnection.create({
      data: {
        organizationId,
        pluginInstallationId: receptionistId,
        name: "Voice Interaction Test Channel",
        provider: "TWILIO",
        channelType: "WHATSAPP",
        status: "ACTIVE",
        voiceEnabled: true,
        routingMode: "INTENT_ROUTER",
        receptionistGreeting: null,
        configuration: {} as unknown as Prisma.InputJsonValue,
        encryptedSecrets: encryption.encrypt({ authToken: "sim" }) as unknown as Prisma.InputJsonValue,
        secretMetadata: {},
        createdByUserId: owner.id
      }
    });

    const session = await prisma.voiceSession.create({
      data: {
        organizationId,
        channelConnectionId: channel.id,
        provider: "SIMULATOR",
        providerCallId: `INTERACTION-${Date.now()}`,
        transport: "SIMULATOR",
        direction: "INBOUND",
        externalCallerId: "+15550003333",
        status: "RINGING"
      }
    });

    const sink: OutboundAudioSink = { sendFrame: () => undefined, close: () => undefined };
    await engine.startStream({
      voiceSessionId: session.id,
      organizationId,
      providerStreamId: "INTERACTION-STREAM",
      externalCallerId: "+15550003333",
      sampleRateHz: 8000,
      greetingText: null,
      sink
    });
    await waitUntilTruthy(() => mockProvider.getSession(session.id) ?? null);

    // STEP 6 — the Interaction exists from call start, before any transcript turn.
    const interactionAtStart = await waitUntilTruthy(() =>
      prisma.interaction.findFirst({ where: { organizationId, voiceSessionId: session.id } })
    );
    expect(interactionAtStart.status).toBe("ACTIVE");
    expect(interactionAtStart.channel).toBe("VOICE");
    expect(interactionAtStart.transport).toBe("SIMULATOR");
    const referenceId = interactionAtStart.referenceId;
    expect(referenceId).toMatch(/^KRV-[A-Z0-9]{6}$/);

    const agentSegmentCount = () =>
      prisma.voiceTranscriptSegment.count({ where: { voiceSessionId: session.id, speaker: "AGENT" } });
    const say = async (line: string) => {
      const before = await agentSegmentCount();
      asMockSession(requireMockSession(mockProvider, session.id)).simulateUserUtterance(line);
      engine.handleInboundAudio(session.id, { pcm16: new Int16Array(160), sampleRateHz: 8000 });
      engine.forceEndOfTurn(session.id);
      await waitUntilTruthy(async () => ((await agentSegmentCount()) > before ? true : null));
    };

    await say("Hi, I'm Asha.");

    // The Interaction is now linked to the Conversation the Receptionist created for this call — same
    // reference, no second Interaction row.
    const voiceSessionAfterFirstTurn = await waitUntilTruthy(async () => {
      const s = await prisma.voiceSession.findUniqueOrThrow({ where: { id: session.id } });
      return s.receptionistConversationId ? s : null;
    });
    const interactionAfterFirstTurn = await prisma.interaction.findFirstOrThrow({
      where: { organizationId, voiceSessionId: session.id }
    });
    expect(interactionAfterFirstTurn.id).toBe(interactionAtStart.id);
    expect(interactionAfterFirstTurn.referenceId).toBe(referenceId);
    expect(interactionAfterFirstTurn.conversationId).toBe(voiceSessionAfterFirstTurn.receptionistConversationId);
    const interactionCountForSession = await prisma.interaction.count({
      where: { organizationId, voiceSessionId: session.id }
    });
    expect(interactionCountForSession).toBe(1);

    // Closing remark — completes the interaction and speaks the reference (spaced-out characters, not
    // the raw "KRV-XXXXXX" string, per the voice-friendly rendering helper).
    await say("That's all, thank you, bye!");
    const completedInteraction = await waitUntilTruthy(async () => {
      const row = await prisma.interaction.findFirst({ where: { id: interactionAtStart.id } });
      return row?.status === "COMPLETED" ? row : null;
    });
    expect(completedInteraction.referenceCommunicatedAt).toBeTruthy();

    const spokenForm = referenceId.split("").filter((ch) => ch !== "-").join(" ");
    const closingSegment = await waitUntilTruthy(() =>
      prisma.voiceTranscriptSegment.findFirst({
        where: { voiceSessionId: session.id, speaker: "AGENT", text: { contains: spokenForm } }
      })
    );
    expect(closingSegment.text).toContain(spokenForm);

    await engine.endStream(session.id, "CALLER_HANGUP");

    // Idempotent: ending an already-completed call's stream must not flip it to FAILED or double-fire
    // notifications.
    const finalInteraction = await prisma.interaction.findFirstOrThrow({ where: { id: interactionAtStart.id } });
    expect(finalInteraction.status).toBe("COMPLETED");
    const notificationCount = await prisma.interactionNotification.count({
      where: { interactionId: interactionAtStart.id }
    });
    expect(notificationCount).toBeGreaterThan(0);
  }, 30_000);
});
