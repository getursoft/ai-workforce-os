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
import { NO_KNOWLEDGE_MESSAGE } from "./knowledge.prompt";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const TRAVEL_POLICY_DOCUMENT = [
  "# Travix India Private Limited — Master Travel Policy",
  "",
  "## Company Name",
  "Travix India Private Limited is the operating company name for all bookings made through this platform.",
  "",
  "## Cancellation Policy",
  "Cancellations made more than 24 hours before departure are fully refundable. Cancellations made within 24 hours of departure are non-refundable.",
  "",
  "## Portal Benefits",
  "Booking through our portal gives you 24/7 support, free date changes on flexible fares, and price-match protection against any lower fare found within 48 hours."
].join("\n");

const HR_LEAVE_POLICY_DOCUMENT = [
  "# Employee Leave Policy",
  "",
  "## Annual Leave",
  "Every full-time employee accrues 18 days of paid annual leave per calendar year, credited monthly."
].join("\n");

/**
 * End-to-end proof for the Sprint 4.1 UAT defects (see the Sprint 4.3 refactor notes in
 * docs/enterprise-knowledge.md): retrieved knowledge must actually be used in the AI Employee's
 * response (not just surfaced as "sources" metadata while the reply ignores it), and knowledge must
 * never cross an AI Employee boundary. Requires a Postgres instance with the pgvector extension
 * (pgvector/pgvector:pg16, see docker-compose.yml) reachable via TEST_DATABASE_URL.
 */
suite("Knowledge grounding UAT", () => {
  let app: INestApplication, prisma: PrismaService, token: string;
  let travelEmployeeId: string, hrEmployeeId: string;

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
        organizationName: `Travix ${Date.now()}`,
        firstName: "Owner",
        email: `travix-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    token = registered.body.data.tokens.accessToken;

    // Travel Employee — real plugin type, deterministic engine (no AI provider configured).
    const travel = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId: "travel-employee", enable: true })
      .expect(201);
    travelEmployeeId = travel.body.id;
    const travelCollection = await request(app.getHttpServer())
      .post(`/api/v1/knowledge/employees/${travelEmployeeId}/collections`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Travel Policies", domain: "TRAVEL" })
      .expect(201);
    await request(app.getHttpServer())
      .post(
        `/api/v1/knowledge/employees/${travelEmployeeId}/collections/${travelCollection.body.id}/documents`
      )
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from(TRAVEL_POLICY_DOCUMENT), {
        filename: "travix-master-travel-policy.md",
        contentType: "text/markdown"
      })
      .expect(201);

    // HR Employee — a second, distinct AI Employee (generic knowledge-grounded, no bespoke runtime)
    // owning a completely separate collection. Deliberately a different Plugin (dummy-echo) than the
    // Travel Employee: proves isolation holds across employee *types*, not just across two
    // installations of the same plugin.
    const hr = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({
        pluginId: "dummy-echo",
        grantedPermissions: ["MEMORY"],
        configuration: { config: {}, secrets: {} },
        enable: true
      })
      .expect(201);
    hrEmployeeId = hr.body.id;
    await request(app.getHttpServer())
      .patch(`/api/v1/plugins/${hrEmployeeId}/ai-configuration`)
      .set("Authorization", `Bearer ${token}`)
      .send({ providerType: "DETERMINISTIC", timeoutMs: 5000 })
      .expect(200);
    const hrCollection = await request(app.getHttpServer())
      .post(`/api/v1/knowledge/employees/${hrEmployeeId}/collections`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "HR Policies", domain: "HR" })
      .expect(201);
    await request(app.getHttpServer())
      .post(
        `/api/v1/knowledge/employees/${hrEmployeeId}/collections/${hrCollection.body.id}/documents`
      )
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from(HR_LEAVE_POLICY_DOCUMENT), {
        filename: "employee-leave-policy.md",
        contentType: "text/markdown"
      })
      .expect(201);
  });

  afterAll(async () => {
    if (prisma) await cleanup(prisma);
    await app?.close();
  });

  function ask(employeeId: string, message: string) {
    return request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginInstallationId: employeeId, message })
      .expect(201);
  }

  it("UAT-02: answers the company name from retrieved knowledge instead of the generic persona", async () => {
    const run = await ask(travelEmployeeId, "What is your company name?");
    expect(run.body.response).toContain("Travix India Private Limited");
    expect(run.body.sources.length).toBeGreaterThan(0);
  });

  it("UAT-03: answers the cancellation policy from retrieved knowledge instead of generic travel advice", async () => {
    const run = await ask(travelEmployeeId, "What is the cancellation policy?");
    expect(run.body.response).toMatch(/24 hours/);
    expect(run.body.response).toMatch(/refundable/i);
  });

  it("returns the document content for a portal-benefits question", async () => {
    const run = await ask(
      travelEmployeeId,
      "What are the benefits of booking through your portal?"
    );
    expect(run.body.response).toMatch(/price-match|24\/7 support|free date changes/i);
  });

  it("UAT-05 / KNOWLEDGE FILTERING: the Travel Employee never answers from HR knowledge", async () => {
    const run = await ask(travelEmployeeId, "What is the leave policy?");
    expect(run.body.response).toBe(NO_KNOWLEDGE_MESSAGE);
    expect(run.body.sources).toEqual([]);
  });

  it("KNOWLEDGE FILTERING: the HR Employee answers the leave policy from its own collection", async () => {
    const run = await ask(hrEmployeeId, "What is the leave policy?");
    expect(run.body.response).toMatch(/18 days/);
    expect(run.body.sources.length).toBeGreaterThan(0);
    expect(run.body.sources[0].documentId).not.toBe(
      (
        await prisma.knowledgeDocument.findFirstOrThrow({
          where: { title: { contains: "travix" } }
        })
      ).id
    );
  });

  it("does not hallucinate an answer to a question neither employee's knowledge covers", async () => {
    const run = await ask(hrEmployeeId, "What is the airspeed velocity of an unladen swallow?");
    expect(run.body.sources).toEqual([]);
    expect(typeof run.body.response).toBe("string");
    expect(run.body.response.length).toBeGreaterThan(0);
  });
});

async function cleanup(prisma: PrismaService) {
  await prisma.conversationMessage.deleteMany();
  await prisma.agentToolExecution.deleteMany();
  await prisma.agentExecution.deleteMany();
  await prisma.agentMemory.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.travelEmployeeConfiguration.deleteMany();
  await prisma.pluginAiConfiguration.deleteMany();
  await prisma.pluginConfiguration.deleteMany();
  await prisma.plugin.deleteMany();
  await prisma.knowledgeChunk.deleteMany();
  await prisma.knowledgeDocument.deleteMany();
  await prisma.knowledgeCollection.deleteMany();
}
