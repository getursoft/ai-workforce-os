/**
 * Sprint 7.17 — Export Permission Revocation fix.
 *
 * Closes the blocker flagged by Krevia_Sprint_7.17_Phase5_Remaining_Verification: an export queued
 * before a permission revocation could continue and complete without rechecking the requester's current
 * authorization, because RecruitmentExportWorkerService.handle() never re-verified anything — it trusted
 * the PermissionGuard check that ran once, at enqueue time, against an HTTP request this background
 * handler never sees again.
 *
 * Real NestFactory app + real Postgres (TEST_DATABASE_URL only), synthetic data, cleaned up after.
 * No real external provider is involved anywhere in this file.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../app.module";
import { ApiExceptionFilter } from "../identity/presentation/http/api-exception.filter";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AuthorizationService } from "../identity/application/services/authorization.service";
import { RecruitmentExportService } from "./recruitment-export.service";
import { RecruitmentExportWorkerService } from "./recruitment-export-worker";
import { OBJECT_STORAGE, type ObjectStorageService } from "../storage/object-storage.types";
import type { QueueMessageView } from "../queue/queue.types";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("Sprint 7.17 — export permission revocation lifecycle", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authorization: AuthorizationService;
  let exportsService: RecruitmentExportService;
  let worker: RecruitmentExportWorkerService;
  let objectStorage: ObjectStorageService;

  let orgId: string;
  let orgName: string;
  let jobId: string;
  let otherOrgId: string;
  let otherOrgToken: string;

  const createdOrgIds: string[] = [];

  async function register(suffix: string) {
    const organizationName = `Export Revocation ${suffix} ${Date.now()}`;
    const res = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName,
        firstName: "Owner",
        email: `export-revocation-${suffix}-${Date.now()}@example.invalid`,
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

  /** A non-owner user holding exactly the given permissions — never the OWNER/ADMIN all-permissions
   * fallback — so every authorization check in this file exercises the real role/permission grant, not an
   * incidental superuser shortcut. */
  async function createRestrictedUser(organizationId: string, permissionKeys: string[]) {
    const email = `restricted-${randomUUID()}@example.invalid`;
    const user = await prisma.user.create({
      data: { organizationId, firstName: "Restricted", lastName: "User", email, normalizedEmail: email, passwordHash: "not-a-real-hash", role: "MEMBER", status: "ACTIVE" }
    });
    const permissions = await prisma.permission.findMany({ where: { key: { in: permissionKeys } } });
    const role = await prisma.role.create({ data: { organizationId, name: `Restricted ${randomUUID().slice(0, 8)}`, isSystem: false } });
    for (const permission of permissions) await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    authorization.invalidateUser(user.id, organizationId);
    return { userId: user.id, roleId: role.id, email: user.email };
  }

  /** Revokes the grant made above and makes sure the live AuthorizationService (used by both the HTTP
   * guard and the worker) reflects it immediately — deleting the role cascades role_permissions and
   * user_roles, and invalidateUser matches exactly what management.service.ts already does on every real
   * revocation action in this codebase (see recruitment-contact-masking.e2e.spec.ts AUDIT-009 for the
   * documented 5-minute cache-staleness window this bypasses deliberately for a deterministic test). */
  async function revoke(userId: string, roleId: string, organizationId: string) {
    await prisma.role.delete({ where: { id: roleId } });
    authorization.invalidateUser(userId, organizationId);
  }

  async function loginToken(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password: "StrongPassword@123", organizationName: orgName });
    return res.body?.data?.tokens?.accessToken as string;
  }

  async function issueTokenFor(userId: string): Promise<string> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const argon2 = await import("argon2");
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: await argon2.hash("StrongPassword@123", { type: argon2.argon2id }) } });
    return loginToken(user.email);
  }

  async function seedCandidate(organizationId: string, job: string, city: string) {
    const candidateId = randomUUID();
    const resumeId = randomUUID();
    await prisma.recruitmentCandidate.create({
      data: { id: candidateId, organizationId, fullName: `Candidate ${randomUUID().slice(0, 6)}`, currentCity: city, mobileNumber: "+910000000001", email: "synthetic@example.invalid" }
    });
    await prisma.recruitmentResume.create({
      data: {
        id: resumeId, organizationId, candidateId, resumeCode: `RES-REV-${randomUUID().slice(0, 18)}`,
        fileName: "r.pdf", storageKey: `recruitment/export-revocation/${resumeId}.pdf`, fileSizeBytes: 1024,
        fileHash: randomUUID().replace(/-/g, ""), parsingStatus: "COMPLETED", totalExperienceYears: 3, relevantExperienceYears: 2, extractedSkills: ["Python"]
      }
    });
    await prisma.recruitmentApplication.create({ data: { organizationId, jobId: job, candidateId, resumeId, recruiterDecision: "PENDING_REVIEW" } });
  }

  /** Builds a QueueMessageView by hand, exactly like recruitment-export-worker.e2e.spec.ts's existing
   * "idempotent" / "cancellation" tests do — worker.handle() is the real drain entry point; this file
   * never needs the actual PostgresQueueAdapter to exercise it. */
  function messageFor(exportJobId: string, attemptCount = 1, maxAttempts = 5): QueueMessageView {
    return {
      id: randomUUID(),
      organizationId: orgId,
      category: "RECRUITMENT_EXPORTS",
      refType: "RecruitmentExportJob",
      refId: exportJobId,
      employeeId: null,
      priority: 0,
      status: "CLAIMED",
      payload: {},
      availableAt: new Date(),
      attemptCount,
      maxAttempts,
      nextAttemptAt: null,
      workerId: "test-worker",
      traceId: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date()
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
    exportsService = app.get(RecruitmentExportService);
    worker = app.get(RecruitmentExportWorkerService);
    objectStorage = app.get(OBJECT_STORAGE);

    const owner = await register("org-a");
    orgId = owner.organizationId;
    orgName = owner.organizationName;
    createdOrgIds.push(orgId);
    await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ pluginId: "recruitment-consultant", configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);
    const jobRes = await request(app.getHttpServer())
      .post("/api/v1/recruitment/jobs")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({
        title: "Export Revocation Test Job",
        description: "Synthetic job for the export-revocation regression suite.",
        requiredCriteria: { mandatorySkills: [], preferredSkills: [], certifications: [] },
        scoringConfig: { mandatorySkillWeight: 35, preferredSkillWeight: 15, experienceWeight: 25, projectExperienceWeight: 15, certificationWeight: 10 }
      })
      .expect(201);
    jobId = jobRes.body.id;
    for (let i = 0; i < 8; i++) await seedCandidate(orgId, jobId, "Noida");
    for (let i = 0; i < 4; i++) await seedCandidate(orgId, jobId, "Pune");

    const other = await register("org-b");
    otherOrgId = other.organizationId;
    otherOrgToken = other.token;
    createdOrgIds.push(otherOrgId);
  }, 90_000);

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await prisma.pluginConfiguration.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.pluginAiConfiguration.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.recruitmentExportJob.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.recruitmentJob.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
    if (app) await app.close();
  }, 60_000);

  // --- 1. still authorized at both request and execution time (control case) ------------------------

  it("EXPREV-001 a user who still holds export permission at execution time: the queued job completes normally", async () => {
    const { userId, roleId } = await createRestrictedUser(orgId, ["recruitment.jobs.read", "recruitment.candidates.export"]);
    const exportJob = await prisma.recruitmentExportJob.create({
      data: { organizationId: orgId, requestedByUserId: userId, jobId, scope: "CURRENT_JOB", format: "CSV", status: "QUEUED", rowCount: 12 }
    });
    const ok = await worker.handle(messageFor(exportJob.id));
    expect(ok).toBe(true);
    const finished = await prisma.recruitmentExportJob.findUniqueOrThrow({ where: { id: exportJob.id } });
    expect(finished.status).toBe("COMPLETED");
    expect(finished.rowCount).toBe(12);
    expect(finished.storageKey).toBeTruthy();
    await revoke(userId, roleId, orgId); // cleanup — don't leak a still-valid grant into later tests
  });

  // --- 2. permission revoked while the job is queued ---------------------------------------------------

  it("EXPREV-002 permission revoked while QUEUED: the worker cancels the job instead of producing a file", async () => {
    const { userId, roleId } = await createRestrictedUser(orgId, ["recruitment.jobs.read", "recruitment.candidates.export"]);
    const exportJob = await prisma.recruitmentExportJob.create({
      data: { organizationId: orgId, requestedByUserId: userId, jobId, scope: "CURRENT_JOB", format: "CSV", status: "QUEUED", rowCount: 12 }
    });
    await revoke(userId, roleId, orgId);

    const ok = await worker.handle(messageFor(exportJob.id));
    expect(ok).toBe(true); // handled — not retried, this is a final decision, not a transient failure
    const after = await prisma.recruitmentExportJob.findUniqueOrThrow({ where: { id: exportJob.id } });
    expect(after.status).toBe("CANCELLED");
    expect(after.errorMessage).toBe("RECRUITMENT_EXPORT_AUTHORIZATION_REVOKED");
    expect(after.storageKey).toBeNull();
    expect(after.downloadToken).toBeNull();
  });

  // --- 3. permission revoked before a retry -------------------------------------------------------------

  it("EXPREV-003 permission revoked before a retried attempt: the retry is also denied, not just the first attempt", async () => {
    const { userId, roleId } = await createRestrictedUser(orgId, ["recruitment.jobs.read", "recruitment.candidates.export"]);
    const exportJob = await prisma.recruitmentExportJob.create({
      data: { organizationId: orgId, requestedByUserId: userId, jobId, scope: "CURRENT_JOB", format: "CSV", status: "QUEUED", rowCount: 12 }
    });
    // Simulates the queue's own backoff ladder re-invoking handle() for the SAME job on a later attempt —
    // authorization must be re-read every time handle() runs, not cached from a first pass.
    await revoke(userId, roleId, orgId);
    const ok = await worker.handle(messageFor(exportJob.id, /* attemptCount */ 3, 5));
    expect(ok).toBe(true);
    const after = await prisma.recruitmentExportJob.findUniqueOrThrow({ where: { id: exportJob.id } });
    expect(after.status).toBe("CANCELLED");
    expect(after.storageKey).toBeNull();
  });

  // --- 4. requester loses organization membership before execution --------------------------------------

  it("EXPREV-004 requester suspended (loses active org membership) before execution: worker cancels rather than exporting", async () => {
    const { userId, roleId } = await createRestrictedUser(orgId, ["recruitment.jobs.read", "recruitment.candidates.export"]);
    const exportJob = await prisma.recruitmentExportJob.create({
      data: { organizationId: orgId, requestedByUserId: userId, jobId, scope: "CURRENT_JOB", format: "CSV", status: "QUEUED", rowCount: 12 }
    });
    await prisma.user.update({ where: { id: userId }, data: { status: "SUSPENDED" } });
    authorization.invalidateUser(userId, orgId);

    const ok = await worker.handle(messageFor(exportJob.id));
    expect(ok).toBe(true);
    const after = await prisma.recruitmentExportJob.findUniqueOrThrow({ where: { id: exportJob.id } });
    expect(after.status).toBe("CANCELLED");
    expect(after.storageKey).toBeNull();

    await prisma.user.update({ where: { id: userId }, data: { status: "ACTIVE" } }); // restore before role cleanup
    await revoke(userId, roleId, orgId);
  });

  // --- 5. cross-tenant job ID guessing --------------------------------------------------------------------

  it("EXPREV-005 cross-tenant job ID guessing: org B gets 404 on org A's export status/cancel/download, never a leak", async () => {
    const created = await exportsService.requestExport(orgId, (await createRestrictedUser(orgId, ["recruitment.candidates.export"])).userId, {
      scope: "CURRENT_JOB", format: "CSV", jobId
    });
    const status = await request(app.getHttpServer()).get(`/api/v1/recruitment/candidates/export/${created.exportJobId}`).set("Authorization", `Bearer ${otherOrgToken}`);
    expect(status.status).toBe(404);
    const cancel = await request(app.getHttpServer()).post(`/api/v1/recruitment/candidates/export/${created.exportJobId}/cancel`).set("Authorization", `Bearer ${otherOrgToken}`);
    expect(cancel.status).toBe(404);
    const token = (created as { downloadToken?: string }).downloadToken ?? "";
    const download = await request(app.getHttpServer()).get(`/api/v1/recruitment/candidates/export/${created.exportJobId}/download?token=${token}`).set("Authorization", `Bearer ${otherOrgToken}`);
    expect(download.status).toBe(404);
  });

  // --- 6. another user (same tenant) polls/downloads someone else's export -------------------------------

  it("EXPREV-006 same-org, different user: cannot poll, cancel or download another user's export even while holding the export permission themselves", async () => {
    const owner = await createRestrictedUser(orgId, ["recruitment.candidates.export"]);
    const created = await exportsService.requestExport(orgId, owner.userId, { scope: "CURRENT_JOB", format: "CSV", jobId });

    const other = await createRestrictedUser(orgId, ["recruitment.candidates.export"]);
    const otherToken = await issueTokenFor(other.userId);

    const status = await request(app.getHttpServer()).get(`/api/v1/recruitment/candidates/export/${created.exportJobId}`).set("Authorization", `Bearer ${otherToken}`);
    expect(status.status).toBe(404); // ownership-scoped, not just org-scoped — see recruitment-export.service.ts
    const cancel = await request(app.getHttpServer()).post(`/api/v1/recruitment/candidates/export/${created.exportJobId}/cancel`).set("Authorization", `Bearer ${otherToken}`);
    expect(cancel.status).toBe(404);
    const token = (created as { downloadToken?: string }).downloadToken ?? "";
    const download = await request(app.getHttpServer()).get(`/api/v1/recruitment/candidates/export/${created.exportJobId}/download?token=${token}`).set("Authorization", `Bearer ${otherToken}`);
    expect(download.status).toBe(404);
  });

  // --- 7. permission revoked after artifact generation but before download -------------------------------

  it("EXPREV-007 permission revoked after the file is generated but before download: the real HTTP download route denies it (403), never returns a URL", async () => {
    const { userId, roleId } = await createRestrictedUser(orgId, ["recruitment.candidates.export"]);
    const token = await issueTokenFor(userId);
    const created = await request(app.getHttpServer())
      .post("/api/v1/recruitment/candidates/export")
      .set("Authorization", `Bearer ${token}`)
      .send({ scope: "CURRENT_JOB", format: "CSV", jobId })
      .expect(201);
    expect(created.body.status).toBe("COMPLETED");

    await revoke(userId, roleId, orgId);

    const status = await request(app.getHttpServer()).get(`/api/v1/recruitment/candidates/export/${created.body.exportJobId}`).set("Authorization", `Bearer ${token}`);
    expect(status.status).toBe(403); // PermissionGuard re-checks on every request — the artifact exists, access does not
    const download = await request(app.getHttpServer()).get(`/api/v1/recruitment/candidates/export/${created.body.exportJobId}/download?token=${created.body.downloadToken}`).set("Authorization", `Bearer ${token}`);
    expect(download.status).toBe(403);
  });

  // --- 8. worker's authorization lookup itself fails ------------------------------------------------------

  it("EXPREV-008 the worker's authorization lookup throwing: fails closed (FAILED, no file), never exports on an unreadable auth state", async () => {
    const { userId, roleId } = await createRestrictedUser(orgId, ["recruitment.jobs.read", "recruitment.candidates.export"]);
    const exportJob = await prisma.recruitmentExportJob.create({
      data: { organizationId: orgId, requestedByUserId: userId, jobId, scope: "CURRENT_JOB", format: "CSV", status: "QUEUED", rowCount: 12 }
    });
    // Simulated fault injection on our OWN already-injected AuthorizationService dependency — not a real
    // provider, not real infrastructure failure, just exercising the catch branch deterministically.
    const spy = vi.spyOn(authorization, "canAccessOrganization").mockRejectedValueOnce(new Error("simulated authorization lookup failure"));
    const ok = await worker.handle(messageFor(exportJob.id));
    expect(ok).toBe(true);
    const after = await prisma.recruitmentExportJob.findUniqueOrThrow({ where: { id: exportJob.id } });
    expect(after.status).toBe("FAILED");
    expect(after.errorMessage).toBe("RECRUITMENT_EXPORT_AUTH_CHECK_FAILED");
    expect(after.storageKey).toBeNull();
    spy.mockRestore();
    await revoke(userId, roleId, orgId);
  });

  // --- 9. authorized export still preserves correct row counts and filtering ------------------------------

  it("EXPREV-009 authorized export through the worker still applies filters correctly and returns the exact matching row count", async () => {
    const { userId, roleId } = await createRestrictedUser(orgId, ["recruitment.jobs.read", "recruitment.candidates.export"]);
    const exportJob = await prisma.recruitmentExportJob.create({
      data: {
        organizationId: orgId, requestedByUserId: userId, jobId, scope: "FILTERED", format: "CSV",
        filters: { currentCity: ["Noida"] }, status: "QUEUED", rowCount: 8
      }
    });
    const ok = await worker.handle(messageFor(exportJob.id));
    expect(ok).toBe(true);
    const after = await prisma.recruitmentExportJob.findUniqueOrThrow({ where: { id: exportJob.id } });
    expect(after.status).toBe("COMPLETED");
    expect(after.rowCount).toBe(8); // exactly the 8 Noida candidates seeded in beforeAll, not all 12
    await revoke(userId, roleId, orgId);
  });

  // --- 10. cancellation/failure never leaves a partial file or a stale accessible artifact -----------------

  it("EXPREV-010 a job cancelled for authorization reasons is never downloadable afterward — no partial or stale artifact is ever exposed", async () => {
    const { userId, roleId } = await createRestrictedUser(orgId, ["recruitment.jobs.read", "recruitment.candidates.export"]);
    const exportJob = await prisma.recruitmentExportJob.create({
      data: { organizationId: orgId, requestedByUserId: userId, jobId, scope: "CURRENT_JOB", format: "CSV", status: "QUEUED", rowCount: 12 }
    });
    await revoke(userId, roleId, orgId);
    await worker.handle(messageFor(exportJob.id));
    const after = await prisma.recruitmentExportJob.findUniqueOrThrow({ where: { id: exportJob.id } });
    expect(after.status).toBe("CANCELLED");
    // getDownloadUrl requires status === COMPLETED and a non-null storageKey — a cancelled job satisfies
    // neither, by construction, regardless of what token is supplied.
    await expect(exportsService.getDownloadUrl(orgId, exportJob.id, "any-token-value", userId)).rejects.toThrow();
  });

  // --- 11. Phase 5.1 — permission revoked strictly MID-EXPORT, after at least one page has already been
  //          written, not merely between a QUEUED job and the attempt that drains it (that gap was closed
  //          by EXPREV-002/003/004/008 above). This is the specific remaining risk named in
  //          Krevia_Sprint_7.17_Export_Revocation_UAT: "authorization is checked at the beginning of each
  //          attempt, but not necessarily during every page of a running export." --------------------------

  it("EXPREV-011 permission revoked mid-export, after page 1 is written but before page 2: the worker halts before any further page is fetched, writes no more rows, and uploads no artifact", async () => {
    const { userId, roleId } = await createRestrictedUser(orgId, ["recruitment.jobs.read", "recruitment.candidates.export"]);
    const bigJob = await prisma.recruitmentJob.create({
      data: {
        organizationId: orgId, jobCode: `JOB-MIDEXPORT-${randomUUID().slice(0, 8)}`, title: "Mid-Export Revocation Test Job",
        description: "Synthetic job seeded with 250 candidates solely to force a real multi-page (3-page) export.",
        requiredCriteria: { mandatorySkills: [], preferredSkills: [], certifications: [] },
        scoringConfig: { mandatorySkillWeight: 35, preferredSkillWeight: 15, experienceWeight: 25, projectExperienceWeight: 15, certificationWeight: 10 },
        status: "OPEN", createdByUserId: userId
      }
    });
    for (let i = 0; i < 250; i++) await seedCandidate(orgId, bigJob.id, "Noida"); // 3 pages at EXPORT_PAGE_SIZE=100

    const exportJob = await prisma.recruitmentExportJob.create({
      data: { organizationId: orgId, requestedByUserId: userId, jobId: bigJob.id, scope: "CURRENT_JOB", format: "CSV", status: "QUEUED", rowCount: 250 }
    });
    const storageKey = `recruitment/exports/${exportJob.id}.csv`;

    // isRequesterAuthorized() is called once at the top of handle() (call 1), then once more immediately
    // before EVERY page fetch inside the write loop (call 2 = before page 1, call 3 = before page 2, ...).
    // Allowing exactly the first 2 calls through and failing membership from call 3 onward simulates a
    // revocation landing strictly AFTER page 1 (100 rows) was already written to the file, but before
    // page 2 is ever fetched — the precise scenario this test exists to prove is caught.
    let calls = 0;
    const spy = vi.spyOn(authorization, "canAccessOrganization").mockImplementation(async () => {
      calls += 1;
      return calls <= 2;
    });
    const putObjectSpy = vi.spyOn(objectStorage, "putObject");

    const ok = await worker.handle(messageFor(exportJob.id));
    expect(ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3); // proves the mid-export checkpoint actually ran, not just the top-of-handle one

    spy.mockRestore();

    const after = await prisma.recruitmentExportJob.findUniqueOrThrow({ where: { id: exportJob.id } });
    expect(after.status).toBe("CANCELLED");
    expect(after.errorMessage).toBe("RECRUITMENT_EXPORT_AUTHORIZATION_REVOKED_MID_EXPORT");
    expect(after.storageKey).toBeNull();
    expect(after.downloadToken).toBeNull();
    expect(putObjectSpy).not.toHaveBeenCalled(); // no file — partial or otherwise — was ever uploaded to storage
    expect(await objectStorage.objectExists(orgId, storageKey)).toBe(false);
    putObjectSpy.mockRestore();

    // A different user who still holds the export permission cannot be handed this half-finished job
    // either — ownership scoping (EXPREV-006) and the CANCELLED/null-storageKey state above combine to
    // make it unreachable via any route.
    await expect(exportsService.getDownloadUrl(orgId, exportJob.id, "any-token", userId)).rejects.toThrow();

    await revoke(userId, roleId, orgId);
  }, 30_000);
});
