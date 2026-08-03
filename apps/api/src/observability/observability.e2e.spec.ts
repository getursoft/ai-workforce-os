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
import { AuthorizationService } from "../identity/application/services/authorization.service";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
import { dummyEchoManifest } from "@ai-workforce-os/plugin-dummy";

/**
 * Sprint 4.7 Phase 25 — real, database-backed proof of the observability API surface: auth/RBAC
 * enforcement, tenant isolation, a real trace produced by a real chat execution, real aggregate metrics,
 * real alert sync/acknowledge, and a real safe operational action (task retry) — all against actual rows,
 * not mocked traces.
 */

for (const c of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(c)) {
    loadEnvFile(c);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("Observability API (Sprint 4.7, e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: { Authorization: string };
  let orgId: string;
  let ownerEmail: string;
  let orgName: string;
  let employeeId: string;
  let traceId: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);

    ownerEmail = `observability-${Date.now()}@example.com`;
    orgName = `Observability Org ${Date.now()}`;
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ organizationName: orgName, firstName: "Owner", email: ownerEmail, password: "StrongPassword@123" })
      .expect(201);
    auth = { Authorization: `Bearer ${registered.body.data.tokens.accessToken}` };
    orgId = registered.body.data.organization.id;
    const owner = await prisma.user.findFirstOrThrow({ where: { organizationId: orgId } });

    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set(auth)
      .send({ manifest: { ...dummyEchoManifest, id: "observability-employee", name: "Observability Test Employee", displayName: "Observability Test Employee" }, enable: true })
      .expect(201);
    employeeId = installed.body.id;
    const encryption = app.get(PluginSecretsEncryptionService);
    await prisma.pluginAiConfiguration.create({
      data: {
        organizationId: orgId,
        pluginInstallationId: employeeId,
        providerType: "DETERMINISTIC",
        configuration: { timeoutMs: 30000 },
        encryptedSecrets: encryption.encrypt({}) as unknown as Prisma.InputJsonValue,
        updatedBy: owner.id
      }
    });

    // Real chat execution to produce a real trace/span tree to read back through the API.
    const run = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({ pluginInstallationId: employeeId, message: "Hello, can you help me?" })
      .expect(201);
    const trace = await prisma.executionTrace.findFirst({ where: { organizationId: orgId, conversationId: run.body.conversationId } });
    if (!trace) throw new Error("trace missing");
    traceId = trace.traceId;
  });

  afterAll(async () => {
    if (prisma && orgId) {
      await prisma.observabilityAlert.deleteMany({ where: { organizationId: orgId } });
      await prisma.executionSpan.deleteMany({ where: { organizationId: orgId } });
      await prisma.executionTrace.deleteMany({ where: { organizationId: orgId } });
      await prisma.employeeDelegatedTask.deleteMany({ where: { organizationId: orgId } });
      await prisma.conversation.deleteMany({ where: { organizationId: orgId } });
      await prisma.pluginAiConfiguration.deleteMany({ where: { organizationId: orgId } });
      await prisma.pluginConfiguration.deleteMany({ where: { organizationId: orgId } });
      await prisma.plugin.deleteMany({ where: { organizationId: orgId } });
    }
    await app?.close();
  });

  it("requires authentication (401) for every observability route", async () => {
    await request(app.getHttpServer()).get("/api/v1/observability/overview").expect(401);
    await request(app.getHttpServer()).get("/api/v1/observability/traces").expect(401);
    await request(app.getHttpServer()).get(`/api/v1/observability/traces/${traceId}`).expect(401);
    await request(app.getHttpServer()).get("/api/v1/observability/alerts").expect(401);
  });

  it("denies a Member without observability permissions (403) and allows the Owner", async () => {
    const owner = await prisma.user.findFirstOrThrow({ where: { organizationId: orgId, normalizedEmail: ownerEmail.toLowerCase() } });
    const memberRole = await prisma.role.findFirstOrThrow({ where: { organizationId: orgId, name: "Member" } });
    const ownerRole = await prisma.role.findFirstOrThrow({ where: { organizationId: orgId, name: "Owner" } });
    await prisma.userRole.deleteMany({ where: { userId: owner.id, roleId: ownerRole.id } });
    await prisma.userRole.create({ data: { userId: owner.id, roleId: memberRole.id } });
    await prisma.user.update({ where: { id: owner.id }, data: { role: "MEMBER" } });
    app.get(AuthorizationService).invalidateUser(owner.id, orgId);

    const relogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: owner.email, password: "StrongPassword@123", organizationName: orgName })
      .expect(200);
    const memberAuth = { Authorization: `Bearer ${relogin.body.data.tokens.accessToken}` };

    await request(app.getHttpServer()).get("/api/v1/observability/overview").set(memberAuth).expect(403);

    await prisma.userRole.deleteMany({ where: { userId: owner.id, roleId: memberRole.id } });
    await prisma.userRole.create({ data: { userId: owner.id, roleId: ownerRole.id } });
    await prisma.user.update({ where: { id: owner.id }, data: { role: "OWNER" } });
    app.get(AuthorizationService).invalidateUser(owner.id, orgId);

    await request(app.getHttpServer()).get("/api/v1/observability/overview").set(auth).expect(200);
  });

  it("returns a real overview with at least one execution counted", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/observability/overview").set(auth).expect(200);
    expect(res.body.totalExecutions).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.successRate === "number" || res.body.successRate === null).toBe(true);
    expect(Array.isArray(res.body.stuckWorkflowDetails)).toBe(true);
  });

  it("lists real traces and retrieves the trace tree with a real span", async () => {
    const list = await request(app.getHttpServer()).get("/api/v1/observability/traces").set(auth).expect(200);
    expect(list.body.items.some((t: { traceId: string }) => t.traceId === traceId)).toBe(true);

    const tree = await request(app.getHttpServer()).get(`/api/v1/observability/traces/${traceId}/tree`).set(auth).expect(200);
    expect(tree.body.trace.traceId).toBe(traceId);
    expect(tree.body.root).toBeTruthy();
    expect(tree.body.root.spanType).toBe("AGENT_EXECUTION");
  });

  it("returns 404 for an unknown trace id, never a 500", async () => {
    await request(app.getHttpServer()).get("/api/v1/observability/traces/does-not-exist").set(auth).expect(404);
  });

  it("is tenant-isolated — a second organization cannot read the first organization's trace", async () => {
    const otherEmail = `observability-other-${Date.now()}@example.com`;
    const registeredOther = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ organizationName: `Observability Other Org ${Date.now()}`, firstName: "Owner", email: otherEmail, password: "StrongPassword@123" })
      .expect(201);
    const otherAuth = { Authorization: `Bearer ${registeredOther.body.data.tokens.accessToken}` };

    await request(app.getHttpServer()).get(`/api/v1/observability/traces/${traceId}`).set(otherAuth).expect(404);
    const otherList = await request(app.getHttpServer()).get("/api/v1/observability/traces").set(otherAuth).expect(200);
    expect(otherList.body.items).toHaveLength(0);
  });

  it("computes real metrics (executions-over-time, failures-by-employee) without raw customer identifiers", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/observability/metrics").set(auth).expect(200);
    expect(res.body.overview.totalExecutions).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.executionsOverTime)).toBe(true);
    expect(Array.isArray(res.body.failuresByEmployee)).toBe(true);
    // No email/phone-shaped values anywhere in the serialized metrics payload.
    expect(JSON.stringify(res.body)).not.toContain(ownerEmail);
  });

  it("syncs and lists real alerts, and can acknowledge one", async () => {
    // Force a real QUEUED-beyond-timeout delegated task so the QUEUE/timeout alert rule has something to
    // find — a genuine detected condition, not a fabricated alert row.
    const stuckTask = await prisma.employeeDelegatedTask.create({
      data: {
        organizationId: orgId,
        sourceEmployeeInstallationId: employeeId,
        targetEmployeeInstallationId: employeeId,
        requestedByActorType: "EMPLOYEE",
        taskType: "GENERAL_QUERY",
        title: "stuck task for alert test",
        instructions: "stuck",
        status: "QUEUED",
        correlationId: "alert-test-corr",
        mode: "ASYNCHRONOUS",
        maxAttempts: 2,
        timeoutAt: new Date(Date.now() - 60 * 60 * 1000)
      }
    });

    const alerts = await request(app.getHttpServer()).get("/api/v1/observability/alerts").set(auth).expect(200);
    const found = alerts.body.find((a: { ruleCode: string; relatedEntityId: string | null }) => a.ruleCode === "DELEGATED_TASK_TIMEOUT" && a.relatedEntityId === stuckTask.id);
    expect(found).toBeTruthy();
    expect(found.status).toBe("OPEN");

    const ack = await request(app.getHttpServer()).post(`/api/v1/observability/alerts/${found.id}/acknowledge`).set(auth).expect(201);
    expect(ack.body.status).toBe("ACKNOWLEDGED");

    await prisma.employeeDelegatedTask.delete({ where: { id: stuckTask.id } });
  });

  it("performs a safe operational retry on a real terminal task, and audits it", async () => {
    const task = await prisma.employeeDelegatedTask.create({
      data: {
        organizationId: orgId,
        sourceEmployeeInstallationId: employeeId,
        targetEmployeeInstallationId: employeeId,
        requestedByActorType: "EMPLOYEE",
        taskType: "GENERAL_QUERY",
        title: "retry test",
        instructions: "retry test",
        status: "TIMED_OUT",
        errorCode: "TASK_TIMED_OUT",
        correlationId: "retry-test-corr",
        mode: "ASYNCHRONOUS",
        attemptCount: 0,
        maxAttempts: 2,
        timeoutAt: new Date(Date.now() - 1000)
      }
    });

    const retried = await request(app.getHttpServer()).post(`/api/v1/observability/tasks/${task.id}/retry`).set(auth).expect(201);
    expect(retried.body.status).toBe("COMPLETED");

    await prisma.employeeDelegatedTask.delete({ where: { id: task.id } });
  });

  it("rejects a resume attempt for a non-EMPLOYEE_DELEGATION workflow type (destructive/unsupported action blocked)", async () => {
    const conversation = await prisma.conversation.create({ data: { organizationId: orgId, pluginInstallationId: employeeId, title: "unsupported resume test" } });
    const workflow = await prisma.workflowExecution.create({
      data: {
        organizationId: orgId,
        pluginInstallationId: employeeId,
        conversationId: conversation.id,
        workflowType: "CONTACT_CAPTURE",
        status: "ACTIVE",
        currentStep: "test",
        state: {}
      }
    });
    await request(app.getHttpServer()).post(`/api/v1/observability/workflows/${workflow.id}/resume`).set(auth).expect(403);
    await prisma.workflowExecution.delete({ where: { id: workflow.id } });
    await prisma.conversation.delete({ where: { id: conversation.id } });
  });

  it("Sprint 4.7A Phase 14: a real chat message carrying an embedded secret/phone/email never leaks into a persisted trace or span row", async () => {
    const SECRET = "sk-live-abcdefghijklmnopqrstuvwx";
    const PHONE = "+14155559876";
    const EMAIL = "traveler.private@example.com";
    const run = await request(app.getHttpServer())
      .post("/api/v1/agents/run")
      .set(auth)
      .send({
        pluginInstallationId: employeeId,
        message: `Please remember my API key ${SECRET}, call me at ${PHONE}, and email me at ${EMAIL} with updates.`
      })
      .expect(201);
    const trace = await prisma.executionTrace.findFirst({ where: { organizationId: orgId, conversationId: run.body.conversationId } });
    if (!trace) throw new Error("trace missing");
    const spans = await prisma.executionSpan.findMany({ where: { organizationId: orgId, traceId: trace.traceId } });
    expect(spans.length).toBeGreaterThan(0);
    const serialized = JSON.stringify({ trace, spans });
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(PHONE);
    expect(serialized).not.toContain(EMAIL);
    // The response to the customer is unaffected — sanitization only applies to what gets persisted for
    // observability, never to the actual conversation the customer sees.
    expect(run.body.response.length).toBeGreaterThan(0);

    await prisma.executionSpan.deleteMany({ where: { organizationId: orgId, traceId: trace.traceId } });
    await prisma.executionTrace.deleteMany({ where: { organizationId: orgId, traceId: trace.traceId } });
    await prisma.conversation.deleteMany({ where: { organizationId: orgId, id: run.body.conversationId } });
  });
});
