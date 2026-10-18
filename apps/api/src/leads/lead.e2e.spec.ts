/**
 * Krevia CRM — end-to-end UAT. Real NestFactory app + real Postgres (TEST_DATABASE_URL) + the real HTTP
 * surface. Proves the internal Lead is created/updated across every required channel without any external
 * CRM connector configured, is tenant-isolated, and drives the manual-lead lifecycle (status/notes/assign).
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
import { AgentService } from "../agents/agent.service";
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
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitUntilTruthy timed out");
    await wait(75);
  }
}

suite("Krevia CRM — end-to-end UAT", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdOrganizationIds: string[] = [];

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: ["error", "warn"], abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
  }, 60_000);

  afterAll(async () => {
    // ChannelConnection -> Plugin is a RESTRICT foreign key: leaving one of this suite's WhatsApp/Voice
    // test channels behind would break any OTHER suite's own blanket `plugin.deleteMany()` cleanup (see
    // employees.e2e.spec.ts). Delete them explicitly; the rest of this suite's data is harmless to leave
    // (every other suite's own cleanup scopes by its own organization/plugin ids, never blanket-queries).
    if (prisma && createdOrganizationIds.length) {
      await prisma.channelConnection.deleteMany({ where: { organizationId: { in: createdOrganizationIds } } });
    }
    await app?.close();
  }, 20_000);

  async function register(suffix: string) {
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Krevia CRM ${suffix} ${Date.now()}`,
        firstName: "Owner",
        email: `krevia-crm-${suffix}-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    createdOrganizationIds.push(registered.body.data.organization.id as string);
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

  function chatWith(token: string, pluginInstallationId: string) {
    let conversationId: string | undefined;
    return async function say(message: string) {
      const res = await request(app.getHttpServer())
        .post("/api/v1/agents/run")
        .set("Authorization", `Bearer ${token}`)
        .send({ pluginInstallationId, ...(conversationId ? { conversationId } : {}), message })
        .expect(201);
      conversationId = res.body.conversationId;
      return res.body as {
        response: string;
        conversationId: string;
        receptionist?: { routeType: string; handoff: { targetDisplayName: string } | null };
      };
    };
  }

  // ---------------------------------------------------------------------------------------------------
  // A + B: Web chat -> Receptionist -> Travel Employee -> lead created, then updated (not duplicated) on
  // a continued conversation. No AI provider is configured — this is the deterministic (no-LLM) runtime,
  // proving Krevia CRM works with zero external AI/CRM credentials.
  // ---------------------------------------------------------------------------------------------------
  describe("A+B: Web chat via Receptionist -> Travel Employee", () => {
    it("captures a Krevia CRM lead on handoff, then updates the SAME lead on a continued conversation without duplicating it", async () => {
      const { token, organizationId } = await register("web");
      const receptionistId = await install(token, "receptionist-employee");
      const travelId = await install(token, "travel-employee");
      const say = chatWith(token, receptionistId);

      await say("Hi");
      await say("I'm Krishna");
      const wantsTravel = await say("I want a Delhi to Dubai trip for 3 adults next month");
      expect(wantsTravel.receptionist?.handoff?.targetDisplayName).toBe("Travel Employee");

      // Provide remaining details naturally until the deterministic engine offers to submit/confirm —
      // mirrors the exact proven turn shape from travel.e2e.spec.ts's own deterministic flow.
      let last = wantsTravel;
      for (let i = 0; i < 6; i++) {
        if (/reply 'confirm'|itinerary summary/i.test(last.response)) break;
        last = await say("3 adults, next month, 5 days, budget $6000");
        if (/reply 'confirm'|itinerary summary/i.test(last.response)) break;
        last = await say("Delhi to Dubai, 3 adults, next month, 5 days, budget $6000");
      }
      if (/reply 'confirm'/i.test(last.response)) {
        last = await say("yes, please confirm");
      }
      expect(last.response).toMatch(/phone number|mobile number/i);

      const withPhone = await say("+919876543210");
      expect(withPhone.response).toMatch(/submitted successfully/i);

      const travelLead = await waitUntilTruthy(() =>
        prisma.travelLead.findFirst({ where: { organizationId, phoneNumber: "+919876543210" } })
      );
      expect(travelLead.pluginInstallationId).toBe(travelId);

      // --- Krevia CRM canonical Lead ---
      const lead = await waitUntilTruthy(() => prisma.lead.findFirst({ where: { organizationId } }));
      expect(lead.source).toBe("WEB_CHAT");
      expect(lead.agentId).toBe(travelId);
      expect(lead.status).toBe("NEW");
      expect(lead.leadReferenceId).toMatch(/^KRV-LD-/);
      expect(lead.phone).toBe("+919876543210");
      expect(lead.interactionId).not.toBeNull();
      expect(await prisma.lead.count({ where: { organizationId } })).toBe(1);

      const interaction = lead.interactionId
        ? await prisma.interaction.findFirst({ where: { id: lead.interactionId } })
        : null;
      expect(interaction?.channel).toBe("WEB_CHAT");

      const activity = await prisma.leadActivity.findMany({ where: { leadId: lead.id }, orderBy: { createdAt: "asc" } });
      expect(activity.some((a) => a.type === "CREATED")).toBe(true);

      // B: continue the SAME conversation (repeating the phone number, the same proven re-trigger this
      // codebase's own travel.contact-routing.e2e.spec.ts uses) — must UPDATE the existing lead, never
      // create a duplicate.
      const before = lead.updatedAt;
      const repeated = await say("+919876543210");
      expect(repeated.response).toContain(travelLead.reference);
      await waitUntilTruthy(async () => {
        const refreshed = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
        return refreshed.updatedAt.getTime() > before.getTime() ? refreshed : null;
      });
      expect(await prisma.lead.count({ where: { organizationId } })).toBe(1);
      // The specialist's own conversationId (not the Receptionist's, which is what `conversationId` in
      // this test tracks) is what Lead.conversationId stores after a handoff — interactionId is the
      // identity that survives the handoff, and is what the dedup above actually keyed on.
      const stillSameLead = await prisma.lead.findFirstOrThrow({ where: { organizationId } });
      expect(stillSameLead.id).toBe(lead.id);
      expect(stillSameLead.interactionId).toBe(lead.interactionId);
    }, 30_000);
  });

  // ---------------------------------------------------------------------------------------------------
  // E: WhatsApp — a CHANNEL actor through the SAME AgentService.execute() path ChannelMessageProcessor
  // uses in production (see travel.e2e.spec.ts's own "shares the same Agent Runtime for a WhatsApp-style
  // channel actor" test for the identical, already-production-proven pattern).
  // ---------------------------------------------------------------------------------------------------
  describe("E: WhatsApp channel actor", () => {
    it("captures a lead with source WHATSAPP", async () => {
      const { token, organizationId } = await register("whatsapp");
      const travelId = await install(token, "travel-employee");
      const agents = app.get(AgentService);

      const channel = await request(app.getHttpServer())
        .post("/api/v1/channels")
        .set("Authorization", `Bearer ${token}`)
        .send({
          name: "Travel WhatsApp",
          provider: "TWILIO",
          channelType: "WHATSAPP",
          agentId: travelId,
          configuration: {
            accountSid: `AC${"b".repeat(32)}`,
            authToken: "test-auth-token-value",
            fromNumber: "+14155238886"
          }
        })
        .expect(201);
      const channelConnectionId = channel.body.id as string;
      const externalUserId = "+14155550199";

      const first = await agents.execute({
        organizationId,
        agentId: travelId,
        actor: { type: "CHANNEL", channelConnectionId, externalUserId },
        text: "Hi",
        source: { type: "CHANNEL", channelId: channelConnectionId, externalUserId },
        requestId: "whatsapp-lead-1"
      });
      const conversationId = first.conversationId;

      const second = await agents.execute({
        organizationId,
        agentId: travelId,
        conversationId,
        actor: { type: "CHANNEL", channelConnectionId, externalUserId },
        text: "Priya",
        source: { type: "CHANNEL", channelId: channelConnectionId, externalUserId },
        requestId: "whatsapp-lead-2"
      });
      let last = second;
      for (let i = 0; i < 4 && !/reply 'confirm'|itinerary summary/i.test(last.response); i++) {
        last = await agents.execute({
          organizationId,
          agentId: travelId,
          conversationId,
          actor: { type: "CHANNEL", channelConnectionId, externalUserId },
          text: "Delhi to Dubai, 3 adults, next month, 5 days, budget $6000",
          source: { type: "CHANNEL", channelId: channelConnectionId, externalUserId },
          requestId: `whatsapp-lead-3-${i}`
        });
      }
      if (/reply 'confirm'/i.test(last.response)) {
        last = await agents.execute({
          organizationId,
          agentId: travelId,
          conversationId,
          actor: { type: "CHANNEL", channelConnectionId, externalUserId },
          text: "yes, please confirm",
          source: { type: "CHANNEL", channelId: channelConnectionId, externalUserId },
          requestId: "whatsapp-lead-4"
        });
      }
      expect(last.response).toMatch(/phone number|mobile number/i);
      await agents.execute({
        organizationId,
        agentId: travelId,
        conversationId,
        actor: { type: "CHANNEL", channelConnectionId, externalUserId },
        text: "+919876500001",
        source: { type: "CHANNEL", channelId: channelConnectionId, externalUserId },
        requestId: "whatsapp-lead-5"
      });

      const lead = await waitUntilTruthy(() =>
        prisma.lead.findFirst({ where: { organizationId, phone: "+919876500001" } })
      );
      expect(lead.source).toBe("WHATSAPP");
      expect(lead.agentId).toBe(travelId);
    }, 30_000);
  });

  // ---------------------------------------------------------------------------------------------------
  // F: Voice simulator — real VoiceSessionEngine + mock realtime provider, real Receptionist -> Travel
  // handoff (same infra as voice-tool-execution.e2e.spec.ts).
  // ---------------------------------------------------------------------------------------------------
  describe("F: Voice simulator", () => {
    it("captures a lead with source VOICE", async () => {
      const { token, organizationId } = await register("voice");
      const receptionistId = await install(token, "receptionist-employee");
      await install(token, "travel-employee");
      const owner = await prisma.user.findFirstOrThrow({ where: { organizationId } });
      const encryption = app.get(PluginSecretsEncryptionService);
      const engine = app.get(VoiceSessionEngine);
      const mockProvider = app.get(MockRealtimeVoiceProvider);

      const channel = await prisma.channelConnection.create({
        data: {
          organizationId,
          pluginInstallationId: receptionistId,
          name: "Voice CRM Test Channel",
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
          providerCallId: `CRM-${Date.now()}`,
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
        providerStreamId: "CRM-STREAM",
        externalCallerId: "+15550003333",
        sampleRateHz: 8000,
        greetingText: null,
        sink
      });
      await waitUntilTruthy(() => mockProvider.getSession(session.id) ?? null);

      const agentSegmentCount = () =>
        prisma.voiceTranscriptSegment.count({ where: { voiceSessionId: session.id, speaker: "AGENT" } });
      const say = async (line: string): Promise<string> => {
        const before = await agentSegmentCount();
        asMockSession(mockProvider.getSession(session.id)!).simulateUserUtterance(line);
        engine.handleInboundAudio(session.id, { pcm16: new Int16Array(160), sampleRateHz: 8000 });
        engine.forceEndOfTurn(session.id);
        await waitUntilTruthy(async () => ((await agentSegmentCount()) > before ? true : null));
        const latest = await prisma.voiceTranscriptSegment.findFirst({
          where: { voiceSessionId: session.id, speaker: "AGENT" },
          orderBy: { sequenceNumber: "desc" }
        });
        return latest?.text ?? "";
      };

      await say("Hi, I'm Krishna.");
      await say("I want to plan a trip to Dubai.");
      const voiceSessionAfterRoute = await waitUntilTruthy(async () => {
        const s = await prisma.voiceSession.findUniqueOrThrow({ where: { id: session.id } });
        return s.activeHandoffId ? s : null;
      });
      expect(voiceSessionAfterRoute.receptionistConversationId).toBeTruthy();

      let lastText = await say("Delhi to Dubai, 3 adults, next month, 5 days, budget $6000");
      for (let i = 0; i < 4 && !/reply confirm|itinerary summary|confirm the booking/i.test(lastText); i++) {
        lastText = await say("Delhi to Dubai, 3 adults, next month, 5 days, budget $6000");
      }
      if (/confirm/i.test(lastText)) {
        lastText = await say("yes, please confirm");
      }
      if (/phone|mobile/i.test(lastText)) {
        lastText = await say("9876543211");
      }

      const travelLead = await waitUntilTruthy(
        () => prisma.travelLead.findFirst({ where: { organizationId } }),
        15_000
      );
      const lead = await waitUntilTruthy(() => prisma.lead.findFirst({ where: { organizationId } }), 15_000);
      expect(lead.source).toBe("VOICE");
      expect(travelLead.organizationId).toBe(organizationId);

      await engine.endStream(session.id, "CALLER_HANGUP");
    }, 40_000);
  });

  // ---------------------------------------------------------------------------------------------------
  // C: Manual lead lifecycle — create, status update, note, assignment, activity timeline.
  // ---------------------------------------------------------------------------------------------------
  describe("C: Manual lead lifecycle", () => {
    it("org admin creates a lead manually, updates status, adds a note, assigns it, and the activity timeline reflects all of it", async () => {
      const { token } = await register("manual");
      const me = await request(app.getHttpServer())
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const ownerId = me.body.data.user.id as string;

      const created = await request(app.getHttpServer())
        .post("/api/v1/leads")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Arjun Mehta", phone: "+919812300000", requirement: "Interested in a family Europe tour" })
        .expect(201);
      expect(created.body.source).toBe("MANUAL");
      expect(created.body.leadReferenceId).toMatch(/^KRV-LD-/);
      const leadId = created.body.id as string;

      const updated = await request(app.getHttpServer())
        .patch(`/api/v1/leads/${leadId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "CONTACTED" })
        .expect(200);
      expect(updated.body.status).toBe("CONTACTED");

      await request(app.getHttpServer())
        .post(`/api/v1/leads/${leadId}/notes`)
        .set("Authorization", `Bearer ${token}`)
        .send({ note: "Called, interested, sending itinerary." })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/leads/${leadId}/assign`)
        .set("Authorization", `Bearer ${token}`)
        .send({ assignedToUserId: ownerId })
        .expect(201);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/leads/${leadId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(detail.body.assignedToUserId).toBe(ownerId);

      const activity = await request(app.getHttpServer())
        .get(`/api/v1/leads/${leadId}/activity`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const types = (activity.body as Array<{ type: string }>).map((a) => a.type);
      expect(types).toEqual(expect.arrayContaining(["CREATED", "STATUS_CHANGED", "NOTE_ADDED", "ASSIGNED"]));

      const summary = await request(app.getHttpServer())
        .get("/api/v1/leads/summary")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(summary.body.total).toBeGreaterThanOrEqual(1);
      expect(summary.body.contacted).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // D: Tenant isolation — Tenant A can never list/read/update Tenant B's leads.
  // ---------------------------------------------------------------------------------------------------
  describe("D: Tenant isolation", () => {
    it("Tenant A cannot list, read, or update Tenant B's lead", async () => {
      const tenantA = await register("tenant-a");
      const tenantB = await register("tenant-b");

      const bLead = await request(app.getHttpServer())
        .post("/api/v1/leads")
        .set("Authorization", `Bearer ${tenantB.token}`)
        .send({ name: "Tenant B Customer", phone: "+911111111111" })
        .expect(201);
      const bLeadId = bLead.body.id as string;

      await request(app.getHttpServer())
        .get(`/api/v1/leads/${bLeadId}`)
        .set("Authorization", `Bearer ${tenantA.token}`)
        .expect(404);

      await request(app.getHttpServer())
        .patch(`/api/v1/leads/${bLeadId}`)
        .set("Authorization", `Bearer ${tenantA.token}`)
        .send({ status: "LOST" })
        .expect(404);

      const listA = await request(app.getHttpServer())
        .get("/api/v1/leads")
        .set("Authorization", `Bearer ${tenantA.token}`)
        .expect(200);
      expect((listA.body.items as Array<{ id: string }>).some((l) => l.id === bLeadId)).toBe(false);

      const stillB = await prisma.lead.findUniqueOrThrow({ where: { id: bLeadId } });
      expect(stillB.status).toBe("NEW");
      expect(stillB.organizationId).toBe(tenantB.organizationId);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // G: CRM-disabled — no HubSpot/external CRM connector is installed/configured for this organization at
  // all, and the internal Lead + TravelLead still succeed. Internal persistence never depends on an
  // external connector (see TravelLeadService.createInternalLead / AgentService.syncLeadToCrmBestEffort).
  // ---------------------------------------------------------------------------------------------------
  describe("G: CRM-disabled behavior", () => {
    it("creates the internal lead successfully with zero connector installations for the organization", async () => {
      const { token, organizationId } = await register("no-crm");
      const travelId = await install(token, "travel-employee");
      const installations = await prisma.connectorInstallation.count({ where: { organizationId } });
      expect(installations).toBe(0);

      const say = chatWith(token, travelId);
      await say("Hi there");
      let last = await say("Krishna");
      for (let i = 0; i < 4 && !/reply 'confirm'|itinerary summary/i.test(last.response); i++) {
        last = await say("Delhi to Dubai, 3 adults, next month, 5 days, budget $6000");
      }
      if (/reply 'confirm'/i.test(last.response)) {
        last = await say("yes, please confirm");
      }
      expect(last.response).toMatch(/phone number|mobile number/i);
      const withPhone = await say("+919876511111");
      expect(withPhone.response).toMatch(/submitted successfully/i);
      expect(withPhone.response).not.toMatch(/CRM/i);

      const travelLead = await waitUntilTruthy(() =>
        prisma.travelLead.findFirst({ where: { organizationId, phoneNumber: "+919876511111" } })
      );
      expect(travelLead.crmSyncStatus).not.toBe("SYNCED");
      const lead = await waitUntilTruthy(() => prisma.lead.findFirst({ where: { organizationId } }));
      expect(lead.status).toBe("NEW");
    }, 30_000);
  });
});
