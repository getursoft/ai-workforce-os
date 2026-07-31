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

suite("Legal Employee documents (PDF generation + country config)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let pluginId: string;
  let conversationId: string;

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
        organizationName: "Legal Docs Org",
        firstName: "Owner",
        email: `legal-docs-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    token = registered.body.data.tokens.accessToken;

    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId: "legal-employee", enable: true })
      .expect(201);
    pluginId = installed.body.id;

    const greeted = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginInstallationId: pluginId, message: "" })
      .expect(201);
    conversationId = greeted.body.conversationId;
  });

  afterAll(async () => {
    if (prisma) await cleanup(prisma);
    await app?.close();
  });

  it("defaults the legal configuration country to India", async () => {
    const config = await request(app.getHttpServer())
      .get(`/api/v1/legal-employee/${pluginId}/configuration`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(config.body.defaultCountry).toBe("India");
  });

  it("updates and returns the default country", async () => {
    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/legal-employee/${pluginId}/configuration`)
      .set("Authorization", `Bearer ${token}`)
      .send({ defaultCountry: "India" })
      .expect(200);
    expect(updated.body.defaultCountry).toBe("India");
  });

  it("persists a drafted legal document and serves it as a downloadable PDF", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/legal-employee/documents")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Legal Notice to Builder",
        conversationId,
        content: "## Subject: Legal Notice\nDear Sir,\n\nThis is a legal notice regarding promised facilities.\n\n1. Demand item.\n2. Second demand."
      })
      .expect(201);
    expect(created.body.downloadUrl).toContain("/api/v1/legal-employee/documents/");

    const pdf = await request(app.getHttpServer())
      .get(created.body.downloadUrl)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.body.slice(0, 4).toString()).toBe("%PDF");
  });

  it("does not expose a legal document from another organization", async () => {
    const other = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Other Legal ${Date.now()}`,
        firstName: "Other",
        email: `other-legal-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    const created = await request(app.getHttpServer())
      .post("/api/v1/legal-employee/documents")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Private Doc", conversationId, content: "secret content" })
      .expect(201);
    await request(app.getHttpServer())
      .get(created.body.downloadUrl)
      .set("Authorization", `Bearer ${other.body.data.tokens.accessToken}`)
      .expect(404);
  });
});

async function cleanup(prisma: PrismaService) {
  await prisma.legalDocument.deleteMany();
  await prisma.conversationMessage.deleteMany();
  await prisma.agentToolExecution.deleteMany();
  await prisma.agentExecution.deleteMany();
  await prisma.agentMemory.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.legalEmployeeConfiguration.deleteMany();
  await prisma.pluginAiConfiguration.deleteMany();
  await prisma.pluginConfiguration.deleteMany();
  await prisma.plugin.deleteMany();
}
