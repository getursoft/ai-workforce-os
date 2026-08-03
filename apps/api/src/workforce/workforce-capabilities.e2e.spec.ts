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
import { WorkflowExecutionService } from "../workflows/workflow-execution.service";
import { WorkforceOrchestratorService } from "./workforce-orchestrator.service";
import { WorkforceTaskProcessor } from "./workforce-task-processor";
import { dummyEchoManifest } from "@ai-workforce-os/plugin-dummy";

/**
 * Sprint 4.6 completion pass — real, database-backed proof for the six capabilities that were
 * previously incomplete: asynchronous execution outside the HTTP request, parallel join policies,
 * push-based approval resumption, least-privilege memory sharing, single parent-resume, and security
 * hardening (confused-deputy / result validation / cross-tenant isolation). Every AI Employee used here
 * is a real Plugin installation (dummy-echo, installed twice under distinct ids) — nothing is mocked
 * below the HTTP boundary; Prisma reads go straight at the test database to observe real side effects.
 */

for (const c of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(c)) {
    loadEnvFile(c);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function requireDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 5000, intervalMs = 75): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("TIMED_OUT_WAITING_FOR_CONDITION");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

suite("Workforce delegation engine — async/parallel/approval/memory/security (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orchestrator: WorkforceOrchestratorService;
  let workflows: WorkflowExecutionService;
  let processor: WorkforceTaskProcessor;
  let auth: { Authorization: string };
  let orgId: string, ownerEmail: string, ownerId: string;
  let sourceId: string, targetId: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    orchestrator = app.get(WorkforceOrchestratorService);
    workflows = app.get(WorkflowExecutionService);
    processor = app.get(WorkforceTaskProcessor);

    ownerEmail = `workforce-cap-${Date.now()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ organizationName: `Workforce Capabilities Org ${Date.now()}`, firstName: "Owner", email: ownerEmail, password: "StrongPassword@123" })
      .expect(201);
    auth = { Authorization: `Bearer ${registered.body.data.tokens.accessToken}` };
    orgId = registered.body.data.organization.id;
    const owner = await prisma.user.findFirstOrThrow({ where: { organizationId: orgId, normalizedEmail: ownerEmail.toLowerCase() } });
    ownerId = owner.id;

    const encryption = app.get(PluginSecretsEncryptionService);
    async function install(idSuffix: string): Promise<string> {
      const res = await request(app.getHttpServer())
        .post("/api/v1/plugins/install")
        .set(auth)
        .send({
          manifest: { ...dummyEchoManifest, id: `workforce-cap-${idSuffix}`, name: `Cap ${idSuffix}`, displayName: `Cap ${idSuffix}` },
          enable: true
        })
        .expect(201);
      // A DETERMINISTIC provider makes execution outcomes predictable (fixed prose reply) rather than
      // depending on which deterministic domain engine a given plugin slug happens to route through.
      await prisma.pluginAiConfiguration.create({
        data: {
          organizationId: orgId,
          pluginInstallationId: res.body.id,
          providerType: "DETERMINISTIC",
          configuration: { timeoutMs: 30000 },
          encryptedSecrets: encryption.encrypt({}) as unknown as Prisma.InputJsonValue,
          updatedBy: ownerId
        }
      });
      return res.body.id as string;
    }
    sourceId = await install("source");
    targetId = await install("target");
  });

  afterAll(async () => {
    if (prisma && orgId) {
      await prisma.memoryRecord.deleteMany({ where: { organizationId: orgId } });
      await prisma.employeeDelegationJoin.deleteMany({ where: { organizationId: orgId } });
      await prisma.employeeDelegatedTask.deleteMany({ where: { organizationId: orgId } });
      await prisma.approvalRequest.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma.workflowExecution.deleteMany({ where: { organizationId: orgId } });
      await prisma.employeeRoutingProfile.deleteMany({ where: { organizationId: orgId } });
      await prisma.conversation.deleteMany({ where: { organizationId: orgId } });
      await prisma.pluginAiConfiguration.deleteMany({ where: { organizationId: orgId } });
      await prisma.pluginConfiguration.deleteMany({ where: { organizationId: orgId } });
      await prisma.plugin.deleteMany({ where: { organizationId: orgId } });
    }
    await app?.close();
  });

  // -------------------------------------------------------------------------------------------
  // 1. Real asynchronous delegation
  // -------------------------------------------------------------------------------------------

  describe("asynchronous delegation (real background execution)", () => {
    it("returns QUEUED immediately and only executes later, via the real background processor — never inline in the HTTP request", async () => {
      const requestSentAt = Date.now();
      const res = await request(app.getHttpServer())
        .post("/api/v1/workforce/tasks")
        .set(auth)
        .send({
          sourceEmployeeInstallationId: sourceId,
          targetEmployeeInstallationId: targetId,
          taskType: "GENERAL_QUERY",
          objective: "Draft a note asynchronously",
          input: { note: "async hello" },
          mode: "ASYNCHRONOUS"
        })
        .expect(201);
      expect(res.body.status).toBe("QUEUED");
      expect(res.body.mode).toBe("ASYNCHRONOUS");
      expect(res.body.parentWorkflowExecutionId).toBeTruthy();
      const taskId = res.body.id as string;

      const immediatelyAfterResponse = await prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: taskId } });
      expect(immediatelyAfterResponse.status).toBe("QUEUED");
      expect(immediatelyAfterResponse.startedAt).toBeNull();

      // No manual tick() here — this relies entirely on WorkforceTaskProcessor's real setInterval,
      // started by OnModuleInit when the app booted, running completely independently of this request.
      const completed = await waitFor(async () => {
        const t = await prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: taskId } });
        return t.status === "COMPLETED" || t.status === "FAILED" ? t : null;
      }, 5000);
      expect(completed.status).toBe("COMPLETED");
      expect(completed.startedAt).not.toBeNull();
      expect(requireDefined(completed.startedAt, "startedAt missing").getTime()).toBeGreaterThanOrEqual(requestSentAt);

      const workflow = await prisma.workflowExecution.findUniqueOrThrow({
        where: { id: requireDefined(completed.parentWorkflowExecutionId, "parentWorkflowExecutionId missing") }
      });
      expect(workflow.status).toBe("COMPLETED");
    });
  });

  // -------------------------------------------------------------------------------------------
  // Deterministic control from here on: stop the live timer and drive execution explicitly via
  // processor.tick() — the exact function the real timer calls — so cancellation/timeout races are
  // no longer left to chance.
  // -------------------------------------------------------------------------------------------

  describe("asynchronous cancellation, timeout and retry", () => {
    beforeAll(() => {
      processor.onModuleDestroy();
    });

    it("cancels a QUEUED task before it is ever picked up, and a subsequent tick never runs it", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/workforce/tasks")
        .set(auth)
        .send({
          sourceEmployeeInstallationId: sourceId,
          targetEmployeeInstallationId: targetId,
          taskType: "GENERAL_QUERY",
          objective: "Should be cancelled before dispatch",
          input: {},
          mode: "ASYNCHRONOUS"
        })
        .expect(201);
      const taskId = res.body.id as string;
      expect(res.body.status).toBe("QUEUED");

      await request(app.getHttpServer()).post(`/api/v1/workforce/tasks/${taskId}/cancel`).set(auth).expect(201);
      const cancelled = await prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: taskId } });
      expect(cancelled.status).toBe("CANCELLED");

      await processor.tick();
      const stillCancelled = await prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: taskId } });
      expect(stillCancelled.status).toBe("CANCELLED");
      expect(stillCancelled.startedAt).toBeNull();
    });

    it("recovers an overdue QUEUED task automatically instead of looping or hanging", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/workforce/tasks")
        .set(auth)
        .send({
          sourceEmployeeInstallationId: sourceId,
          targetEmployeeInstallationId: targetId,
          taskType: "GENERAL_QUERY",
          objective: "Should time out while still queued, then auto-retry to completion",
          input: {},
          mode: "ASYNCHRONOUS",
          constraints: { timeoutMs: 100 }
        })
        .expect(201);
      const taskId = res.body.id as string;

      await new Promise((r) => setTimeout(r, 150));
      // A single tick() must terminate even though this task's deadline already passed before it was
      // ever dispatched — failTask()'s retry branch has to move attemptCount and timeoutAt forward, or
      // this recurses into dispatch()/failTask() forever without ever actually completing.
      await processor.tick();

      const settled = await prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: taskId } });
      expect(settled.status).toBe("COMPLETED");
      expect(settled.attemptCount).toBeGreaterThanOrEqual(1);
    });

    it("lets a manual retry recover a task sitting in a terminal TIMED_OUT state with attempts remaining", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/workforce/tasks")
        .set(auth)
        .send({
          sourceEmployeeInstallationId: sourceId,
          targetEmployeeInstallationId: targetId,
          taskType: "GENERAL_QUERY",
          objective: "Simulated terminal timeout awaiting manual retry",
          input: {},
          mode: "ASYNCHRONOUS"
        })
        .expect(201);
      const taskId = res.body.id as string;
      // Simulates a task that reached a genuine terminal TIMED_OUT state (e.g. a crash mid-retry in a
      // real deployment) with attempts still remaining — the precondition is seeded directly so this test
      // isolates the manual retry endpoint itself, which then runs for real against the real database.
      await prisma.employeeDelegatedTask.update({
        where: { id: taskId },
        data: { status: "TIMED_OUT", errorCode: "TASK_TIMED_OUT", errorMessageSafe: "simulated timeout", failedAt: new Date() }
      });

      await request(app.getHttpServer()).post(`/api/v1/workforce/tasks/${taskId}/retry`).set(auth).expect(201);
      const retried = await prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: taskId } });
      expect(retried.status).toBe("COMPLETED");
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2. Parallel collaboration
  // -------------------------------------------------------------------------------------------

  describe("parallel collaboration (join policies)", () => {
    interface JoinBody {
      correlationId: string;
      status: string;
      resolvedReason: string | null;
      totalChildren: number;
      minimumRequired: number | null;
      succeededCount: number;
      terminalCount: number;
      tasks: Array<{ id: string; status: string; correlationId: string }>;
    }

    async function delegateParallel(joinPolicy: string, count: number, minimumRequired?: number): Promise<JoinBody> {
      const requests = Array.from({ length: count }, (_, i) => ({
        targetEmployeeInstallationId: targetId,
        taskType: "GENERAL_QUERY",
        objective: `Parallel child ${i} for ${joinPolicy}`,
        input: { i }
      }));
      const res = await request(app.getHttpServer())
        .post("/api/v1/workforce/tasks/parallel")
        .set(auth)
        .send({
          sourceEmployeeInstallationId: sourceId,
          requests,
          joinPolicy,
          ...(minimumRequired ? { minimumRequired } : {}),
          mode: "SYNCHRONOUS"
        })
        .expect(201);
      return res.body as JoinBody;
    }

    it("ALL_REQUIRED resolves once every sibling succeeds, with exactly one persisted join row", async () => {
      const join = await delegateParallel("ALL_REQUIRED", 3);
      expect(join.status).toBe("RESOLVED");
      expect(join.resolvedReason).toBe("ALL_SUCCEEDED");
      expect(join.totalChildren).toBe(3);
      expect(join.succeededCount).toBe(3);
      expect(join.terminalCount).toBe(3);
      expect(join.tasks).toHaveLength(3);
      expect(join.tasks.every((t) => t.correlationId === join.correlationId)).toBe(true);

      const rows = await prisma.employeeDelegationJoin.findMany({ where: { correlationId: join.correlationId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("RESOLVED");

      const fetched = await request(app.getHttpServer()).get(`/api/v1/workforce/joins/${join.correlationId}`).set(auth).expect(200);
      expect(fetched.body.status).toBe("RESOLVED");
    });

    it("ANY_ONE resolves as soon as the first sibling succeeds", async () => {
      const join = await delegateParallel("ANY_ONE", 3);
      expect(join.status).toBe("RESOLVED");
      expect(join.resolvedReason).toBe("FIRST_SUCCESS");
    });

    it("MINIMUM_N resolves once the configured minimum has succeeded", async () => {
      const join = await delegateParallel("MINIMUM_N", 3, 2);
      expect(join.status).toBe("RESOLVED");
      expect(join.resolvedReason).toBe("MINIMUM_REACHED");
      expect(join.minimumRequired).toBe(2);
    });

    it("BEST_EFFORT resolves once every sibling is terminal, preserving successful partial results", async () => {
      const join = await delegateParallel("BEST_EFFORT", 3);
      expect(join.status).toBe("RESOLVED");
      expect(join.resolvedReason).toBe("BEST_EFFORT_PARTIAL");
      expect(join.tasks.filter((t) => t.status === "COMPLETED")).toHaveLength(3);
    });

    it("rejects a MINIMUM_N request that omits minimumRequired", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/workforce/tasks/parallel")
        .set(auth)
        .send({
          sourceEmployeeInstallationId: sourceId,
          requests: [{ targetEmployeeInstallationId: targetId, taskType: "GENERAL_QUERY", objective: "x", input: {} }],
          joinPolicy: "MINIMUM_N"
        })
        .expect(422);
      expect(res.body.error.code).toBe("TASK_SCHEMA_INVALID");
    });

    it("resumes the parent workflow exactly once even when several async siblings complete under real concurrency", async () => {
      const parentConversation = await prisma.conversation.create({
        data: { organizationId: orgId, pluginInstallationId: sourceId, title: "parallel parent" }
      });
      const { execution: parentWorkflow } = await workflows.createWorkflow({
        scope: { organizationId: orgId, pluginInstallationId: sourceId, conversationId: parentConversation.id, workflowType: "EMPLOYEE_DELEGATION" },
        currentStep: "AWAITING_PARALLEL_CHILDREN",
        pendingInput: null,
        state: {},
        turnId: `parallel-parent-${Date.now()}`
      });

      const requests = Array.from({ length: 5 }, (_, i) => ({
        targetEmployeeInstallationId: targetId,
        contract: { taskType: "GENERAL_QUERY", objective: `concurrent child ${i}`, input: { i } }
      }));
      const join = await orchestrator.delegateParallel({
        organizationId: orgId,
        sourceEmployeeInstallationId: sourceId,
        requests,
        joinPolicy: "ALL_REQUIRED",
        mode: "ASYNCHRONOUS",
        parentWorkflowExecutionId: parentWorkflow.id
      });
      expect(join.totalChildren).toBe(5);

      // The real race the "resume exactly once" guarantee has to survive: several concurrent ticks,
      // each capable of completing multiple siblings and calling evaluateJoin() at nearly the same time.
      await Promise.all(Array.from({ length: 5 }, () => processor.tick()));

      await waitFor(async () => {
        const j = await prisma.employeeDelegationJoin.findUniqueOrThrow({ where: { correlationId: join.correlationId } });
        return j.status === "RESOLVED" ? j : null;
      }, 5000);

      const resolvedWorkflow = await prisma.workflowExecution.findUniqueOrThrow({ where: { id: parentWorkflow.id } });
      expect(resolvedWorkflow.status).toBe("COMPLETED");
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. Least-privilege memory sharing
  // -------------------------------------------------------------------------------------------

  describe("least-privilege memory sharing", () => {
    it("shares only explicitly requested, non-CRITICAL, non-USER-scope facts — never secrets, private user notes, or unrequested categories", async () => {
      await request(app.getHttpServer())
        .post("/api/v1/memory")
        .set(auth)
        .send({ scope: "EMPLOYEE", employeeId: sourceId, category: "PREFERENCE", key: "favorite-airline", value: { airline: "Delta" }, importance: "MEDIUM" })
        .expect(201);
      await request(app.getHttpServer())
        .post("/api/v1/memory")
        .set(auth)
        .send({
          scope: "EMPLOYEE",
          employeeId: sourceId,
          category: "API_KEYS",
          key: "internal-secret",
          value: { apiKey: "sk-super-secret-do-not-share" },
          importance: "CRITICAL"
        })
        .expect(201);
      await request(app.getHttpServer())
        .post("/api/v1/memory")
        .set(auth)
        .send({ scope: "EMPLOYEE", employeeId: sourceId, category: "SCRATCH_NOTES", key: "unrelated-note", value: { note: "unrequested category, must not be shared" }, importance: "LOW" })
        .expect(201);
      await request(app.getHttpServer())
        .post("/api/v1/memory")
        .set(auth)
        .send({ scope: "USER", category: "PREFERENCE", key: "private-user-note", value: { secret: "private user note, never for delegation" }, importance: "MEDIUM" })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post("/api/v1/workforce/tasks")
        .set(auth)
        .send({
          sourceEmployeeInstallationId: sourceId,
          targetEmployeeInstallationId: targetId,
          taskType: "GENERAL_QUERY",
          objective: "Use my preferences to help",
          input: {},
          // Explicitly asks for API_KEYS too — the CRITICAL-importance filter must still block it.
          requestedMemoryCategories: ["PREFERENCE", "API_KEYS"]
        })
        .expect(201);
      const taskId = res.body.id as string;

      const task = await prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: taskId } });
      expect(task.instructions).toContain("Delta");
      expect(task.instructions).not.toContain("sk-super-secret-do-not-share");
      expect(task.instructions).not.toContain("unrequested category");
      expect(task.instructions).not.toContain("private user note");

      const collaborationContext = await prisma.memoryRecord.findFirst({
        where: { organizationId: orgId, employeeId: targetId, category: "DELEGATION_CONTEXT", key: `delegation-context:${taskId}` }
      });
      const context = requireDefined(collaborationContext, "collaborationContext missing");
      expect(context.expiresAt).not.toBeNull();
      const ttlMs = requireDefined(context.expiresAt, "expiresAt missing").getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(50 * 60 * 1000);
      expect(ttlMs).toBeLessThanOrEqual(60 * 60 * 1000 + 10_000);

      const targetFacts = JSON.stringify(context.value);
      expect(targetFacts).toContain("Delta");
      expect(targetFacts).not.toContain("sk-super-secret-do-not-share");
    });

    it("shares nothing at all when the source requests no memory categories", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/workforce/tasks")
        .set(auth)
        .send({ sourceEmployeeInstallationId: sourceId, targetEmployeeInstallationId: targetId, taskType: "GENERAL_QUERY", objective: "No memory requested", input: {} })
        .expect(201);
      const task = await prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(task.instructions).not.toContain("Shared context");
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Push-based approval resumption
  // -------------------------------------------------------------------------------------------

  describe("push-based approval resumption", () => {
    it("auto-resumes the delegated task and its parent workflow the instant an approval is decided — proven without ever calling GET (poll-on-read)", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/workforce/tasks")
        .set(auth)
        .send({
          sourceEmployeeInstallationId: sourceId,
          targetEmployeeInstallationId: targetId,
          taskType: "GENERAL_QUERY",
          objective: "Needs sign-off",
          input: {},
          constraints: { requiresApproval: true }
        })
        .expect(201);
      expect(res.body.status).toBe("WAITING_FOR_APPROVAL");
      const taskId = res.body.id as string;

      const raw = await prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: taskId } });
      expect(raw.approvalRequestId).toBeTruthy();
      expect(raw.parentWorkflowExecutionId).toBeTruthy();

      await request(app.getHttpServer()).post(`/api/v1/approvals/${raw.approvalRequestId}/approve`).send({ organizationId: orgId, userId: ownerId }).expect(201);

      // Deliberately never calls GET /workforce/tasks/:id (which would itself trigger the poll-on-read
      // fallback via syncFromApproval) — polls the raw table directly to isolate proof to the push path.
      const completed = await waitFor(async () => {
        const t = await prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: taskId } });
        return t.status === "COMPLETED" || t.status === "FAILED" ? t : null;
      }, 5000);
      expect(completed.status).toBe("COMPLETED");

      const workflow = await prisma.workflowExecution.findUniqueOrThrow({
        where: { id: requireDefined(completed.parentWorkflowExecutionId, "parentWorkflowExecutionId missing") }
      });
      expect(workflow.status).toBe("COMPLETED");
    });

    it("fails the delegated task automatically when the approval is rejected", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/workforce/tasks")
        .set(auth)
        .send({
          sourceEmployeeInstallationId: sourceId,
          targetEmployeeInstallationId: targetId,
          taskType: "GENERAL_QUERY",
          objective: "Needs sign-off, will be rejected",
          input: {},
          constraints: { requiresApproval: true }
        })
        .expect(201);
      const taskId = res.body.id as string;
      const raw = await prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: taskId } });

      await request(app.getHttpServer()).post(`/api/v1/approvals/${raw.approvalRequestId}/reject`).send({ organizationId: orgId, userId: ownerId }).expect(201);

      const failed = await waitFor(async () => {
        const t = await prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: taskId } });
        return t.status === "FAILED" ? t : null;
      }, 5000);
      expect(failed.errorCode).toBe("DELEGATION_NOT_ALLOWED");
    });
  });

  // -------------------------------------------------------------------------------------------
  // 5. Security hardening
  // -------------------------------------------------------------------------------------------

  describe("security hardening", () => {
    it("confused-deputy: rejects a delegation that asks the target to use a capability it does not itself hold", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/workforce/tasks")
        .set(auth)
        .send({
          sourceEmployeeInstallationId: sourceId,
          targetEmployeeInstallationId: targetId,
          taskType: "GENERAL_QUERY",
          targetCapability: "sensitive.wire_transfer",
          objective: "Try to borrow a capability the target does not have",
          input: {}
        })
        .expect(403);
      expect(res.body.error.code).toBe("WORKFORCE_CAPABILITY_NOT_GRANTED");
    });

    it("result-injection: validates the target's result before merging it — an incomplete result fails the task instead of completing it", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/workforce/tasks")
        .set(auth)
        .send({
          sourceEmployeeInstallationId: sourceId,
          targetEmployeeInstallationId: targetId,
          taskType: "GENERAL_QUERY",
          objective: "Return structured output the deterministic provider cannot actually produce",
          input: {},
          expectedOutput: { mustHaveField: "x" }
        })
        .expect(201);
      expect(res.body.status).toBe("FAILED");
      expect(res.body.errorCode).toBe("RESULT_SCHEMA_INVALID");

      const task = await prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(task.resultPayloadJson).toBeNull();
    });

    it("is tenant-isolated at the parallel-join level too — a second organization cannot read the first organization's join", async () => {
      const requests = [0, 1].map((i) => ({ targetEmployeeInstallationId: targetId, taskType: "GENERAL_QUERY", objective: `tenant-isolated child ${i}`, input: {} }));
      const join = await request(app.getHttpServer())
        .post("/api/v1/workforce/tasks/parallel")
        .set(auth)
        .send({ sourceEmployeeInstallationId: sourceId, requests, joinPolicy: "ALL_REQUIRED" })
        .expect(201);

      const otherEmail = `workforce-cap-other-${Date.now()}@example.com`;
      const registeredOther = await request(app.getHttpServer())
        .post("/api/v1/auth/register")
        .send({ organizationName: `Workforce Cap Other Org ${Date.now()}`, firstName: "Owner", email: otherEmail, password: "StrongPassword@123" })
        .expect(201);
      const otherAuth = { Authorization: `Bearer ${registeredOther.body.data.tokens.accessToken}` };

      await request(app.getHttpServer()).get(`/api/v1/workforce/joins/${join.body.correlationId}`).set(otherAuth).expect(404);
    });
  });
});
