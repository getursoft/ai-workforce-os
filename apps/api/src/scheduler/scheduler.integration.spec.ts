import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { SchedulerService } from "./scheduler.service";
import { JobLockService } from "./job-lock.service";
import { JobRegistry } from "./job-registry";
import { SchedulerHandlers } from "./scheduler-handlers";
import type { JobHandler } from "./scheduler.types";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("Sprint 4.8 Autonomous Scheduler", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let scheduler: SchedulerService;
  let locks: JobLockService;
  let registry: JobRegistry;
  let handlers: SchedulerHandlers;
  let orgA: { token: string; orgId: string; pluginId: string };
  let orgB: { token: string; orgId: string; pluginId: string };

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    await app.init();
    prisma = app.get(PrismaService);
    scheduler = app.get(SchedulerService);
    locks = app.get(JobLockService);
    registry = app.get(JobRegistry);
    handlers = app.get(SchedulerHandlers);

    await prisma.scheduledExecution.deleteMany();
    await prisma.scheduledJob.deleteMany();
    await prisma.jobLock.deleteMany();
    await prisma.memoryRecord.deleteMany();

    // The definition catalog + global templates are seeded by SchedulerService.onModuleInit above; keep
    // them (they are shared platform data), but make sure they exist before any test runs.
    await registry.ensureDefinitions();

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
      return { token, orgId, pluginId: installed.body.id as string };
    };
    orgA = await register("Scheduler Org A", "sched-a");
    orgB = await register("Scheduler Org B", "sched-b");
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.scheduledExecution.deleteMany();
      await prisma.scheduledJob.deleteMany();
      await prisma.jobLock.deleteMany();
      await prisma.memoryRecord.deleteMany();
    }
    await app?.close();
  });

  const tick = async (times = 1) => {
    for (let i = 0; i < times; i += 1) await scheduler.tick();
  };

  it("seeds the built-in definition catalog and templates at startup", async () => {
    const definitions = await prisma.jobDefinition.findMany();
    expect(definitions.length).toBeGreaterThan(10);
    const keys = definitions.map((d) => d.key);
    expect(keys).toContain("travel.reminder.pre_travel");
    expect(keys).toContain("hr.reminder.manager_approval");
    expect(keys).toContain("finance.reminder.invoice");
    expect(keys).toContain("legal.reminder.contract");
    expect(keys).toContain("sales.reminder.lead_followup");
    const templates = await prisma.jobTemplate.findMany();
    expect(templates.length).toBeGreaterThan(10);
  });

  it("creates a one-shot job, dispatches and completes it exactly once", async () => {
    const created = await scheduler.createOneShot({
      organizationId: orgA.orgId,
      definitionKey: "travel.reminder.pre_travel",
      triggerType: "ONE_TIME",
      payload: {
        kind: "travel.pre_travel",
        entityId: "booking-1",
        recipientName: "Krishna",
        travelDates: "12-15 Aug"
      },
      dedupeKey: `test:once:${Date.now()}`,
      createdBy: null
    });
    expect(created.status).toBe("ACTIVE");
    await tick();
    await tick(); // second pass runs the queued execution

    const executions = await prisma.scheduledExecution.findMany({ where: { jobId: created.id } });
    expect(executions.length).toBe(1);
    expect(executions[0]?.status).toBe("COMPLETED");
    expect(executions[0]?.attemptCount).toBe(1);
    const result = executions[0]?.result as { outcome?: string; delivered?: boolean } | null;
    expect(result?.outcome).toBe("sent");

    const finalJob = await prisma.scheduledJob.findUnique({ where: { id: created.id } });
    expect(finalJob?.status).toBe("COMPLETED");
    expect(finalJob?.nextRun).toBeNull();

    // Memory dedup record was written — a re-run of the same reminder must not resend.
    const dedup = await prisma.memoryRecord.findFirst({
      where: { organizationId: orgA.orgId, key: { contains: "scheduler.reminder.sent" } }
    });
    expect(dedup).not.toBeNull();
  });

  it("every job run generates a trace visible in the Trace Viewer (Phase 16)", async () => {
    const created = await scheduler.createOneShot({
      organizationId: orgA.orgId,
      definitionKey: "travel.reminder.booking_reminder",
      triggerType: "ONE_TIME",
      payload: { kind: "travel.booking_reminder", entityId: `trace-${Date.now()}` }
    });
    await tick(2);
    const [execution] = await prisma.scheduledExecution.findMany({ where: { jobId: created.id } });
    expect(execution?.status).toBe("COMPLETED");
    expect(execution?.traceId).toBeTruthy();
    const trace = await prisma.executionTrace.findFirst({
      where: { organizationId: orgA.orgId, traceId: execution?.traceId ?? "missing" }
    });
    expect(trace).not.toBeNull();
    expect(trace?.status).toBe("COMPLETED");
    const spans = await prisma.executionSpan.findMany({
      where: { organizationId: orgA.orgId, traceId: execution?.traceId ?? "missing" }
    });
    expect(spans.some((span) => span.spanType === "BACKGROUND_TASK")).toBe(true);
  });

  it("dedupeKey prevents duplicate one-shot schedules", async () => {
    const key = `test:dedupe:${Date.now()}`;
    const first = await scheduler.createOneShot({
      organizationId: orgA.orgId,
      definitionKey: "sales.reminder.lead_followup",
      triggerType: "ONE_TIME",
      payload: { kind: "sales.lead_followup", entityId: "lead-9" },
      dedupeKey: key
    });
    const second = await scheduler.createOneShot({
      organizationId: orgA.orgId,
      definitionKey: "sales.reminder.lead_followup",
      triggerType: "ONE_TIME",
      payload: { kind: "sales.lead_followup", entityId: "lead-9" },
      dedupeKey: key
    });
    expect(second.id).toBe(first.id);
    await tick(2);
    const executions = await prisma.scheduledExecution.findMany({ where: { jobId: first.id } });
    expect(executions.length).toBe(1);
  });

  it("two concurrent workers only ever create one execution per dispatch", async () => {
    const created = await scheduler.createOneShot({
      organizationId: orgA.orgId,
      definitionKey: "hr.reminder.manager_approval",
      triggerType: "ONE_TIME",
      payload: { kind: "hr.manager_approval", entityId: "leave-1" },
      dedupeKey: `test:concurrent:${Date.now()}`
    });
    const [a, b] = await Promise.all([
      scheduler["dispatcher"].publishDueJobs("worker-a"),
      scheduler["dispatcher"].publishDueJobs("worker-b")
    ]);
    expect(a + b).toBe(1);
    const executions = await prisma.scheduledExecution.findMany({ where: { jobId: created.id } });
    expect(executions.length).toBe(1);
    await tick(2); // consume the published execution so it doesn't pollute the shared queue
  });

  it("executions are claimed in priority order (CRITICAL before LOW)", async () => {
    const low = await scheduler.createOneShot({
      organizationId: orgA.orgId,
      definitionKey: "sales.reminder.proposal",
      triggerType: "ONE_TIME",
      priority: "LOW",
      payload: { kind: "sales.proposal", entityId: "p-low" }
    });
    const critical = await scheduler.createOneShot({
      organizationId: orgA.orgId,
      definitionKey: "sales.reminder.proposal",
      triggerType: "ONE_TIME",
      priority: "CRITICAL",
      payload: { kind: "sales.proposal", entityId: "p-critical" }
    });
    await tick(2);
    const [lowExec] = await prisma.scheduledExecution.findMany({ where: { jobId: low.id } });
    const [criticalExec] = await prisma.scheduledExecution.findMany({
      where: { jobId: critical.id }
    });
    expect(criticalExec?.status).toBe("COMPLETED");
    expect(lowExec?.status).toBe("COMPLETED");
    // CRITICAL was dispatched first, so it started first.
    expect(new Date(criticalExec?.startedAt ?? 0).getTime()).toBeLessThanOrEqual(
      new Date(lowExec?.startedAt ?? 0).getTime()
    );
  });

  it("multi-tenant isolation: schedules never leak between organizations", async () => {
    const job = await scheduler.createOneShot({
      organizationId: orgA.orgId,
      definitionKey: "legal.reminder.contract",
      triggerType: "ONE_TIME",
      payload: { kind: "legal.contract", entityId: "contract-a" }
    });
    const orgAList = await scheduler.listJobs(orgA.orgId);
    const orgBList = await scheduler.listJobs(orgB.orgId);
    expect(orgAList.items.some((item) => item.id === job.id)).toBe(true);
    expect(orgBList.items.some((item) => item.id === job.id)).toBe(false);
    // Firing an event in org A never dispatches org B's identical job.
    const orgBJob = await scheduler.createSchedule({
      organizationId: orgB.orgId,
      definitionKey: "scheduler.booking_approved_followup",
      triggerType: "AFTER_BOOKING",
      payload: { eventName: "booking.approved" }
    });
    scheduler.emitEvent({
      name: "booking.approved",
      organizationId: orgA.orgId,
      entityType: "TRAVEL_BOOKING",
      entityId: "booking-org-a",
      occurredAt: new Date()
    });
    await tick(2);
    const orgBExecutions = await prisma.scheduledExecution.findMany({
      where: { jobId: orgBJob.id }
    });
    expect(orgBExecutions.length).toBe(0);
  });

  it("retries a failing job with exponential backoff and dead-letters after maxRetry", async () => {
    const failing: JobHandler = {
      key: "test.failing",
      handlerType: "SEND_REMINDER",
      execute: async () => ({
        success: false,
        errorCode: "TEST_FAILURE",
        errorMessage: "intentional failure"
      })
    };
    await prisma.jobDefinition.upsert({
      where: { key: "test.failing" },
      create: {
        key: "test.failing",
        name: "Test failing job",
        description: "",
        category: "PLATFORM",
        handlerType: "SEND_REMINDER",
        retryPolicy: "2_MIN",
        maxRetry: 2,
        timeoutMs: 5_000,
        enabled: true
      },
      update: { retryPolicy: "2_MIN", maxRetry: 2 }
    });
    registry.register({ "test.failing": failing });

    const created = await scheduler.createOneShot({
      organizationId: orgA.orgId,
      definitionKey: "test.failing",
      triggerType: "ONE_TIME",
      payload: { kind: "test.failing", entityId: "x" }
    });
    await tick(); // attempt 1 fails → scheduled for retry with exponential backoff
    const afterFirst = await prisma.scheduledExecution.findMany({ where: { jobId: created.id } });
    expect(afterFirst[0]?.status).toBe("RETRYING");
    expect(afterFirst[0]?.attemptCount).toBe(2);
    expect(afterFirst[0]?.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now());

    // Simulate the backoff window elapsing and drive attempts 2 + 3.
    await prisma.scheduledExecution.updateMany({
      where: { id: afterFirst[0]?.id ?? "missing" },
      data: { nextAttemptAt: new Date() }
    });
    await tick();
    const afterSecond = await prisma.scheduledExecution.findMany({ where: { jobId: created.id } });
    expect(afterSecond[0]?.status).toBe("RETRYING");
    expect(afterSecond[0]?.attemptCount).toBe(3);

    await prisma.scheduledExecution.updateMany({
      where: { id: afterSecond[0]?.id ?? "missing" },
      data: { nextAttemptAt: new Date() }
    });
    await tick();
    const final = await prisma.scheduledExecution.findMany({ where: { jobId: created.id } });
    expect(final[0]?.status).toBe("DEAD_LETTERED");
    expect(final[0]?.attemptCount).toBe(3);
  });

  it("recovers abandoned RUNNING executions after a worker crash", async () => {
    const created = await scheduler.createOneShot({
      organizationId: orgA.orgId,
      definitionKey: "sales.reminder.proposal",
      triggerType: "ONE_TIME",
      payload: { kind: "sales.proposal", entityId: "abandoned" }
    });
    const oldStartedAt = new Date(Date.now() - 3 * 60_000);
    await prisma.scheduledExecution.create({
      data: {
        organizationId: orgA.orgId,
        jobId: created.id,
        definitionKey: "sales.reminder.proposal",
        triggerType: "ONE_TIME",
        priority: "NORMAL",
        status: "RUNNING",
        scheduledFor: new Date(),
        startedAt: oldStartedAt,
        workerId: "crashed-worker"
      }
    });
    await scheduler.tick();
    const recovered = await prisma.scheduledExecution.findFirst({
      where: { jobId: created.id, workerId: "crashed-worker" }
    });
    expect(recovered?.status).toBe("FAILED");
    expect(recovered?.errorCode).toBe("WORKER_CRASH");
  });

  it("worker B cannot steal an active lock, but recovers an expired one", async () => {
    const created = await scheduler.createOneShot({
      organizationId: orgA.orgId,
      definitionKey: "sales.reminder.proposal",
      triggerType: "ONE_TIME",
      payload: { kind: "sales.proposal", entityId: "lock" }
    });
    const acquiredA = await locks.acquire(created.id, orgA.orgId, "worker-a", 60_000);
    expect(acquiredA).toBe(true);
    const acquiredB = await locks.acquire(created.id, orgA.orgId, "worker-b", 60_000);
    expect(acquiredB).toBe(false);
    // Lease expires → worker B can steal it.
    await prisma.jobLock.updateMany({
      where: { jobId: created.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) }
    });
    const stolenB = await locks.acquire(created.id, orgA.orgId, "worker-b", 60_000);
    expect(stolenB).toBe(true);
    await locks.release(created.id, "worker-b");
  });

  it("event-driven AFTER_BOOKING job runs automatically when booking.approved fires", async () => {
    const job = await scheduler.createSchedule({
      organizationId: orgA.orgId,
      definitionKey: "scheduler.booking_approved_followup",
      triggerType: "AFTER_BOOKING",
      payload: { eventName: "booking.approved", kind: "booking_approved", recipientName: "Krishna" }
    });
    scheduler.emitEvent({
      name: "booking.approved",
      organizationId: orgA.orgId,
      employeeId: orgA.pluginId,
      entityType: "TRAVEL_BOOKING",
      entityId: `booking-ev-${Date.now()}`,
      occurredAt: new Date()
    });
    await tick(2);
    const executions = await prisma.scheduledExecution.findMany({ where: { jobId: job.id } });
    expect(executions.length).toBeGreaterThan(0);
    expect(executions.some((e) => e.status === "COMPLETED")).toBe(true);
  });

  it("pending approval scan schedules exactly one reminder per approval (Phase 13)", async () => {
    const conversation = await prisma.conversation.create({
      data: {
        organizationId: orgA.orgId,
        pluginInstallationId: orgA.pluginId,
        title: "approval reminder test"
      }
    });
    const workflow = await prisma.workflowExecution.create({
      data: {
        organizationId: orgA.orgId,
        pluginInstallationId: orgA.pluginId,
        conversationId: conversation.id,
        workflowType: "CONTACT_CAPTURE",
        status: "ACTIVE",
        currentStep: "TEST",
        state: {},
        activeKey: `approval-test-${Date.now()}`
      }
    });
    const approval = await prisma.approvalRequest.create({
      data: {
        organizationId: orgA.orgId,
        workflowExecutionId: workflow.id,
        agentId: orgA.pluginId,
        actionType: "LEAVE",
        requesterType: "EMPLOYEE",
        requestedBy: "employee@example.com",
        status: "PENDING",
        title: "Approve leave",
        description: "Pending leave approval",
        approverType: "MANAGER",
        expiresAt: new Date(Date.now() + 86_400_000)
      }
    });

    const result = await handlers.execute("PENDING_APPROVAL_SCAN", {
      organizationId: orgA.orgId,
      jobId: "scan-job",
      executionId: "scan-exec",
      definitionKey: "scheduler.pending_approval_scan",
      triggerType: "INTERVAL",
      priority: "NORMAL",
      employeeId: orgA.pluginId,
      payload: { reminderDefinitionKey: "hr.reminder.manager_approval", entityId: approval.id },
      context: {},
      timezone: "UTC",
      traceId: null,
      attemptCount: 1
    });
    expect((result.result as { scheduled?: number })?.scheduled).toBe(1);

    await tick(2);
    const reminders = await prisma.scheduledJob.findMany({
      where: { dedupeKey: `scheduler:approval-reminder:${approval.id}` }
    });
    expect(reminders.length).toBe(1);
    const reminderId = reminders[0]?.id;
    expect(reminderId).toBeTruthy();
    const reminderRuns = await prisma.scheduledExecution.findMany({
      where: { jobId: reminderId ?? "missing" }
    });
    expect(reminderRuns.some((e) => e.status === "COMPLETED")).toBe(true);
  });

  it("templates can be listed and instantiated into active schedules", async () => {
    const templates = await scheduler.listTemplates(orgA.orgId);
    expect(templates.length).toBeGreaterThan(10);
    const monthly = templates.find((t) => t.name === "Monthly report");
    expect(monthly).toBeDefined();
    const monthlyId = (monthly as { id: string }).id;
    const instantiated = await scheduler.instantiateTemplate(orgA.orgId, monthlyId, {
      timezone: "UTC",
      createdBy: null
    });
    expect(instantiated.status).toBe("ACTIVE");
    expect(instantiated.triggerType).toBe("MONTHLY");
    expect(instantiated.nextRun).not.toBeNull();
  });

  it("reports overview + worker health (Phase 9/10)", async () => {
    const overview = await scheduler.overview(orgA.orgId);
    expect(overview.totalJobs).toBeGreaterThan(0);
    expect(overview.activeJobs).toBeGreaterThan(0);
    expect(typeof overview.averageDurationMs).toBe("number");
    expect(overview.worker.workerId).toBeTruthy();
    expect(overview.worker.status).toBeTruthy();
    expect(Array.isArray(overview.upcomingJobs)).toBe(true);
  });

  it("REST API exposes scheduler endpoints under scheduler.read", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/scheduler/overview")
      .set("Authorization", `Bearer ${orgA.token}`)
      .expect(200);
    expect(res.body).toHaveProperty("totalJobs");
    expect(res.body).toHaveProperty("worker");

    const jobsRes = await request(app.getHttpServer())
      .get("/api/v1/scheduler/jobs")
      .set("Authorization", `Bearer ${orgA.token}`)
      .expect(200);
    expect(Array.isArray(jobsRes.body.items)).toBe(true);

    const templatesRes = await request(app.getHttpServer())
      .get("/api/v1/scheduler/templates")
      .set("Authorization", `Bearer ${orgA.token}`)
      .expect(200);
    expect(Array.isArray(templatesRes.body)).toBe(true);
  });

  it("REST API enforces RBAC (scheduler.read denied without permission)", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/scheduler/overview").expect(401);
    expect(res.status).toBe(401);
  });
});
