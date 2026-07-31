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

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/** One domain employee under test: plugin slug, route prefix, artifact endpoint, artifact noun, and a
 *  topic phrase that matches its domain extractor (so the artifact flow completes in this generic suite). */
const EMPLOYEES = [
  {
    slug: "hr-employee",
    route: "hr-employee",
    artifacts: "tickets",
    artifactNoun: "HR request",
    topic: "it's about the leave policy"
  },
  {
    slug: "finance-employee",
    route: "finance-employee",
    artifacts: "records",
    artifactNoun: "finance request",
    topic: "it's about an expense"
  },
  {
    slug: "it-support-employee",
    route: "it-support-employee",
    artifacts: "tickets",
    artifactNoun: "IT support ticket",
    topic: "my vpn is not working"
  },
  {
    slug: "sales-employee",
    route: "sales-employee",
    artifacts: "leads",
    artifactNoun: "sales lead",
    topic: "i would like a quote"
  },
  {
    slug: "marketing-employee",
    route: "marketing-employee",
    artifacts: "campaigns",
    artifactNoun: "campaign brief",
    topic: "plan an email campaign"
  },
  {
    slug: "legal-employee",
    route: "legal-employee",
    artifacts: "notices",
    artifactNoun: "legal notice record",
    topic: "it's a gst notice"
  },
  {
    slug: "customer-support-employee",
    route: "customer-support-employee",
    artifacts: "tickets",
    artifactNoun: "support ticket",
    topic: "where is my order"
  }
] as const;

