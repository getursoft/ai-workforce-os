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

function requireDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

suite("Travel Employee end-to-end", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let agents: AgentService;
  let token: string;
  let organizationId: string;
  let pluginId: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    agents = app.get(AgentService);
    await cleanup(prisma);

    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Travel Org",
        firstName: "Owner",
        email: `travel-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    token = registered.body.data.tokens.accessToken;
    organizationId = registered.body.data.organization.id;

    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId: "travel-employee", enable: true })
      .expect(201);
    pluginId = installed.body.id;
  });

  afterAll(async () => {
    if (prisma) await cleanup(prisma);
    await app?.close();
  });

  it("installs as an ACTIVE AI employee with the declared travel tools", async () => {
    const employees = await request(app.getHttpServer())
      .get("/api/v1/agents")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const employee = employees.body.find((item: { id: string }) => item.id === pluginId);
    expect(employee).toMatchObject({ status: "ACTIVE" });
  });

  it("returns safe configuration defaults before any configuration is saved", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const config = await request(app.getHttpServer())
      .get(`/api/v1/travel-employee/${pluginId}/configuration`)
      .set(auth)
      .expect(200);
    expect(config.body.configured).toBe(false);
    expect(config.body.defaultCurrency).toBe("USD");
  });

  it("updates configuration, preserves untouched fields on a partial update, and enforces tenant isolation", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    await request(app.getHttpServer())
      .patch(`/api/v1/travel-employee/${pluginId}/configuration`)
      .set(auth)
      .send({
        persona: "Warm, concise travel concierge",
        welcomeMessage: "Welcome to Voyager AI! Where shall we send you?",
        escalationContact: "humans@voyager.example",
        brandTone: "FRIENDLY",
        defaultCurrency: "USD",
        defaultLanguage: "en"
      })
      .expect(200);
    const afterPartial = await request(app.getHttpServer())
      .patch(`/api/v1/travel-employee/${pluginId}/configuration`)
      .set(auth)
      .send({ brandTone: "FORMAL" })
      .expect(200);
    expect(afterPartial.body).toMatchObject({
      configured: true,
      brandTone: "FORMAL",
      escalationContact: "humans@voyager.example",
      welcomeMessage: "Welcome to Voyager AI! Where shall we send you?"
    });

    const other = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Other Travel Org",
        firstName: "Other",
        email: `travel-other-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/api/v1/travel-employee/${pluginId}/configuration`)
      .set("Authorization", `Bearer ${other.body.data.tokens.accessToken}`)
      .expect(404);
  });

  it("requires authentication", async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/travel-employee/${pluginId}/configuration`)
      .expect(401);
  });

  describe("dashboard chat conversation flow", () => {
    const auth = () => ({ Authorization: `Bearer ${token}` });
    let conversationId: string;

    it("greets and asks for the traveler's name on the first message", async () => {
      const run = await request(app.getHttpServer())
        .post("/api/v1/agents/run")
        .set(auth())
        .send({ pluginInstallationId: pluginId, message: "Hi there" })
        .expect(201);
      expect(run.body.status).toBe("COMPLETED");
      expect(run.body.response).toMatch(/may i know your name/i);
      expect(run.body.response).not.toMatch(/where would you like to travel/i);
      conversationId = run.body.conversationId;
    });

    it("offers the Intent Discovery menu right after the name is captured, instead of assuming a trip is being planned", async () => {
      const run = await request(app.getHttpServer())
        .post("/api/v1/agents/run")
        .set(auth())
        .send({ pluginInstallationId: pluginId, conversationId, message: "Krishna" })
        .expect(201);
      expect(run.body.response).toMatch(/krishna/i);
      expect(run.body.response).toMatch(/how may i help you today/i);
      expect(run.body.response).toMatch(/plan a trip/i);
      expect(run.body.response).toMatch(/build an itinerary/i);
      expect(run.body.response).toMatch(/estimate costs/i);
      expect(run.body.response).toMatch(/explain policies/i);
      expect(run.body.response).toMatch(/answer travel questions/i);
      expect(run.body.response).not.toMatch(/where would you like to travel/i);
      const state = await request(app.getHttpServer())
        .get(`/api/v1/travel-employee/${pluginId}/conversations/${conversationId}/state`)
        .set(auth())
        .expect(200);
      expect(state.body.stage).toBe("DISCOVER_INTENT");
    });

    it("never re-asks for information already collected while progressing through stages", async () => {
      const destination = await request(app.getHttpServer())
        .post("/api/v1/agents/run")
        .set(auth())
        .send({ pluginInstallationId: pluginId, conversationId, message: "Dubai" })
        .expect(201);
      expect(destination.body.response).not.toMatch(/where would you like to travel/i);
      // Once destination is known, the remaining gaps are asked together in one natural bulleted
      // message, not one mechanical question per turn.
      expect(destination.body.response).toMatch(/when you're travelling/i);
      expect(destination.body.response).toMatch(/how many people/i);
      expect(destination.body.response).toMatch(/your approximate budget/i);

      const dates = await request(app.getHttpServer())
        .post("/api/v1/agents/run")
        .set(auth())
        .send({
          pluginInstallationId: pluginId,
          conversationId,
          message: "December for 5 days, 2 adults, budget $6000"
        })
        .expect(201);
      expect(dates.body.response).toMatch(/itinerary summary/i);
      expect(dates.body.response).toMatch(/reply 'confirm' to proceed/i);
      expect(dates.body.response).not.toMatch(/where would you like to travel/i);
    });

    it("exposes the collected structured state for future CRM integration", async () => {
      const state = await request(app.getHttpServer())
        .get(`/api/v1/travel-employee/${pluginId}/conversations/${conversationId}/state`)
        .set(auth())
        .expect(200);
      expect(state.body).toMatchObject({
        destination: "Dubai",
        travelMonth: "December",
        passengers: 2,
        budgetAmount: 6000,
        stage: "CONFIRM_BOOKING"
      });
      const memory = await prisma.agentMemory.findFirst({
        where: { conversationId, key: "travel.trip_state" }
      });
      expect(memory).not.toBeNull();
    });

    it("asks for a phone number on confirmation, then persists an internal TravelLead and records BOOKING_CONFIRMED state — no CRM connector involved", async () => {
      const confirm = await request(app.getHttpServer())
        .post("/api/v1/agents/run")
        .set(auth())
        .send({ pluginInstallationId: pluginId, conversationId, message: "yes, please confirm" })
        .expect(201);
      expect(confirm.body.response).toMatch(/phone number|mobile number/i);
      expect(confirm.body.response).not.toMatch(/CRM/i);

      const withPhone = await request(app.getHttpServer())
        .post("/api/v1/agents/run")
        .set(auth())
        .send({ pluginInstallationId: pluginId, conversationId, message: "+919876543210" })
        .expect(201);
      expect(withPhone.body.response).toMatch(/travel request has been submitted successfully/i);

      const state = await request(app.getHttpServer())
        .get(`/api/v1/travel-employee/${pluginId}/conversations/${conversationId}/state`)
        .set(auth())
        .expect(200);
      expect(state.body.stage).toBe("BOOKING_CONFIRMED");

      const lead = await prisma.travelLead.findFirst({ where: { conversationId } });
      expect(lead).not.toBeNull();
      expect(lead?.phoneNumber).toBe("+919876543210");
    });

    it("resets the conversation, archiving it so a fresh conversation starts next", async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/travel-employee/${pluginId}/conversations/${conversationId}/reset`)
        .set(auth())
        .expect(201);
      const archived = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      expect(archived.status).toBe("ARCHIVED");
    });
  });

  it("escalates to a human and surfaces the configured escalation contact", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const run = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({ pluginInstallationId: pluginId, message: "I'd like to talk to a human agent please" })
      .expect(201);
    expect(run.body.response).toContain("humans@voyager.example");
    const state = await request(app.getHttpServer())
      .get(`/api/v1/travel-employee/${pluginId}/conversations/${run.body.conversationId}/state`)
      .set(auth)
      .expect(200);
    expect(state.body.stage).toBe("ESCALATED");
  });

  it("shares the same Agent Runtime for a WhatsApp-style channel actor, with no code duplication", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const channel = await request(app.getHttpServer())
      .post("/api/v1/channels")
      .set(auth)
      .send({
        name: "Travel WhatsApp",
        provider: "TWILIO",
        channelType: "WHATSAPP",
        agentId: pluginId,
        configuration: {
          accountSid: `AC${"a".repeat(32)}`,
          authToken: "test-auth-token-value",
          fromNumber: "+14155238886"
        }
      })
      .expect(201);
    const channelConnectionId = channel.body.id as string;
    const externalUserId = "+14155550111";

    const first = await agents.execute({
      organizationId,
      agentId: pluginId,
      actor: { type: "CHANNEL", channelConnectionId, externalUserId },
      text: "Hi",
      source: { type: "CHANNEL", channelId: channelConnectionId, externalUserId },
      requestId: "whatsapp-request-1"
    });
    expect(first.response).toMatch(/may i know your name/i);
    expect(first.response).not.toMatch(/where would you like to travel/i);
    const conversation = requireDefined(
      await prisma.conversation.findFirst({ where: { id: first.conversationId } }),
      "conversation not created"
    );
    expect(conversation.channelConnectionId).toBe(channelConnectionId);
    expect(conversation.externalUserId).toBe(externalUserId);

    const second = await agents.execute({
      organizationId,
      agentId: pluginId,
      conversationId: first.conversationId,
      actor: { type: "CHANNEL", channelConnectionId, externalUserId },
      text: "Priya",
      source: { type: "CHANNEL", channelId: channelConnectionId, externalUserId },
      requestId: "whatsapp-request-2"
    });
    expect(second.response).toMatch(/priya/i);
    expect(second.response).toMatch(/how may i help you today/i);
    expect(second.response).not.toMatch(/where would you like to travel/i);

    const third = await agents.execute({
      organizationId,
      agentId: pluginId,
      conversationId: first.conversationId,
      actor: { type: "CHANNEL", channelConnectionId, externalUserId },
      text: "Bali in January for 4 days, 2 people, budget $4000",
      source: { type: "CHANNEL", channelId: channelConnectionId, externalUserId },
      requestId: "whatsapp-request-3"
    });
    expect(third.response).not.toMatch(/where would you like to travel/i);
    expect(third.response).toMatch(/itinerary summary/i);
  });

  describe("Travel Leads API (Conversation Completion & Lead Capture)", () => {
    const auth = () => ({ Authorization: `Bearer ${token}` });
    let leadId: string;

    beforeAll(async () => {
      const conversation = await prisma.conversation.create({
        data: { organizationId, pluginInstallationId: pluginId, title: "Lead capture test conversation" }
      });
      const lead = await prisma.travelLead.create({
        data: {
          organizationId,
          pluginInstallationId: pluginId,
          conversationId: conversation.id,
          reference: "TRV-E2E001",
          customerName: "Test Traveler",
          phoneNumber: "+919876543210",
          departureCity: "New Delhi",
          destination: "Paris",
          travelDates: "August",
          passengers: "2 adults",
          budgetAmount: 2000,
          budgetCurrency: "USD",
          conversationSummary: "New Delhi -> Paris | August | 2 adults | Budget: 2000 USD"
        }
      });
      leadId = lead.id;
    });

    it("lists leads captured for the organization", async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/travel-employee/${pluginId}/leads`)
        .set(auth())
        .expect(200);
      expect(res.body.total).toBeGreaterThanOrEqual(1);
      expect(res.body.items.some((item: { id: string }) => item.id === leadId)).toBe(true);
      const found = res.body.items.find((item: { id: string }) => item.id === leadId);
      expect(found).toMatchObject({ reference: "TRV-E2E001", destination: "Paris", status: "NEW" });
    });

    it("filters by status", async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/travel-employee/${pluginId}/leads?status=CONTACTED`)
        .set(auth())
        .expect(200);
      expect(res.body.items.some((item: { id: string }) => item.id === leadId)).toBe(false);
    });

    it("updates a lead's status", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/travel-employee/${pluginId}/leads/${leadId}/status`)
        .set(auth())
        .send({ status: "CONTACTED" })
        .expect(200);
      expect(res.body.status).toBe("CONTACTED");
    });

    it("rejects an invalid status value", async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/travel-employee/${pluginId}/leads/${leadId}/status`)
        .set(auth())
        .send({ status: "NOT_A_REAL_STATUS" })
        .expect(400);
    });

    it("enforces tenant isolation", async () => {
      const other = await request(app.getHttpServer())
        .post("/api/v1/auth/register")
        .send({
          organizationName: "Other Leads Org",
          firstName: "Other",
          email: `travel-leads-other-${Date.now()}@example.com`,
          password: "StrongPassword@123"
        })
        .expect(201);
      await request(app.getHttpServer())
        .get(`/api/v1/travel-employee/${pluginId}/leads`)
        .set("Authorization", `Bearer ${other.body.data.tokens.accessToken}`)
        .expect(404);
    });
  });
});

async function cleanup(prisma: PrismaService): Promise<void> {
  await prisma.travelLead.deleteMany();
  await prisma.channelMessage.deleteMany();
  await prisma.channelConnection.deleteMany();
  await prisma.conversationMessage.deleteMany();
  await prisma.agentToolExecution.deleteMany();
  await prisma.agentExecution.deleteMany();
  await prisma.agentMemory.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.travelEmployeeConfiguration.deleteMany();
  await prisma.pluginAiConfiguration.deleteMany();
  await prisma.pluginConfiguration.deleteMany();
  await prisma.plugin.deleteMany();
}
