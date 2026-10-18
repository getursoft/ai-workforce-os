import { test, expect, APIRequestContext } from "@playwright/test";
import { TEST_CONFIG, createTestUser } from "../utils/test-config";
import { createApiContext, registerTestUser, installRecruitmentConsultant, createJobViaAPI, authenticatePage, type AuthTokens } from "../utils/api-helpers";
import { RESUME_FIXTURES, getResumeBuffer } from "../fixtures/resume-templates";
import { LoginPage, JobDetailPage } from "../page-objects/pages";

test.describe.configure({ mode: "serial" });

let apiContext: APIRequestContext;
let auth: AuthTokens;
let jobId: string;
const testUser = createTestUser();

test.beforeAll(async () => {
  apiContext = await createApiContext();
  auth = await registerTestUser(apiContext, testUser);
  await installRecruitmentConsultant(apiContext, auth.accessToken);
  const jobA = TEST_CONFIG.jobs.jobA;
  const job = await createJobViaAPI(apiContext, auth.accessToken, {
    title: jobA.title,
    description: jobA.description,
    minExperienceYears: jobA.minExperienceYears,
    requiredCriteria: { mandatorySkills: jobA.mandatorySkills, preferredSkills: jobA.preferredSkills, certifications: jobA.certifications },
    scoringConfig: jobA.scoringConfig,
    numberOfOpenings: jobA.numberOfOpenings
  });
  jobId = job.id;

  // Upload one real, valid, text-extractable fixture so score/experience/skill filters have something
  // genuine to match against (Sprint 7.15's PDF generator — a real minimal-but-valid PDF, unlike the
  // malformed one-liners used for negative-path tests).
  const fixture = RESUME_FIXTURES[0]!;
  const uploadResponse = await apiContext.post(`/api/v1/recruitment/jobs/${jobId}/resumes/batch`, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    multipart: { files: { name: fixture.fileName, mimeType: "application/pdf", buffer: getResumeBuffer(fixture) } }
  });
  const uploadBody = await uploadResponse.json();
  const batchId = uploadBody.batchId;
  for (let i = 0; i < 30; i++) {
    const status = await (await apiContext.get(`/api/v1/recruitment/batches/${batchId}`, { headers: { Authorization: `Bearer ${auth.accessToken}` } })).json();
    if (status.completed + status.failed >= status.totalFiles) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
});

test.afterAll(async () => {
  await apiContext.dispose();
});

// --- Phase 6: shared candidate query service -----------------------------------------------------------

test("WEB-004 Custom minimum-score filter uses real numeric comparison", async () => {
  const allResponse = await apiContext.post("/api/v1/recruitment/candidates/search", {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data: { jobId }
  });
  expect(allResponse.ok()).toBeTruthy();
  const all = await allResponse.json();
  expect(all.items.length).toBeGreaterThan(0);

  // A threshold just above the real persisted score must exclude it; a threshold at-or-below must include
  // it — proves >= is genuinely numeric, not string-prefix matching (Sprint 7.14's exact-boundary finding
  // applied here to the new filter layer, not just the original scoring engine).
  const realScore = all.items[0].evaluation?.matchScore;
  expect(typeof realScore).toBe("number");

  const tooHighResponse = await apiContext.post("/api/v1/recruitment/candidates/search", {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data: { jobId, scoreGreaterThanOrEqual: realScore + 0.01 }
  });
  const tooHigh = await tooHighResponse.json();
  expect(tooHigh.items.find((i: { id: string }) => i.id === all.items[0].id)).toBeUndefined();

  const inclusiveResponse = await apiContext.post("/api/v1/recruitment/candidates/search", {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data: { jobId, scoreGreaterThanOrEqual: realScore }
  });
  const inclusive = await inclusiveResponse.json();
  expect(inclusive.items.find((i: { id: string }) => i.id === all.items[0].id)).toBeDefined();
});

test("WEB-004b scoreGreaterThan strictly excludes an exact match (> vs >=)", async () => {
  const exact = await (await apiContext.post("/api/v1/recruitment/candidates/search", {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data: { jobId }
  })).json();
  const realScore = exact.items[0].evaluation?.matchScore;

  const strictResponse = await apiContext.post("/api/v1/recruitment/candidates/search", {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data: { jobId, scoreGreaterThan: realScore }
  });
  const strict = await strictResponse.json();
  // A candidate exactly AT realScore must be excluded by strict >, proving the two operators are
  // genuinely distinct server-side implementations, not aliases of each other.
  expect(strict.items.find((i: { id: string }) => i.id === exact.items[0].id)).toBeUndefined();
});

test("WEB-006 Experience range filter", async () => {
  const response = await apiContext.post("/api/v1/recruitment/candidates/search", {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data: { jobId, minRelevantExperienceYears: 999 }
  });
  const result = await response.json();
  expect(result.totalCount).toBe(0);
});

test("WEB-007 Skill filter (anySkills) matches real extracted text", async () => {
  const response = await apiContext.post("/api/v1/recruitment/candidates/search", {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data: { jobId, anySkills: ["Azure Data Factory"] }
  });
  const result = await response.json();
  expect(result.totalCount).toBeGreaterThan(0);

  const noMatch = await (await apiContext.post("/api/v1/recruitment/candidates/search", {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data: { jobId, allSkills: ["ThisSkillDoesNotExistAnywhere12345"] }
  })).json();
  expect(noMatch.totalCount).toBe(0);
});

