/**
 * Real end-to-end UAT for the Recruitment Consultant's WhatsApp menu — a real NestFactory app + real
 * Postgres (TEST_DATABASE_URL). Calls RecruitmentWhatsAppMenuService.handleMessage() directly, the same
 * entry point RecruitmentWhatsAppController.processInbound() calls after Twilio signature verification —
 * that verification step is a pure, already-tested cryptographic check (see channel.runtime.ts) with
 * nothing recruitment-specific in it, so this file exercises the actual menu/conversation logic without
 * needing a live Twilio account. No live LLM provider is configured in this environment, so the
 * AI-assisted job-description parsing degrades to its documented empty-criteria fallback here — asserted
 * explicitly below, not hidden.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../app.module";
import { ApiExceptionFilter } from "../../identity/presentation/http/api-exception.filter";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";
import { RecruitmentWhatsAppMenuService } from "./recruitment-whatsapp-menu.service";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// Same minimal, real, parseable PDF as recruitment.e2e.spec.ts — real text the deterministic pipeline
// stages can act on without a live LLM.
const RESUME_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 90>>stream\nBT /F1 14 Tf 72 720 Td (Jane Doe. Python developer, 6 years experience. Skills: Python, SQL. jane@example.com) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \n0000000227 00000 n \n0000000336 00000 n \ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n407\n%%EOF\n",
  "latin1"
);

suite("Recruitment Consultant — WhatsApp menu end-to-end UAT", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let menu: RecruitmentWhatsAppMenuService;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: ["error", "warn"], abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    menu = app.get(RecruitmentWhatsAppMenuService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  async function setupLinkedRecruiter(suffix: string) {
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Recruitment WA ${suffix} ${Date.now()}`,
        firstName: "Owner",
        email: `recruitment-wa-${suffix}-${Date.now()}@example.com`,
        password: "StrongPassword@123"
      })
      .expect(201);
    const token = registered.body.data.tokens.accessToken as string;
    const organizationId = registered.body.data.organization.id as string;
    await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId: "recruitment-consultant", configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);
    const me = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const userId = me.body.data.user.id as string;
    // recruitmentWhatsAppSession.whatsappNumber is a GLOBALLY unique key (not scoped per organization),
    // so this must be unique per test run, not just per suffix — a fixed string would silently reuse a
    // stale session (and its menuState/activeFilters) left behind by an earlier run against the same
    // shared test database.
    const whatsappNumber = `whatsapp:+1${Date.now().toString().slice(-10)}${Math.floor(Math.random() * 90 + 10)}`;
    await prisma.recruitmentWhatsAppLink.create({
      data: { organizationId, userId, whatsappNumber, status: "VERIFIED", linkedAt: new Date() }
    });
    return { token, organizationId, userId, whatsappNumber };
  }

  it("greeting 'Hi' replies with the welcome message and numbered main menu", async () => {
    const { organizationId, userId, whatsappNumber } = await setupLinkedRecruiter("greet");
    const reply = await menu.handleMessage(organizationId, userId, whatsappNumber, "Hi");
    expect(reply.text).toContain("Welcome to Krevia Recruitment Consultant");
    expect(reply.text).toContain("1. Job Openings");
    expect(reply.text).toContain("2. Candidates");
    expect(reply.text).toContain("new job");
    expect(reply.awaitingUpload).toBe(false);
  });

  it("creates a job end-to-end through the 'new job' conversational flow, with the degrade-gracefully fallback when no live AI provider is configured", async () => {
    const { organizationId, userId, whatsappNumber } = await setupLinkedRecruiter("create");

    const start = await menu.handleMessage(organizationId, userId, whatsappNumber, "new job");
    expect(start.text).toContain("What's the job title?");

    const afterTitle = await menu.handleMessage(organizationId, userId, whatsappNumber, "Senior Backend Engineer");
    expect(afterTitle.text).toContain("send the full job description");

    const afterDescription = await menu.handleMessage(
      organizationId,
      userId,
      whatsappNumber,
      "We need a backend engineer to own our payments service. Must know Python and SQL. 5+ years experience."
    );
    expect(afterDescription.text).toMatch(/Job posted: JOB-\d+-\d+ — Senior Backend Engineer/);
    // No live LLM provider in this environment -> parseJobDescription degrades to empty criteria, not a
    // thrown error — the job is still created, and the reply says so explicitly.
    expect(afterDescription.text).toContain("No required skills were extracted automatically");

    const job = await prisma.recruitmentJob.findFirstOrThrow({ where: { organizationId, title: "Senior Backend Engineer" } });
    expect(job.description).toContain("payments service");
    expect((job.requiredCriteria as { mandatorySkills: string[] }).mandatorySkills).toEqual([]);
    expect(job.status).toBe("OPEN");

    // The newly created job is now visible through the ordinary "jobs" listing.
    const jobsList = await menu.handleMessage(organizationId, userId, whatsappNumber, "jobs");
    expect(jobsList.text).toContain("Senior Backend Engineer");
  });

  it("a userId that doesn't match this WhatsApp number's verified link can't use the session at all, not even to reach the permission check", async () => {
    const { organizationId, whatsappNumber } = await setupLinkedRecruiter("wronguser");
    const before = await prisma.recruitmentJob.count({ where: { organizationId } });
    await expect(
      menu.handleMessage(organizationId, "00000000-0000-0000-0000-000000000000", whatsappNumber, "new job")
    ).rejects.toThrow("RECRUITMENT_WHATSAPP_LINK_NOT_VERIFIED");
    const after = await prisma.recruitmentJob.count({ where: { organizationId } });
    expect(after).toBe(before);
  });

  it("uploads a resume, views the candidate, and shortlists them via WhatsApp — recruiterDecision actually changes in the database", async () => {
    const { token, organizationId, userId, whatsappNumber } = await setupLinkedRecruiter("shortlist");
    const createdJob = await request(app.getHttpServer())
      .post("/api/v1/recruitment/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "WhatsApp Shortlist Test Job",
        description: "x",
        requiredCriteria: { mandatorySkills: ["Python"] },
        scoringConfig: { mandatorySkillWeight: 35, preferredSkillWeight: 15, experienceWeight: 25, projectExperienceWeight: 15, certificationWeight: 10 }
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/recruitment/jobs/${createdJob.body.id}/resumes/batch`)
      .set("Authorization", `Bearer ${token}`)
      .attach("files", RESUME_PDF, { filename: "candidate.pdf", contentType: "application/pdf" })
      .expect(201);
    const application = await prisma.recruitmentApplication.findFirstOrThrow({ where: { jobId: createdJob.body.id } });
    expect(application.recruiterDecision).toBe("PENDING_REVIEW");
    // Candidate name/skill extraction is LLM-only (no deterministic fallback) and this environment has no
    // live provider configured, so it would otherwise come back "Not Available" (same documented
    // limitation as recruitment.e2e.spec.ts). Set it directly, the same way that file's export test does,
    // so this test can actually demonstrate the WhatsApp candidate-detail/shortlist UX with a real name.
    await prisma.recruitmentCandidate.update({ where: { id: application.candidateId }, data: { fullName: "Jane Doe" } });

    const jobsList = await menu.handleMessage(organizationId, userId, whatsappNumber, "jobs");
    const jobLine = jobsList.text.split("\n").find((line) => line.includes("WhatsApp Shortlist Test Job"));
    const jobNumber = jobLine?.trim().match(/^(\d+)\./)?.[1];
    expect(jobNumber).toBeTruthy();

    await menu.handleMessage(organizationId, userId, whatsappNumber, jobNumber!);
    const candidatesPage = await menu.handleMessage(organizationId, userId, whatsappNumber, "2"); // Applied Candidates
    expect(candidatesPage.text).toContain("Jane Doe");

    // "shortlist" before any candidate's detail has been viewed this session is a no-op, not a crash.
    const premature = await menu.handleMessage(organizationId, userId, whatsappNumber, "shortlist");
    expect(premature.text).toContain("View a candidate first");

    const detail = await menu.handleMessage(organizationId, userId, whatsappNumber, "1");
    expect(detail.text).toContain("Candidate: Jane Doe");
    expect(detail.text).toContain("Reply \"shortlist\" to shortlist this candidate.");

    const shortlisted = await menu.handleMessage(organizationId, userId, whatsappNumber, "shortlist");
    expect(shortlisted.text).toContain("Jane Doe has been shortlisted");

    const refreshed = await prisma.recruitmentApplication.findUniqueOrThrow({ where: { id: application.id } });
    expect(refreshed.recruiterDecision).toBe("SHORTLISTED");
    expect(refreshed.reviewedByUserId).toBe(userId);
  }, 30_000);

  it("multi-tenant isolation: one organization's linked WhatsApp session never sees another organization's jobs", async () => {
    const orgA = await setupLinkedRecruiter("tenantA");
    const orgB = await setupLinkedRecruiter("tenantB");
    await menu.handleMessage(orgA.organizationId, orgA.userId, orgA.whatsappNumber, "new job");
    await menu.handleMessage(orgA.organizationId, orgA.userId, orgA.whatsappNumber, "Org A Only Job");
    await menu.handleMessage(orgA.organizationId, orgA.userId, orgA.whatsappNumber, "Only visible to organization A.");

    const orgBJobs = await menu.handleMessage(orgB.organizationId, orgB.userId, orgB.whatsappNumber, "jobs");
    expect(orgBJobs.text).not.toContain("Org A Only Job");
  });
});
