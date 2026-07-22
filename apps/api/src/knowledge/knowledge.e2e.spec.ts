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

suite("Knowledge HTTP", () => {
  let app: INestApplication,
    prisma: PrismaService,
    token: string,
    otherToken: string,
    documentId: string,
    pluginId: string;
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
    token = await register("Knowledge Owner");
    otherToken = await register("Other Knowledge Owner");
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
    return result.body.data.tokens.accessToken as string;
  }
  it("uploads, indexes, lists, searches and never exposes embeddings", async () => {
    const uploaded = await request(app.getHttpServer())
      .post("/api/v1/knowledge/documents")
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
    expect(uploaded.body.chunkCount).toBe(1);
    const list = await request(app.getHttpServer())
      .get("/api/v1/knowledge/documents")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/knowledge/documents/${documentId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.chunks[0].embeddingJson).toBeUndefined();
    const search = await request(app.getHttpServer())
      .post("/api/v1/knowledge/search")
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "business class policy", topK: 5, scoreThreshold: 0 })
      .expect(201);
    expect(search.body[0].title).toBe("travel-policy");
    const unrelated = await request(app.getHttpServer())
      .post("/api/v1/knowledge/search")
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "quantum gardening", topK: 5, scoreThreshold: 0.95 })
      .expect(201);
    expect(unrelated.body).toEqual([]);
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
    pluginId = installed.body.id;
    await request(app.getHttpServer())
      .patch(`/api/v1/plugins/${pluginId}/ai-configuration`)
      .set("Authorization", `Bearer ${token}`)
      .send({ providerType: "DETERMINISTIC", timeoutMs: 5000 })
      .expect(200);
    const run = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set("Authorization", `Bearer ${token}`)
      .send({
        pluginInstallationId: pluginId,
        message: "What is the company business class travel policy?"
      })
      .expect(201);
    expect(run.body.sources[0]).toMatchObject({
      documentId,
      title: "travel-policy"
    });
    const execution = await prisma.agentExecution.findUniqueOrThrow({
      where: { id: run.body.executionId }
    });
    expect(execution.metadata).toMatchObject({
      retrieval: [expect.objectContaining({ documentId })]
    });
  });
  it("enforces tenant isolation, validation, authentication, re-index and soft deletion", async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/knowledge/documents/${documentId}`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/v1/knowledge/documents/${documentId}/reindex`)
      .set("Authorization", `Bearer ${token}`)
      .expect(201);
    await request(app.getHttpServer())
      .post("/api/v1/knowledge/documents")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("bad"), {
        filename: "bad.exe",
        contentType: "application/octet-stream"
      })
      .expect(415);
    await request(app.getHttpServer()).get("/api/v1/knowledge/documents").expect(401);
    await request(app.getHttpServer())
      .delete(`/api/v1/knowledge/documents/${documentId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(204);
    expect(
      await prisma.knowledgeDocument.count({ where: { id: documentId, deletedAt: { not: null } } })
    ).toBe(1);
    expect(await prisma.knowledgeChunk.count({ where: { documentId } })).toBe(0);
  });
});
