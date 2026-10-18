/**
 * Krevia CRM — workforce-wide lead integration UAT. Proves the generic non-Travel domain-employee artifact
 * path (`AgentService.registerEmployeeTools`) mirrors into the canonical Lead ONLY for a domain flagged
 * `isLeadGenerating` (Sales), with correct specialist attribution, dedupe, tenant isolation, CRM-disabled
 * behavior, and WEB_CHAT/WHATSAPP/VOICE source resolution — and that a non-lead-generating domain (HR)
 * never creates one. Real NestFactory app + real Postgres (TEST_DATABASE_URL).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AgentService } from "../agents/agent.service";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

async function waitUntilTruthy<T>(check: () => Promise<T | null> | T | null, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitUntilTruthy timed out");
    await new Promise((res) => setTimeout(res, 75));
  }
}

suite("Krevia CRM — workforce lead integration UAT", () => {
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
        organizationName: `Krevia CRM Workforce ${suffix} ${Date.now()}`,
        firstName: "Owner",
        email: `krevia-crm-workforce-${suffix}-${Date.now()}@example.com`,
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

  // Proven deterministic sequence for every domain employee (see employees.e2e.spec.ts's own
  // "persists an artifact after consent + contact" test) — name -> topic -> detail -> consent -> phone.
  async function runSalesCaptureTurns(say: (m: string) => Promise<{ response: string }>) {
    await say("my name is Kabir");
    await say("i would like a quote");
    await say("please help with this request for my team");
    await say("yes please submit it");
    return say("+919876500002");
  }

  describe("Sales Employee — Web via Receptionist handoff (real continueHandoff, no direct-specialist workaround)", () => {
    it("resumes the SAME specialist state across 3+ turns routed through Receptionist.continueHandoff — no repeated questions, no lost fields — and attributes the Lead to Sales, never the Receptionist", async () => {
      const { token, organizationId } = await register("sales-web");
      const receptionistId = await install(token, "receptionist-employee");
      const salesId = await install(token, "sales-employee");
      const say = chatWith(token, receptionistId);

      await say("Hi");
      await say("I'm Kabir");
      // Turn 1 through Receptionist: triggers the handoff (startHandoff) AND is itself processed by Sales.
      const wantsSales = await say("i would like a quote");
      expect(wantsSales.receptionist?.handoff?.targetDisplayName).toBe("Sales Employee");
      // Regression guard for the fixed bug: must NOT re-show the generic intent-discovery menu (the
      // symptom was every post-handoff turn falling back to "What can I help you with?" instead of
      // progressing) and must acknowledge the actual interest expressed in THIS message.
      expect(wantsSales.response).not.toMatch(/what can i help you with/i);

      const handoffRow = await prisma.receptionistHandoff.findFirstOrThrow({
        where: { organizationId, conversationId: wantsSales.conversationId }
      });
      const receptionistConversationId = wantsSales.conversationId;

      // Turn 2 through Receptionist.continueHandoff: must NOT re-ask name/interest already known.
      const t2 = await say("please help with this request for my team");
      expect(t2.response).not.toMatch(/what can i help you with|what is your name|what are you interested in/i);

      // Turn 3 through Receptionist.continueHandoff: consent.
      const t3 = await say("yes please submit it");
      expect(t3.response).toMatch(/mobile|phone|contact/i);

      // Turn 4 through Receptionist.continueHandoff: contact — completes the capture.
      const captured = await say("+919876500002");
      expect(captured.response).toMatch(/created successfully|reference/i);

      // Same Interaction/conversation identity preserved across every continueHandoff turn.
      const handoffAfter = await prisma.receptionistHandoff.findUniqueOrThrow({ where: { id: handoffRow.id } });
      expect(handoffAfter.conversationId).toBe(receptionistConversationId);
      expect(captured.conversationId).toBe(receptionistConversationId);

      const salesLead = await waitUntilTruthy(() => prisma.salesLead.findFirst({ where: { organizationId } }));
      expect(salesLead.pluginInstallationId).toBe(salesId);
      expect(salesLead.conversationId).toBe(handoffAfter.targetConversationId);

      const lead = await waitUntilTruthy(() => prisma.lead.findFirst({ where: { organizationId } }));
      expect(lead.source).toBe("WEB_CHAT");
      // Specialist attribution: the Sales Employee's own plugin installation id, never the Receptionist's.
      expect(lead.agentId).toBe(salesId);
      expect(lead.agentId).not.toBe(receptionistId);
      expect(lead.status).toBe("NEW");
      expect(lead.leadReferenceId).toMatch(/^KRV-LD-/);
      expect(await prisma.lead.count({ where: { organizationId } })).toBe(1);

      // Dedupe: resending the phone number through Receptionist.continueHandoff again must never create a
      // second SalesLead or a second canonical Lead.
      await say("+919876500002");
      expect(await prisma.salesLead.count({ where: { organizationId } })).toBe(1);
      expect(await prisma.lead.count({ where: { organizationId } })).toBe(1);
      const stillSameLead = await prisma.lead.findFirstOrThrow({ where: { organizationId } });
      expect(stillSameLead.id).toBe(lead.id);
    }, 30_000);
  });

  describe("HR Employee — Web via Receptionist handoff (non-lead-generating domain, multi-turn continuation)", () => {
    it("resumes the SAME specialist state across 3+ turns through Receptionist.continueHandoff, creates an HrTicket, and creates NO canonical Lead", async () => {
      const { token, organizationId } = await register("hr-web");
      const receptionistId = await install(token, "receptionist-employee");
      const hrId = await install(token, "hr-employee");
      const say = chatWith(token, receptionistId);

      await say("Hi");
      await say("I'm Priya");
      const wantsHr = await say("it's about the leave policy");
      expect(wantsHr.receptionist?.handoff?.targetDisplayName).toBe("HR Employee");
      expect(wantsHr.response).not.toMatch(/what can i help you with/i);

      const t2 = await say("please help with this request for my team");
      expect(t2.response).not.toMatch(/what can i help you with|what is your name/i);

      const t3 = await say("yes please submit it");
      expect(t3.response).toMatch(/mobile|phone|contact/i);

      const captured = await say("+919876500006");
      expect(captured.response).toMatch(/created successfully|reference/i);

      const ticket = await waitUntilTruthy(() => prisma.hrTicket.findFirst({ where: { organizationId } }));
      expect(ticket.pluginInstallationId).toBe(hrId);

      await new Promise((res) => setTimeout(res, 300));
      expect(await prisma.lead.count({ where: { organizationId } })).toBe(0);
    }, 30_000);
  });

  describe("Sales Employee — WhatsApp channel actor", () => {
    it("captures a canonical Lead with source WHATSAPP, attributed to Sales", async () => {
      const { token, organizationId } = await register("sales-whatsapp");
      const salesId = await install(token, "sales-employee");
      const agents = app.get(AgentService);

      const channel = await request(app.getHttpServer())
        .post("/api/v1/channels")
        .set("Authorization", `Bearer ${token}`)
        .send({
          name: "Sales WhatsApp",
          provider: "TWILIO",
          channelType: "WHATSAPP",
          agentId: salesId,
          configuration: {
            accountSid: `AC${"c".repeat(32)}`,
            authToken: "test-auth-token-value",
            fromNumber: "+14155238887"
          }
        })
        .expect(201);
      const channelConnectionId = channel.body.id as string;
      const externalUserId = "+14155550222";
      const actor = { type: "CHANNEL" as const, channelConnectionId, externalUserId };
      const source = { type: "CHANNEL" as const, channelId: channelConnectionId, externalUserId };

      const first = await agents.execute({
        organizationId,
        agentId: salesId,
        actor,
        text: "my name is Kabir",
        source,
        requestId: "sales-whatsapp-1"
      });
      const conversationId = first.conversationId;
      await agents.execute({
        organizationId,
        agentId: salesId,
        conversationId,
        actor,
        text: "i would like a quote",
        source,
        requestId: "sales-whatsapp-2"
      });
      await agents.execute({
        organizationId,
        agentId: salesId,
        conversationId,
        actor,
        text: "please help with this request for my team",
        source,
        requestId: "sales-whatsapp-3"
      });
      await agents.execute({
        organizationId,
        agentId: salesId,
        conversationId,
        actor,
        text: "yes please submit it",
        source,
        requestId: "sales-whatsapp-4"
      });
      await agents.execute({
        organizationId,
        agentId: salesId,
        conversationId,
        actor,
        text: "+919876500003",
        source,
        requestId: "sales-whatsapp-5"
      });

      const lead = await waitUntilTruthy(() =>
        prisma.lead.findFirst({ where: { organizationId, phone: "+919876500003" } })
      );
      expect(lead.source).toBe("WHATSAPP");
      expect(lead.agentId).toBe(salesId);
    }, 30_000);
  });

  describe("Sales Employee — VOICE source actor", () => {
    it("captures a canonical Lead with source VOICE", async () => {
      const { token, organizationId } = await register("sales-voice");
      const salesId = await install(token, "sales-employee");
      const agents = app.get(AgentService);

      const channel = await request(app.getHttpServer())
        .post("/api/v1/channels")
        .set("Authorization", `Bearer ${token}`)
        .send({
          name: "Sales Voice",
          provider: "TWILIO",
          channelType: "WHATSAPP",
          agentId: salesId,
          configuration: {
            accountSid: `AC${"d".repeat(32)}`,
            authToken: "test-auth-token-value",
            fromNumber: "+14155238888"
          }
        })
        .expect(201);
      const channelConnectionId = channel.body.id as string;
      const externalUserId = "+15550004444";
      const actor = { type: "CHANNEL" as const, channelConnectionId, externalUserId };
      const source = { type: "VOICE" as const, channelId: channelConnectionId, providerCallId: "sim-call-1" };

      const first = await agents.execute({
        organizationId,
        agentId: salesId,
        actor,
        text: "my name is Kabir",
        source,
        requestId: "sales-voice-1"
      });
      const conversationId = first.conversationId;
      const turns: Array<{ text: string; requestId: string }> = [
        { text: "i would like a quote", requestId: "sales-voice-2" },
        { text: "please help with this request for my team", requestId: "sales-voice-3" },
        { text: "yes please submit it", requestId: "sales-voice-4" },
        { text: "+919876500004", requestId: "sales-voice-5" }
      ];
      for (const turn of turns) {
        await agents.execute({ organizationId, agentId: salesId, conversationId, actor, ...turn, source });
      }

      const lead = await waitUntilTruthy(() =>
        prisma.lead.findFirst({ where: { organizationId, phone: "+919876500004" } })
      );
      expect(lead.source).toBe("VOICE");
      expect(lead.agentId).toBe(salesId);
    }, 30_000);
  });

  describe("Sales Employee — CRM-disabled behavior", () => {
    it("creates the canonical Lead with zero connector installations for the organization", async () => {
      const { token, organizationId } = await register("sales-no-crm");
      const salesId = await install(token, "sales-employee");
      expect(await prisma.connectorInstallation.count({ where: { organizationId } })).toBe(0);

      const say = chatWith(token, salesId);
      const captured = await runSalesCaptureTurns(say);
      expect(captured.response).toMatch(/created successfully|reference/i);
      expect(captured.response).not.toMatch(/CRM/i);

      const lead = await waitUntilTruthy(() => prisma.lead.findFirst({ where: { organizationId } }));
      expect(lead.status).toBe("NEW");
      expect(lead.source).toBe("WEB_CHAT");
    }, 30_000);
  });

  describe("Tenant isolation for workforce-generated leads", () => {
    it("Tenant A cannot see a Sales lead generated inside Tenant B", async () => {
      const tenantA = await register("sales-tenant-a");
      const tenantB = await register("sales-tenant-b");
      const salesIdB = await install(tenantB.token, "sales-employee");
      const say = chatWith(tenantB.token, salesIdB);
      await runSalesCaptureTurns(say);

      const leadB = await waitUntilTruthy(() =>
        prisma.lead.findFirst({ where: { organizationId: tenantB.organizationId } })
      );

      const listA = await request(app.getHttpServer())
        .get("/api/v1/leads")
        .set("Authorization", `Bearer ${tenantA.token}`)
        .expect(200);
      expect((listA.body.items as Array<{ id: string }>).some((l) => l.id === leadB.id)).toBe(false);

      await request(app.getHttpServer())
        .get(`/api/v1/leads/${leadB.id}`)
        .set("Authorization", `Bearer ${tenantA.token}`)
        .expect(404);
    }, 30_000);
  });

  describe("HR Employee — non-lead-generating domain", () => {
    it("creates an HrTicket but NEVER a canonical Krevia CRM Lead", async () => {
      const { token, organizationId } = await register("hr-non-lead");
      const hrId = await install(token, "hr-employee");
      const say = chatWith(token, hrId);
      await say("my name is Kabir");
      await say("it's about the leave policy");
      await say("please help with this request for my team");
      await say("yes please submit it");
      const captured = await say("+919876500005");
      expect(captured.response).toMatch(/created successfully|reference/i);

      const ticket = await waitUntilTruthy(() => prisma.hrTicket.findFirst({ where: { organizationId } }));
      expect(ticket.organizationId).toBe(organizationId);

      // Give any (incorrect) mirror attempt time to land, then assert it never did.
      await new Promise((res) => setTimeout(res, 300));
      expect(await prisma.lead.count({ where: { organizationId } })).toBe(0);
    }, 30_000);
  });
});
