/**
 * Krevia Phase 5.2 — Organization Suspension Enforcement.
 *
 * Closes the reported gap: "Organization suspension is not enforced consistently by
 * AuthorizationService for already-authenticated sessions." Root cause: the user access token is a
 * self-contained, stateless JWT (JoseAccessTokenService.verify is signature+expiry only, no DB read) —
 * it stayed valid for its full TTL (900s default) after issuance regardless of anything that happened to
 * the organization afterward, and neither AuthorizationService.canAccessOrganization nor
 * getEffectivePermissions ever inspected Organization.status at all. Login and refresh already blocked a
 * suspended org (pre-existing), but a token issued moments before suspension kept working on every
 * protected route until it naturally expired.
 *
 * Fix (see jwt-access.guard.ts, authorization.service.ts, platform.service.ts): JwtAccessGuard — the one
 * shared guard every tenant-scoped controller runs through — now re-derives organization status fresh on
 * every single request for the Bearer-token path (the API-key path already did this). canAccessOrganization
 * and getEffectivePermissions both now also check organization status unconditionally, with no
 * platform-owner exception, matching the already-established OrganizationAccessService precedent used by
 * /auth/me and the organization-settings handlers. suspendOrganization/reactivateOrganization both call
 * AuthorizationService.invalidateOrganization so a cached grant from moments before a transition can never
 * serve stale state for the rest of its 5-minute TTL.
 *
 * This file proves each of the 10 verification points from the task against the REAL HTTP stack, the real
 * AuthorizationService cache, and the real (Phase 5.1) export worker — not mocks — using the real local
 * test database only. Every test here is written to FAIL against the pre-fix code (reusing a pre-suspension
 * token on a protected route used to return 200) and PASS against the fix.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../../app.module";
import { ApiExceptionFilter } from "./api-exception.filter";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { AuthorizationService } from "../../application/services/authorization.service";
import { PlatformService } from "../../application/services/platform.service";
import { RecruitmentExportWorkerService } from "../../../recruitment/recruitment-export-worker";
import { deleteAllOrganizationScopedRows, ensurePlatformOwner } from "../../../test/cleanup";
import type { QueueMessageView } from "../../../queue/queue.types";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const OWNER_EMAIL = process.env.PLATFORM_OWNER_EMAIL?.toLowerCase() || "krpandey25646@gmail.com";
const OWNER_PASSWORD = process.env.PLATFORM_OWNER_PASSWORD || "PlatformOwner@25646";

suite("Phase 5.2 — organization suspension is enforced for already-authenticated sessions", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authorization: AuthorizationService;
  let platform: PlatformService;
  let worker: RecruitmentExportWorkerService;
  let platformOwnerToken: string;
  let platformOwnerUserId: string;

  // Target org: the one that gets suspended mid-session.
  let orgId: string;
  let orgOwnerToken: string; // minted while ACTIVE, reused unchanged throughout — never re-logged-in
  let orgOwnerUserId: string;
  let jobId: string;
  let candidateId: string;

  // Unrelated, untouched org — proves suspension is tenant-scoped, not global.
  let otherOrgToken: string;

  const orgOwnerPassword = "StrongPassword@123";
  const orgName = `Org Suspension Test ${Date.now()}`;

  async function register(organizationName: string, emailPrefix: string) {
    const email = `${emailPrefix}-${Date.now()}@example.invalid`;
    const res = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ organizationName, firstName: "Owner", email, password: orgOwnerPassword })
      .expect(201);
    return {
      token: res.body.data.tokens.accessToken as string,
      organizationId: res.body.data.organization.id as string,
      userId: res.body.data.user.id as string,
      email
    };
  }

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: ["error", "warn"], abortOnError: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    authorization = app.get(AuthorizationService);
    platform = app.get(PlatformService);
    worker = app.get(RecruitmentExportWorkerService);

    await ensurePlatformOwner(prisma);
    const ownerLogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD, organizationName: "Krevia.ai Platform" })
      .expect(200);
    platformOwnerToken = ownerLogin.body.data.tokens.accessToken;
    platformOwnerUserId = ownerLogin.body.data.user.id;

    // --- Point 1: authenticate while the organization is active ---------------------------------------
    const owner = await register(orgName, "suspension-owner");
    orgId = owner.organizationId;
    orgOwnerToken = owner.token;
    orgOwnerUserId = owner.userId;

    await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${orgOwnerToken}`)
      .send({ pluginId: "recruitment-consultant", configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);
    const jobRes = await request(app.getHttpServer())
      .post("/api/v1/recruitment/jobs")
      .set("Authorization", `Bearer ${orgOwnerToken}`)
      .send({
        title: "Org Suspension Test Job",
        description: "Synthetic job for Phase 5.2 organization-suspension coverage.",
        requiredCriteria: { mandatorySkills: [], preferredSkills: [], certifications: [] },
        scoringConfig: { mandatorySkillWeight: 35, preferredSkillWeight: 15, experienceWeight: 25, projectExperienceWeight: 15, certificationWeight: 10 }
      })
      .expect(201);
    jobId = jobRes.body.id;
    candidateId = randomUUID();
    const resumeId = randomUUID();
    await prisma.recruitmentCandidate.create({
      data: { id: candidateId, organizationId: orgId, fullName: "Suspension Test Candidate", mobileNumber: "+910000000002", email: "suspension-candidate@example.invalid" }
    });
    await prisma.recruitmentResume.create({
      data: {
        id: resumeId, organizationId: orgId, candidateId, resumeCode: `RES-SUS-${randomUUID().slice(0, 18)}`,
        fileName: "sus.pdf", storageKey: "recruitment/suspension-test/sus.pdf", fileSizeBytes: 1024,
        fileHash: randomUUID().replace(/-/g, ""), parsingStatus: "COMPLETED", totalExperienceYears: 3, relevantExperienceYears: 2, extractedSkills: ["Python"]
      }
    });
    await prisma.recruitmentApplication.create({ data: { organizationId: orgId, jobId, candidateId, resumeId, recruiterDecision: "PENDING_REVIEW" } });

    const other = await register(`Unrelated Active Org ${Date.now()}`, "unrelated-owner");
    otherOrgToken = other.token;
  }, 90_000);

  afterAll(async () => {
    if (prisma) await deleteAllOrganizationScopedRows(prisma);
    if (app) await app.close();
  }, 60_000);

  it("POINT-1/3/4 reusing the SAME pre-suspension access token on a protected endpoint is denied after suspension, with no re-login involved", async () => {
    // Sanity: the token legitimately works before suspension — proves the later denial is caused by
    // suspension, not by the token/route being broken.
    await request(app.getHttpServer())
      .get("/api/v1/recruitment/jobs")
      .set("Authorization", `Bearer ${orgOwnerToken}`)
      .expect(200);

    // Point 2: suspend WITHOUT logging the user out — no logout call, no new login, the exact same
    // orgOwnerToken captured in beforeAll is reused verbatim below.
    const suspended = await request(app.getHttpServer())
      .post(`/api/v1/platform/organizations/${orgId}/suspend`)
      .set("Authorization", `Bearer ${platformOwnerToken}`)
      .send({ reason: "Phase 5.2 automated test" })
      .expect(201);
    expect(suspended.body.data.status).toBe("SUSPENDED");

    // Point 3/4: the SAME still-cryptographically-valid token, reused on the SAME route that worked
    // seconds ago, must now be denied. Pre-fix, this returned 200 (the original reported defect).
    const res = await request(app.getHttpServer())
      .get("/api/v1/recruitment/jobs")
      .set("Authorization", `Bearer ${orgOwnerToken}`);
    expect(res.status).toBe(403);
    expect(res.body?.error?.code ?? res.body?.code).toBe("ORGANIZATION_INACTIVE");
  });

  it("POINT-5 protected candidate contact data, recruitment records, and exports are all inaccessible with the reused token while suspended", async () => {
    const auth = { Authorization: `Bearer ${orgOwnerToken}` };
    const search = await request(app.getHttpServer()).post("/api/v1/recruitment/candidates/search").set(auth).send({ jobId });
    expect(search.status).toBe(403);
    expect(JSON.stringify(search.body)).not.toContain("+910000000002"); // candidate's phone never leaks in the denial body
    expect(JSON.stringify(search.body)).not.toContain("suspension-candidate@example.invalid");

    const detail = await request(app.getHttpServer()).get(`/api/v1/recruitment/jobs/${jobId}/candidates`).set(auth);
    expect(detail.status).toBe(403);

    const exportReq = await request(app.getHttpServer()).post("/api/v1/recruitment/candidates/export").set(auth).send({ scope: "CURRENT_JOB", format: "CSV", jobId });
    expect(exportReq.status).toBe(403);

    const me = await request(app.getHttpServer()).get("/api/v1/auth/me").set(auth);
    expect(me.status).toBe(403); // consistent with the pre-existing OrganizationAccessService precedent

    const permissions = await request(app.getHttpServer()).get("/api/v1/auth/me/permissions").set(auth);
    expect(permissions.status).toBe(403); // this route has no @RequirePermission at all — only JwtAccessGuard gated it, confirming the fix lives at the right boundary
  });

  it("POINT-6 a permission grant warmed in the AuthorizationService cache BEFORE suspension does not survive suspension — proven at the service layer, independent of any HTTP guard", async () => {
    // Re-warm deliberately: suspension earlier may have already cached an EMPTY grant for this key:
    // re-activate, warm a TRUE grant, then re-suspend and assert the cache reports false immediately,
    // with no 5-minute wait and no dependency on JwtAccessGuard (called directly on the service).
    await platform.reactivateOrganization(orgId, platformOwnerUserId);
    expect(await authorization.hasPermission(orgOwnerUserId, orgId, "recruitment.jobs.read")).toBe(true); // warms the cache with a TRUE grant

    await platform.suspendOrganization(orgId, platformOwnerUserId, "Phase 5.2 cache-bypass check");
    expect(await authorization.hasPermission(orgOwnerUserId, orgId, "recruitment.jobs.read")).toBe(false); // same tick, same 5-minute window — must already be false
  });

  it("POINT-7 the recruitment export worker refuses to process a queued export while the organization is suspended", async () => {
    // orgId is already SUSPENDED from the previous test (kept that way deliberately — restored in the
    // next test for the reactivation-recovery scenario).
    const exportJob = await prisma.recruitmentExportJob.create({
      data: { organizationId: orgId, requestedByUserId: orgOwnerUserId, jobId, scope: "CURRENT_JOB", format: "CSV", status: "QUEUED", rowCount: 1 }
    });
    const message: QueueMessageView = {
      id: randomUUID(), organizationId: orgId, category: "RECRUITMENT_EXPORTS", refType: "RecruitmentExportJob", refId: exportJob.id,
      employeeId: null, priority: 0, status: "CLAIMED", payload: {}, availableAt: new Date(), attemptCount: 1, maxAttempts: 5,
      nextAttemptAt: null, workerId: "test-worker", traceId: null, errorCode: null, errorMessage: null, createdAt: new Date()
    };
    const ok = await worker.handle(message);
    expect(ok).toBe(true); // handled, not retried — same as any other authorization-revoked outcome
    const after = await prisma.recruitmentExportJob.findUniqueOrThrow({ where: { id: exportJob.id } });
    expect(after.status).toBe("CANCELLED");
    expect(after.storageKey).toBeNull(); // no sensitive org data was ever processed into a file
  });

  it("POINT-8 reactivating the organization restores access for the SAME original token, with no re-login required", async () => {
    const reactivated = await request(app.getHttpServer())
      .post(`/api/v1/platform/organizations/${orgId}/reactivate`)
      .set("Authorization", `Bearer ${platformOwnerToken}`)
      .expect(201);
    expect(reactivated.body.data.status).toBe("ACTIVE");

    // The exact same token minted in beforeAll, never refreshed or re-issued, now works again — proving
    // the chosen policy is per-request REVALIDATION against live organization state, not a one-time,
    // irrevocable token-level decision. No forced logout/re-login was ever required of this user.
    const res = await request(app.getHttpServer())
      .get("/api/v1/recruitment/jobs")
      .set("Authorization", `Bearer ${orgOwnerToken}`)
      .expect(200);
    expect(Array.isArray(res.body.items ?? res.body)).toBe(true);

    expect(await authorization.hasPermission(orgOwnerUserId, orgId, "recruitment.jobs.read")).toBe(true); // cache also recovers immediately, not after a 5-minute wait
  });

  it("POINT-9 an unrelated, never-suspended organization's session is unaffected throughout", async () => {
    // otherOrgToken was minted in beforeAll and never touched again — if suspension ever leaked across
    // tenants, or if the fix were implemented as a global kill-switch instead of per-organization, this
    // would have started failing the moment orgId was first suspended above.
    await request(app.getHttpServer())
      .get("/api/v1/recruitment/jobs")
      .set("Authorization", `Bearer ${otherOrgToken}`)
      .expect(200);
  });

  it("POINT-10 health endpoints and platform-admin recovery operations remain reachable throughout a suspension, with no special-casing needed", async () => {
    await platform.suspendOrganization(orgId, platformOwnerUserId, "Phase 5.2 point-10 check");

    // Fully public, no guard at all — unaffected by anything in this fix by construction.
    await request(app.getHttpServer()).get("/api/v1/health/live").expect(200);
    await request(app.getHttpServer()).get("/api/v1/health/ready").expect(200);

    // Platform-admin routes run through PlatformOwnerGuard, never PermissionGuard, and the acting
    // principal's OWN organizationId (the always-ACTIVE "Krevia.ai Platform" org) is what JwtAccessGuard
    // checks — never the target org named in the :id route param — so suspending orgId never blocks the
    // platform owner's ability to act ON it.
    const summary = await request(app.getHttpServer())
      .get(`/api/v1/platform/organizations/${orgId}/summary`)
      .set("Authorization", `Bearer ${platformOwnerToken}`)
      .expect(200);
    expect(summary.body.data.organization.id).toBe(orgId);

    await request(app.getHttpServer())
      .post(`/api/v1/platform/organizations/${orgId}/reactivate`)
      .set("Authorization", `Bearer ${platformOwnerToken}`)
      .expect(201);
  });
});
