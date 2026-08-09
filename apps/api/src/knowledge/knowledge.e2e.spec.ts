import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import JSZip from "jszip";
import request from "supertest";
import * as XLSX from "xlsx";
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
      .send({ email: PLATFORM_OWNER_EMAIL, password: PLATFORM_OWNER_PASSWORD, organizationName: "Krevia.ai Platform" })
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
  it("uploads, indexes, and makes searchable a real .xlsx workbook and a real .zip archive (Sprint 5.0B)", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Route", "Refund"],
        ["Domestic cancellation", "eighty percent refundable"]
      ]),
      "Refunds"
    );
    const xlsxBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const xlsxUpload = await request(app.getHttpServer())
      .post(`/api/v1/knowledge/employees/${employeeId}/collections/${collectionId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", xlsxBuffer, {
        filename: "refund-table.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      })
      .expect(201);
    expect(xlsxUpload.body.status).toBe("INDEXED");
    const xlsxSearch = await request(app.getHttpServer())
      .post(`/api/v1/knowledge/employees/${employeeId}/search`)
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "domestic cancellation refund percent", topK: 5, scoreThreshold: 0 })
      .expect(201);
    expect(xlsxSearch.body.some((source: { documentId: string }) => source.documentId === xlsxUpload.body.id)).toBe(
      true
    );

    const zip = new JSZip();
    zip.file("baggage-policy.txt", "Checked baggage allowance is thirty two kilograms per passenger.");
    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const zipUpload = await request(app.getHttpServer())
      .post(`/api/v1/knowledge/employees/${employeeId}/collections/${collectionId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", zipBuffer, { filename: "bundle.zip", contentType: "application/zip" })
      .expect(201);
    expect(zipUpload.body.status).toBe("INDEXED");
    const zipSearch = await request(app.getHttpServer())
      .post(`/api/v1/knowledge/employees/${employeeId}/search`)
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "checked baggage allowance kilograms", topK: 5, scoreThreshold: 0 })
      .expect(201);
    expect(zipSearch.body.some((source: { documentId: string }) => source.documentId === zipUpload.body.id)).toBe(
      true
    );

    // Clean up: these two documents are separate from the shared `documentId` fixture the remaining
    // tests in this file depend on.
    await request(app.getHttpServer())
      .delete(`/api/v1/knowledge/documents/${xlsxUpload.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(204);
    await request(app.getHttpServer())
      .delete(`/api/v1/knowledge/documents/${zipUpload.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(204);
  });
  it("issues a real, working, tenant-scoped, expiring signed download URL for the original file (Sprint 5.0B)", async () => {
    const issued = await request(app.getHttpServer())
      .get(`/api/v1/knowledge/documents/${documentId}/download-url`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(issued.body.url).toEqual(expect.any(String));
    expect(issued.body.filename).toBe("travel-policy.txt");
    const parsed = new URL(issued.body.url);

    // A second organization can't even ask for this document's download URL in the first place —
    // tenant isolation at the issuing endpoint, not just at the storage layer.
    await request(app.getHttpServer())
      .get(`/api/v1/knowledge/documents/${documentId}/download-url`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(404);

    // The signed URL itself is real and directly fetchable (no Authorization header — the signature is
    // the credential, exactly like a presigned S3 URL) and returns the original uploaded bytes.
    const downloaded = await request(app.getHttpServer())
      .get(`${parsed.pathname}${parsed.search}`)
      .expect(200);
    expect(downloaded.text).toBe(
      "Company business class travel policy permits business class for international flights longer than eight hours."
    );
    expect(downloaded.headers["content-type"]).toContain("text/plain");

    // Tampering with the signature (or the org/key it was signed over) is rejected, not silently ignored.
    const tamperedSig = `${parsed.pathname}?${new URLSearchParams({
      org: parsed.searchParams.get("org") ?? "",
      key: parsed.searchParams.get("key") ?? "",
      exp: parsed.searchParams.get("exp") ?? "",
      sig: `0${(parsed.searchParams.get("sig") ?? "").slice(1)}`
    })}`;
    await request(app.getHttpServer()).get(tamperedSig).expect(403);
    const otherOrgReplay = `${parsed.pathname}?${new URLSearchParams({
      org: "00000000-0000-4000-8000-000000000000",
      key: parsed.searchParams.get("key") ?? "",
      exp: parsed.searchParams.get("exp") ?? "",
      sig: parsed.searchParams.get("sig") ?? ""
    })}`;
    await request(app.getHttpServer()).get(otherOrgReplay).expect(403);

    // An already-expired reference is rejected — expiry is enforced, not merely accepted as a parameter.
    const expired = await request(app.getHttpServer())
      .get(`/api/v1/knowledge/documents/${documentId}/download-url`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const expiredUrl = new URL(expired.body.url);
    const alreadyExpired = `${expiredUrl.pathname}?${new URLSearchParams({
      org: expiredUrl.searchParams.get("org") ?? "",
      key: expiredUrl.searchParams.get("key") ?? "",
      exp: "1",
      sig: expiredUrl.searchParams.get("sig") ?? ""
    })}`;
    await request(app.getHttpServer()).get(alreadyExpired).expect(403);
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
