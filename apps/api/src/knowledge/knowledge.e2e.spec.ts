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

/**
 * Exercises the employee-scoped knowledge hierarchy end to end: Organization -> AI Employee ->
 * Collection -> Document -> Chunk (see docs/enterprise-knowledge.md). Requires a Postgres instance
 * with the pgvector extension (pgvector/pgvector:pg16, see docker-compose.yml) reachable via
 * TEST_DATABASE_URL — skipped entirely otherwise, matching the existing e2e convention in this repo.
 */
suite("Knowledge HTTP", () => {
  let app: INestApplication,
    prisma: PrismaService,
    token: string,
    otherToken: string,
    employeeId: string,
    collectionId: string,
    documentId: string;
  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.knowledgeChunk.deleteMany();
    await prisma.knowledgeDocument.deleteMany();
    await prisma.knowledgeCollection.deleteMany();
    const owner = await register("Knowledge Owner");
    token = owner.token;
    otherToken = (await register("Other Knowledge Owner")).token;
    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({
        pluginId: "dummy-echo",
        grantedPermissions: ["MEMORY"],
        configuration: { config: {}, secrets: {} },
        enable: true
      })
      .expect(201);
    employeeId = installed.body.id;

    // AI provider configuration is platform-owner-only — switch into this org as the platform owner
    // just for this one call, matching the ownership boundary enforced in plugin.controller.ts.
    await ensurePlatformOwner(prisma);
    const platformLogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: PLATFORM_OWNER_EMAIL, password: PLATFORM_OWNER_PASSWORD, organizationName: "AI Workforce OS Platform" })
      .expect(200);
    const switched = await request(app.getHttpServer())
      .post(`/api/v1/platform/organizations/${owner.organizationId}/switch`)
      .set("Authorization", `Bearer ${platformLogin.body.data.tokens.accessToken}`)
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/api/v1/plugins/${employeeId}/ai-configuration`)
      .set("Authorization", `Bearer ${switched.body.data.tokens.accessToken}`)
      .send({ providerType: "DETERMINISTIC", timeoutMs: 5000 })
      .expect(200);
    const collection = await request(app.getHttpServer())
      .post(`/api/v1/knowledge/employees/${employeeId}/collections`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Travel Policies", domain: "TRAVEL" })
      .expect(201);
    collectionId = collection.body.id;
  });
  afterAll(async () => {
    if (prisma) {
      await prisma.conversationMessage.deleteMany();
      await prisma.agentToolExecution.deleteMany();
      await prisma.agentExecution.deleteMany();
      await prisma.agentMemory.deleteMany();
      await prisma.conversation.deleteMany();
      await prisma.pluginAiConfiguration.deleteMany();
      await prisma.pluginConfiguration.deleteMany();
      await prisma.plugin.deleteMany();
      await prisma.knowledgeChunk.deleteMany();
      await prisma.knowledgeDocument.deleteMany();
      await prisma.knowledgeCollection.deleteMany();
    }
    await app?.close();
  });
  async function register(name: string) {
    const result = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `${name} ${Date.now()}`,
        firstName: "Owner",
        email: `${name.toLowerCase().replaceAll(" ", "-")}-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    return {
      token: result.body.data.tokens.accessToken as string,
      organizationId: result.body.data.organization.id as string
    };
  }
  it("uploads, indexes, lists, searches within one employee's collection and never exposes the embedding", async () => {
    const uploaded = await request(app.getHttpServer())
      .post(`/api/v1/knowledge/employees/${employeeId}/collections/${collectionId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach(
        "file",
        Buffer.from(
          "Company business class travel policy permits business class for international flights longer than eight hours."
        ),
        { filename: "travel-policy.txt", contentType: "text/plain" }
      )
      .expect(201);
    documentId = uploaded.body.id;
    expect(uploaded.body.status).toBe("INDEXED");
    expect(uploaded.body.collectionId).toBe(collectionId);
    expect(uploaded.body.chunkCount).toBe(1);
    const list = await request(app.getHttpServer())
      .get(`/api/v1/knowledge/employees/${employeeId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/knowledge/documents/${documentId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.chunks[0].embeddingJson).toBeUndefined();
    expect(detail.body.chunks[0].embedding).toBeUndefined();
    const search = await request(app.getHttpServer())
      .post(`/api/v1/knowledge/employees/${employeeId}/search`)
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "business class policy", topK: 5, scoreThreshold: 0 })
      .expect(201);
    expect(search.body[0].title).toBe("travel-policy");
    const unrelated = await request(app.getHttpServer())
      .post(`/api/v1/knowledge/employees/${employeeId}/search`)
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "quantum gardening", topK: 5, scoreThreshold: 0.95 })
      .expect(201);
    expect(unrelated.body).toEqual([]);
    const run = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({
        pluginInstallationId: employeeId,
        message: "What is the company business class travel policy?"
      })
      .expect(201);
    expect(run.body.sources[0]).toMatchObject({
      documentId,
      title: "travel-policy"
    });
    expect(run.body.response).toContain("business class");
    const execution = await prisma.agentExecution.findUniqueOrThrow({
      where: { id: run.body.executionId }
    });
    expect(execution.metadata).toMatchObject({
      retrieval: [expect.objectContaining({ documentId })]
    });
  });
  it("never lets a second AI Employee in the same organization retrieve this employee's knowledge", async () => {
    // A *different* employee type (Travel Employee) in the SAME organization — the unique
    // (organization_id, slug) index forbids installing the same plugin slug twice, so this proves
    // isolation holds across employee types, not just across two installations of the same plugin.
    const otherEmployee = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({
        pluginId: "travel-employee",
        grantedPermissions: ["MEMORY"],
        configuration: { config: {}, secrets: {} },
        enable: true
      })
      .expect(201);
    const search = await request(app.getHttpServer())
      .post(`/api/v1/knowledge/employees/${otherEmployee.body.id}/search`)
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "business class policy", topK: 5, scoreThreshold: 0 })
      .expect(201);
    expect(search.body).toEqual([]);
  });
  it("enforces tenant isolation, validation, authentication, re-index and soft deletion", async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/knowledge/documents/${documentId}`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/knowledge/employees/${employeeId}/collections`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/v1/knowledge/documents/${documentId}/reindex`)
      .set("Authorization", `Bearer ${token}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/knowledge/employees/${employeeId}/collections/${collectionId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("bad"), {
        filename: "bad.exe",
        contentType: "application/octet-stream"
      })
      .expect(415);
    await request(app.getHttpServer())
      .get(`/api/v1/knowledge/employees/${employeeId}/documents`)
      .expect(401);
    await request(app.getHttpServer())
      .delete(`/api/v1/knowledge/documents/${documentId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(204);
    expect(
      await prisma.knowledgeDocument.count({ where: { id: documentId, deletedAt: { not: null } } })
    ).toBe(1);
    expect(await prisma.knowledgeChunk.count({ where: { documentId } })).toBe(0);
    await request(app.getHttpServer())
      .delete(`/api/v1/knowledge/collections/${collectionId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(204);
  });
});
