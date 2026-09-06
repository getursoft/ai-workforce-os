/**
 * Sprint 7 — Local Voice Simulator (STEP 38).
 *
 * A developer-facing tool for exercising the full voice pipeline without Twilio, WhatsApp Business
 * Calling, or any paid realtime API: real VoiceSessionEngine, real AI Receptionist, real specialist
 * routing, real conversation persistence — only the external speech transformation is mocked. Unlike the
 * e2e UAT (voice.sprint-7-uat.e2e.spec.ts), this drives VoiceSessionEngine's public methods directly
 * (no HTTP webhook, no real WebSocket) so it stays fast and simple enough to read top to bottom as a
 * script. Organization/plugin setup still goes through the real HTTP API (not a raw Prisma insert) —
 * plugin installation has real side effects (routing profile creation, RBAC) a hand-rolled fixture would
 * silently skip and break routing against.
 *
 * Run it directly:
 *   TEST_DATABASE_URL=postgresql://... npx vitest run src/voice/voice-simulator.spec.ts
 *
 * It prints a transcript in the shape the brief asks for:
 *   SIMULATED CALL START
 *   Caller: Hi, I'm Krishna.
 *   Receptionist: ...
 *   Caller: I want to plan a trip to Dubai.
 *   HANDOFF -> Travel Employee
 *   Travel Employee: ...
 *   SIMULATED CALL END
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
import { asMockSession, MockRealtimeVoiceProvider } from "./voice-mock-realtime.provider";
import { VoiceSessionEngine, type OutboundAudioSink } from "./voice-session.engine";

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
async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await wait(50);
  }
  throw new Error("simulator waitUntil timed out");
}

function requireMockSession(mockProvider: MockRealtimeVoiceProvider, voiceSessionId: string) {
  const session = mockProvider.getSession(voiceSessionId);
  if (!session) throw new Error(`no mock realtime session for ${voiceSessionId}`);
  return session;
}

suite("Sprint 7: local voice simulator", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let engine: VoiceSessionEngine;
  let mockProvider: MockRealtimeVoiceProvider;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: ["error", "warn"], abortOnError: false });
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
        organizationName: `Voice Simulator ${Date.now()}`,
        firstName: "Owner",
        email: `voice-sim-${Date.now()}@example.com`,
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

  it("plays a simulated inbound call end to end and prints a human-readable transcript", async () => {
    const { token, organizationId } = await register();
    const receptionistId = await install(token, "receptionist-employee");
    await install(token, "travel-employee");
    const owner = await prisma.user.findFirstOrThrow({ where: { organizationId } });
    const encryption = app.get(PluginSecretsEncryptionService);
    const channel = await prisma.channelConnection.create({
      data: {
        organizationId,
        pluginInstallationId: receptionistId,
        name: "Voice Simulator Channel",
        provider: "TWILIO",
        channelType: "WHATSAPP",
        status: "ACTIVE",
        voiceEnabled: true,
        routingMode: "INTENT_ROUTER",
        receptionistGreeting: "Hi, you've reached Krevia. How can I help you today?",
        configuration: {} as unknown as Prisma.InputJsonValue,
        encryptedSecrets: encryption.encrypt({ authToken: "sim" }) as unknown as Prisma.InputJsonValue,
        secretMetadata: {},
        createdByUserId: owner.id
      }
    });

    // --- drive VoiceSessionEngine directly (no HTTP webhook, no real WebSocket) ---
    const providerCallId = `SIM-${Date.now()}`;
    const session = await prisma.voiceSession.create({
      data: {
        organizationId,
        channelConnectionId: channel.id,
        provider: "SIMULATOR",
        providerCallId,
        transport: "SIMULATOR",
        direction: "INBOUND",
        externalCallerId: "+15550001111",
        status: "RINGING"
      }
    });

    const transcript: string[] = [];
    const sentFrames: unknown[] = [];
    const sink: OutboundAudioSink = { sendFrame: (f) => sentFrames.push(f), close: () => undefined };

    await engine.startStream({
      voiceSessionId: session.id,
      organizationId,
      providerStreamId: "SIM-STREAM",
      externalCallerId: "+15550001111",
      sampleRateHz: 8000,
      greetingText: channel.receptionistGreeting,
      sink
    });

    transcript.push("SIMULATED CALL START");
    await waitUntil(() => mockProvider.getSession(session.id) !== undefined);

    const agentSegmentCount = () =>
      prisma.voiceTranscriptSegment.count({ where: { voiceSessionId: session.id, speaker: "AGENT" } });

    // Let the greeting's own async transcript-persist chain land first — otherwise the first say()
    // below can race it and mistake the greeting's delayed segment for a real reply to the caller.
    await waitUntil(async () => (await agentSegmentCount()) >= 1);
    {
      const greeting = await prisma.voiceTranscriptSegment.findFirst({
        where: { voiceSessionId: session.id, speaker: "AGENT" },
        orderBy: { sequenceNumber: "asc" }
      });
      if (greeting) transcript.push(`Agent: ${greeting.text}`);
    }

    const say = async (line: string) => {
      transcript.push(`Caller: ${line}`);
      const agentBefore = await agentSegmentCount();
      asMockSession(requireMockSession(mockProvider, session.id)).simulateUserUtterance(line);
      engine.handleInboundAudio(session.id, { pcm16: new Int16Array(160), sampleRateHz: 8000 });
      engine.forceEndOfTurn(session.id); // explicit-commit turn detection mode — see STEP 14
      // Wait for the AGENT's own reply segment specifically — not just any new segment — so the next
      // caller line is never spoken while this turn (routing + agent execution) is still in flight.
      await waitUntil(async () => (await agentSegmentCount()) > agentBefore);
      const segments = await prisma.voiceTranscriptSegment.findMany({
        where: { voiceSessionId: session.id, speaker: "AGENT" },
        orderBy: { sequenceNumber: "desc" },
        take: 1
      });
      if (segments[0]) transcript.push(`Agent: ${segments[0].text}`);
    };

    await say("Hi, I'm Krishna.");
    await say("I want to plan a trip to Dubai.");

    const finalSession = await prisma.voiceSession.findUniqueOrThrow({ where: { id: session.id } });
    if (finalSession.activeHandoffId) transcript.push("HANDOFF -> Travel Employee");

    await engine.endStream(session.id, "CALLER_HANGUP");
    transcript.push("SIMULATED CALL END");

    console.log("\n" + transcript.join("\n") + "\n");

    expect(transcript[0]).toBe("SIMULATED CALL START");
    expect(transcript.at(-1)).toBe("SIMULATED CALL END");
    expect(transcript).toContain("HANDOFF -> Travel Employee");
    expect(sentFrames.length).toBeGreaterThan(0);
  }, 20_000);
});
