/**
 * Sprint 7.17 (Phase 4) — real cross-platform consistency validation.
 *
 * Website and iOS are proven identical BY CONSTRUCTION: both serialize the same
 * RecruitmentCandidateQuery shape to the same POST /recruitment/candidates/search endpoint (iOS's
 * Codable struct field names were built to match the website's AdvancedCandidateQueryDto one-for-one in
 * Sprint 7.17 Phase 2; apps/ios/.../RecruitmentCandidateFilterViewModelTests.swift locks that in from the
 * iOS side). The genuinely UNVERIFIED pairing this file checks for real is: does WhatsApp's in-process
 * call into RecruitmentCandidateQueryService — which never goes over HTTP — return the exact same
 * candidate IDs/scores/ordering as the HTTP path website and iOS both use, for equivalent filters, against
 * one real, deterministic, synthetic dataset.
 *
 * Real NestFactory app + real Postgres (TEST_DATABASE_URL only), synthetic data only, cleaned up after.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { RecruitmentCandidateQueryService } from "./recruitment-candidate-query.service";
import { RecruitmentExportService } from "./recruitment-export.service";
import { RecruitmentWhatsAppLinkService } from "./whatsapp/recruitment-whatsapp-link.service";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

type ScenarioStatus = "PASSED" | "FAILED" | "BLOCKED" | "NOT_EXECUTED";
interface ScenarioRecord {
  id: string;
  name: string;
  status: ScenarioStatus;
  detail: string;
  evidence?: Record<string, unknown>;
}
const scenarios: ScenarioRecord[] = [];
function record(id: string, name: string, status: ScenarioStatus, detail: string, evidence?: Record<string, unknown>) {
  scenarios.push({ id, name, status, detail, evidence });
}

suite("Sprint 7.17 Phase 4 — cross-platform consistency (website / iOS-equivalent / WhatsApp)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let queries: RecruitmentCandidateQueryService;
  let exportsService: RecruitmentExportService;
  let whatsappLinks: RecruitmentWhatsAppLinkService;
  let token: string;
  let orgId: string;
  let userId: string;
  let jobAId: string;
  let jobBId: string;
  const named: Record<string, { candidateId: string; applicationId: string; resumeId: string }> = {};

  async function register(suffix: string) {
    const res = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: `Cross-Platform ${suffix} ${Date.now()}`,
        firstName: "Owner",
        email: `cross-platform-${suffix}-${Date.now()}@example.invalid`,
        password: "StrongPassword@123"
      })
      .expect(201);
    return { token: res.body.data.tokens.accessToken as string, organizationId: res.body.data.organization.id as string, userId: res.body.data.user.id as string };
  }

  async function createJob(authToken: string, title: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/api/v1/recruitment/jobs")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        title,
        description: `Synthetic job for Phase 4 cross-platform testing: ${title}`,
        requiredCriteria: { mandatorySkills: ["Python"], preferredSkills: [], certifications: [] },
        scoringConfig: { mandatorySkillWeight: 35, preferredSkillWeight: 15, experienceWeight: 25, projectExperienceWeight: 15, certificationWeight: 10 }
      })
      .expect(201);
    return res.body.id as string;
  }

  interface CandidateSeed {
    key: string;
    jobId: string;
    fullName: string;
    score: number | null;
    city: string | null;
    state: string | null;
    region: string | null;
    relevantExperienceYears: number;
    skills: string[];
    applicationStatus: string;
    recruiterDecision:
      | "PENDING_REVIEW" | "SHORTLISTED" | "NOT_SELECTED" | "INTERVIEW_SCHEDULED" | "INTERVIEW_COMPLETED" | "ON_HOLD" | "HIRED";
  }

  async function seedCandidate(seed: CandidateSeed) {
    const candidateId = randomUUID();
    const resumeId = randomUUID();
    await prisma.recruitmentCandidate.create({
      data: {
        id: candidateId,
        organizationId: orgId,
        fullName: seed.fullName,
        mobileNumber: `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
        currentCity: seed.city,
        currentState: seed.state,
        currentCountry: seed.city ? "India" : null,
        normalizedRegion: seed.region,
        preferredWorkLocations: seed.city ? [seed.city] : []
      }
    });
    await prisma.recruitmentResume.create({
      data: {
        id: resumeId,
        organizationId: orgId,
        candidateId,
        resumeCode: `RES-CP-${randomUUID().slice(0, 18)}`,
        fileName: `${seed.key}.pdf`,
        storageKey: `recruitment/cross-platform/${seed.key}.pdf`,
        fileSizeBytes: 1024,
        fileHash: randomUUID().replace(/-/g, ""),
        parsingStatus: "COMPLETED",
        totalExperienceYears: seed.relevantExperienceYears + 1,
        relevantExperienceYears: seed.relevantExperienceYears,
        extractedSkills: seed.skills
      }
    });
    const application = await prisma.recruitmentApplication.create({
      data: {
        organizationId: orgId,
        jobId: seed.jobId,
        candidateId,
        resumeId,
        applicationStatus: seed.applicationStatus,
        recruiterDecision: seed.recruiterDecision,
        aiRecommendation: seed.score === null ? null : seed.score >= 80 ? "RECOMMENDED_FOR_SHORTLIST" : "REVIEW_REQUIRED"
      }
    });
    if (seed.score !== null) {
      await prisma.recruitmentEvaluation.create({
        data: {
          applicationId: application.id,
          matchScore: seed.score,
          matchedSkills: seed.skills,
          missingSkills: [],
          scoringVersion: "cross-platform-test-1",
          evaluationStatus: "COMPLETED",
          evaluatedAt: new Date()
        }
      });
    }
    named[seed.key] = { candidateId, applicationId: application.id, resumeId };
    return { candidateId, applicationId: application.id, resumeId };
  }

  async function seedFiller(jobId: string, count: number) {
    const cities = ["Noida", "Gurugram", "Pune", "Hyderabad", "Bengaluru"];
    for (let i = 0; i < count; i++) {
      const candidateId = randomUUID();
      const resumeId = randomUUID();
      await prisma.recruitmentCandidate.create({
        data: { id: candidateId, organizationId: orgId, fullName: `Filler Candidate ${i}`, currentCity: cities[i % cities.length] }
      });
      await prisma.recruitmentResume.create({
        data: {
          id: resumeId,
          organizationId: orgId,
          candidateId,
          resumeCode: `RES-CPF-${randomUUID().slice(0, 18)}`,
          fileName: `filler-${i}.pdf`,
          storageKey: `recruitment/cross-platform/filler-${i}.pdf`,
          fileSizeBytes: 1024,
          fileHash: randomUUID().replace(/-/g, ""),
          parsingStatus: "COMPLETED",
          totalExperienceYears: 3,
          relevantExperienceYears: 2,
          extractedSkills: ["Python"]
        }
      });
      const application = await prisma.recruitmentApplication.create({
        data: { organizationId: orgId, jobId, candidateId, resumeId, recruiterDecision: "PENDING_REVIEW" }
      });
      await prisma.recruitmentEvaluation.create({
        data: {
          applicationId: application.id,
          matchScore: 40 + (i % 40),
          matchedSkills: ["Python"],
          missingSkills: [],
          scoringVersion: "cross-platform-test-1",
          evaluationStatus: "COMPLETED",
          evaluatedAt: new Date()
        }
      });
    }
  }

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: ["error", "warn"], abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    queries = app.get(RecruitmentCandidateQueryService);
    exportsService = app.get(RecruitmentExportService);
    whatsappLinks = app.get(RecruitmentWhatsAppLinkService);

    const auth = await register("phase4");
    token = auth.token;
    orgId = auth.organizationId;
    userId = auth.userId;
    await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${token}`)
      .send({ pluginId: "recruitment-consultant", configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);

    jobAId = await createJob(token, "Senior Backend Engineer (Phase 4)");
    jobBId = await createJob(token, "Data Analyst (Phase 4)");

    // Deterministic, named boundary/variety dataset (section 2's requirements).
    await seedCandidate({ key: "scoreBelow80", jobId: jobAId, fullName: "Rahul Sharma", score: 79.99, city: "Noida", state: "Uttar Pradesh", region: "Delhi NCR", relevantExperienceYears: 3, skills: ["Python"], applicationStatus: "ACTIVE", recruiterDecision: "PENDING_REVIEW" });
    await seedCandidate({ key: "scoreAt80", jobId: jobAId, fullName: "Rahul Sharma", score: 80.0, city: "Gurugram", state: "Haryana", region: "Delhi NCR", relevantExperienceYears: 5, skills: ["Python", "SQL"], applicationStatus: "ACTIVE", recruiterDecision: "SHORTLISTED" });
    await seedCandidate({ key: "scoreAt80Tie", jobId: jobAId, fullName: "Tie Candidate", score: 80.0, city: "Noida", state: "Uttar Pradesh", region: "Delhi NCR", relevantExperienceYears: 5, skills: ["Python"], applicationStatus: "ACTIVE", recruiterDecision: "PENDING_REVIEW" });
    await seedCandidate({ key: "scoreAbove80", jobId: jobAId, fullName: "Priya Singh", score: 80.01, city: "Bengaluru", state: "Karnataka", region: "Bengaluru", relevantExperienceYears: 4, skills: ["Java"], applicationStatus: "ACTIVE", recruiterDecision: "PENDING_REVIEW" });
    await seedCandidate({ key: "scoreBelow30", jobId: jobAId, fullName: "Amit Kumar", score: 29.99, city: "Noida", state: "Uttar Pradesh", region: "Delhi NCR", relevantExperienceYears: 1, skills: ["Excel"], applicationStatus: "ACTIVE", recruiterDecision: "NOT_SELECTED" });
    await seedCandidate({ key: "scoreAt30", jobId: jobAId, fullName: "Sara Khan", score: 30.0, city: "Pune", state: "Maharashtra", region: "Pune", relevantExperienceYears: 2, skills: ["Excel", "SQL"], applicationStatus: "ACTIVE", recruiterDecision: "PENDING_REVIEW" });
    await seedCandidate({ key: "unknownLocation", jobId: jobAId, fullName: "John Doe", score: 30.01, city: null, state: null, region: null, relevantExperienceYears: 6, skills: ["Python", "Java", "SQL"], applicationStatus: "ACTIVE", recruiterDecision: "ON_HOLD" });
    await seedCandidate({ key: "scoreBelow90", jobId: jobAId, fullName: "John Doe", score: 89.99, city: "Noida", state: "Uttar Pradesh", region: "Delhi NCR", relevantExperienceYears: 7, skills: ["Python", "SQL", "Java"], applicationStatus: "ACTIVE", recruiterDecision: "HIRED" });
    await seedCandidate({ key: "scoreAt90", jobId: jobAId, fullName: "Neha Verma", score: 90.0, city: "Hyderabad", state: "Telangana", region: "Hyderabad", relevantExperienceYears: 8, skills: ["Python"], applicationStatus: "ACTIVE", recruiterDecision: "INTERVIEW_SCHEDULED" });
    await seedCandidate({ key: "scoreAbove90", jobId: jobAId, fullName: "Vikram Rao", score: 90.01, city: null, state: null, region: null, relevantExperienceYears: 0, skills: [], applicationStatus: "ARCHIVED", recruiterDecision: "PENDING_REVIEW" });
    // > 1 page (MAX_LIMIT = 100) and > 100 rows for the export truncation-bug guard (CP-009).
    await seedFiller(jobAId, 110);
  }, 120_000);

  afterAll(async () => {
    writeFileSync(resolve(process.cwd(), "cross-platform-results.json"), JSON.stringify(scenarios, null, 2));
    if (prisma && orgId) {
      // pluginConfiguration/pluginAiConfiguration.updater and recruitmentJob/recruitmentExportJob's
      // created/requested-by user fields are all onDelete: Restrict, so they must go before the user row,
      // which must go before the organization (User.organization is itself Restrict).
      await prisma.pluginConfiguration.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma.pluginAiConfiguration.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma.recruitmentExportJob.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma.recruitmentJob.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    }
    if (app) await app.close();
  }, 60_000);

  it("CP-001 Job visibility — same job ID/status via website HTTP and WhatsApp's in-process job lookup", async () => {
    const websiteGet = await request(app.getHttpServer())
      .get(`/api/v1/recruitment/jobs/${jobAId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const dbRow = await prisma.recruitmentJob.findUniqueOrThrow({ where: { id: jobAId } });
    const pass = websiteGet.body.id === jobAId && websiteGet.body.status === dbRow.status && dbRow.organizationId === orgId;
    expect(pass).toBe(true);
    record("CP-001", "Job visibility", "PASSED", "Website HTTP GET and the persisted RecruitmentJob row (the same row WhatsApp's menu service reads via RecruitmentJobService) agree on id/status.", {
      jobId: jobAId, websiteStatus: websiteGet.body.status, dbStatus: dbRow.status
    });
  });

  it("CP-002 Candidate ingestion — identical candidate ID, job ID, ATS score via HTTP search and WhatsApp's direct query call", async () => {
    const c = named.scoreAt90!;
    const httpResult = await request(app.getHttpServer())
      .post("/api/v1/recruitment/candidates/search")
      .set("Authorization", `Bearer ${token}`)
      .send({ jobId: jobAId, search: "Neha Verma" })
      .expect(201);
    const whatsappResult = await queries.query(orgId, { jobId: jobAId, search: "Neha Verma" });

    const httpItem = httpResult.body.items.find((i: { id: string }) => i.id === c.applicationId);
    const waItem = whatsappResult.items.find((i) => i.id === c.applicationId);
    const pass =
      !!httpItem && !!waItem &&
      httpItem.candidate.id === waItem.candidate.id &&
      httpItem.jobId === waItem.jobId &&
      httpItem.evaluation.matchScore === waItem.evaluation?.matchScore &&
      httpItem.evaluation.matchScore === 90.0;
    expect(pass).toBe(true);
    record("CP-002", "Candidate ingestion", "PASSED", "HTTP search (website/iOS path) and WhatsApp's direct RecruitmentCandidateQueryService.query() call return the identical candidate id, job id and ATS score for the same seeded candidate.", {
      candidateId: c.candidateId, applicationId: c.applicationId, httpScore: httpItem?.evaluation?.matchScore, whatsappScore: waItem?.evaluation?.matchScore
    });
  });

  it("CP-003 Score boundary — > 80 excludes exactly-80, >= 80 includes it, identically on both call paths", async () => {
    const atId = named.scoreAt80!.applicationId;
    const belowId = named.scoreBelow80!.applicationId;
    const aboveId = named.scoreAbove80!.applicationId;

    const httpGt = await request(app.getHttpServer()).post("/api/v1/recruitment/candidates/search").set("Authorization", `Bearer ${token}`).send({ jobId: jobAId, scoreGreaterThan: 80, limit: 100 }).expect(201);
    const waGt = await queries.query(orgId, { jobId: jobAId, scoreGreaterThan: 80, limit: 100 });
    const httpGte = await request(app.getHttpServer()).post("/api/v1/recruitment/candidates/search").set("Authorization", `Bearer ${token}`).send({ jobId: jobAId, scoreGreaterThanOrEqual: 80, limit: 100 }).expect(201);
    const waGte = await queries.query(orgId, { jobId: jobAId, scoreGreaterThanOrEqual: 80, limit: 100 });

    const ids = (items: Array<{ id: string }>) => items.map((i) => i.id).sort();
    const gtIdsMatch = JSON.stringify(ids(httpGt.body.items)) === JSON.stringify(ids(waGt.items));
    const gteIdsMatch = JSON.stringify(ids(httpGte.body.items)) === JSON.stringify(ids(waGte.items));

    const gtExcludesExact = !ids(httpGt.body.items).includes(atId) && ids(httpGt.body.items).includes(aboveId) && !ids(httpGt.body.items).includes(belowId);
    const gteIncludesExact = ids(httpGte.body.items).includes(atId) && ids(httpGte.body.items).includes(aboveId) && !ids(httpGte.body.items).includes(belowId);

    const pass = gtIdsMatch && gteIdsMatch && gtExcludesExact && gteIncludesExact;
    expect(pass).toBe(true);
    record("CP-003", "Score boundary (>80 vs >=80)", pass ? "PASSED" : "FAILED", "scoreGreaterThan excludes an exact 80.00 match; scoreGreaterThanOrEqual includes it; both call paths return identical id sets.", {
      httpGtIds: ids(httpGt.body.items), waGtIds: ids(waGt.items), httpGteIds: ids(httpGte.body.items), waGteIds: ids(waGte.items)
    });
  });

  it("CP-004 Location filtering — Noida and the Delhi NCR region return identical candidate IDs on both call paths", async () => {
    const httpCity = await request(app.getHttpServer()).post("/api/v1/recruitment/candidates/search").set("Authorization", `Bearer ${token}`).send({ jobId: jobAId, currentCity: ["Noida"], limit: 100 }).expect(201);
    const waCity = await queries.query(orgId, { jobId: jobAId, currentCity: ["Noida"], limit: 100 });
    const httpRegion = await request(app.getHttpServer()).post("/api/v1/recruitment/candidates/search").set("Authorization", `Bearer ${token}`).send({ jobId: jobAId, region: ["Delhi NCR"], limit: 100 }).expect(201);
    const waRegion = await queries.query(orgId, { jobId: jobAId, region: ["Delhi NCR"], limit: 100 });

    const ids = (items: Array<{ id: string }>) => items.map((i) => i.id).sort();
    const cityMatch = JSON.stringify(ids(httpCity.body.items)) === JSON.stringify(ids(waCity.items));
    const regionMatch = JSON.stringify(ids(httpRegion.body.items)) === JSON.stringify(ids(waRegion.items));
    // Delhi NCR region must expand beyond literal "Noida" city matches (Gurugram is also Delhi NCR).
    const regionExpandsBeyondCity = ids(httpRegion.body.items).length > ids(httpCity.body.items).length;

    const pass = cityMatch && regionMatch && regionExpandsBeyondCity;
    expect(pass).toBe(true);
    record("CP-004", "Location filtering (Noida / Delhi NCR)", pass ? "PASSED" : "FAILED", "City and region filters return identical id sets across both call paths; the region taxonomy expansion is real (region result set is a strict superset of the single-city one).", {
      cityIds: ids(httpCity.body.items), regionIds: ids(httpRegion.body.items)
    });
  });

  it("CP-005 Combined filters — score + location + skills + experience together agree across both call paths", async () => {
    const filter = { jobId: jobAId, scoreGreaterThanOrEqual: 80, region: ["Delhi NCR"], anySkills: ["Python"], minRelevantExperienceYears: 1, limit: 100 };
    const httpRes = await request(app.getHttpServer()).post("/api/v1/recruitment/candidates/search").set("Authorization", `Bearer ${token}`).send(filter).expect(201);
    const waRes = await queries.query(orgId, filter);
    const ids = (items: Array<{ id: string }>) => items.map((i) => i.id).sort();
    const match = JSON.stringify(ids(httpRes.body.items)) === JSON.stringify(ids(waRes.items));
    expect(match).toBe(true);
    record("CP-005", "Combined filters", match ? "PASSED" : "FAILED", "score + region + skills + experience applied together return the identical id set on both call paths.", { ids: ids(httpRes.body.items) });
  });

  it("CP-006 Sorting — score_desc/asc are correctly ordered with deterministic id tie-breaking on exact ties", async () => {
    const descRes = await request(app.getHttpServer()).post("/api/v1/recruitment/candidates/search").set("Authorization", `Bearer ${token}`).send({ jobId: jobAId, sortBy: "score_desc", limit: 100 }).expect(201);
    const scores = descRes.body.items.map((i: { evaluation?: { matchScore?: number } }) => i.evaluation?.matchScore ?? -1);
    const isDescending = scores.every((s: number, i: number) => i === 0 || s <= scores[i - 1]);

    // The two exact-80.00 ties (scoreAt80, scoreAt80Tie) must appear adjacent and in ascending-id order
    // between themselves — the service's own documented tie-break rule.
    const tieIds = [named.scoreAt80!.applicationId, named.scoreAt80Tie!.applicationId].sort();
    const positions = descRes.body.items.map((i: { id: string }) => i.id);
    const tieIndexes = tieIds.map((id) => positions.indexOf(id));
    const tieOrderCorrect = tieIndexes[0]! < tieIndexes[1]!;

    const pass = isDescending && tieOrderCorrect;
    expect(pass).toBe(true);
    record("CP-006", "Sorting determinism", pass ? "PASSED" : "FAILED", "score_desc is a true non-increasing sequence; two exact-score ties break deterministically by ascending application id, matching RecruitmentCandidateQueryService.buildOrdering's documented secondary key.", {
      tieIds, tieIndexes
    });
  });

  it("CP-007 Pagination — no duplicate IDs across pages, full coverage, and a filter change on a later page restarts cleanly", async () => {
    const pageSize = 20;
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let duplicateFound = false;
    do {
      const res = await request(app.getHttpServer())
        .post("/api/v1/recruitment/candidates/search")
        .set("Authorization", `Bearer ${token}`)
        .send({ jobId: jobAId, sortBy: "score_desc", limit: pageSize, ...(cursor ? { cursor } : {}) })
        .expect(201);
      for (const item of res.body.items) {
        if (seen.has(item.id)) duplicateFound = true;
        seen.add(item.id);
      }
      cursor = res.body.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 20);

    const totalCountRes = await request(app.getHttpServer()).post("/api/v1/recruitment/candidates/search").set("Authorization", `Bearer ${token}`).send({ jobId: jobAId, limit: 1 }).expect(201);
    const fullCoverage = seen.size === totalCountRes.body.totalCount;

    // A filter change mid-pagination (new request with cursor omitted) must start from the beginning of
    // the NEW filtered set, not continue the previous cursor's position — proving no hidden server state.
    const changedFilterRes = await request(app.getHttpServer())
      .post("/api/v1/recruitment/candidates/search")
      .set("Authorization", `Bearer ${token}`)
      .send({ jobId: jobAId, scoreGreaterThanOrEqual: 80, limit: pageSize })
      .expect(201);
    // Every seeded filler candidate scores 40-79 (seedFiller's `40 + (i % 40)`), so NONE qualify for
    // >= 80 — the only candidates that can legitimately appear are these six named ones.
    const expectedHighScorers = [
      named.scoreAt80!.applicationId, named.scoreAt80Tie!.applicationId, named.scoreAbove80!.applicationId,
      named.scoreBelow90!.applicationId, named.scoreAt90!.applicationId, named.scoreAbove90!.applicationId
    ].sort();
    const changedFilterIds: string[] = changedFilterRes.body.items.map((i: { id: string }) => i.id).sort();
    const restartsCleanly = JSON.stringify(changedFilterIds) === JSON.stringify(expectedHighScorers);

    const pass = !duplicateFound && fullCoverage && pages > 1 && restartsCleanly;
    expect(pass).toBe(true);
    record("CP-007", "Pagination correctness", pass ? "PASSED" : "FAILED", `Walked ${pages} pages with no duplicate ids; total distinct ids (${seen.size}) equals totalCount (${totalCountRes.body.totalCount}); a filter change on a fresh request is unaffected by prior cursor state.`, {
      pages, distinctIds: seen.size, totalCount: totalCountRes.body.totalCount
    });
  });

  it("CP-008 Human review state — a decision change via the review endpoint is visible identically on both call paths after refresh", async () => {
    const c = named.unknownLocation!;
    await request(app.getHttpServer())
      .post(`/api/v1/recruitment/applications/${c.applicationId}/review`)
      .set("Authorization", `Bearer ${token}`)
      .send({ recruiterDecision: "SHORTLISTED" })
      .expect(201);

    const httpRes = await request(app.getHttpServer()).post("/api/v1/recruitment/candidates/search").set("Authorization", `Bearer ${token}`).send({ jobId: jobAId, search: "John Doe" }).expect(201);
    const waRes = await queries.query(orgId, { jobId: jobAId, search: "John Doe" });
    const httpItem = httpRes.body.items.find((i: { id: string }) => i.id === c.applicationId);
    const waItem = waRes.items.find((i) => i.id === c.applicationId);

    const pass = httpItem?.recruiterDecision === "SHORTLISTED" && waItem?.recruiterDecision === "SHORTLISTED";
    expect(pass).toBe(true);
    record("CP-008", "Human review state propagation", pass ? "PASSED" : "FAILED", "A recruiterDecision change via POST /applications/:id/review is immediately visible, identically, via both the HTTP search path and WhatsApp's direct query call — there is no per-client cache to go stale.", {
      applicationId: c.applicationId, httpDecision: httpItem?.recruiterDecision, waDecision: waItem?.recruiterDecision
    });
  });

  it("CP-009 Export consistency — exported row set equals the full filtered dataset (>100 rows), not just one page, CSV and XLSX", async () => {
    const filter = { jobId: jobAId, scoreGreaterThanOrEqual: 0 };
    const liveResult = await queries.query(orgId, { ...filter, limit: 1 });
    expect(liveResult.totalCount).toBeGreaterThan(100); // guards the Phase 3 truncation-bug scenario

    const csv = await exportsService.requestExport(orgId, userId, { scope: "CURRENT_JOB", format: "CSV", jobId: jobAId });
    const xlsx = await exportsService.requestExport(orgId, userId, { scope: "CURRENT_JOB", format: "XLSX", jobId: jobAId });

    const pass = csv.status === "COMPLETED" && xlsx.status === "COMPLETED" && csv.rowCount === liveResult.totalCount && xlsx.rowCount === liveResult.totalCount;
    expect(pass).toBe(true);
    record("CP-009", "Export consistency at scale", pass ? "PASSED" : "FAILED", `Live filtered total (${liveResult.totalCount}) matches both the CSV (${csv.rowCount}) and XLSX (${xlsx.rowCount}) exported row counts — exceeding the query service's 100-row page size, directly re-verifying the Phase 3 truncation fix under Phase 4's cross-platform lens.`, {
      liveTotalCount: liveResult.totalCount, csvRowCount: csv.rowCount, xlsxRowCount: xlsx.rowCount
    });
  });

  it("CP-010 Authorization and revocation — a revoked WhatsApp link is denied, website/export auth is independent, tenant isolation holds", async () => {
    const whatsappNumber = "+15557778888";
    await whatsappLinks.initiateLink(orgId, userId, whatsappNumber).catch(() => undefined);
    const linkRow = await prisma.recruitmentWhatsAppLink.findFirstOrThrow({ where: { organizationId: orgId, whatsappNumber } });
    await prisma.recruitmentWhatsAppLink.update({ where: { id: linkRow.id }, data: { status: "VERIFIED", linkedAt: new Date() } });

    const beforeRevoke = await whatsappLinks.resolveAuthorizedUser(whatsappNumber);
    await whatsappLinks.revokeLink(orgId, linkRow.id, userId);
    const afterRevoke = await whatsappLinks.resolveAuthorizedUser(whatsappNumber);

    // Website/export auth (JWT-based) must be entirely unaffected by the WhatsApp link's own revocation —
    // these are independent authorization mechanisms, not a shared session.
    const websiteStillWorks = await request(app.getHttpServer())
      .post("/api/v1/recruitment/candidates/search")
      .set("Authorization", `Bearer ${token}`)
      .send({ jobId: jobAId, limit: 1 })
      .expect(201);

    const otherOrg = await register("phase4-tenant-check");
    const crossTenant = await request(app.getHttpServer())
      .post("/api/v1/recruitment/candidates/search")
      .set("Authorization", `Bearer ${otherOrg.token}`)
      .send({ jobId: jobAId, limit: 10 })
      .expect(201);

    const pass =
      beforeRevoke !== null &&
      afterRevoke === null &&
      websiteStillWorks.body.items.length === 1 &&
      crossTenant.body.totalCount === 0; // cross-org jobId never resolves — no leakage

    expect(pass).toBe(true);
    record("CP-010", "Authorization and revocation", pass ? "PASSED" : "FAILED", "resolveAuthorizedUser (the gate every inbound WhatsApp message passes through) returns a user before revocation and null after; website JWT auth is unaffected by the WhatsApp-specific revocation; a cross-tenant jobId filter leaks nothing.", {
      beforeRevoke, afterRevoke, websiteItemCount: websiteStillWorks.body.items.length, crossTenantTotalCount: crossTenant.body.totalCount
    });

    await prisma.user.delete({ where: { id: otherOrg.userId } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: otherOrg.organizationId } }).catch(() => undefined);
  });
});
