import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("Memory platform API", () => {
  let app: INestApplication,
    prisma: PrismaService,
    orgA: { token: string; orgId: string; pluginId: string },
    orgB: { token: string; orgId: string; pluginId: string };

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.memoryAuditEvent.deleteMany();
    await prisma.memoryRecord.deleteMany();
    await prisma.conversationSummary.deleteMany();
    await prisma.conversationMessage.deleteMany();
    await prisma.agentToolExecution.deleteMany();
    await prisma.agentExecution.deleteMany();
    await prisma.agentMemory.deleteMany();
    await prisma.conversation.deleteMany();
    await prisma.pluginAiConfiguration.deleteMany();
    await prisma.pluginConfiguration.deleteMany();
    await prisma.plugin.deleteMany();

    const register = async (name: string, suffix: string) => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/auth/register")
        .send({
          organizationName: name,
          firstName: "Owner",
          email: `${suffix}-${Date.now()}@example.com`,
          password: "StrongPassword@123"
        })
        .expect(201);
      const token = res.body.data.tokens.accessToken;
      const orgId = res.body.data.organization.id;
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
      const pluginId = installed.body.id;
      const plugin = await prisma.plugin.findUniqueOrThrow({ where: { id: pluginId } });
      const owner = await prisma.user.findFirstOrThrow({
        where: { organizationId: plugin.organizationId }
      });
      const encryption = app.get(PluginSecretsEncryptionService);
      await prisma.pluginAiConfiguration.create({
        data: {
          organizationId: plugin.organizationId,
          pluginInstallationId: pluginId,
          providerType: "DETERMINISTIC",
          configuration: { timeoutMs: 30000 },
          encryptedSecrets: encryption.encrypt({}) as unknown as Prisma.InputJsonValue,
          updatedBy: owner.id
        }
      });
      return { token, orgId, pluginId };
    };
    orgA = await register("Memory Org A", "memory-a");
    orgB = await register("Memory Org B", "memory-b");
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.memoryAuditEvent.deleteMany();
      await prisma.memoryRecord.deleteMany();
      await prisma.conversationSummary.deleteMany();
      await prisma.conversationMessage.deleteMany();
      await prisma.agentToolExecution.deleteMany();
      await prisma.agentExecution.deleteMany();
      await prisma.agentMemory.deleteMany();
      await prisma.conversation.deleteMany();
      await prisma.pluginAiConfiguration.deleteMany();
      await prisma.pluginConfiguration.deleteMany();
      await prisma.plugin.deleteMany();
    }
    await app?.close();
  });

  it("remembers, lists, updates, searches, and forgets a preference", async () => {
    const auth = { Authorization: `Bearer ${orgA.token}` };
    const created = await request(app.getHttpServer())
      .post("/api/v1/memory")
      .set(auth)
      .send({
        scope: "USER",
        key: "preferred.airline",
        value: { value: "Emirates" },
        category: "PREFERENCE",
        employeeId: orgA.pluginId,
        confidence: 0.98,
        importance: "HIGH",
        source: "RULE_EXTRACTION",
        searchableText: "Emirates"
      })
      .expect(201);
    expect(created.body.id).toBeDefined();
    expect(created.body.scope).toBe("USER");
    expect(created.body.key).toBe("preferred.airline");

    const list = await request(app.getHttpServer())
      .get("/api/v1/memory?scope=USER&page=1&pageSize=20")
      .set(auth)
      .expect(200);
    expect(list.body.items.some((item: { key: string }) => item.key === "preferred.airline")).toBe(
      true
    );

    const search = await request(app.getHttpServer())
      .post("/api/v1/memory/search")
      .set(auth)
      .send({ query: "airline", employeeId: orgA.pluginId })
      .expect(201);
    expect(search.body[0]?.key).toBe("preferred.airline");

    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/memory/${created.body.id}`)
      .set(auth)
      .send({ value: { value: "Vistara" }, importance: "CRITICAL" })
      .expect(200);
    expect(updated.body.value).toEqual({ value: "Vistara" });
    expect(updated.body.importance).toBe("CRITICAL");

    await request(app.getHttpServer())
      .delete(`/api/v1/memory/${created.body.id}`)
      .set(auth)
      .expect(204);
    const after = await request(app.getHttpServer())
      .get("/api/v1/memory?scope=USER&page=1&pageSize=20")
      .set(auth)
      .expect(200);
    expect(after.body.items.some((item: { key: string }) => item.key === "preferred.airline")).toBe(
      false
    );
  });

  it("automatically extracts a preference from an agent conversation turn", async () => {
    const auth = { Authorization: `Bearer ${orgA.token}` };
    const run = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({
        pluginInstallationId: orgA.pluginId,
        message: "Remember that I prefer vegetarian food."
      })
      .expect(201);
    expect(run.body.status).toBe("COMPLETED");
    // Memory capture is fire-and-forget; poll briefly for the extracted record.
    let record: { value: Prisma.JsonValue } | null = null;
    for (let attempt = 0; attempt < 20 && !record; attempt++) {
      record = await prisma.memoryRecord.findFirst({
        where: { organizationId: orgA.orgId, key: "food.preference" }
      });
      if (!record) await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    expect(record).not.toBeNull();
    expect(record?.value).toMatchObject({ value: "Vegetarian" });
  });

  it("summarizes a conversation", async () => {
    const auth = { Authorization: `Bearer ${orgA.token}` };
    const run = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({ pluginInstallationId: orgA.pluginId, message: "Hello there" })
      .expect(201);
    const conversationId = run.body.conversationId;
    const result = await request(app.getHttpServer())
      .post("/api/v1/memory/summarize")
      .set(auth)
      .send({ conversationId })
      .expect(201);
    expect(result.body.summary).toBeDefined();
    expect(result.body.version).toBe(1);
    const summary = await prisma.conversationSummary.findUnique({
      where: { conversationId }
    });
    expect(summary).not.toBeNull();
  });

  it("forgets by criteria and expires stale memories", async () => {
    const auth = { Authorization: `Bearer ${orgA.token}` };
    await request(app.getHttpServer())
      .post("/api/v1/memory")
      .set(auth)
      .send({ scope: "ORGANIZATION", key: "policy.travel", value: { value: "100km/day" }, category: "POLICY" })
      .expect(201);
    const forgotten = await request(app.getHttpServer())
      .post("/api/v1/memory/forget")
      .set(auth)
      .send({ scope: "ORGANIZATION", category: "POLICY" })
      .expect(201);
    expect(forgotten.body.count).toBe(1);

    await request(app.getHttpServer())
      .post("/api/v1/memory")
      .set(auth)
      .send({
        scope: "CONVERSATION",
        key: "travel.current.hotel",
        value: { value: "Grand" },
        category: "TRAVEL",
        expiresAt: new Date(Date.now() - 1000).toISOString()
      })
      .expect(201);
    const expired = await request(app.getHttpServer())
      .post("/api/v1/memory/expire")
      .set(auth)
      .send({ scope: "CONVERSATION" })
      .expect(201);
    expect(expired.body.expired).toBeGreaterThan(0);
  });

  it("isolates memories across tenants", async () => {
    const authB = { Authorization: `Bearer ${orgB.token}` };
    const listB = await request(app.getHttpServer())
      .get("/api/v1/memory?scope=USER&page=1&pageSize=50")
      .set(authB)
      .expect(200);
    expect(listB.body.items.length).toBe(0);
    const searchB = await request(app.getHttpServer())
      .post("/api/v1/memory/search")
      .set(authB)
      .send({ query: "vegetarian" })
      .expect(201);
    expect(searchB.body).toHaveLength(0);
    // Org A still has its own memories.
    const authA = { Authorization: `Bearer ${orgA.token}` };
    const searchA = await request(app.getHttpServer())
      .post("/api/v1/memory/search")
      .set(authA)
      .send({ query: "vegetarian" })
      .expect(201);
    expect(searchA.body.length).toBeGreaterThan(0);
  });

  it("enforces RBAC on memory routes", async () => {
    await request(app.getHttpServer()).get("/api/v1/memory").expect(401);
    await request(app.getHttpServer())
      .post("/api/v1/memory")
      .send({ scope: "USER", key: "x", value: { value: "y" } })
      .expect(401);
    await request(app.getHttpServer()).post("/api/v1/memory/search").send({ query: "x" }).expect(401);
    const auth = { Authorization: `Bearer ${orgB.token}` };
    const invalid = await request(app.getHttpServer())
      .patch("/api/v1/memory/00000000-0000-0000-0000-000000000000")
      .set(auth)
      .send({ value: { value: "z" } })
      .expect(404);
    expect(invalid.body).toBeDefined();
  });

  it("recalls a context for a conversation turn", async () => {
    const auth = { Authorization: `Bearer ${orgA.token}` };
    const recall = await request(app.getHttpServer())
      .post("/api/v1/memory/recall")
      .set(auth)
      .send({ employeeId: orgA.pluginId })
      .expect(201);
    expect(Array.isArray(recall.body.organization)).toBe(true);
    expect(Array.isArray(recall.body.employee)).toBe(true);
    expect(Array.isArray(recall.body.user)).toBe(true);
  });
});
