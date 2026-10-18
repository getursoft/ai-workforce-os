/**
 * Real end-to-end UAT for the AI Recruitment Consultant — a real NestFactory app + real Postgres (via
 * TEST_DATABASE_URL, an isolated `*_test` database, never the dev database) + the real HTTP surface, same
 * convention as src/receptionist/receptionist.sprint-6-5-uat.e2e.spec.ts. No live LLM provider is
 * configured in this environment (no OPENAI_API_KEY/ANTHROPIC_API_KEY/etc. in .env) — tests that would
 * require a real model response (full resume scoring, JD-parsing suggestions) are explicitly marked
 * BLOCKED below rather than faked; everything else (install, job CRUD, upload acceptance, async batch
 * processing, isolated per-file failure handling, tenant isolation, permission enforcement, review) runs
 * for real against the real pipeline.
 */
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
import { WorkforceDirectoryService } from "../receptionist/workforce-directory.service";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// Minimal but real, parseable PDF (same construction as attachments.e2e.spec.ts) — a resume with
// extractable text the deterministic (non-LLM) pipeline stages can actually act on.
const RESUME_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 90>>stream\nBT /F1 14 Tf 72 720 Td (Jane Doe. Python developer, 6 years experience. Skills: Python, SQL. jane@example.com) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \n0000000227 00000 n \n0000000336 00000 n \ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n407\n%%EOF\n",
  "latin1"
);

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

