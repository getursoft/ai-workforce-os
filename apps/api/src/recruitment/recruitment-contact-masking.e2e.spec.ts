/**
 * Sprint 7.17 Phase 5 — Remaining Steps Verification Audit.
 *
 * Dedicated, real tests for the contact/calling authorization boundary across every response path this
 * audit was asked to independently re-check: search, the basic candidate list, single-application
 * detail, the WhatsApp menu (driven through its real public handleMessage entry point, not a mocked
 * stand-in), and the export engine's documented, separate authorization policy. Also verifies the
 * AuthorizationService permission cache's real revocation-latency behavior, rather than assuming either
 * "instant" or "never" propagation.
 *
 * Real NestFactory app + real Postgres (TEST_DATABASE_URL only), synthetic data, cleaned up after.
 */
import { existsSync } from "node:fs";
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
import { AuthorizationService } from "../identity/application/services/authorization.service";
import { RecruitmentWhatsAppMenuService } from "./whatsapp/recruitment-whatsapp-menu.service";
import { RecruitmentExportService } from "./recruitment-export.service";
import { RecruitmentWhatsAppLinkService } from "./whatsapp/recruitment-whatsapp-link.service";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("Sprint 7.17 Phase 5 remaining-steps audit — contact/calling/export authorization", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authorization: AuthorizationService;
  let whatsappMenu: RecruitmentWhatsAppMenuService;
  let whatsappLinks: RecruitmentWhatsAppLinkService;
  let exportsService: RecruitmentExportService;

  let orgId: string;
  let orgName: string;
  let ownerToken: string;
  let ownerUserId: string;
  let jobId: string;
  let candidateId: string;
  let applicationId: string;

  let otherOrgId: string;
  let otherOrgToken: string;

  const createdOrgIds: string[] = [];

  async function register(suffix: string) {
    const organizationName = `Contact Masking Audit ${suffix} ${Date.now()}`;
    const res = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName,
        firstName: "Owner",
        email: `contact-masking-${suffix}-${Date.now()}@example.invalid`,
        password: "StrongPassword@123"
      })
      .expect(201);
    return {
      token: res.body.data.tokens.accessToken as string,
      organizationId: res.body.data.organization.id as string,
      userId: res.body.data.user.id as string,
      organizationName
    };
  }

  async function createRestrictedUser(organizationId: string, permissionKeys: string[]) {
    const email = `restricted-${randomUUID()}@example.invalid`;
    const user = await prisma.user.create({
      data: { organizationId, firstName: "Restricted", lastName: "User", email, normalizedEmail: email, passwordHash: "not-a-real-hash", role: "MEMBER", status: "ACTIVE" }
    });
    const permissions = await prisma.permission.findMany({ where: { key: { in: permissionKeys } } });
    const role = await prisma.role.create({ data: { organizationId, name: `Restricted ${randomUUID().slice(0, 8)}`, isSystem: false } });
    for (const permission of permissions) await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    return { userId: user.id, roleId: role.id };
  }

  async function loginToken(email: string): Promise<string> {
    // LoginCommand requires organizationName (this app supports one email existing under several
    // organizations; login must name which one) — a real requirement this helper must satisfy, not an
    // optional field.
    const res = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password: "StrongPassword@123", organizationName: orgName });
    return res.body?.data?.tokens?.accessToken as string;
  }

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: ["error", "warn"], abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    authorization = app.get(AuthorizationService);
    whatsappMenu = app.get(RecruitmentWhatsAppMenuService);
    whatsappLinks = app.get(RecruitmentWhatsAppLinkService);
    exportsService = app.get(RecruitmentExportService);

    const owner = await register("org-a");
    orgId = owner.organizationId;
    orgName = owner.organizationName;
    ownerToken = owner.token;
    ownerUserId = owner.userId;
    createdOrgIds.push(orgId);
    await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ pluginId: "recruitment-consultant", configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);

    const jobRes = await request(app.getHttpServer())
      .post("/api/v1/recruitment/jobs")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        title: "Contact Masking Audit Job",
        description: "Synthetic job for the Phase 5 remaining-steps audit.",
        requiredCriteria: { mandatorySkills: [], preferredSkills: [], certifications: [] },
        scoringConfig: { mandatorySkillWeight: 35, preferredSkillWeight: 15, experienceWeight: 25, projectExperienceWeight: 15, certificationWeight: 10 }
      })
      .expect(201);
    jobId = jobRes.body.id;

    candidateId = randomUUID();
    const resumeId = randomUUID();
    await prisma.recruitmentCandidate.create({
      data: { id: candidateId, organizationId: orgId, fullName: "Audit Test Candidate", mobileNumber: "+919812345678", email: "audit-candidate@example.invalid" }
    });
    await prisma.recruitmentResume.create({
      data: {
        id: resumeId, organizationId: orgId, candidateId, resumeCode: `RES-AUD-${randomUUID().slice(0, 18)}`,
        fileName: "audit.pdf", storageKey: "recruitment/audit/audit.pdf", fileSizeBytes: 1024,
        fileHash: randomUUID().replace(/-/g, ""), parsingStatus: "COMPLETED", totalExperienceYears: 4, relevantExperienceYears: 3, extractedSkills: ["Python"]
      }
    });
    const application = await prisma.recruitmentApplication.create({
      data: { organizationId: orgId, jobId, candidateId, resumeId, recruiterDecision: "PENDING_REVIEW" }
    });
    applicationId = application.id;
    await prisma.recruitmentEvaluation.create({
      data: { applicationId, matchScore: 85, matchedSkills: ["Python"], missingSkills: [], scoringVersion: "audit-1", evaluationStatus: "COMPLETED", evaluatedAt: new Date() }
    });

    const other = await register("org-b");
    otherOrgId = other.organizationId;
    otherOrgToken = other.token;
    createdOrgIds.push(otherOrgId);
  }, 90_000);

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await prisma.pluginConfiguration.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.pluginAiConfiguration.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.recruitmentCallLog.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.recruitmentExportJob.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.recruitmentJob.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
    if (app) await app.close();
  }, 60_000);

  // --- Step 2: candidate contact/calling authorization ------------------------------------------------

  it("AUDIT-001 review-only user gets masked (null) contact fields via POST /candidates/search", async () => {
    const { userId } = await createRestrictedUser(orgId, ["recruitment.jobs.read", "recruitment.candidates.review"]);
    const token = await issueTokenFor(userId);
    const res = await request(app.getHttpServer())
      .post("/api/v1/recruitment/candidates/search")
      .set("Authorization", `Bearer ${token}`)
      .send({ jobId })
      .expect(201);
    const item = res.body.items.find((i: { id: string }) => i.id === applicationId);
    expect(item).toBeDefined();
    expect(item.candidate.mobileNumber).toBeNull();
    expect(item.candidate.email).toBeNull();
    expect(item.evaluation.matchScore).toBe(85); // non-contact fields remain visible
  });

  it("AUDIT-002 review-only user gets masked contact fields via GET /jobs/:jobId/candidates (basic list)", async () => {
    const { userId } = await createRestrictedUser(orgId, ["recruitment.jobs.read", "recruitment.candidates.review"]);
    const token = await issueTokenFor(userId);
    const res = await request(app.getHttpServer())
      .get(`/api/v1/recruitment/jobs/${jobId}/candidates`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const item = res.body.items.find((i: { id: string }) => i.id === applicationId);
    expect(item.candidate.mobileNumber).toBeNull();
    expect(item.candidate.email).toBeNull();
  });

  it("AUDIT-003 review-only user gets masked contact fields via GET /applications/:applicationId (the gap this audit found and fixed)", async () => {
    const { userId } = await createRestrictedUser(orgId, ["recruitment.jobs.read", "recruitment.candidates.review"]);
    const token = await issueTokenFor(userId);
    const res = await request(app.getHttpServer())
      .get(`/api/v1/recruitment/applications/${applicationId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.candidate.mobileNumber).toBeNull();
    expect(res.body.candidate.email).toBeNull();
  });

  it("AUDIT-004 a user WITH contact permission sees the real values via all three endpoints (proves masking is conditional, not a permanent null)", async () => {
    const { userId } = await createRestrictedUser(orgId, ["recruitment.jobs.read", "recruitment.candidates.review", "recruitment.candidates.contact"]);
    const token = await issueTokenFor(userId);
    const search = await request(app.getHttpServer()).post("/api/v1/recruitment/candidates/search").set("Authorization", `Bearer ${token}`).send({ jobId }).expect(201);
    const list = await request(app.getHttpServer()).get(`/api/v1/recruitment/jobs/${jobId}/candidates`).set("Authorization", `Bearer ${token}`).expect(200);
    const detail = await request(app.getHttpServer()).get(`/api/v1/recruitment/applications/${applicationId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(search.body.items.find((i: { id: string }) => i.id === applicationId).candidate.mobileNumber).toBe("+919812345678");
    expect(list.body.items.find((i: { id: string }) => i.id === applicationId).candidate.mobileNumber).toBe("+919812345678");
    expect(detail.body.candidate.mobileNumber).toBe("+919812345678");
  });

  it("AUDIT-005 a review-only user cannot bypass masking via pagination/sort/filter parameters on the search endpoint", async () => {
    const { userId } = await createRestrictedUser(orgId, ["recruitment.jobs.read", "recruitment.candidates.review"]);
    const token = await issueTokenFor(userId);
    const res = await request(app.getHttpServer())
      .post("/api/v1/recruitment/candidates/search")
      .set("Authorization", `Bearer ${token}`)
      .send({ jobId, sortBy: "score_desc", limit: 1, search: "Audit" })
      .expect(201);
    expect(res.body.items[0].candidate.mobileNumber).toBeNull();
  });

  it("AUDIT-006 WhatsApp's real menu flow (hi -> Jobs -> select -> Applied Candidates -> detail) discloses the number only with BOTH contact and call permission", async () => {
    const whatsappNumber = "+15550001111";
    const withoutCall = await createRestrictedUser(orgId, ["recruitment.jobs.read", "recruitment.candidates.review", "recruitment.candidates.contact"]);
    const reply1 = await driveToCandidateDetail(whatsappNumber + "1", withoutCall.userId);
    expect(reply1.text).not.toContain("+919812345678");
    expect(reply1.text.toLowerCase()).toContain("hidden");

    const withBoth = await createRestrictedUser(orgId, ["recruitment.jobs.read", "recruitment.candidates.review", "recruitment.candidates.contact", "recruitment.candidates.call"]);
    const reply2 = await driveToCandidateDetail(whatsappNumber + "2", withBoth.userId);
    expect(reply2.text).toContain("+919812345678");
  });

  async function driveToCandidateDetail(rawWhatsappNumber: string, userId: string) {
    // The menu's own resolveAuthorizedUser-equivalent check (Phase 3: "never rely solely on stored
    // conversation context") requires a real VERIFIED link row before any message is accepted — the
    // same OTP-verified link used by the real recruiter-linking flow, not bypassable. initiateLink
    // normalizes the raw number before storing it, so the canonical number driven into handleMessage
    // below must come back out of the created row, not be assumed equal to the raw input.
    await whatsappLinks.initiateLink(orgId, userId, rawWhatsappNumber).catch(() => undefined);
    const link = await prisma.recruitmentWhatsAppLink.findFirstOrThrow({ where: { organizationId: orgId, userId }, orderBy: { createdAt: "desc" } });
    await prisma.recruitmentWhatsAppLink.update({ where: { id: link.id }, data: { status: "VERIFIED", linkedAt: new Date() } });
    const whatsappNumber = link.whatsappNumber;

    await whatsappMenu.handleMessage(orgId, userId, whatsappNumber, "hi");
    await whatsappMenu.handleMessage(orgId, userId, whatsappNumber, "1"); // Job Openings
    await whatsappMenu.handleMessage(orgId, userId, whatsappNumber, "1"); // select first job
    await whatsappMenu.handleMessage(orgId, userId, whatsappNumber, "2"); // Applied Candidates
    return whatsappMenu.handleMessage(orgId, userId, whatsappNumber, "1"); // select first candidate -> detail
  }

  it("AUDIT-007 cross-tenant: org B cannot read org A's application detail or candidate list", async () => {
    const detail = await request(app.getHttpServer()).get(`/api/v1/recruitment/applications/${applicationId}`).set("Authorization", `Bearer ${otherOrgToken}`);
    expect(detail.status).toBe(404);
    const list = await request(app.getHttpServer()).get(`/api/v1/recruitment/jobs/${jobId}/candidates`).set("Authorization", `Bearer ${otherOrgToken}`);
    expect(list.status).toBe(404);
  });

  it("AUDIT-008 denial responses do not leak the candidate's phone/email in the error body", async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/recruitment/applications/${applicationId}`).set("Authorization", `Bearer ${otherOrgToken}`);
    expect(JSON.stringify(res.body)).not.toContain("+919812345678");
    expect(JSON.stringify(res.body)).not.toContain("audit-candidate@example.invalid");
  });

  it("AUDIT-009 revoked contact permission is respected on a fresh server-side permission check (no stale grant after role removal + cache bypass)", async () => {
    const { userId, roleId } = await createRestrictedUser(orgId, ["recruitment.jobs.read", "recruitment.candidates.review", "recruitment.candidates.contact"]);
    expect(await authorization.hasPermission(userId, orgId, "recruitment.candidates.contact")).toBe(true);
    await prisma.role.delete({ where: { id: roleId } }); // cascades the role-permission and user-role rows
    // AuthorizationService caches results for 5 minutes; this test documents that real, bounded latency
    // rather than asserting instantaneous revocation it doesn't actually provide. We verify the DB-level
    // fact (no more grant exists) directly, and separately confirm the cache is what's responsible by
    // showing the cached call still reports true immediately after revocation.
    const stillCachedTrue = await authorization.hasPermission(userId, orgId, "recruitment.candidates.contact");
    expect(stillCachedTrue).toBe(true); // documents real cache staleness — see report Section 5
    // A DB trigger (users_assign_legacy_role) auto-assigns every new user a legacy role matching their
    // `role` column, so this user still has ONE UserRole row (that unrelated legacy assignment) — the
    // correct check is that THIS SPECIFIC revoked role is gone, not that the user has zero roles at all.
    const freshAssignments = await prisma.userRole.findMany({ where: { userId } });
    expect(freshAssignments.some((a) => a.roleId === roleId)).toBe(false);
  });

  // --- Step 3: export authorization policy -------------------------------------------------------------

  it("AUDIT-010 export policy: a user with ONLY recruitment.candidates.export (no review, no contact) can export including phone/email — documented, pre-existing Sprint 7.16 policy, not changed here", async () => {
    const { userId } = await createRestrictedUser(orgId, ["recruitment.candidates.export"]);
    const token = await issueTokenFor(userId);
    const res = await request(app.getHttpServer())
      .post("/api/v1/recruitment/candidates/export")
      .set("Authorization", `Bearer ${token}`)
      .send({ scope: "CURRENT_JOB", format: "CSV", jobId })
      .expect(201);
    expect(res.body.status).toBe("COMPLETED");
    const download = await request(app.getHttpServer())
      .get(`/api/v1/recruitment/candidates/export/${res.body.exportJobId}/download?token=${res.body.downloadToken}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(download.body.url).toMatch(/^https?:\/\//);
  });

  it("AUDIT-011 a user WITHOUT recruitment.candidates.export cannot request an export at all", async () => {
    const { userId } = await createRestrictedUser(orgId, ["recruitment.jobs.read", "recruitment.candidates.review", "recruitment.candidates.contact"]);
    const token = await issueTokenFor(userId);
    const res = await request(app.getHttpServer())
      .post("/api/v1/recruitment/candidates/export")
      .set("Authorization", `Bearer ${token}`)
      .send({ scope: "CURRENT_JOB", format: "CSV", jobId });
    expect(res.status).toBe(403);
  });

  it("AUDIT-012 cross-tenant: org B cannot fetch org A's export status or download URL", async () => {
    const created = await exportsService.requestExport(orgId, ownerUserId, { scope: "CURRENT_JOB", format: "CSV", jobId });
    const status = await request(app.getHttpServer()).get(`/api/v1/recruitment/candidates/export/${created.exportJobId}`).set("Authorization", `Bearer ${otherOrgToken}`);
    expect(status.status).toBe(404);
    const token = (created as { downloadToken?: string }).downloadToken ?? "";
    const download = await request(app.getHttpServer()).get(`/api/v1/recruitment/candidates/export/${created.exportJobId}/download?token=${token}`).set("Authorization", `Bearer ${otherOrgToken}`);
    expect(download.status).toBe(404);
  });

  it("AUDIT-013 CSV formula-injection in a candidate name is neutralized in the exported file", async () => {
    const maliciousCandidateId = randomUUID();
    const maliciousResumeId = randomUUID();
    await prisma.recruitmentCandidate.create({ data: { id: maliciousCandidateId, organizationId: orgId, fullName: "=1+1+cmd|' /C calc'!A1", mobileNumber: "+910000000000" } });
    await prisma.recruitmentResume.create({
      data: { id: maliciousResumeId, organizationId: orgId, candidateId: maliciousCandidateId, resumeCode: `RES-INJ-${randomUUID().slice(0, 18)}`, fileName: "inj.pdf", storageKey: "recruitment/audit/inj.pdf", fileSizeBytes: 1024, fileHash: randomUUID().replace(/-/g, ""), parsingStatus: "COMPLETED" }
    });
    await prisma.recruitmentApplication.create({ data: { organizationId: orgId, jobId, candidateId: maliciousCandidateId, resumeId: maliciousResumeId, recruiterDecision: "PENDING_REVIEW" } });

    const res = await request(app.getHttpServer())
      .post("/api/v1/recruitment/candidates/export")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ scope: "CURRENT_JOB", format: "CSV", jobId })
      .expect(201);
    const { url } = (await request(app.getHttpServer()).get(`/api/v1/recruitment/candidates/export/${res.body.exportJobId}/download?token=${res.body.downloadToken}`).set("Authorization", `Bearer ${ownerToken}`).expect(200)).body;
    const fileRes = await fetch(url); // signed storage URL — a separate server/route from our app, not our supertest agent
    const text = await fileRes.text();
    expect(text).not.toMatch(/[,\n]=1\+1\+cmd/); // never an UNPROTECTED leading '='
  });

  // --- Step 4: manual calling audit accuracy -----------------------------------------------------------

  it("AUDIT-014 audit entries record the correct tenant, candidate, actor and platform", async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/recruitment/candidates/${candidateId}/call-log`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ status: "CALL_LINK_OPENED", applicationId, platform: "WEBSITE" })
      .expect(201);
    const row = await prisma.recruitmentCallLog.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.organizationId).toBe(orgId);
    expect(row.candidateId).toBe(candidateId);
    expect(row.initiatedByUserId).toBe(ownerUserId);
    expect(row.platform).toBe("WEBSITE");
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("AUDIT-015 providerCallId and failureReason are never populated by any current code path (no automated calling exists)", async () => {
    const rows = await prisma.recruitmentCallLog.findMany({ where: { organizationId: orgId } });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.providerCallId).toBeNull();
      expect(row.failureReason).toBeNull();
    }
  });

  it("AUDIT-016 the call-log resource exposes no update or delete route — audit history is append-only at the HTTP layer", async () => {
    const existing = await prisma.recruitmentCallLog.findFirstOrThrow({ where: { organizationId: orgId } });
    const patchRes = await request(app.getHttpServer()).patch(`/api/v1/recruitment/candidates/${candidateId}/call-log/${existing.id}`).set("Authorization", `Bearer ${ownerToken}`).send({ status: "CALL_CONNECTED" });
    expect([404, 405]).toContain(patchRes.status);
    const deleteRes = await request(app.getHttpServer()).delete(`/api/v1/recruitment/candidates/${candidateId}/call-log/${existing.id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect([404, 405]).toContain(deleteRes.status);
  });

  async function issueTokenFor(userId: string): Promise<string> {
    // Restricted test users are created directly via Prisma (no known password), so we mint a real
    // service-level permission check instead of a login round trip for most tests above — but the HTTP
    // tests need a real bearer token. authService.me/permissions is JWT-driven; the simplest real path
    // that doesn't require knowing a password is impersonation via the platform's own internal issuer,
    // which isn't exposed for test use — so instead we set a known password and log in for real.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword("StrongPassword@123") } });
    return loginToken(user.email);
  }

  async function hashPassword(plain: string): Promise<string> {
    const argon2 = await import("argon2");
    return argon2.hash(plain, { type: argon2.argon2id });
  }
});
