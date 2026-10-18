/**
 * Sprint 7.17 (Phase 3) — real end-to-end coverage for RecruitmentExportWorkerService: the drain path
 * for RecruitmentExportJob rows marked QUEUED by RecruitmentExportService once a request exceeds
 * SYNCHRONOUS_ROW_CAP. Real NestFactory app + real Postgres (TEST_DATABASE_URL only), synthetic rows
 * (never real candidate data), same convention as recruitment.e2e.spec.ts.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { RecruitmentExportService } from "./recruitment-export.service";
import { RecruitmentExportWorkerService } from "./recruitment-export-worker";
import type { QueueMessageView } from "../queue/queue.types";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("RecruitmentExportWorkerService — real end-to-end", () => {
  let app: import("@nestjs/common").INestApplication;
  let prisma: PrismaService;
  let exportsService: RecruitmentExportService;
  let worker: RecruitmentExportWorkerService;
  let orgId: string;
  let userId: string;
  let jobId: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: ["error", "warn"], abortOnError: false });
    await app.init();
    prisma = app.get(PrismaService);
    exportsService = app.get(RecruitmentExportService);
    worker = app.get(RecruitmentExportWorkerService);
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
  }, 30_000);

  async function freshOrgWithJob() {
    const org = randomUUID();
    const user = randomUUID();
    const job = randomUUID();
    await prisma.organization.create({
      data: { id: org, name: `Export Worker Test ${Date.now()}`, slug: `export-worker-${Date.now()}-${org.slice(0, 8)}`, status: "ACTIVE" }
    });
    await prisma.user.create({
      data: {
        id: user,
        organizationId: org,
        firstName: "Test",
        lastName: "Owner",
        email: `export-worker-${Date.now()}@example.invalid`,
        normalizedEmail: `export-worker-${Date.now()}-${org.slice(0, 8)}@example.invalid`,
        passwordHash: "not-a-real-hash",
        role: "OWNER",
        status: "ACTIVE"
      }
    });
    await prisma.recruitmentJob.create({
      data: {
        id: job,
        organizationId: org,
        jobCode: "JOB-WORKER-TEST",
        title: "Export Worker Test Job",
        description: "Synthetic job for export worker e2e coverage.",
        requiredCriteria: { mandatorySkills: [], preferredSkills: [], certifications: [] },
        scoringConfig: { mandatorySkillWeight: 35, preferredSkillWeight: 15, experienceWeight: 25, projectExperienceWeight: 15, certificationWeight: 10 },
        status: "OPEN",
        createdByUserId: user
      }
    });
    return { org, user, job };
  }

  async function seed(org: string, job: string, count: number) {
    for (let i = 0; i < count; i++) {
      const candidateId = randomUUID();
      const resumeId = randomUUID();
      await prisma.recruitmentCandidate.create({
        data: { id: candidateId, organizationId: org, fullName: `Candidate ${i}`, currentCity: "Noida" }
      });
      await prisma.recruitmentResume.create({
        data: {
          id: resumeId,
          organizationId: org,
          candidateId,
          resumeCode: `RES-W-${randomUUID().slice(0, 20)}`,
          fileName: `r${i}.pdf`,
          storageKey: `recruitment/worker-test/${i}.pdf`,
          fileSizeBytes: 1024,
          fileHash: randomUUID().replace(/-/g, ""),
          parsingStatus: "COMPLETED",
          totalExperienceYears: 3,
          relevantExperienceYears: 2,
          extractedSkills: ["Python"]
        }
      });
      await prisma.recruitmentApplication.create({
        data: { organizationId: org, jobId: job, candidateId, resumeId, recruiterDecision: "PENDING_REVIEW" }
      });
    }
  }

  async function claim(org: string): Promise<QueueMessageView | null> {
    const row = await prisma.queueMessage.findFirst({
      where: { organizationId: org, category: "RECRUITMENT_EXPORTS", status: { in: ["QUEUED", "RETRYING"] } },
      orderBy: { createdAt: "desc" }
    });
    if (!row) return null;
    await prisma.queueMessage.update({ where: { id: row.id }, data: { status: "CLAIMED", workerId: "test-worker" } });
    return {
      id: row.id,
      organizationId: row.organizationId,
      category: row.category,
      refType: row.refType,
      refId: row.refId,
      employeeId: row.employeeId,
      priority: row.priority,
      status: "CLAIMED",
      payload: row.payload,
      availableAt: row.availableAt,
      attemptCount: 1,
      maxAttempts: row.maxAttempts,
      nextAttemptAt: row.nextAttemptAt,
      workerId: "test-worker",
      traceId: row.traceId,
      errorCode: null,
      errorMessage: null,
      createdAt: row.createdAt
    };
  }

  const createdOrgIds: string[] = [];
  afterEach(async () => {
    for (const org of createdOrgIds.splice(0)) {
      await prisma.recruitmentExportJob.deleteMany({ where: { organizationId: org } }).catch(() => undefined);
      await prisma.recruitmentJob.deleteMany({ where: { organizationId: org } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { organizationId: org } }).catch(() => undefined);
      await prisma.organization.delete({ where: { id: org } }).catch(() => undefined);
    }
  });

  it("regression: a synchronous export over the query service's 100-row page size still returns every row", async () => {
    const { org, user, job } = await freshOrgWithJob();
    createdOrgIds.push(org);
    await seed(org, job, 250); // > RecruitmentCandidateQueryService's MAX_LIMIT (100), spans 3 pages
    // Sprint 7.17's scale benchmark caught this exact case returning only 100 rows (the synchronous path
    // used to make one query() call with limit: SYNCHRONOUS_ROW_CAP, which the query service silently
    // clamped to 100) — this is 250 rows, well under SYNCHRONOUS_ROW_CAP (5000), so it takes the
    // synchronous path, and must still come back complete.
    const requested = await exportsService.requestExport(org, user, { scope: "CURRENT_JOB", format: "CSV", jobId: job });
    expect(requested.status).toBe("COMPLETED");
    expect(requested.rowCount).toBe(250);
  });

  it("the worker completes a directly-queued export job end to end with the correct row count", async () => {
    const { org, user, job } = await freshOrgWithJob();
    createdOrgIds.push(org);
    await seed(org, job, 250);

    const exportJob = await prisma.recruitmentExportJob.create({
      data: { organizationId: org, requestedByUserId: user, jobId: job, scope: "CURRENT_JOB", format: "XLSX", status: "QUEUED", rowCount: 250 }
    });
    const queued = await prisma.queueMessage.create({
      data: {
        organizationId: org,
        category: "RECRUITMENT_EXPORTS",
        refType: "RecruitmentExportJob",
        refId: exportJob.id,
        status: "QUEUED",
        payload: {},
        availableAt: new Date(),
        maxAttempts: 5,
        visibilityMs: 60_000
      }
    });
    const message = await claim(org);
    expect(message?.id).toBe(queued.id);
    const ok = await worker.handle(message!);
    expect(ok).toBe(true);

    const finished = await prisma.recruitmentExportJob.findUniqueOrThrow({ where: { id: exportJob.id } });
    expect(finished.status).toBe("COMPLETED");
    expect(finished.rowCount).toBe(250);
    expect(finished.storageKey).toBeTruthy();
    expect(finished.downloadToken).toBeTruthy();

    const url = await exportsService.getDownloadUrl(org, exportJob.id, finished.downloadToken!, user);
    expect(url).toBeTruthy();
  });

  it("is idempotent: handling an already-COMPLETED export job again is a safe no-op", async () => {
    const { org, user, job } = await freshOrgWithJob();
    createdOrgIds.push(org);
    const exportJob = await prisma.recruitmentExportJob.create({
      data: {
        organizationId: org,
        requestedByUserId: user,
        jobId: job,
        scope: "CURRENT_JOB",
        format: "CSV",
        status: "COMPLETED",
        rowCount: 10,
        storageKey: "recruitment/exports/already-done.csv",
        downloadToken: "existing-token"
      }
    });
    const message: QueueMessageView = {
      id: randomUUID(),
      organizationId: org,
      category: "RECRUITMENT_EXPORTS",
      refType: "RecruitmentExportJob",
      refId: exportJob.id,
      employeeId: null,
      priority: 0,
      status: "CLAIMED",
      payload: {},
      availableAt: new Date(),
      attemptCount: 1,
      maxAttempts: 5,
      nextAttemptAt: null,
      workerId: "test-worker",
      traceId: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date()
    };
    const ok = await worker.handle(message);
    expect(ok).toBe(true);
    const unchanged = await prisma.recruitmentExportJob.findUniqueOrThrow({ where: { id: exportJob.id } });
    expect(unchanged.downloadToken).toBe("existing-token"); // not regenerated
  });

  it("respects a cancellation requested before the worker picks up the job", async () => {
    const { org, user, job } = await freshOrgWithJob();
    createdOrgIds.push(org);
    const exportJob = await prisma.recruitmentExportJob.create({
      data: { organizationId: org, requestedByUserId: user, jobId: job, scope: "CURRENT_JOB", format: "CSV", status: "CANCELLED", rowCount: 0 }
    });
    const message: QueueMessageView = {
      id: randomUUID(),
      organizationId: org,
      category: "RECRUITMENT_EXPORTS",
      refType: "RecruitmentExportJob",
      refId: exportJob.id,
      employeeId: null,
      priority: 0,
      status: "CLAIMED",
      payload: {},
      availableAt: new Date(),
      attemptCount: 1,
      maxAttempts: 5,
      nextAttemptAt: null,
      workerId: "test-worker",
      traceId: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date()
    };
    const ok = await worker.handle(message);
    expect(ok).toBe(true);
    const unchanged = await prisma.recruitmentExportJob.findUniqueOrThrow({ where: { id: exportJob.id } });
    expect(unchanged.status).toBe("CANCELLED"); // never flipped to PROCESSING/COMPLETED
    expect(unchanged.storageKey).toBeNull();
  });

  it("handling a message for a export job row that no longer exists is a safe no-op, not a false failure", async () => {
    const { org } = await freshOrgWithJob();
    createdOrgIds.push(org);
    const ghostMessage: QueueMessageView = {
      id: randomUUID(),
      organizationId: org,
      category: "RECRUITMENT_EXPORTS",
      refType: "RecruitmentExportJob",
      refId: randomUUID(), // no matching RecruitmentExportJob row
      employeeId: null,
      priority: 0,
      status: "CLAIMED",
      payload: {},
      availableAt: new Date(),
      attemptCount: 5,
      maxAttempts: 5,
      nextAttemptAt: null,
      workerId: "test-worker",
      traceId: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date()
    };
    const ok = await worker.handle(ghostMessage);
    expect(ok).toBe(true); // missing row => handled, not a failure
  });

  it("cancelExport only allows cancelling a QUEUED/PROCESSING job, never a COMPLETED one", async () => {
    const { org, user, job } = await freshOrgWithJob();
    createdOrgIds.push(org);

    const queuedJob = await prisma.recruitmentExportJob.create({
      data: { organizationId: org, requestedByUserId: user, jobId: job, scope: "CURRENT_JOB", format: "CSV", status: "QUEUED", rowCount: 9000 }
    });
    const cancelled = await exportsService.cancelExport(org, queuedJob.id, user);
    expect(cancelled.status).toBe("CANCELLED");

    const completedJob = await prisma.recruitmentExportJob.create({
      data: {
        organizationId: org,
        requestedByUserId: user,
        jobId: job,
        scope: "CURRENT_JOB",
        format: "CSV",
        status: "COMPLETED",
        rowCount: 10,
        storageKey: "recruitment/exports/done.csv",
        downloadToken: "tok"
      }
    });
    await expect(exportsService.cancelExport(org, completedJob.id, user)).rejects.toThrow();
  });
});
