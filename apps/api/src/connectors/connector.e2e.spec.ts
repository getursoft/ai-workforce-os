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
import { ensurePlatformOwner } from "../test/cleanup";

const PLATFORM_OWNER_EMAIL = process.env.PLATFORM_OWNER_EMAIL?.toLowerCase() || "krpandey25646@gmail.com";
const PLATFORM_OWNER_PASSWORD = process.env.PLATFORM_OWNER_PASSWORD || "PlatformOwner@25646";
for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("Connector framework HTTP", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let platformOwnerAuth: string;
  let installationId: string;
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
    await cleanup(prisma);
    const registration = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Connector Org ${Date.now()}`,
        firstName: "Owner",
        email: `connector-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    token = registration.body.data.tokens.accessToken;
    const organizationId = registration.body.data.organization.id;
    await ensurePlatformOwner(prisma);
    const platformLogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: PLATFORM_OWNER_EMAIL, password: PLATFORM_OWNER_PASSWORD, organizationName: "AI Workforce OS Platform" })
      .expect(200);
    const switched = await request(app.getHttpServer())
      .post(`/api/v1/platform/organizations/${organizationId}/switch`)
      .set("Authorization", `Bearer ${platformLogin.body.data.tokens.accessToken}`)
      .expect(201);
    platformOwnerAuth = `Bearer ${switched.body.data.tokens.accessToken}`;
  });
  afterAll(async () => {
    if (prisma) await cleanup(prisma);
    await app?.close();
  });
  it("installs, grants, enables and health-checks Dummy CRM without exposing credentials", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const catalogue = await request(app.getHttpServer())
      .get("/api/v1/connectors")
      .set(auth)
      .expect(200);
    expect(catalogue.body.some((item: { key: string }) => item.key === "dummy-crm")).toBe(true);
    const installed = await request(app.getHttpServer())
      .post("/api/v1/connector-installations")
      .set(auth)
      .send({
        connectorKey: "dummy-crm",
        displayName: "Travel CRM",
        configuration: {},
        credentials: {},
        grantedCapabilities: ["CRM"]
      })
      .expect(201);
    installationId = installed.body.id;
    expect(installed.body.encryptedCredentials).toBeUndefined();
    await request(app.getHttpServer())
      .post(`/api/v1/connector-installations/${installationId}/enable`)
      .set(auth)
      .expect(201);
    const health = await request(app.getHttpServer())
      .post(`/api/v1/connector-installations/${installationId}/health`)
      .set(auth)
      .expect(201);
    expect(health.body.lastHealthStatus).toBe("READY");
    expect(
      await prisma.connectorAuditEvent.count({
        where: { connectorInstallationId: installationId }
      })
    ).toBeGreaterThanOrEqual(3);
  });
  it("executes CRM lead creation through the standard agent tool loop", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set(auth)
      .send({
        pluginId: "dummy-echo",
        grantedPermissions: ["CRM"],
        configuration: { config: {}, secrets: {} },
        enable: true
      })
      .expect(201);
    pluginId = installed.body.id;
    await request(app.getHttpServer())
      .patch(`/api/v1/plugins/${pluginId}/ai-configuration`)
      .set("Authorization", platformOwnerAuth)
      .send({ providerType: "DETERMINISTIC", timeoutMs: 5000 })
      .expect(200);
    const run = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({
        pluginInstallationId: pluginId,
        message: "I want a five-day Dubai trip in December for two adults with a budget of 2 lakh."
      })
      .expect(201);
    expect(run.body.response).toContain("LEAD-");
    expect(
      await prisma.dummyCrmLead.count({ where: { connectorInstallationId: installationId } })
    ).toBe(1);
    expect(
      await prisma.connectorExecution.count({
        where: { connectorInstallationId: installationId, status: "SUCCEEDED" }
      })
    ).toBe(1);
  });
  it("deduplicates inbound events and rejects cross-tenant installation IDs", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const payload = { eventType: "lead.updated", externalEventId: "event-1", payload: { id: "1" } };
    const first = await request(app.getHttpServer())
      .post(`/api/v1/connector-installations/${installationId}/events`)
      .set(auth)
      .send(payload)
      .expect(201);
    const duplicate = await request(app.getHttpServer())
      .post(`/api/v1/connector-installations/${installationId}/events`)
      .set(auth)
      .send(payload)
      .expect(201);
    expect(duplicate.body.id).toBe(first.body.id);
    await request(app.getHttpServer())
      .get("/api/v1/connector-installations/00000000-0000-4000-8000-000000000001")
      .set(auth)
      .expect(404);
    await request(app.getHttpServer()).get("/api/v1/connectors").expect(401);
  });
});

async function cleanup(prisma: PrismaService) {
  await prisma.conversationMessage.deleteMany();
  await prisma.agentToolExecution.deleteMany();
  await prisma.agentExecution.deleteMany();
  await prisma.agentMemory.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.pluginAiConfiguration.deleteMany();
  await prisma.pluginConfiguration.deleteMany();
  await prisma.plugin.deleteMany();
  await prisma.dummyCrmLead.deleteMany();
  await prisma.connectorExecution.deleteMany();
  await prisma.connectorEvent.deleteMany();
  await prisma.connectorAuditEvent.deleteMany();
  await prisma.connectorInstallation.deleteMany();
}