suite("Domain AI Employees end-to-end", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup(prisma);

    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Domain Employees Org",
        firstName: "Owner",
        email: `domain-employees-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    token = registered.body.data.tokens.accessToken;
  });

  afterAll(async () => {
    if (prisma) await cleanup(prisma);
    await app?.close();
  });

  for (const employee of EMPLOYEES) {
    describe(`${employee.slug}`, () => {
      let pluginId: string;

      it("installs as an ACTIVE AI employee with its domain tools", async () => {
        const installed = await request(app.getHttpServer())
          .post("/api/v1/plugins/install")
          .set("Authorization", `Bearer ${token}`)
          .send({ pluginId: employee.slug, enable: true })
          .expect(201);
        pluginId = installed.body.id;
        const employees = await request(app.getHttpServer())
          .get("/api/v1/agents")
          .set("Authorization", `Bearer ${token}`)
          .expect(200);
        const row = employees.body.find((item: { id: string }) => item.id === pluginId);
        expect(row).toMatchObject({ status: "ACTIVE", slug: employee.slug });
      });

      it("returns safe configuration defaults before any configuration is saved", async () => {
        const auth = { Authorization: `Bearer ${token}` };
        const config = await request(app.getHttpServer())
          .get(`/api/v1/${employee.route}/${pluginId}/configuration`)
          .set(auth)
          .expect(200);
        expect(config.body.configured).toBe(false);
        expect(config.body.defaultCurrency).toBe("USD");
      });

      it("updates configuration and preserves untouched fields on a partial update", async () => {
        const auth = { Authorization: `Bearer ${token}` };
        await request(app.getHttpServer())
          .patch(`/api/v1/${employee.route}/${pluginId}/configuration`)
          .set(auth)
          .send({
            persona: "Warm, concise assistant",
            welcomeMessage: "Welcome! How can I help you today?",
            escalationContact: "humans@example.com",
            brandTone: "FRIENDLY",
            defaultCurrency: "USD",
            defaultLanguage: "en"
          })
          .expect(200);
        const afterPartial = await request(app.getHttpServer())
          .patch(`/api/v1/${employee.route}/${pluginId}/configuration`)
          .set(auth)
          .send({ brandTone: "FORMAL" })
          .expect(200);
        expect(afterPartial.body).toMatchObject({
          configured: true,
          brandTone: "FORMAL",
          escalationContact: "humans@example.com",
          welcomeMessage: "Welcome! How can I help you today?"
        });
      });

      it("enforces tenant isolation on configuration", async () => {
        const other = await request(app.getHttpServer())
          .post("/api/v1/auth/register")
          .send({
            organizationName: `Other ${employee.slug} Org`,
            firstName: "Other",
            email: `domain-other-${employee.slug}-${Date.now()}@example.com`,
            password: "StrongPassword@123"
          })
          .expect(201);
        await request(app.getHttpServer())
          .get(`/api/v1/${employee.route}/${pluginId}/configuration`)
          .set("Authorization", `Bearer ${other.body.data.tokens.accessToken}`)
          .expect(404);
      });

      it("greets proactively on a brand-new conversation", async () => {
        const auth = { Authorization: `Bearer ${token}` };
        const run = await request(app.getHttpServer())
          .post("/api/v1/agents/run")
          .set(auth)
          .send({ pluginInstallationId: pluginId, message: "" })
          .expect(201);
        expect(typeof run.body.response).toBe("string");
        expect(run.body.response.length).toBeGreaterThan(0);
      });

      it("collects the customer name and a domain detail through the deterministic engine", async () => {
        const auth = { Authorization: `Bearer ${token}` };
        const conversationId = await startConversation(auth);
        const named = await runMessage(auth, conversationId, "my name is Priya");
        expect(named.response).toBeTruthy();
        const detail = await runMessage(auth, conversationId, employee.topic);
        expect(detail.response).toBeTruthy();
      });

      it("persists an artifact after consent + contact, and lists it", async () => {
        const auth = { Authorization: `Bearer ${token}` };
        const conversationId = await startConversation(auth);
        await runMessage(auth, conversationId, "my name is Kabir");
        await runMessage(auth, conversationId, employee.topic);
        // The engine asks for details next; a concrete line satisfies the details extractor.
        await runMessage(auth, conversationId, "please help with this request for my team");
        // Answer the artifact offer affirmatively and provide a phone number.
        await runMessage(auth, conversationId, "yes please submit it");
        const captured = await runMessage(auth, conversationId, "+91 98765 43210");
        expect(captured.response).toMatch(/created successfully|reference/i);

        const artifacts = await request(app.getHttpServer())
          .get(`/api/v1/${employee.route}/${pluginId}/${employee.artifacts}`)
          .set(auth)
          .expect(200);
        expect(Array.isArray(artifacts.body)).toBe(true);
        expect(artifacts.body.length).toBeGreaterThan(0);
      });

      it("returns conversation state for a conversation", async () => {
        const auth = { Authorization: `Bearer ${token}` };
        const conversationId = await startConversation(auth);
        await runMessage(auth, conversationId, "my name is Ananya");
        const state = await request(app.getHttpServer())
          .get(`/api/v1/${employee.route}/${pluginId}/conversations/${conversationId}/state`)
          .set(auth)
          .expect(200);
        expect(state.body).toMatchObject({
          customerName: "Ananya",
          onboardingCompleted: true,
          greetingSent: true
        });
      });

      async function startConversation(auth: Record<string, string>) {
        const run = await request(app.getHttpServer())
          .post("/api/v1/agents/run")
          .set(auth)
          .send({ pluginInstallationId: pluginId, message: "" })
          .expect(201);
        expect(run.body.conversationId).toBeTruthy();
        return run.body.conversationId as string;
      }

      async function runMessage(
        auth: Record<string, string>,
        conversationId: string,
        message: string
      ) {
        const run = await request(app.getHttpServer())
          .post("/api/v1/agents/run")
          .set(auth)
          .send({ pluginInstallationId: pluginId, conversationId, message })
          .expect(201);
        return run.body as { response: string };
      }
    });
  }
});

suite("Domain AI Employee behavior (out-of-scope routing + in-domain answers)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let legalPluginId: string;
  let hrPluginId: string;
  let financePluginId: string;
  let itPluginId: string;
  let salesPluginId: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup(prisma);

    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Behavior Org",
        firstName: "Owner",
        email: `behavior-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    token = registered.body.data.tokens.accessToken;

    const install = async (slug: string) => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/plugins/install")
        .set("Authorization", `Bearer ${token}`)
        .send({ pluginId: slug, enable: true })
        .expect(201);
      return res.body.id as string;
    };
    legalPluginId = await install("legal-employee");
    hrPluginId = await install("hr-employee");
    financePluginId = await install("finance-employee");
    itPluginId = await install("it-support-employee");
    salesPluginId = await install("sales-employee");
  });

  afterAll(async () => {
    if (prisma) await cleanup(prisma);
    await app?.close();
  });

  it("legal employee routes an out-of-scope travel request to the Travel Employee", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const conversationId = await start(legalPluginId, auth);
    const reply = await send(legalPluginId, conversationId, auth, "I want to plan a trip to Dubai next month");
    expect(reply.response).toMatch(/outside my scope|route|correct employee/i);
    expect(reply.response).toMatch(/Travel Employee/i);
  });

  it("legal employee answers an in-domain legal question in legal terms", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const conversationId = await start(legalPluginId, auth);
    const reply = await send(legalPluginId, conversationId, auth, "how do I draft a reply to a GST show-cause notice?");
    expect(reply.response).toMatch(/notice|licensed CA|advocate|draft/i);
  });

  it("hr employee routes a finance question to the Finance Employee", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const conversationId = await start(hrPluginId, auth);
    const reply = await send(hrPluginId, conversationId, auth, "I need help classifying an expense");
    expect(reply.response).toMatch(/outside my scope|route|correct employee/i);
    expect(reply.response).toMatch(/Finance Employee/i);
  });

  it("hr employee answers an in-domain policy question in HR terms", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const conversationId = await start(hrPluginId, auth);
    const reply = await send(hrPluginId, conversationId, auth, "what is the leave policy for new joiners?");
    expect(reply.response).toMatch(/leave|policy|HR/i);
  });

  it("finance employee routes an IT support request to the IT Support Employee", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const conversationId = await start(financePluginId, auth);
    const reply = await send(financePluginId, conversationId, auth, "my vpn is not connecting");
    expect(reply.response).toMatch(/outside my scope|route|correct employee/i);
    expect(reply.response).toMatch(/IT Support Employee/i);
  });

  it("finance employee answers an in-domain finance question in finance terms", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const conversationId = await start(financePluginId, auth);
    const reply = await send(financePluginId, conversationId, auth, "can you help classify an expense?");
    expect(reply.response).toMatch(/expense|classif|finance/i);
  });

  it("IT employee routes a sales request to the Sales Employee", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const conversationId = await start(itPluginId, auth);
    const reply = await send(itPluginId, conversationId, auth, "I would like a quote for your product");
    expect(reply.response).toMatch(/outside my scope|route|correct employee/i);
    expect(reply.response).toMatch(/Sales Employee/i);
  });

  it("sales employee routes a legal request to the Legal Employee", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const conversationId = await start(salesPluginId, auth);
    const reply = await send(salesPluginId, conversationId, auth, "I need to draft a reply to a compliance notice");
    expect(reply.response).toMatch(/outside my scope|route|correct employee/i);
    expect(reply.response).toMatch(/Legal Employee/i);
  });

  async function start(pluginId: string, auth: Record<string, string>) {
    const run = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({ pluginInstallationId: pluginId, message: "" })
      .expect(201);
    return run.body.conversationId as string;
  }

  async function send(
    pluginId: string,
    conversationId: string,
    auth: Record<string, string>,
    message: string
  ) {
    const run = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({ pluginInstallationId: pluginId, conversationId, message })
      .expect(201);
    return run.body as { response: string };
  }
});

async function cleanup(prisma: PrismaService) {
  await prisma.hrTicket.deleteMany();
  await prisma.financeRecord.deleteMany();
  await prisma.itSupportTicket.deleteMany();
  await prisma.salesLead.deleteMany();
  await prisma.marketingCampaign.deleteMany();
  await prisma.legalNotice.deleteMany();
  await prisma.customerSupportTicket.deleteMany();
  await prisma.conversationMessage.deleteMany();
  await prisma.agentToolExecution.deleteMany();
  await prisma.agentExecution.deleteMany();
  await prisma.agentMemory.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.hrEmployeeConfiguration.deleteMany();
  await prisma.financeEmployeeConfiguration.deleteMany();
  await prisma.itSupportEmployeeConfiguration.deleteMany();
  await prisma.salesEmployeeConfiguration.deleteMany();
  await prisma.marketingEmployeeConfiguration.deleteMany();
  await prisma.legalEmployeeConfiguration.deleteMany();
  await prisma.customerSupportEmployeeConfiguration.deleteMany();
  await prisma.pluginAiConfiguration.deleteMany();
  await prisma.pluginConfiguration.deleteMany();
  await prisma.plugin.deleteMany();
}
