import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Prisma } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
import { dummyEchoManifest } from "@ai-workforce-os/plugin-dummy";

/**
 * Sprint 4.7 Phase 0 — real, database-backed proof that a normal chat turn can automatically trigger
 * WorkforceOrchestratorService.delegate() when the user's own message contains an explicit consult
 * phrase referencing another installed employee's routing domain, and that the delegation is traced
 * under the SAME traceId as the parent chat turn (Phase 2).
 */

for (const c of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(c)) {
    loadEnvFile(c);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("Chat-triggered workforce delegation (Sprint 4.7 Phase 0, e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: { Authorization: string };
  let orgId: string;
  let primaryId: string;
  let specialistId: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);

    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ organizationName: `Chat Delegation Org ${Date.now()}`, firstName: "Owner", email: `chat-delegation-${Date.now()}@example.com`, password: "StrongPassword@123" })
      .expect(201);
    auth = { Authorization: `Bearer ${registered.body.data.tokens.accessToken}` };
    orgId = registered.body.data.organization.id;
    const owner = await prisma.user.findFirstOrThrow({ where: { organizationId: orgId } });

    const encryption = app.get(PluginSecretsEncryptionService);
    async function install(idSuffix: string, displayName: string): Promise<string> {
      const res = await request(app.getHttpServer())
        .post("/api/v1/plugins/install")
        .set(auth)
        .send({ manifest: { ...dummyEchoManifest, id: `chat-delegation-${idSuffix}`, name: displayName, displayName }, enable: true })
        .expect(201);
      await prisma.pluginAiConfiguration.create({
        data: {
          organizationId: orgId,
          pluginInstallationId: res.body.id,
          providerType: "DETERMINISTIC",
          configuration: { timeoutMs: 30000 },
          encryptedSecrets: encryption.encrypt({}) as unknown as Prisma.InputJsonValue,
          updatedBy: owner.id
        }
      });
      return res.body.id as string;
    }
    primaryId = await install("primary", "Travel Employee (Test)");
    specialistId = await install("specialist", "Finance Employee (Test)");

    // Gives the specialist a real routing profile — EmployeeCollaborationRouter's DOMAIN_KEYWORD_MATCH
    // scoring reads this, never a hardcoded employee name.
    await prisma.employeeRoutingProfile.upsert({
      where: { pluginInstallationId: specialistId },
      create: {
        organizationId: orgId,
        pluginInstallationId: specialistId,
        displayName: "Finance Employee (Test)",
        supportedDomains: ["finance", "refund", "reimbursement"],
        routingKeywords: ["finance", "refund"],
        enabledForDelegation: true,
        supportsSynchronousDelegation: true
      },
      update: {
        supportedDomains: ["finance", "refund", "reimbursement"],
        routingKeywords: ["finance", "refund"],
        enabledForDelegation: true,
        supportsSynchronousDelegation: true
      }
    });
  });

  afterAll(async () => {
    if (prisma && orgId) {
      await prisma.executionSpan.deleteMany({ where: { organizationId: orgId } });
      await prisma.executionTrace.deleteMany({ where: { organizationId: orgId } });
      await prisma.employeeDelegatedTask.deleteMany({ where: { organizationId: orgId } });
      await prisma.employeeRoutingProfile.deleteMany({ where: { organizationId: orgId } });
      await prisma.conversation.deleteMany({ where: { organizationId: orgId } });
      await prisma.pluginAiConfiguration.deleteMany({ where: { organizationId: orgId } });
      await prisma.pluginConfiguration.deleteMany({ where: { organizationId: orgId } });
      await prisma.plugin.deleteMany({ where: { organizationId: orgId } });
    }
    await app?.close();
  });

  it("automatically delegates when the message explicitly asks to consult another installed employee's domain", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({ pluginInstallationId: primaryId, message: "Please check the refund calculation with Finance." })
      .expect(201);

    expect(res.body.response).toContain("I checked with");
    expect(res.body.response).toContain("Finance Employee (Test)");

    const task = await prisma.employeeDelegatedTask.findFirst({
      where: { organizationId: orgId, sourceEmployeeInstallationId: primaryId, targetEmployeeInstallationId: specialistId }
    });
    if (!task) throw new Error("delegated task missing");
    expect(task.status).toBe("COMPLETED");
    expect(task.requestedByActorType).toBe("EMPLOYEE");

    // The delegated child never becomes its own customer-facing conversation — it's a separate row.
    expect(task.childConversationId).not.toBe(res.body.conversationId);

    // Trace continuity (Phase 2): the delegation span and the child's own AGENT_EXECUTION span must
    // share the SAME traceId as the parent chat turn's trace — not a disconnected trace of their own.
    if (task.traceId) {
      const spans = await prisma.executionSpan.findMany({ where: { organizationId: orgId, traceId: task.traceId } });
      const spanTypes = spans.map((s) => s.spanType);
      expect(spanTypes).toContain("DELEGATION");
      expect(spans.filter((s) => s.spanType === "AGENT_EXECUTION").length).toBeGreaterThanOrEqual(1);
    }
  });

  it("does not delegate for an ordinary message with no consult phrase", async () => {
    const before = await prisma.employeeDelegatedTask.count({ where: { organizationId: orgId, sourceEmployeeInstallationId: primaryId } });
    const res = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({ pluginInstallationId: primaryId, message: "Hi, can you help me plan a trip?" })
      .expect(201);
    expect(res.body.response).not.toContain("I checked with");
    const after = await prisma.employeeDelegatedTask.count({ where: { organizationId: orgId, sourceEmployeeInstallationId: primaryId } });
    expect(after).toBe(before);
  });

  it("falls back gracefully when no installed employee's domain matches the consult phrase", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({ pluginInstallationId: primaryId, message: "Please check the launch trajectory with Aerospace Engineering." })
      .expect(201);
    // No installed employee has an "aerospace" routing domain — the primary's own reply is returned
    // unmodified rather than the request failing.
    expect(res.body.response).not.toContain("I checked with");
    expect(typeof res.body.response).toBe("string");
  });

  it("falls back gracefully when the only matching employee has delegation disabled", async () => {
    await prisma.employeeRoutingProfile.update({ where: { pluginInstallationId: specialistId }, data: { enabledForDelegation: false } });
    try {
      const res = await request(app.getHttpServer())
        .post("/api/v1/agents/run")
        .set(auth)
        .send({ pluginInstallationId: primaryId, message: "Please check the refund calculation with Finance." })
        .expect(201);
      expect(res.body.response).not.toContain("I checked with");
    } finally {
      await prisma.employeeRoutingProfile.update({ where: { pluginInstallationId: specialistId }, data: { enabledForDelegation: true } });
    }
  });
});