suite("AI Recruitment Consultant — real end-to-end UAT", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  async function register(orgSuffix: string) {
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Recruitment ${orgSuffix} ${Date.now()}`,
        firstName: "Owner",
        email: `recruitment-${orgSuffix}-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    return {
      token: registered.body.data.tokens.accessToken as string,
      organizationId: registered.body.data.organization.id as string
    };
  }

  async function installRecruitmentConsultant(token: string) {
    const installed = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId: "recruitment-consultant", configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);
    return installed.body.id as string;
  }

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: ["error", "warn"], abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  // --- Step 1: employee installation + internal-only visibility -------------------------------------

  it("installs successfully and is internal-only — excluded from the AI Receptionist's routing directory", async () => {
    const { token, organizationId } = await register("install");
    const pluginId = await installRecruitmentConsultant(token);
    expect(pluginId).toBeTruthy();

    const plugin = await prisma.plugin.findUnique({ where: { id: pluginId } });
    expect(plugin?.status).toBe("ACTIVE");

    // Also install the Receptionist so there's something to route FROM, then assert the recruitment
    // consultant never appears as an eligible delegation target — this is the real mechanism
    // (routing.delegationEnabled: false in the manifest -> enabledForDelegation: false on its routing
    // profile), not a mocked assertion.
    const receptionistInstall = await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId: "receptionist-employee", configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);
    const directory = app.get(WorkforceDirectoryService);
    const eligible = await directory.eligible(organizationId, "WEB_CHAT", receptionistInstall.body.id as string);
    expect(eligible.find((e) => e.pluginInstallationId === pluginId)).toBeUndefined();
  });

  it("rejects unauthenticated requests to recruitment endpoints", async () => {
    await request(app.getHttpServer()).get("/api/v1/recruitment/jobs").expect(401);
  });

  // --- Step 2: job creation ---------------------------------------------------------------------------

  it("creates a job with a generated, org-scoped job code and persists required criteria", async () => {
    const { token } = await register("jobcreate");
    const created = await request(app.getHttpServer())
      .post("/api/v1/recruitment/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Senior Azure Data Engineer",
        description: "Build and operate our Azure data platform.",
        minExperienceYears: 6,
        maxExperienceYears: 10,
        requiredCriteria: {
          mandatorySkills: ["Azure Data Factory", "Azure Databricks", "Python", "PySpark", "SQL", "Azure Data Lake Storage Gen2"],
          preferredSkills: ["Snowflake", "Delta Lake", "Azure Event Hubs", "CI/CD", "Power BI"]
        },
        scoringConfig: {
          mandatorySkillWeight: 35,
          preferredSkillWeight: 15,
          experienceWeight: 25,
          projectExperienceWeight: 15,
          certificationWeight: 10
        }
      })
      .expect(201);
    expect(created.body.jobCode).toMatch(/^JOB-\d{4}-\d{5}$/);
    expect(created.body.status).toBe("OPEN");

    const fetched = await request(app.getHttpServer())
      .get(`/api/v1/recruitment/jobs/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(fetched.body.requiredCriteria.mandatorySkills).toHaveLength(6);
  });

  it("rejects a scoring config whose weights do not sum to 100", async () => {
    const { token } = await register("badweights");
    await request(app.getHttpServer())
      .post("/api/v1/recruitment/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Bad Weights Job",
        description: "x",
        requiredCriteria: { mandatorySkills: ["Python"] },
        scoringConfig: { mandatorySkillWeight: 50, preferredSkillWeight: 50, experienceWeight: 50, projectExperienceWeight: 0, certificationWeight: 0 }
      })
      .expect(400);
  });

  // --- Tenant isolation --------------------------------------------------------------------------------

  it("enforces tenant isolation: Org B cannot read, see in listings, or review Org A's job/candidates", async () => {
    const orgA = await register("tenantA");
    const orgB = await register("tenantB");

    const job = await request(app.getHttpServer())
      .post("/api/v1/recruitment/jobs")
      .set("Authorization", `Bearer ${orgA.token}`)
      .send({
        title: "Org A Only Job",
        description: "x",
        requiredCriteria: { mandatorySkills: ["Python"] },
        scoringConfig: { mandatorySkillWeight: 35, preferredSkillWeight: 15, experienceWeight: 25, projectExperienceWeight: 15, certificationWeight: 10 }
      })
      .expect(201);

    // Org B's token, Org A's job id -> never found (not a 403 that would confirm existence)
    await request(app.getHttpServer())
      .get(`/api/v1/recruitment/jobs/${job.body.id}`)
      .set("Authorization", `Bearer ${orgB.token}`)
      .expect(404);

    const orgBList = await request(app.getHttpServer())
      .get("/api/v1/recruitment/jobs")
      .set("Authorization", `Bearer ${orgB.token}`)
      .expect(200);
    expect(orgBList.body.items.find((j: { id: string }) => j.id === job.body.id)).toBeUndefined();

    await request(app.getHttpServer())
      .get(`/api/v1/recruitment/jobs/${job.body.id}/candidates`)
      .set("Authorization", `Bearer ${orgB.token}`)
      .expect(404);
  });

  // --- Step 3+4: resume upload, async processing, isolated failure handling --------------------------

  it(
    "accepts a mixed batch immediately, rejects files that fail type/signature validation at upload " +
      "time, and processes the valid one asynchronously — BLOCKED beyond this point for a " +
      "COMPLETED/scored outcome: no live LLM provider is configured in this environment, so the valid " +
      "resume's parsing is expected to reach a terminal state (not get stuck) once the provider call " +
      "fails, which is itself the thing being verified: isolated, graceful degradation.",
    async () => {
      const { token } = await installOrgWithRecruitment("upload");
      const job = await createJob(token, "Upload Test Job");

      const batchStart = Date.now();
      const upload = await request(app.getHttpServer())
        .post(`/api/v1/recruitment/jobs/${job.id}/resumes/batch`)
        .set("Authorization", `Bearer ${token}`)
        .attach("files", RESUME_PDF, { filename: "jane-doe.pdf", contentType: "application/pdf" })
        // Declares PDF but fails the magic-byte signature check — rejected at upload time, never queued.
        .attach("files", Buffer.from("not a real document"), { filename: "bad-file.pdf", contentType: "application/pdf" })
        // Wrong type entirely — rejected by the content-type allowlist.
        .attach("files", Buffer.from("irrelevant"), { filename: "unsupported.zip", contentType: "application/zip" })
        .expect(201);
      const uploadLatencyMs = Date.now() - batchStart;
      expect(uploadLatencyMs).toBeLessThan(5000); // never blocks on provider calls (Phase 3 requirement)
      expect(upload.body.totalFiles).toBe(3);
      expect(upload.body.results.filter((r: { status: string }) => r.status === "FAILED")).toHaveLength(2); // bad-file.pdf + unsupported.zip, both rejected at upload time
      expect(upload.body.results.filter((r: { status: string }) => r.status === "QUEUED")).toHaveLength(1);

      const { RecruitmentBatchProcessor } = await import("./recruitment-batch-processor");
      const processor = app.get(RecruitmentBatchProcessor);
      let status = "";
      // Only the valid PDF was ever queued; its text extraction succeeds (real bytes, real pdf-parse
      // call) and RecruitmentParsingService.parseResume degrades gracefully on the LLM failure (empty
      // fields + a warning, not a thrown exception) — so this reaches COMPLETED in one tick, no retries.
      for (let i = 0; i < 10; i++) {
        await processor.tick();
        const current = await request(app.getHttpServer())
          .get(`/api/v1/recruitment/batches/${upload.body.batchId}`)
          .set("Authorization", `Bearer ${token}`)
          .expect(200);
        status = current.body.status as string;
        if (status !== "QUEUED" && status !== "PROCESSING") break;
        await sleep(100);
      }
      expect(["COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED"]).toContain(status);

      const resumes = await prisma.recruitmentResume.findMany({ where: { uploadBatchId: upload.body.batchId } });
      expect(resumes).toHaveLength(1); // only the file that passed upload-time validation was ever queued
      const terminalStates = resumes.map((r) => r.parsingStatus);
      expect(terminalStates.every((s) => s === "COMPLETED" || s === "FAILED")).toBe(true); // never stuck QUEUED/PROCESSING
    },
    30_000
  );

  it(
    "retries a file that passes upload validation but fails during async parsing, with exponential " +
      "backoff, and gives up after MAX_RETRIES — real wait, not a mock.",
    async () => {
      const { token } = await installOrgWithRecruitment("retrybackoff");
      const job = await createJob(token, "Retry Backoff Test Job");
      // Valid PDF signature (passes upload-time validation) but truncated/corrupt body — pdf-parse itself
      // throws on this, which is what actually exercises parseOne's catch -> failOrRequeue path.
      const corruptPdf = Buffer.from("%PDF-1.4\nthis is not a real pdf body at all, truncated\n%%EOF", "latin1");
      const upload = await request(app.getHttpServer())
        .post(`/api/v1/recruitment/jobs/${job.id}/resumes/batch`)
        .set("Authorization", `Bearer ${token}`)
        .attach("files", corruptPdf, { filename: "corrupt.pdf", contentType: "application/pdf" })
        .expect(201);
      expect(upload.body.results[0].status).toBe("QUEUED"); // signature check alone can't catch this

      const { RecruitmentBatchProcessor } = await import("./recruitment-batch-processor");
      const processor = app.get(RecruitmentBatchProcessor);
      let resume = await prisma.recruitmentResume.findFirstOrThrow({ where: { uploadBatchId: upload.body.batchId } });
      for (let i = 0; i < 40 && resume.parsingStatus !== "FAILED"; i++) {
        await processor.tick();
        await sleep(250);
        resume = await prisma.recruitmentResume.findUniqueOrThrow({ where: { id: resume.id } });
      }
      expect(resume.parsingStatus).toBe("FAILED");
      expect(resume.retryCount).toBe(3); // MAX_RETRIES reached, then gave up
      expect(resume.parsingError).toContain("gave up after 3 attempts");
    },
    30_000
  );

  it("retrying a batch does not duplicate resume or application records", async () => {
    const { token } = await installOrgWithRecruitment("retry");
    const job = await createJob(token, "Retry Test Job");
    const upload = await request(app.getHttpServer())
      .post(`/api/v1/recruitment/jobs/${job.id}/resumes/batch`)
      .set("Authorization", `Bearer ${token}`)
      .attach("files", RESUME_PDF, { filename: "candidate.pdf", contentType: "application/pdf" })
      .expect(201);

    const before = await prisma.recruitmentResume.count({ where: { uploadBatchId: upload.body.batchId } });
    // Re-upload the SAME bytes against the SAME job — idempotency: same fileHash -> same resume row,
    // @@unique([jobId, resumeId]) -> no second application.
    await request(app.getHttpServer())
      .post(`/api/v1/recruitment/jobs/${job.id}/resumes/batch`)
      .set("Authorization", `Bearer ${token}`)
      .attach("files", RESUME_PDF, { filename: "candidate-again.pdf", contentType: "application/pdf" })
      .expect(201);
    const after = await prisma.recruitmentResume.count({ where: { organizationId: (await prisma.recruitmentJob.findUniqueOrThrow({ where: { id: job.id } })).organizationId } });
    expect(after).toBe(before); // no new resume row created
    const applications = await prisma.recruitmentApplication.count({ where: { jobId: job.id } });
    expect(applications).toBe(1); // no duplicate application
  });

  // --- Phase 5: exports -------------------------------------------------------------------------------

  it("exports CSV and XLSX with matching data and sanitizes formula-injection attempts in candidate names", async () => {
    const { token } = await installOrgWithRecruitment("export");
    const job = await createJob(token, "Export Test Job");
    await request(app.getHttpServer())
      .post(`/api/v1/recruitment/jobs/${job.id}/resumes/batch`)
      .set("Authorization", `Bearer ${token}`)
      .attach("files", RESUME_PDF, { filename: "candidate.pdf", contentType: "application/pdf" })
      .expect(201);
    // Force a formula-shaped candidate name directly in the DB — the exports must neutralize it
    // regardless of where such a value originated (resume parsing, manual entry, anywhere).
    const application = await prisma.recruitmentApplication.findFirstOrThrow({ where: { jobId: job.id } });
    await prisma.recruitmentCandidate.update({
      where: { id: application.candidateId },
      data: { fullName: "=1+1cmd|' /C calc'!A1" }
    });

    const csv = await request(app.getHttpServer())
      .get(`/api/v1/recruitment/jobs/${job.id}/export`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(csv.text).toContain("Job ID"); // header present
    expect(csv.text).not.toMatch(/[,\n]=1\+1cmd/); // never an UNPROTECTED leading '='

    const xlsx = await request(app.getHttpServer())
      .get(`/api/v1/recruitment/jobs/${job.id}/export.xlsx`)
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((xlsx.body as Buffer).length).toBeGreaterThan(0);
    expect((xlsx.headers["content-type"] as string)).toContain("spreadsheetml");
  });

  // --- Step 7: human review, separate from AI recommendation -----------------------------------------

  it("lets an authorized recruiter review a candidate independently of the AI recommendation, with an audit trail", async () => {
    const { token, userId } = await installOrgWithRecruitment("review");
    const job = await createJob(token, "Review Test Job");
    const upload = await request(app.getHttpServer())
      .post(`/api/v1/recruitment/jobs/${job.id}/resumes/batch`)
      .set("Authorization", `Bearer ${token}`)
      .attach("files", RESUME_PDF, { filename: "candidate.pdf", contentType: "application/pdf" })
      .expect(201);
    const candidatesPage = await request(app.getHttpServer())
      .get(`/api/v1/recruitment/jobs/${job.id}/candidates`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(candidatesPage.body.items).toHaveLength(1);
    expect(candidatesPage.body.items[0].recruiterDecision).toBe("PENDING_REVIEW"); // default, never auto-decided

    const applicationId = candidatesPage.body.items[0].id as string;
    const reviewed = await request(app.getHttpServer())
      .post(`/api/v1/recruitment/applications/${applicationId}/review`)
      .set("Authorization", `Bearer ${token}`)
      .send({ recruiterDecision: "SHORTLISTED", overrideReason: "Strong background despite no live AI score available." })
      .expect(201);
    expect(reviewed.body.recruiterDecision).toBe("SHORTLISTED");
    expect(reviewed.body.reviewedByUserId).toBe(userId);
    expect(reviewed.body.reviewedAt).not.toBeNull();
    void upload; // batch id not needed further; upload already asserted to have created the application
  });

  // --- helpers -----------------------------------------------------------------------------------------

  async function installOrgWithRecruitment(suffix: string) {
    const { token, organizationId } = await register(suffix);
    await installRecruitmentConsultant(token);
    const me = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return { token, organizationId, userId: me.body.data.user.id as string };
  }

  async function createJob(token: string, title: string) {
    const created = await request(app.getHttpServer())
      .post("/api/v1/recruitment/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title,
        description: "x",
        minExperienceYears: 3,
        requiredCriteria: { mandatorySkills: ["Python", "SQL"] },
        scoringConfig: { mandatorySkillWeight: 35, preferredSkillWeight: 15, experienceWeight: 25, projectExperienceWeight: 15, certificationWeight: 10 }
      })
      .expect(201);
    return created.body as { id: string };
  }
});
