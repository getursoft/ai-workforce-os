/**
 * Krevia Phase 5.3 — background worker suspension audit: RecruitmentBatchProcessor.
 *
 * Resumes/candidate contact data are explicitly named as a priority in that audit. This poller runs on
 * its own setInterval tick (500ms) with no HTTP request, no JwtAccessGuard, and no per-user authorization
 * context at all — only an organizationId on each resume/application row. Before this fix, a QUEUED
 * resume for a suspended organization would still be parsed (candidate PII extracted, an LLM provider
 * potentially called) and a pending application would still be scored.
 *
 * Policy chosen (documented in recruitment-batch-processor.ts): DEFER, not terminal-fail. Unlike a single
 * discrete export job or channel message, a resume/application backlog has no urgency and no "resubmit"
 * concept for whoever uploaded it — the row is simply left untouched (retryCount and status unchanged)
 * while the organization is suspended, and is picked up again on a later tick once reactivated, with zero
 * data loss and no retry budget wasted on a suspension that was never the file's fault.
 *
 * Real NestFactory app + real Postgres (TEST_DATABASE_URL only), synthetic data, cleaned up after.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";
import { type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PlatformService } from "../identity/application/services/platform.service";
import { RecruitmentBatchProcessor } from "./recruitment-batch-processor";
import { ensurePlatformOwner } from "../test/cleanup";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const OWNER_EMAIL = process.env.PLATFORM_OWNER_EMAIL?.toLowerCase() || "krpandey25646@gmail.com";
const OWNER_PASSWORD = process.env.PLATFORM_OWNER_PASSWORD || "PlatformOwner@25646";

suite("Phase 5.3 — RecruitmentBatchProcessor defers (does not process) resumes for a suspended organization", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let platform: PlatformService;
  let batchProcessor: RecruitmentBatchProcessor;
  let platformOwnerUserId: string;

  let orgId: string;
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: ["error", "warn"], abortOnError: false });
    app.setGlobalPrefix("api/v1");
    await app.init();
    prisma = app.get(PrismaService);
    platform = app.get(PlatformService);
    batchProcessor = app.get(RecruitmentBatchProcessor);

    await ensurePlatformOwner(prisma);
    const ownerLogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD, organizationName: "Krevia.ai Platform" })
      .expect(200);
    platformOwnerUserId = ownerLogin.body.data.user.id;

    const owner = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ organizationName: `Batch Processor Suspension Test ${Date.now()}`, firstName: "Owner", email: `batch-suspension-${Date.now()}@example.invalid`, password: "StrongPassword@123" })
      .expect(201);
    orgId = owner.body.data.organization.id;
    createdOrgIds.push(orgId);
    const ownerToken = owner.body.data.tokens.accessToken;

    await request(app.getHttpServer())
      .post("/api/v1/plugins/install")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ pluginId: "recruitment-consultant", configuration: { config: {}, secrets: {} }, enable: true })
      .expect(201);
  }, 90_000);

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await prisma.pluginConfiguration.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.pluginAiConfiguration.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.recruitmentApplication.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.recruitmentResume.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.recruitmentCandidate.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.recruitmentJob.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
    if (app) await app.close();
  }, 60_000);

  it("a QUEUED resume for a suspended organization is left untouched (not claimed, retryCount unchanged) across multiple ticks", async () => {
    const candidateId = randomUUID();
    const resumeId = randomUUID();
    await prisma.recruitmentCandidate.create({
      data: { id: candidateId, organizationId: orgId, fullName: "Suspended Batch Test Candidate" }
    });
    await prisma.recruitmentResume.create({
      data: {
        id: resumeId, organizationId: orgId, candidateId, resumeCode: `RES-BATCHSUS-${randomUUID().slice(0, 16)}`,
        fileName: "suspended.pdf", storageKey: "recruitment/batch-suspension-test/suspended.pdf", fileSizeBytes: 1024,
        fileHash: randomUUID().replace(/-/g, ""), parsingStatus: "QUEUED", retryCount: 0
      }
    });

    await platform.suspendOrganization(orgId, platformOwnerUserId, "Phase 5.3 batch-processor suspension test");

    await batchProcessor.tick();
    await batchProcessor.tick();
    await batchProcessor.tick();

    const after = await prisma.recruitmentResume.findUniqueOrThrow({ where: { id: resumeId } });
    expect(after.parsingStatus).toBe("QUEUED"); // never claimed, never moved to PROCESSING/COMPLETED/FAILED
    expect(after.retryCount).toBe(0); // no retry budget spent on a suspension that isn't the file's fault
    expect(after.extractedText).toBeNull(); // no candidate PII was ever extracted from the stored bytes
  });

  it("the same resume is picked up and completes once the organization is reactivated", async () => {
    const candidateId = randomUUID();
    const resumeId = randomUUID();
    await prisma.recruitmentCandidate.create({
      data: { id: candidateId, organizationId: orgId, fullName: "Reactivated Batch Test Candidate" }
    });
    await prisma.recruitmentResume.create({
      data: {
        id: resumeId, organizationId: orgId, candidateId, resumeCode: `RES-BATCHREACT-${randomUUID().slice(0, 12)}`,
        fileName: "reactivated.pdf", storageKey: "recruitment/batch-suspension-test/reactivated.pdf", fileSizeBytes: 1024,
        fileHash: randomUUID().replace(/-/g, ""), parsingStatus: "QUEUED", retryCount: 0,
        // extractedText pre-populated so this test exercises resolveCandidate/scoring without needing a
        // real stored PDF buffer or a live text-extraction/LLM call — the suspension-defer mechanics
        // above this point are what's being proven, not the parsing pipeline itself.
        extractedText: "Jane Doe. Python developer. 3 years experience.",
        totalExperienceYears: 3,
        extractedSkills: ["Python"]
      }
    });

    // Still SUSPENDED from the previous test — confirm it is STILL deferred.
    await batchProcessor.tick();
    expect((await prisma.recruitmentResume.findUniqueOrThrow({ where: { id: resumeId } })).parsingStatus).toBe("QUEUED");

    await platform.reactivateOrganization(orgId, platformOwnerUserId);

    // Poll a few ticks — the real parse call may take a moment (deterministic, no live LLM needed since
    // extractedText is already present; parseOne() only re-extracts when extractedText is empty).
    let finalStatus = "QUEUED";
    for (let i = 0; i < 20; i++) {
      await batchProcessor.tick();
      finalStatus = (await prisma.recruitmentResume.findUniqueOrThrow({ where: { id: resumeId } })).parsingStatus;
      if (finalStatus !== "QUEUED") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(finalStatus).toBe("COMPLETED");
  });
});
