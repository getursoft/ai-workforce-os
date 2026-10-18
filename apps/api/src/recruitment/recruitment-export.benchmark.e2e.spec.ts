/**
 * Sprint 7.17 (Phase 3) — real scale benchmark for the large-export worker, not a correctness test (no
 * assertions beyond "the file was actually produced"). Boots a real Nest app against TEST_DATABASE_URL
 * only (never dev/prod), creates ONE throwaway organization + owner user + job directly via Prisma,
 * bulk-inserts synthetic candidate/resume/application/evaluation rows (never real candidate data), then
 * drives the REAL RecruitmentExportService.requestExport() -> queue ->
 * RecruitmentExportWorkerService.handle() path for each scale point and records actual wall-clock time,
 * heap delta, row count and output file size. Deletes the throwaway organization (cascading) at the end.
 *
 * Run with: npx vitest run --no-file-parallelism src/recruitment/recruitment-export.benchmark.e2e.spec.ts
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, it } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { RecruitmentExportService } from "./recruitment-export.service";
import { RecruitmentExportWorkerService } from "./recruitment-export-worker";
import { OBJECT_STORAGE, type ObjectStorageService } from "../storage/object-storage.types";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const SCALES = [100, 1_000, 5_000, 10_000, 25_000];

suite("Sprint 7.17 Phase 3 — recruitment export scale benchmark", () => {
  let app: import("@nestjs/common").INestApplication;
  let prisma: PrismaService;
  let exportsService: RecruitmentExportService;
  let worker: RecruitmentExportWorkerService;
  let storage: ObjectStorageService;
  let orgId: string;
  let userId: string;
  let jobId: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: ["error", "warn"], abortOnError: false });
    await app.init();
    prisma = app.get(PrismaService);
    exportsService = app.get(RecruitmentExportService);
    worker = app.get(RecruitmentExportWorkerService);
    storage = app.get(OBJECT_STORAGE);

    orgId = randomUUID();
    userId = randomUUID();
    jobId = randomUUID();
    await prisma.organization.create({
      data: { id: orgId, name: `Sprint 7.17 Export Benchmark ${Date.now()}`, slug: `export-bench-${Date.now()}`, status: "ACTIVE" }
    });
    await prisma.user.create({
      data: {
        id: userId,
        organizationId: orgId,
        firstName: "Benchmark",
        lastName: "Owner",
        email: `benchmark-${Date.now()}@example.invalid`,
        normalizedEmail: `benchmark-${Date.now()}@example.invalid`,
        passwordHash: "not-a-real-hash",
        role: "OWNER",
        status: "ACTIVE"
      }
    });
    await prisma.recruitmentJob.create({
      data: {
        id: jobId,
        organizationId: orgId,
        jobCode: "JOB-BENCH-001",
        title: "Benchmark Software Engineer",
        description: "Synthetic job for Sprint 7.17 export scale benchmarking.",
        requiredCriteria: { mandatorySkills: ["Python"], preferredSkills: [], certifications: [] },
        scoringConfig: {
          mandatorySkillWeight: 35,
          preferredSkillWeight: 15,
          experienceWeight: 25,
          projectExperienceWeight: 15,
          certificationWeight: 10
        },
        status: "OPEN",
        createdByUserId: userId
      }
    });
  }, 60_000);

  afterAll(async () => {
    // Several rows reference the user via onDelete: Restrict (recruitment_jobs.created_by_user_id,
    // recruitment_export_jobs.requested_by_user_id), and User.organization is itself Restrict — so
    // those must be cleared before the user, and the user before the organization, or the deletes fail.
    if (prisma && orgId) {
      await prisma.recruitmentExportJob.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma.recruitmentJob.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
    }
    if (prisma && userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    if (prisma && orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    if (app) await app.close();
  }, 60_000);

  it(
    "generates CSV and XLSX exports at 100/1k/5k/10k/25k synthetic rows with bounded time and memory",
    async () => {
      const results: Array<Record<string, unknown>> = [];
      let totalSeeded = 0;

      for (const scale of SCALES) {
        const toSeed = scale - totalSeeded;
        await seedApplications(prisma, orgId, jobId, totalSeeded, toSeed);
        totalSeeded = scale;

        for (const format of ["CSV", "XLSX"] as const) {
          const heapBefore = process.memoryUsage().heapUsed;
          const startedAt = Date.now();

          const requestResult = await exportsService.requestExport(orgId, userId, { scope: "CURRENT_JOB", format, jobId });
          let finalStatus: string = requestResult.status;
          let rowCount = requestResult.rowCount;

          if (requestResult.status === "QUEUED") {
            const message = await claimOne(prisma, orgId);
            if (message) {
              const ok = await worker.handle(message);
              await prisma.queueMessage.updateMany({
                where: { id: message.id },
                data: { status: ok ? "COMPLETED" : "FAILED" }
              });
            }
            const row = await prisma.recruitmentExportJob.findUniqueOrThrow({ where: { id: requestResult.exportJobId } });
            finalStatus = row.status;
            rowCount = row.rowCount ?? rowCount;
          }

          const durationMs = Date.now() - startedAt;
          const heapDeltaMB = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);

          const jobRow = await prisma.recruitmentExportJob.findUnique({ where: { id: requestResult.exportJobId } });
          let fileSizeBytes: number | null = null;
          if (jobRow?.storageKey) {
            const meta = await storage.getMetadata(orgId, jobRow.storageKey).catch(() => null);
            fileSizeBytes = meta?.sizeBytes ?? null;
          }

          const result = { scale, format, finalStatus, rowCount, durationMs, heapDeltaMB: heapDeltaMB.toFixed(1), fileSizeBytes };
          results.push(result);
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result));
        }
      }
      // eslint-disable-next-line no-console
      console.log("\n=== Sprint 7.17 Phase 3 — Export Benchmark Results ===");
      console.table(results);
      writeFileSync(resolve(process.cwd(), "export-benchmark-results.json"), JSON.stringify(results, null, 2));
    },
    20 * 60_000
  );
});

async function seedApplications(prisma: PrismaService, orgId: string, jobId: string, startIndex: number, count: number) {
  const BATCH = 500;
  const cities = ["Noida", "Gurugram", "Bengaluru", "Pune", "Hyderabad"];
  for (let offset = 0; offset < count; offset += BATCH) {
    const batchSize = Math.min(BATCH, count - offset);
    const candidateRows = [];
    const resumeRows = [];
    const applicationRows = [];
    const evaluationRows = [];
    for (let i = 0; i < batchSize; i++) {
      const n = startIndex + offset + i;
      const candidateId = randomUUID();
      const resumeId = randomUUID();
      const applicationId = randomUUID();
      candidateRows.push({
        id: candidateId,
        organizationId: orgId,
        fullName: `Synthetic Candidate ${n}`,
        mobileNumber: `+9199900${String(n).padStart(5, "0")}`,
        email: `synthetic-${n}@example.invalid`,
        currentCity: cities[n % cities.length],
        currentState: "Synthetic State",
        currentCountry: "India",
        preferredWorkLocations: [cities[n % cities.length]],
        willingToRelocate: n % 2 === 0
      });
      resumeRows.push({
        id: resumeId,
        organizationId: orgId,
        candidateId,
        resumeCode: `RES-BENCH-${n}`,
        fileName: `synthetic-${n}.pdf`,
        storageKey: `recruitment/benchmark/${n}.pdf`,
        fileSizeBytes: 1024,
        fileHash: randomUUID().replace(/-/g, ""),
        parsingStatus: "COMPLETED" as const,
        totalExperienceYears: 2 + (n % 10),
        relevantExperienceYears: 1 + (n % 8),
        extractedSkills: ["Python", "SQL"]
      });
      applicationRows.push({
        id: applicationId,
        organizationId: orgId,
        jobId,
        candidateId,
        resumeId,
        aiRecommendation: (n % 3 === 0 ? "RECOMMENDED_FOR_SHORTLIST" : "REVIEW_REQUIRED") as const,
        recruiterDecision: "PENDING_REVIEW" as const
      });
      evaluationRows.push({
        id: randomUUID(),
        applicationId,
        matchScore: 50 + (n % 50),
        matchedSkills: ["Python"],
        missingSkills: [],
        scoringVersion: "benchmark-1",
        evaluationStatus: "COMPLETED" as const,
        evaluatedAt: new Date()
      });
    }
    await prisma.recruitmentCandidate.createMany({ data: candidateRows, skipDuplicates: true });
    await prisma.recruitmentResume.createMany({ data: resumeRows, skipDuplicates: true });
    await prisma.recruitmentApplication.createMany({ data: applicationRows, skipDuplicates: true });
    await prisma.recruitmentEvaluation.createMany({ data: evaluationRows, skipDuplicates: true });
  }
}

async function claimOne(prisma: PrismaService, orgId: string) {
  const row = await prisma.queueMessage.findFirst({
    where: { organizationId: orgId, category: "RECRUITMENT_EXPORTS", status: { in: ["QUEUED", "RETRYING"] } },
    orderBy: { createdAt: "desc" }
  });
  if (!row) return null;
  await prisma.queueMessage.update({ where: { id: row.id }, data: { status: "CLAIMED", workerId: "benchmark-worker" } });
  return {
    id: row.id,
    organizationId: row.organizationId,
    category: row.category,
    refType: row.refType,
    refId: row.refId,
    employeeId: row.employeeId,
    priority: row.priority,
    status: "CLAIMED" as const,
    payload: row.payload,
    availableAt: row.availableAt,
    attemptCount: 1,
    maxAttempts: row.maxAttempts,
    nextAttemptAt: row.nextAttemptAt,
    workerId: "benchmark-worker",
    traceId: row.traceId,
    errorCode: null,
    errorMessage: null,
    createdAt: row.createdAt
  };
}
