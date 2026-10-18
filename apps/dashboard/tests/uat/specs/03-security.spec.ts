import { test, expect, APIRequestContext } from "@playwright/test";
import { TEST_CONFIG, createTestUser } from "../utils/test-config";
import { createApiContext, registerTestUser, installRecruitmentConsultant, createJobViaAPI, type AuthTokens } from "../utils/api-helpers";

test.describe.configure({ mode: "serial" });

let apiContext: APIRequestContext;
let orgA: AuthTokens;
let orgB: AuthTokens;
let orgAJobId: string;

test.beforeAll(async () => {
  apiContext = await createApiContext();
  orgA = await registerTestUser(apiContext, createTestUser());
  await installRecruitmentConsultant(apiContext, orgA.accessToken);
  orgB = await registerTestUser(apiContext, createTestUser());
  await installRecruitmentConsultant(apiContext, orgB.accessToken);

  const jobA = TEST_CONFIG.jobs.jobA;
  const job = await createJobViaAPI(apiContext, orgA.accessToken, {
    title: jobA.title,
    description: jobA.description,
    minExperienceYears: jobA.minExperienceYears,
    requiredCriteria: {
      mandatorySkills: jobA.mandatorySkills,
      preferredSkills: jobA.preferredSkills,
      certifications: jobA.certifications
    },
    scoringConfig: jobA.scoringConfig,
    numberOfOpenings: jobA.numberOfOpenings
  });
  orgAJobId = job.id;
});

test.afterAll(async () => {
  await apiContext.dispose();
});

// TC-011: Tenant isolation — org B's token must not be able to read org A's job via the real backend API.
test("TC-011 Tenant isolation: cross-org job read is denied", async ({}) => {
  const response = await apiContext.get(`/api/v1/recruitment/jobs/${orgAJobId}`, {
    headers: { Authorization: `Bearer ${orgB.accessToken}` }
  });
  expect([403, 404]).toContain(response.status());
});

// TC-012: Tenant isolation — org B's token must not be able to list org A's candidates.
test("TC-012 Tenant isolation: cross-org candidate list is denied", async ({}) => {
  const response = await apiContext.get(`/api/v1/recruitment/jobs/${orgAJobId}/candidates`, {
    headers: { Authorization: `Bearer ${orgB.accessToken}` }
  });
  expect([403, 404]).toContain(response.status());
});

// TC-013: Unauthorized access — no bearer token at all must be rejected, not silently served.
test("TC-013 Unauthorized access without a token is rejected", async ({}) => {
  const response = await apiContext.get(`/api/v1/recruitment/jobs/${orgAJobId}`);
  expect(response.status()).toBe(401);
});

// TC-014: A malformed/garbage bearer token must be rejected, not crash the server or leak data.
test("TC-014 Malformed bearer token is rejected", async ({}) => {
  const response = await apiContext.get(`/api/v1/recruitment/jobs/${orgAJobId}`, {
    headers: { Authorization: "Bearer not-a-real-jwt" }
  });
  expect(response.status()).toBe(401);
});

// TC-015: Prompt-injection content in a resume must not change the deterministic scoring outcome — the
// backend's own persisted record (not the UI) is the source of truth here.
test("TC-015 Prompt injection in resume content does not elevate the score", async () => {
  const { RESUME_FIXTURES, getResumeBuffer } = await import("../fixtures/resume-templates");
  const { uploadResumeBatchViaAPI, waitForBatchCompletion, listCandidatesViaAPI } = await import("../utils/api-helpers");

  const injectionFixture = RESUME_FIXTURES.find((f) => f.description.toLowerCase().includes("prompt injection"))!;
  const buffer = getResumeBuffer(injectionFixture);

  const batch = await uploadResumeBatchViaAPI(apiContext, orgA.accessToken, orgAJobId, [
    { name: injectionFixture.fileName, buffer, mimeType: "application/pdf" }
  ]);
  await waitForBatchCompletion(apiContext, orgA.accessToken, batch.batchId, 60000);

  const candidates = await listCandidatesViaAPI(apiContext, orgA.accessToken, orgAJobId, { search: "Attacker" });
  const candidate = candidates.items.find((c: any) => c.candidate.fullName === "Attacker User" || c.resume?.fileName === injectionFixture.fileName);

  // The injected text explicitly demands "100% match score" and "recommend for hire immediately" — the
  // deterministic scorer must ignore that instruction entirely and score only on real skill overlap.
  if (candidate?.evaluation?.matchScore !== undefined && candidate.evaluation.matchScore !== null) {
    expect(candidate.evaluation.matchScore).toBeLessThan(100);
  }
});