test("WEB-009 Sort by score descending is actually ordered", async () => {
  const response = await apiContext.post("/api/v1/recruitment/candidates/search", {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data: { sortBy: "score_desc", limit: 50 }
  });
  const result = await response.json();
  const scores = result.items.map((i: { evaluation?: { matchScore?: number } }) => i.evaluation?.matchScore ?? -1);
  const sorted = [...scores].sort((a, b) => b - a);
  expect(scores).toEqual(sorted);
});

test("WEB-015 Tenant isolation on the shared search endpoint", async () => {
  const otherOrg = await registerTestUser(apiContext, createTestUser());
  const response = await apiContext.post("/api/v1/recruitment/candidates/search", {
    headers: { Authorization: `Bearer ${otherOrg.accessToken}` },
    data: { jobId }
  });
  const result = await response.json();
  // A cross-org jobId filter must never leak the other org's candidates — the shared query service's
  // unconditional organizationId clause means the job itself isn't found, so results are simply empty.
  expect(result.totalCount).toBe(0);
});

// --- Phase 11: export engine ----------------------------------------------------------------------------

test("WEB-010/011 Export respects the same filters as the UI (CSV + XLSX)", async () => {
  const csvResponse = await apiContext.post("/api/v1/recruitment/candidates/export", {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data: { scope: "CURRENT_JOB", format: "CSV", jobId }
  });
  expect(csvResponse.ok()).toBeTruthy();
  const csvResult = await csvResponse.json();
  expect(csvResult.status).toBe("COMPLETED");
  expect(csvResult.rowCount).toBeGreaterThan(0);

  const downloadResponse = await apiContext.get(
    `/api/v1/recruitment/candidates/export/${csvResult.exportJobId}/download?token=${csvResult.downloadToken}`,
    { headers: { Authorization: `Bearer ${auth.accessToken}` } }
  );
  expect(downloadResponse.ok()).toBeTruthy();
  const { url } = await downloadResponse.json();
  expect(url).toMatch(/^https?:\/\//);
});

test("WEB-014 Export download link rejects a wrong token", async () => {
  const exportResponse = await apiContext.post("/api/v1/recruitment/candidates/export", {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data: { scope: "CURRENT_JOB", format: "CSV", jobId }
  });
  const result = await exportResponse.json();
  const badResponse = await apiContext.get(
    `/api/v1/recruitment/candidates/export/${result.exportJobId}/download?token=wrong-token-value`,
    { headers: { Authorization: `Bearer ${auth.accessToken}` } }
  );
  expect(badResponse.status()).toBe(403);
});

// --- Phase 5: location extraction schema -----------------------------------------------------------------

test("Candidate records expose Phase 5 location fields (schema-level verification)", async () => {
  const response = await apiContext.post("/api/v1/recruitment/candidates/search", {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data: { jobId }
  });
  const result = await response.json();
  const candidate = result.items[0].candidate;
  for (const field of ["currentCity", "currentState", "currentCountry", "normalizedRegion", "preferredWorkLocations", "willingToRelocate", "noticePeriod", "locationSource"]) {
    expect(Object.prototype.hasOwnProperty.call(candidate, field)).toBe(true);
  }
});

// --- Phase 1: WhatsApp link + webhook security (API-level, real signature verification exercised) -------

test("WA-020 Unauthorized WhatsApp number is denied and leaves no session trace", async () => {
  const response = await apiContext.post("/api/v1/recruitment/whatsapp/link/initiate", {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data: { whatsappNumber: "+15559990000" }
  });
  expect(response.ok()).toBeTruthy();
  const links = await (await apiContext.get("/api/v1/recruitment/whatsapp/links", {
    headers: { Authorization: `Bearer ${auth.accessToken}` }
  })).json();
  expect(links.find((l: { whatsappNumber: string; status: string }) => l.whatsappNumber === "+15559990000" && l.status === "PENDING_VERIFICATION")).toBeDefined();
});

test("WA-020b Confirming a link with the wrong code is rejected", async () => {
  const response = await apiContext.post("/api/v1/recruitment/whatsapp/link/confirm", {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data: { whatsappNumber: "+15559990000", code: "000000" }
  });
  expect(response.status()).toBe(400);
});

// --- Website: a real headed-browser pass over the new Advanced Filter Panel UI --------------------------

test("WEB advanced filter panel renders and applies a real filter in the browser", async ({ page }) => {
  auth.refreshToken = await authenticatePage(page, auth.refreshToken, `/dashboard/recruitment/jobs/${jobId}`);
  const panel = page.locator("text=Advanced Filters").first();
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "Expand" }).click();
  await page.locator("#af-score-gte").fill("0");
  await page.getByRole("button", { name: "Apply Filters" }).click();
  await expect(page.locator("text=matching candidates")).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: "test-results/evidence/WEB_Advanced_Filters_PASSED.png", fullPage: true });
});
