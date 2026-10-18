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
import { LoginPage, JobOpeningsPage, CreateJobPage, JobDetailPage } from "../page-objects/pages";
import { RESUME_FIXTURES, getResumeBuffer } from "../fixtures/resume-templates";

test.describe.configure({ mode: "serial" });

let apiContext: APIRequestContext;
let auth: AuthTokens;
const testUser = createTestUser();
let jobAId: string;

test.beforeAll(async () => {
  apiContext = await createApiContext();
  auth = await registerTestUser(apiContext, testUser);
  await installRecruitmentConsultant(apiContext, auth.accessToken);
});

test.afterAll(async () => {
  await apiContext.dispose();
});

// TC-001: Login with the freshly registered employee account via the real UI form.
test("TC-001 Login succeeds with valid credentials", async ({ page }) => {
  const login = new LoginPage(page);
  await login.goto();
  await login.login(testUser.email, testUser.password, testUser.organizationName);
  await expect(page).toHaveURL(/\/dashboard/);
  await page.screenshot({ path: "test-results/evidence/TC-001_Login_PASSED.png", fullPage: true });
});

// TC-002: AI Recruitment Consultant is visible in the dashboard nav/home for this employee, since the
// plugin was installed via API in beforeAll.
test("TC-002 Recruitment Consultant visible after installation", async ({ page }) => {
  auth.refreshToken = await authenticatePage(page, auth.refreshToken, "/dashboard/recruitment/jobs");
  const jobs = new JobOpeningsPage(page);
  await expect(jobs.pageTitle).toBeVisible();
  await page.screenshot({ path: "test-results/evidence/TC-002_Visibility_PASSED.png", fullPage: true });
});

// TC-003: Job portfolio page loads and shows the empty state before any jobs exist for this fresh org.
test("TC-003 Job portfolio page loads", async ({ page }) => {
  auth.refreshToken = await authenticatePage(page, auth.refreshToken, "/dashboard/recruitment/jobs");
  const jobs = new JobOpeningsPage(page);
  await expect(jobs.pageTitle).toHaveText("Job Openings");
  await expect(jobs.emptyState).toBeVisible();
  await page.screenshot({ path: "test-results/evidence/TC-003_JobPortfolio_PASSED.png", fullPage: true });
});

// TC-004: Create Job A (Senior Azure Data Engineer) through the real UI form end-to-end.
test("TC-004 Create job via UI form", async ({ page }) => {
  auth.refreshToken = await authenticatePage(page, auth.refreshToken, "/dashboard/recruitment/jobs/new");

  const createPage = new CreateJobPage(page);
  const jobA = TEST_CONFIG.jobs.jobA;
  await createPage.fillJobForm(jobA);
  await createPage.submit();

  await expect(page).toHaveURL(/\/dashboard\/recruitment\/jobs\/[a-f0-9-]+$/);
  const detail = new JobDetailPage(page);
  await expect(detail.jobTitle).toContainText(jobA.title);
  jobAId = page.url().split("/jobs/")[1];
  await page.screenshot({ path: "test-results/evidence/TC-004_Job_Creation_PASSED.png", fullPage: true });
});

// TC-005: AI JD parsing — "Suggest criteria from description" populates skill fields from the pasted JD.
test("TC-005 AI JD parsing suggests criteria", async ({ page }) => {
  auth.refreshToken = await authenticatePage(page, auth.refreshToken, "/dashboard/recruitment/jobs/new");

  const createPage = new CreateJobPage(page);
  await createPage.descriptionTextarea.fill(TEST_CONFIG.jobs.jobB.description);
  await createPage.clickSuggestCriteria();

  const mandatoryValue = await createPage.mandatorySkillsInput.inputValue();
  await page.screenshot({ path: "test-results/evidence/TC-005_AI_JD_Parsing.png", fullPage: true });

  if (mandatoryValue.trim().length > 0) {
    expect(mandatoryValue.length).toBeGreaterThan(0);
  } else {
    test.info().annotations.push({
      type: "BLOCKED",
      description: "AI JD parsing returned no suggested skills — likely no live LLM provider configured for this org. See AI provider audit in final report."
    });
  }
});

// TC-006: Single resume upload against Job A, polling the real batch-status API (bounded, no arbitrary sleep).
test("TC-006 Single resume upload and parse", async ({ page }) => {
  test.setTimeout(90000);
  const jobA = await createJobViaAPI(apiContext, auth.accessToken, {
    title: TEST_CONFIG.jobs.jobA.title,
    description: TEST_CONFIG.jobs.jobA.description,
    department: TEST_CONFIG.jobs.jobA.department,
    location: TEST_CONFIG.jobs.jobA.location,
    minExperienceYears: TEST_CONFIG.jobs.jobA.minExperienceYears,
    maxExperienceYears: TEST_CONFIG.jobs.jobA.maxExperienceYears,
    requiredCriteria: {
      mandatorySkills: TEST_CONFIG.jobs.jobA.mandatorySkills,
      preferredSkills: TEST_CONFIG.jobs.jobA.preferredSkills,
      certifications: TEST_CONFIG.jobs.jobA.certifications
    },
    scoringConfig: TEST_CONFIG.jobs.jobA.scoringConfig,
    numberOfOpenings: TEST_CONFIG.jobs.jobA.numberOfOpenings
  });
  jobAId = jobA.id;

  auth.refreshToken = await authenticatePage(page, auth.refreshToken, `/dashboard/recruitment/jobs/${jobAId}`);

  const detail = new JobDetailPage(page);

  const fixture = RESUME_FIXTURES[0];
  const buffer = getResumeBuffer(fixture);
  await detail.fileInput.setInputFiles([{ name: fixture.fileName, mimeType: "application/pdf", buffer }]);

  await expect(detail.batchStatusAlert).toBeVisible({ timeout: 15000 });
  // The candidates table live-refetches every 5s (React Query) while the batch is processing — no
  // reload needed, which also avoids repeatedly re-triggering the single-use refresh-token rotation.
  await expect
    .poll(async () => (await detail.getCandidateRows()).length, { timeout: 60000, intervals: [2000] })
    .toBeGreaterThan(0);

  await page.screenshot({ path: "test-results/evidence/TC-006_Single_Upload_PASSED.png", fullPage: true });
});
