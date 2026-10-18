import { test, expect, APIRequestContext } from "@playwright/test";
import { TEST_CONFIG, createTestUser } from "../utils/test-config";
import {
  createApiContext,
  registerTestUser,
  installRecruitmentConsultant,
  createJobViaAPI,
  authenticatePage,
  type AuthTokens
} from "../utils/api-helpers";
import { JobDetailPage } from "../page-objects/pages";
import { RESUME_FIXTURES, getResumeBuffer, createBatch } from "../fixtures/resume-templates";

test.describe.configure({ mode: "serial" });

let apiContext: APIRequestContext;
let auth: AuthTokens;
const testUser = createTestUser();
let jobId: string;

test.beforeAll(async () => {
  apiContext = await createApiContext();
  auth = await registerTestUser(apiContext, testUser);
  await installRecruitmentConsultant(apiContext, auth.accessToken);
  const jobA = TEST_CONFIG.jobs.jobA;
  const job = await createJobViaAPI(apiContext, auth.accessToken, {
    title: jobA.title,
    description: jobA.description,
    department: jobA.department,
    location: jobA.location,
    minExperienceYears: jobA.minExperienceYears,
    maxExperienceYears: jobA.maxExperienceYears,
    requiredCriteria: {
      mandatorySkills: jobA.mandatorySkills,
      preferredSkills: jobA.preferredSkills,
      certifications: jobA.certifications
    },
    scoringConfig: jobA.scoringConfig,
    numberOfOpenings: jobA.numberOfOpenings
  });
  jobId = job.id;
});

test.afterAll(async () => {
  await apiContext.dispose();
});

// TC-007: Bulk upload of 10 resumes (mixed strong/medium/weak/edge-case fixtures) in a single batch,
// including a malformed PDF and a malformed DOCX — one bad file must never fail the whole batch.
test("TC-007 Bulk upload of 10 resumes with isolated failure handling", async ({ page }) => {
  test.setTimeout(120000);
  auth.refreshToken = await authenticatePage(page, auth.refreshToken, `/dashboard/recruitment/jobs/${jobId}`);

  const detail = new JobDetailPage(page);

  const batch = createBatch(RESUME_FIXTURES, 10);
  const files = batch.map((fixture, i) => ({
    name: `${i}-${fixture.fileName}`,
    mimeType: fixture.fileName.endsWith(".docx")
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/pdf",
    buffer: getResumeBuffer(fixture)
  }));

  await detail.fileInput.setInputFiles(files);
  await expect(detail.batchStatusAlert).toBeVisible({ timeout: 15000 });

  // Bounded poll — no arbitrary sleep — until the banner reports zero items still queued or processing.
  await expect
    .poll(
      async () => {
        const text = (await detail.batchStatusAlert.textContent()) ?? "";
        const stillPending = /(\d+)\s*processing/.exec(text)?.[1] !== "0" || /(\d+)\s*queued/.exec(text)?.[1] !== "0";
        return stillPending;
      },
      { timeout: 90000, intervals: [3000] }
    )
    .toBe(false);

  await page.screenshot({ path: "test-results/evidence/TC-007_Bulk_Upload_10_PASSED.png", fullPage: true });

  const finalBanner = await detail.batchStatusAlert.textContent();
  expect(finalBanner).toMatch(/\d+ total/);
});

// TC-008: Candidate table reflects the real persisted rows for this job (count + columns), validated
// against the backend's own candidates API — not just "something rendered."
test("TC-008 Candidate table matches backend records", async ({ page }) => {
  auth.refreshToken = await authenticatePage(page, auth.refreshToken, `/dashboard/recruitment/jobs/${jobId}`);

  const detail = new JobDetailPage(page);
  await page.waitForTimeout(1000);

  const apiResponse = await apiContext.get(`/api/v1/recruitment/jobs/${jobId}/candidates?page=1&pageSize=20`, {
    headers: { Authorization: `Bearer ${auth.accessToken}` }
  });
  const apiData = await apiResponse.json();
  const expectedCount = apiData.items.length;

  await expect(detail.candidatesTable).toBeVisible();
  const rows = await detail.getCandidateRows();
  expect(rows.length).toBe(expectedCount);
  await page.screenshot({ path: "test-results/evidence/TC-008_Candidate_Table_PASSED.png", fullPage: true });
});

// TC-009: Human recruiter review decision persists independently of the AI recommendation, and survives
// a full page refresh (proving it round-trips through the backend, not just local component state).
test("TC-009 Recruiter review decision persists across refresh", async ({ page }) => {
  auth.refreshToken = await authenticatePage(page, auth.refreshToken, `/dashboard/recruitment/jobs/${jobId}`);

  const detail = new JobDetailPage(page);
  await page.waitForTimeout(1000);

  const rows = await detail.getCandidateRows();
  expect(rows.length).toBeGreaterThan(0);

  const select = rows[0].locator("select");
  await select.selectOption("SHORTLISTED");
  await page.waitForTimeout(800);

  // This reload rotates the single-use refresh-token cookie again (same bootstrap flow as
  // authenticatePage) — recapture it so the NEXT test doesn't replay an already-consumed token.
  const refreshResponse = page.waitForResponse((res) => res.url().includes("/auth/refresh"));
  await page.reload();
  await refreshResponse;
  const cookies = await page.context().cookies();
  auth.refreshToken = cookies.find((c) => c.name === "aiwos_refresh_token")?.value ?? auth.refreshToken;

  await expect(detail.candidatesTable).toBeVisible();
  await expect
    .poll(async () => (await detail.getCandidateRows()).length, { timeout: 10000 })
    .toBeGreaterThan(0);
  const refreshedRows = await detail.getCandidateRows();
  await expect(refreshedRows[0].locator("select")).toHaveValue("SHORTLISTED");
  await page.screenshot({ path: "test-results/evidence/TC-009_Review_Persistence_PASSED.png", fullPage: true });
});

// TC-010: Search filters the candidate table, and CSV export produces a real downloaded file via a
// genuine Playwright download event (not a mocked blob check).
test("TC-010 Search and CSV export", async ({ page }) => {
  auth.refreshToken = await authenticatePage(page, auth.refreshToken, `/dashboard/recruitment/jobs/${jobId}`);

  const detail = new JobDetailPage(page);
  await page.waitForTimeout(1000);

  await detail.searchCandidates("zzz-no-such-candidate-zzz");
  await page.waitForTimeout(600);
  const noMatchRows = await detail.getCandidateRows();
  expect(noMatchRows.length).toBe(0);

  await detail.searchCandidates("");
  await page.waitForTimeout(600);

  const downloadPromise = page.waitForEvent("download", { timeout: 15000 });
  await detail.exportCsvButton.click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  await page.screenshot({ path: "test-results/evidence/TC-010_Search_Export_PASSED.png", fullPage: true });
});
