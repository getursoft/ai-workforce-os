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

/**
 * Sprint 6.1B — Skills Platform Enterprise Completion end-to-end. Runs against a real Postgres
 * (same convention as skill-platform.e2e.spec.ts). Covers pipelines (Feature 1), recommendations
 * (Feature 2), dependency resolution (Feature 3, exercised indirectly through pack install order),
 * analytics (Feature 4), packs (Feature 5), templates (Feature 6), search (Feature 9), and tenant
 * isolation across all of the above.
 */
suite("Skills Platform Enterprise Completion (Sprint 6.1B) end-to-end", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let organizationId: string;
  let employeeId: string;

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
        organizationName: "Enterprise Skills Org",
        firstName: "Owner",
        email: `enterprise-skills-owner-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    ownerToken = registered.body.data.tokens.accessToken;
    organizationId = registered.body.data.organization.id;

    const otherRegistered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Other Enterprise Org",
        firstName: "Owner",
        email: `enterprise-skills-other-${Date.now()}@example.com`,
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

    // Feature installs (entity-extraction/translation/text-summarization) are AI_PROVIDER_BACKED and
    // gated behind the SKILLS_AI_BACKED entitlement (false by default for a fresh org's plan). This
    // suite proves genuinely full pack/template/pipeline behavior rather than only the DETERMINISTIC
    // subset, so it enables the flag directly via the FeatureFlag table — the same mechanism an
    // administrator's plan upgrade would flip, not a bypass of the entitlement check itself.
    await prisma.featureFlag.create({
      data: { organizationId, key: "SKILLS_AI_BACKED", enabled: true, value: {} }
    });
  });

  afterAll(async () => {
    if (prisma) await cleanup(prisma);
    await app?.close();
  });

  // ------------------------------------------------------------------ search / recommend

  it("finds a skill by fuzzy name search", async () => {
    const result = await request(app.getHttpServer())
      .get("/api/v1/skills/search?query=documnet")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const keys = result.body.data.map((row: { key: string }) => row.key);
    expect(keys).toContain("document-reader");
  });

  it("filters search results by category", async () => {
    const result = await request(app.getHttpServer())
      .get("/api/v1/skills/search?category=Security")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(result.body.data.every((row: { category: string }) => row.category === "Security")).toBe(true);
    expect(result.body.data.some((row: { key: string }) => row.key === "file-validation")).toBe(true);
  });

  it("recommends document-reader for an uploaded PDF-like MIME type", async () => {
    const result = await request(app.getHttpServer())
      .get("/api/v1/skills/recommend?mimeTypes=text/plain")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const keys = result.body.data.map((row: { skillKey: string }) => row.skillKey);
    expect(keys).toContain("document-reader");
  });

  it("recommends by free-text keyword overlap with manifest capability summaries", async () => {
    const result = await request(app.getHttpServer())
      .get("/api/v1/skills/recommend?message=please+translate+this+document")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const keys = result.body.data.map((row: { skillKey: string }) => row.skillKey);
    expect(keys).toContain("translation");
  });

  // ------------------------------------------------------------------ packs (Feature 5, Feature 3 proof)

  it("lists the seeded built-in packs with their items", async () => {
    const result = await request(app.getHttpServer())
      .get("/api/v1/skills/packs")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const keys = result.body.data.map((row: { key: string }) => row.key);
    expect(keys).toEqual(expect.arrayContaining(["document-intelligence-pack", "text-insights-pack"]));
    const pack = result.body.data.find((row: { key: string }) => row.key === "document-intelligence-pack");
    expect(pack.items.map((item: { skillKey: string }) => item.skillKey)).toEqual([
      "file-validation",
      "document-reader",
      "entity-extraction",
      "translation",
      "text-summarization"
    ]);
  });

  it("installs a pack end-to-end — every item lands as a real, executable SkillInstallation", async () => {
    const installed = await request(app.getHttpServer())
      .post("/api/v1/skills/packs/install")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ packKey: "text-insights-pack" })
      .expect(201);
    expect(installed.body.data.installation.status).toBe("INSTALLED");
    expect(installed.body.data.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skillKey: "text-summarization", outcome: "INSTALLED" }),
        expect.objectContaining({ skillKey: "entity-extraction", outcome: "INSTALLED" }),
        expect.objectContaining({ skillKey: "translation", outcome: "INSTALLED" })
      ])
    );

    // Proof this is a real installation, not bookkeeping-only: it shows up in the ordinary
    // installations list exactly like a manually installed skill would.
    const installations = await request(app.getHttpServer())
      .get("/api/v1/skills/installations")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const installedKeys = installations.body.data.map((row: { skillVersion: { skill: { key: string } } }) => row.skillVersion.skill.key);
    expect(installedKeys).toEqual(expect.arrayContaining(["text-summarization", "entity-extraction", "translation"]));
  });

  it("rejects installing the same pack twice for the same organization", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/skills/packs/install")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ packKey: "text-insights-pack" })
      .expect(409);
  });

  it("removes a pack without uninstalling its underlying skills", async () => {
    await request(app.getHttpServer())
      .delete("/api/v1/skills/packs/text-insights-pack")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);

    const installations = await request(app.getHttpServer())
      .get("/api/v1/skills/installations")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const installedKeys = installations.body.data.map((row: { skillVersion: { skill: { key: string } } }) => row.skillVersion.skill.key);
    expect(installedKeys).toContain("text-summarization");
  });

  it("denies a cross-tenant pack removal for a pack the calling org never installed", async () => {
    await request(app.getHttpServer())
      .delete("/api/v1/skills/packs/document-intelligence-pack")
      .set("Authorization", `Bearer ${otherOrgToken}`)
      .expect(404);
  });

  // ------------------------------------------------------------------ templates (Feature 6)

  it("lists the seeded built-in templates", async () => {
    const result = await request(app.getHttpServer())
      .get("/api/v1/skills/templates")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const keys = result.body.data.map((row: { key: string }) => row.key);
    expect(keys).toEqual(expect.arrayContaining(["invoice-intelligence-template", "hr-document-intake-template"]));
  });

  it("installs a template onto a NEW employee it creates itself, granting every listed skill", async () => {
    // invoice-intelligence-template targets "finance-employee" — not yet installed for this org (only
    // hr-employee was installed in beforeAll), so PluginService.install creates a genuinely new employee
    // rather than colliding with the existing-active-installation-per-slug uniqueness constraint.
    const installed = await request(app.getHttpServer())
      .post("/api/v1/skills/templates/install")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ templateKey: "invoice-intelligence-template" })
      .expect(201);

    expect(installed.body.data.pluginInstallationId).toBeTruthy();
    expect(installed.body.data.pluginInstallationId).not.toBe(employeeId);
    expect(installed.body.data.installedSkills).toEqual(
      expect.arrayContaining(["document-reader", "entity-extraction", "text-summarization"])
    );

    const discovery = await request(app.getHttpServer())
      .get(`/api/v1/skills/employees/${installed.body.data.pluginInstallationId}/skills`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const grantedKeys = discovery.body.data.map((row: { skillKey: string }) => row.skillKey);
    expect(grantedKeys).toEqual(expect.arrayContaining(["document-reader", "entity-extraction", "text-summarization"]));
  });

  it("installs a template onto an EXISTING employee when one is specified", async () => {
    // hr-document-intake-template targets "hr-employee"; passing the already-installed employeeId
    // explicitly skips employee creation entirely (no PluginService.install call), so it never touches
    // the active-installation-per-slug uniqueness constraint.
    const installed = await request(app.getHttpServer())
      .post("/api/v1/skills/templates/install")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ templateKey: "hr-document-intake-template", pluginInstallationId: employeeId })
      .expect(201);
    expect(installed.body.data.pluginInstallationId).toBe(employeeId);
  });

  it("returns 404 for an unknown template key", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/skills/templates/install")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ templateKey: "does-not-exist-template" })
      .expect(404);
  });

  // ------------------------------------------------------------------ pipelines (Feature 1, Feature 7)

  it("rejects a pipeline definition with an unknown skill key", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/skills/pipeline")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        name: "Bad Pipeline",
        description: "References a skill that does not exist",
        nodes: [{ order: 1, skillKey: "not-a-real-skill" }]
      })
      .expect(400);
  });

  it("creates and executes a two-node pipeline where the second node's input is the first node's output", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/skills/pipeline")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        name: "Read then Summarize",
        description: "document-reader output chains directly into text-summarization input",
        nodes: [
          { order: 1, skillKey: "document-reader" },
          { order: 2, skillKey: "text-summarization" }
        ]
      })
      .expect(201);
    expect(created.body.data.nodes).toHaveLength(2);
    const pipelineId = created.body.data.id;

    const fetched = await request(app.getHttpServer())
      .get(`/api/v1/skills/pipeline/${pipelineId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(fetched.body.data.nodes.map((n: { skillKey: string }) => n.skillKey)).toEqual([
      "document-reader",
      "text-summarization"
    ]);

    const executed = await request(app.getHttpServer())
      .post(`/api/v1/skills/pipeline/${pipelineId}/execute`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        pluginInstallationId: employeeId,
        input: { fileName: "brief.txt", mimeType: "text/plain", text: "The quarterly numbers were strong across every region." }
      })
      .expect(201);

    expect(executed.body.data.status).toBe("COMPLETED");
    expect(executed.body.data.nodeExecutions).toHaveLength(2);
    const [first, second] = executed.body.data.nodeExecutions;
    expect(first).toMatchObject({ skillKey: "document-reader", status: "COMPLETED" });
    expect(second).toMatchObject({ skillKey: "text-summarization", status: "COMPLETED" });
    expect(first.skillRunId).toBeTruthy();
    expect(second.skillRunId).toBeTruthy();
    expect(first.skillRunId).not.toBe(second.skillRunId);

    // Fetch the execution graph directly by id (the dashboard's DAG view) and confirm timing data exists.
    const executionDetail = await request(app.getHttpServer())
      .get(`/api/v1/skills/pipeline-executions/${executed.body.data.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(executionDetail.body.data.nodeExecutions).toHaveLength(2);
    expect(executionDetail.body.data.durationMs).toBeGreaterThanOrEqual(0);

    const executions = await request(app.getHttpServer())
      .get(`/api/v1/skills/pipeline/${pipelineId}/executions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(executions.body.data.total).toBeGreaterThan(0);
  });

  it("stops the pipeline (STOP policy) when a node fails, and skips every remaining node", async () => {
    // A fresh employee (a distinct, not-yet-installed plugin slug — this org already has an active
    // hr-employee and finance-employee from earlier tests) with NO skill grants — the first node fails
    // with SKILL_EMPLOYEE_GRANT_DENIED.
    const ungranted = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ pluginId: "travel-employee", enable: true })
      .expect(201);

    const created = await request(app.getHttpServer())
      .post("/api/v1/skills/pipeline")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        name: "Stop On Failure",
        description: "First node fails for an ungranted employee; STOP must skip the rest",
        nodes: [
          { order: 1, skillKey: "document-reader", onFailure: "STOP" },
          { order: 2, skillKey: "text-summarization" }
        ]
      })
      .expect(201);

    const executed = await request(app.getHttpServer())
      .post(`/api/v1/skills/pipeline/${created.body.data.id}/execute`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ pluginInstallationId: ungranted.body.id, input: { fileName: "x.txt", mimeType: "text/plain", text: "hello" } })
      .expect(201);

    expect(executed.body.data.status).toBe("FAILED");
    const [first, second] = executed.body.data.nodeExecutions;
    expect(first.status).toBe("FAILED");
    expect(second.status).toBe("SKIPPED");
  });

  it("continues past a failed node (CONTINUE policy), producing a PARTIAL pipeline result", async () => {
    const ungranted = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ pluginId: "legal-employee", enable: true })
      .expect(201);
    // Grant only text-summarization, not document-reader, so node 1 fails and node 2 can still succeed.
    const installations = await request(app.getHttpServer())
      .get("/api/v1/skills/installations")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const textSummarizationInstallation = installations.body.data.find(
      (row: { skillVersion: { skill: { key: string } } }) => row.skillVersion.skill.key === "text-summarization"
    );
    await request(app.getHttpServer())
      .post(`/api/v1/skills/installations/${textSummarizationInstallation.id}/grants`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ pluginInstallationId: ungranted.body.id })
      .expect(201);

    const created = await request(app.getHttpServer())
      .post("/api/v1/skills/pipeline")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        name: "Continue On Failure",
        description: "Node 1 fails (no grant) but CONTINUE lets node 2 still run",
        nodes: [
          { order: 1, skillKey: "document-reader", onFailure: "CONTINUE" },
          { order: 2, skillKey: "text-summarization", useTriggerInput: true }
        ]
      })
      .expect(201);

    const executed = await request(app.getHttpServer())
      .post(`/api/v1/skills/pipeline/${created.body.data.id}/execute`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        pluginInstallationId: ungranted.body.id,
        input: { text: "This node runs on the trigger input directly, bypassing the failed first node's output." }
      })
      .expect(201);

    expect(executed.body.data.status).toBe("PARTIAL");
    const [first, second] = executed.body.data.nodeExecutions;
    expect(first.status).toBe("FAILED");
    expect(second.status).toBe("COMPLETED");
  });

  it("merges a node's staticInput with the trigger input for a skill needing fixed parameters no prior output could supply", async () => {
    // file-validation requires fileName+mimeType+sizeBytes. The trigger below deliberately omits
    // sizeBytes — it can only come from this node's own staticInput, never from the trigger or a
    // prior node's output, proving the pipeline's staticInput merge mechanism with a real,
    // deterministic (no AI provider dependency) skill execution.
    const created = await request(app.getHttpServer())
      .post("/api/v1/skills/pipeline")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        name: "Static Input Merge Proof",
        description: "Single file-validation node fed the trigger's fileName/mimeType plus a fixed sizeBytes",
        nodes: [
          {
            order: 1,
            skillKey: "file-validation",
            useTriggerInput: true,
            staticInput: { sizeBytes: 2048 }
          }
        ]
      })
      .expect(201);

    const executed = await request(app.getHttpServer())
      .post(`/api/v1/skills/pipeline/${created.body.data.id}/execute`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ pluginInstallationId: employeeId, input: { fileName: "invoice.pdf", mimeType: "application/pdf" } })
      .expect(201);

    expect(executed.body.data.status).toBe("COMPLETED");
    expect(executed.body.data.nodeExecutions[0].status).toBe("COMPLETED");
    expect(executed.body.data.nodeExecutions[0].skillRunId).toBeTruthy();
  });

  it("skips a node whose condition is not met, without failing the pipeline", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/skills/pipeline")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        name: "Conditional Skip",
        description: "Second node only runs when the first node's text is non-trivially long",
        nodes: [
          { order: 1, skillKey: "document-reader" },
          { order: 2, skillKey: "text-summarization", conditionExpression: "output.text.length > 100000" }
        ]
      })
      .expect(201);

    const executed = await request(app.getHttpServer())
      .post(`/api/v1/skills/pipeline/${created.body.data.id}/execute`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ pluginInstallationId: employeeId, input: { fileName: "short.txt", mimeType: "text/plain", text: "short" } })
      .expect(201);

    expect(executed.body.data.status).toBe("COMPLETED");
    const [first, second] = executed.body.data.nodeExecutions;
    expect(first.status).toBe("COMPLETED");
    expect(second.status).toBe("SKIPPED");
  });

  it("denies cross-tenant access to another organization's pipeline", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/skills/pipeline")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Tenant Isolation Probe", description: "x", nodes: [{ order: 1, skillKey: "document-reader" }] })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/api/v1/skills/pipeline/${created.body.data.id}`)
      .set("Authorization", `Bearer ${otherOrgToken}`)
      .expect(404);
  });

  // ------------------------------------------------------------------ analytics (Feature 4)

  it("reports analytics aggregated from real SkillRun rows produced above", async () => {
    const report = await request(app.getHttpServer())
      .get("/api/v1/skills/analytics")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);

    expect(report.body.data.totals.executions).toBeGreaterThan(0);
    expect(report.body.data.totals.organizationsUsing).toBe(1);
    const documentReaderRow = report.body.data.perSkill.find((row: { skillKey: string }) => row.skillKey === "document-reader");
    expect(documentReaderRow.executions).toBeGreaterThan(0);
    expect(report.body.data.topSkills.length).toBeGreaterThan(0);
  });

  it("exports analytics as CSV with a header row and one row per skill", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/skills/analytics/export")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    const lines = response.text.trim().split("\n");
    expect(lines[0]).toBe(
      "skillKey,name,category,executions,completedExecutions,failedExecutions,successRate,failureRate,avgLatencyMs,creditsConsumed,totalTokens,employeesUsing,installed"
    );
    expect(lines.length).toBeGreaterThan(1);
  });

  it("tenant-isolates analytics — the other organization sees zero executions", async () => {
    const report = await request(app.getHttpServer())
      .get("/api/v1/skills/analytics")
      .set("Authorization", `Bearer ${otherOrgToken}`)
      .expect(200);
    expect(report.body.data.totals.executions).toBe(0);
  });
});

async function cleanup(prisma: PrismaService) {
  await prisma.skillPipelineNodeExecution.deleteMany();
  await prisma.skillPipelineExecution.deleteMany();
  await prisma.skillPipelineNode.deleteMany();
  await prisma.skillPipeline.deleteMany();
  await prisma.skillTemplateInstallation.deleteMany();
  await prisma.skillPackInstallation.deleteMany();
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
  await prisma.featureFlag.deleteMany();
}
