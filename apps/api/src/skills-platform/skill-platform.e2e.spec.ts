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

suite("Skills Platform (Sprint 6.1) end-to-end", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let employeeId: string;
  let installationId: string;

  let otherOrgToken: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup(prisma);

    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Skills Org",
        firstName: "Owner",
        email: `skills-owner-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    ownerToken = registered.body.data.tokens.accessToken;

    const otherRegistered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Other Skills Org",
        firstName: "Owner",
        email: `skills-other-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    otherOrgToken = otherRegistered.body.data.tokens.accessToken;

    const installedEmployee = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ pluginId: "hr-employee", enable: true })
      .expect(201);
    employeeId = installedEmployee.body.id;
  });

  afterAll(async () => {
    if (prisma) await cleanup(prisma);
    await app?.close();
  });

  it("lists the published built-in skills on the marketplace", async () => {
    const marketplace = await request(app.getHttpServer())
      .get("/api/v1/skills/marketplace")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const keys = marketplace.body.data.items.map((item: { key: string }) => item.key);
    expect(keys).toEqual(
      expect.arrayContaining(["document-reader", "text-summarization", "entity-extraction", "translation", "file-validation"])
    );
  });

  it("rejects an unauthenticated marketplace request", async () => {
    await request(app.getHttpServer()).get("/api/v1/skills/marketplace").expect(401);
  });

  it("installs the Document Reader skill for the organization", async () => {
    const installed = await request(app.getHttpServer())
      .post("/api/v1/skills/install")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ skillKey: "document-reader", enabled: true })
      .expect(201);
    installationId = installed.body.data.id;
    expect(installed.body.data.enabled).toBe(true);
  });

  it("rejects installing the same skill twice for the same organization", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/skills/install")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ skillKey: "document-reader", enabled: true })
      .expect(409);
  });

  it("denies skill execution before the employee has a grant", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/skills/execute")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        skillKey: "document-reader",
        pluginInstallationId: employeeId,
        input: { fileName: "note.txt", mimeType: "text/plain", text: "hello" }
      })
      .expect(403);
  });

  it("grants the installed skill to the employee", async () => {
    const grants = await request(app.getHttpServer())
      .post(`/api/v1/skills/installations/${installationId}/grants`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ pluginInstallationId: employeeId })
      .expect(201);
    expect(grants.body.data.some((g: { pluginInstallationId: string }) => g.pluginInstallationId === employeeId)).toBe(
      true
    );
  });

  it("exposes the granted skill via employee capability discovery", async () => {
    const discovery = await request(app.getHttpServer())
      .get(`/api/v1/skills/employees/${employeeId}/skills`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(discovery.body.data.some((s: { skillKey: string }) => s.skillKey === "document-reader")).toBe(true);
  });

  it("executes the Document Reader skill and returns normalized structured output", async () => {
    const result = await request(app.getHttpServer())
      .post("/api/v1/skills/execute")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        skillKey: "document-reader",
        pluginInstallationId: employeeId,
        input: { fileName: "note.txt", mimeType: "text/plain", text: "Quarterly report highlights." }
      })
      .expect(201);
    expect(result.body.data.data.text).toMatch(/Quarterly report highlights/);
    expect(result.body.data.status).toBe("COMPLETED");
    expect(result.body.data.runId).toBeTruthy();
  });

  it("records the execution in this installation's execution history", async () => {
    const executions = await request(app.getHttpServer())
      .get(`/api/v1/skills/installations/${installationId}/executions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(executions.body.data.total).toBeGreaterThan(0);
    expect(executions.body.data.items[0]).not.toHaveProperty("inputSummaryJson");
  });

  it("reports installation health", async () => {
    const health = await request(app.getHttpServer())
      .get(`/api/v1/skills/installations/${installationId}/health`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(["HEALTHY", "DEGRADED", "UNHEALTHY", "UNKNOWN"]).toContain(health.body.data.status);
  });

  it("stops all execution once the installation is disabled, but keeps history visible", async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/skills/installations/${installationId}/disable`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);

    // A disabled installation is a state conflict (409), distinct from a permissions denial (403) —
    // see toSkillHttpError's SKILL_DISABLED -> ConflictException mapping.
    await request(app.getHttpServer())
      .post("/api/v1/skills/execute")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        skillKey: "document-reader",
        pluginInstallationId: employeeId,
        input: { fileName: "note.txt", mimeType: "text/plain", text: "hello" }
      })
      .expect(409);

    const executions = await request(app.getHttpServer())
      .get(`/api/v1/skills/installations/${installationId}/executions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(executions.body.data.total).toBeGreaterThan(0);

    await request(app.getHttpServer())
      .patch(`/api/v1/skills/installations/${installationId}/enable`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
  });

  it("denies cross-tenant access to another organization's skill installation", async () => {
    // SKILL_NOT_INSTALLED intentionally maps to 403 (not 404) — see toSkillHttpError — so a
    // cross-tenant lookup never distinguishes "doesn't exist" from "not yours" to the caller.
    await request(app.getHttpServer())
      .get(`/api/v1/skills/installations/${installationId}`)
      .set("Authorization", `Bearer ${otherOrgToken}`)
      .expect(403);
  });

  it("denies a cross-tenant grant onto an employee that belongs to a different organization", async () => {
    // otherOrgToken's organization installs its own copy of the skill, then tries to grant it to the
    // FIRST organization's employee id — the plugin lookup is organization-scoped, so this must fail.
    // Uses file-validation (DETERMINISTIC billing category) rather than an AI-backed skill: an
    // AI_PROVIDER_BACKED install is correctly gated behind the SKILLS_AI_BACKED entitlement (false by
    // default), which is unrelated to what this test actually exercises (cross-tenant grant denial).
    const otherInstall = await request(app.getHttpServer())
      .post("/api/v1/skills/install")
      .set("Authorization", `Bearer ${otherOrgToken}`)
      .send({ skillKey: "file-validation", enabled: true })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/skills/installations/${otherInstall.body.data.id}/grants`)
      .set("Authorization", `Bearer ${otherOrgToken}`)
      .send({ pluginInstallationId: employeeId })
      .expect(404);
  });

  it("rejects a skill execution with input that fails the skill's declared schema", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/skills/execute")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ skillKey: "document-reader", pluginInstallationId: employeeId, input: { notAValidField: true } })
      .expect(400);
  });

  it("revokes the employee grant and denies further execution", async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/skills/installations/${installationId}/grants/${employeeId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post("/api/v1/skills/execute")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        skillKey: "document-reader",
        pluginInstallationId: employeeId,
        input: { fileName: "note.txt", mimeType: "text/plain", text: "hello" }
      })
      .expect(403);
  });

  it("uninstalls the skill", async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/skills/installations/${installationId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    // A soft-deleted installation resolves the same as a never-installed one: SKILL_NOT_INSTALLED -> 403.
    await request(app.getHttpServer())
      .get(`/api/v1/skills/installations/${installationId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(403);
  });
});

async function cleanup(prisma: PrismaService) {
  await prisma.skillRun.deleteMany();
  await prisma.employeeSkillGrant.deleteMany();
  await prisma.skillInstallation.deleteMany();
  await prisma.conversationMessage.deleteMany();
  await prisma.agentToolExecution.deleteMany();
  await prisma.agentExecution.deleteMany();
  await prisma.agentMemory.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.hrEmployeeConfiguration.deleteMany();
  await prisma.pluginAiConfiguration.deleteMany();
  await prisma.pluginConfiguration.deleteMany();
  await prisma.plugin.deleteMany();
}
