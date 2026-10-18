import { Page, Locator, expect } from "@playwright/test";
import { TEST_CONFIG } from "../utils/test-config";

export class LoginPage {
  readonly page: Page;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly organizationNameInput: Locator;
  readonly loginButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.emailInput = page.locator('#email').first();
    this.passwordInput = page.locator('#password').first();
    this.organizationNameInput = page.locator('#organizationName').first();
    this.loginButton = page.getByRole('button', { name: 'Sign in' }).first();
    this.errorMessage = page.locator('[role="alert"]');
  }

  async goto(): Promise<void> {
    await this.page.goto("/login");
  }

  async login(email: string, password: string, organizationName: string): Promise<void> {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.organizationNameInput.fill(organizationName);
    await this.loginButton.click();
    await this.page.waitForURL("**/dashboard**", { timeout: TEST_CONFIG.timeouts.navigation });
  }

  async expectError(message: string): Promise<void> {
    await expect(this.errorMessage).toContainText(message);
  }
}

export class DashboardPage {
  readonly page: Page;
  readonly recruitmentCard: Locator;
  readonly sidebar: Locator;

  constructor(page: Page) {
    this.page = page;
    this.recruitmentCard = page.locator('a[href*="/recruitment"], button:has-text("AI Recruitment Consultant"), [data-testid="recruitment-card"]');
    this.sidebar = page.locator('nav, [role="navigation"], .sidebar');
  }

  async goto(): Promise<void> {
    await this.page.goto("/dashboard");
  }

  async navigateToRecruitment(): Promise<void> {
    await this.recruitmentCard.first().click();
    await this.page.waitForURL("**/recruitment/jobs**");
  }

  async verifyRecruitmentCardVisible(): Promise<void> {
    await expect(this.recruitmentCard.first()).toBeVisible();
  }

  async verifyRecruitmentCardNotVisible(): Promise<void> {
    await expect(this.recruitmentCard.first()).not.toBeVisible();
  }
}

export class JobOpeningsPage {
  readonly page: Page;
  readonly pageTitle: Locator;
  readonly jobTable: Locator;
  readonly createJobButton: Locator;
  readonly searchInput: Locator;
  readonly pagination: Locator;
  readonly emptyState: Locator;

  constructor(page: Page) {
    this.page = page;
    this.pageTitle = page.locator('h1:has-text("Job Openings")');
    this.jobTable = page.locator('table.admin-table');
    this.createJobButton = page.locator('button:has-text("Create Job")');
    this.searchInput = page.locator('input[placeholder*="search" i], input[placeholder*="Search" i]');
    this.pagination = page.locator('.admin-pagination');
    this.emptyState = page.locator('text=No job openings yet');
  }

  async goto(): Promise<void> {
    await this.page.goto("/dashboard/recruitment/jobs");
  }

  async verifyPageLoaded(): Promise<void> {
    await expect(this.pageTitle).toBeVisible();
    await expect(this.jobTable).toBeVisible();
  }

  async clickCreateJob(): Promise<void> {
    await this.createJobButton.click();
    await this.page.waitForURL("**/jobs/new**");
  }

  async searchJobs(query: string): Promise<void> {
    await this.searchInput.fill(query);
    await this.page.waitForTimeout(500);
  }

  async getJobRows(): Promise<Locator[]> {
    return await this.jobTable.locator("tbody tr").all();
  }

  async clickJob(jobId: string): Promise<void> {
    await this.page.locator(`tr:has-text("${jobId}"), a[href*="/jobs/${jobId}"]`).first().click();
    await this.page.waitForURL(`**/jobs/${jobId}**`);
  }

  async verifyJobInList(jobCode: string): Promise<void> {
    await expect(this.jobTable.locator(`text=${jobCode}`)).toBeVisible();
  }
}

export class CreateJobPage {
  readonly page: Page;
  readonly titleInput: Locator;
  readonly descriptionTextarea: Locator;
  readonly departmentInput: Locator;
  readonly locationInput: Locator;
  readonly minExperienceInput: Locator;
  readonly maxExperienceInput: Locator;
  readonly mandatorySkillsInput: Locator;
  readonly preferredSkillsInput: Locator;
  readonly certificationsInput: Locator;
  readonly hiringManagerInput: Locator;
  readonly numberOfOpeningsInput: Locator;
  readonly suggestCriteriaButton: Locator;
  readonly createJobButton: Locator;
  readonly successAlert: Locator;
  readonly errorAlert: Locator;

  constructor(page: Page) {
    this.page = page;
    this.titleInput = page.locator('#job-title, input[name="title"]');
    this.descriptionTextarea = page.locator('#job-description, textarea[name="description"]');
    this.departmentInput = page.locator('#job-department, input[name="department"]');
    this.locationInput = page.locator('#job-location, input[name="location"]');
    this.minExperienceInput = page.locator('#job-min-exp, input[name="minExperienceYears"]');
    this.maxExperienceInput = page.locator('#job-max-exp, input[name="maxExperienceYears"]');
    this.mandatorySkillsInput = page.locator('#job-mandatory, input[name="mandatorySkills"]');
    this.preferredSkillsInput = page.locator('#job-preferred, input[name="preferredSkills"]');
    this.certificationsInput = page.locator('#job-certs, input[name="certifications"]');
    this.hiringManagerInput = page.locator('#job-hiring-manager, input[name="hiringManager"]');
    this.numberOfOpeningsInput = page.locator('#job-openings, input[name="numberOfOpenings"]');
    this.suggestCriteriaButton = page.locator('button:has-text("Suggest criteria from description")');
    this.createJobButton = page.locator('button:has-text("Create Job")');
    this.successAlert = page.locator('[role="alert"]:has-text("success"), .alert-success');
    this.errorAlert = page.locator('[role="alert"]:has-text("error"), .alert-danger');
  }

  async goto(): Promise<void> {
    await this.page.goto("/dashboard/recruitment/jobs/new");
  }

  async fillJobForm(jobData: any): Promise<void> {
    await this.titleInput.fill(jobData.title);
    await this.descriptionTextarea.fill(jobData.description);
    
    if (jobData.department) await this.departmentInput.fill(jobData.department);
    if (jobData.location) await this.locationInput.fill(jobData.location);
    if (jobData.minExperienceYears !== undefined) await this.minExperienceInput.fill(String(jobData.minExperienceYears));
    if (jobData.maxExperienceYears !== undefined) await this.maxExperienceInput.fill(String(jobData.maxExperienceYears));
    
    await this.mandatorySkillsInput.fill(jobData.mandatorySkills.join(", "));
    if (jobData.preferredSkills?.length) await this.preferredSkillsInput.fill(jobData.preferredSkills.join(", "));
    if (jobData.certifications?.length) await this.certificationsInput.fill(jobData.certifications.join(", "));
    if (jobData.hiringManager) await this.hiringManagerInput.fill(jobData.hiringManager);
    if (jobData.numberOfOpenings) await this.numberOfOpeningsInput.fill(String(jobData.numberOfOpenings));
  }

  async clickSuggestCriteria(): Promise<void> {
    await this.suggestCriteriaButton.click();
    await this.page.waitForTimeout(2000);
  }

  async submit(): Promise<void> {
    await this.createJobButton.click();
    await this.page.waitForURL(/\/jobs\/[a-f0-9-]+$/, { timeout: TEST_CONFIG.timeouts.navigation });
  }

  async verifyValidationError(field: string): Promise<void> {
    await expect(this.page.locator(`text=${field}`)).toBeVisible();
  }
}

export class JobDetailPage {
  readonly page: Page;
  readonly jobTitle: Locator;
  readonly jobCode: Locator;
  readonly statusBadge: Locator;
  readonly summaryCards: Locator;
  readonly uploadButton: Locator;
  readonly fileInput: Locator;
  readonly batchStatusAlert: Locator;
  readonly searchInput: Locator;
  readonly recommendationFilter: Locator;
  readonly candidatesTable: Locator;
  readonly pagination: Locator;
  readonly exportCsvButton: Locator;
  readonly exportXlsxButton: Locator;
  readonly emptyState: Locator;

  constructor(page: Page) {
    this.page = page;
    this.jobTitle = page.locator('.dashboard-content .ui-page-header h1');
    this.jobCode = page.locator('.ui-page-header__eyebrow');
    this.statusBadge = page.locator('.ui-summary-card:has-text("Status") .ui-summary-card__value');
    this.summaryCards = page.locator('.ui-summary-card');
    this.uploadButton = page.locator('button:has-text("Upload Resumes")');
    this.fileInput = page.locator('input[type="file"][accept=".pdf,.docx"]');
    this.batchStatusAlert = page.locator('[role="alert"]:has-text("Batch:")');
    this.searchInput = page.locator('input[placeholder*="Search candidate" i]');
    this.recommendationFilter = page.locator('select:has(option[value="RECOMMENDED_FOR_SHORTLIST"])');
    this.candidatesTable = page.locator('table.admin-table');
    this.pagination = page.locator('.admin-pagination');
    this.exportCsvButton = page.locator('button:has-text("Export CSV")');
    this.exportXlsxButton = page.locator('button:has-text("Export XLSX")');
    this.emptyState = page.locator('text=No candidates yet');
  }

  async goto(jobId: string): Promise<void> {
    await this.page.goto(`/dashboard/recruitment/jobs/${jobId}`);
  }

  async verifyPageLoaded(jobTitle: string): Promise<void> {
    await expect(this.jobTitle).toContainText(jobTitle);
    await expect(this.candidatesTable).toBeVisible();
  }

  async uploadResumes(files: string[]): Promise<void> {
    await this.fileInput.setInputFiles(files);
    await this.page.waitForTimeout(1000);
  }

  async waitForUploadComplete(timeoutMs: number = 30000): Promise<void> {
    await expect(this.batchStatusAlert).toBeVisible({ timeout: timeoutMs });
  }

  async searchCandidates(query: string): Promise<void> {
    await this.searchInput.fill(query);
    await this.page.waitForTimeout(500);
  }

  async filterByRecommendation(recommendation: string): Promise<void> {
    await this.recommendationFilter.selectOption(recommendation);
    await this.page.waitForTimeout(500);
  }

  async getCandidateRows(): Promise<Locator[]> {
    return await this.candidatesTable.locator("tbody tr").all();
  }

  async expandCandidate(rowIndex: number): Promise<void> {
    const rows = await this.getCandidateRows();
    if (rows[rowIndex]) {
      await rows[rowIndex].click();
    }
  }

  async getCandidateData(rowIndex: number): Promise<Record<string, string>> {
    const rows = await this.getCandidateRows();
    const row = rows[rowIndex];
    if (!row) return {};

    const cells = await row.locator("td").all();
    const data: Record<string, string> = {};
    
    if (cells.length >= 6) {
      data.name = await cells[0].textContent() || "";
      data.mobile = await cells[1].textContent() || "";
      data.score = await cells[2].textContent() || "";
      data.aiRecommendation = await cells[3].textContent() || "";
      data.selectionStatus = await cells[4].locator("select").inputValue() || "";
      data.resumeId = await cells[5].textContent() || "";
    }
    return data;
  }

  async setSelectionStatus(rowIndex: number, status: string): Promise<void> {
    const rows = await this.getCandidateRows();
    const row = rows[rowIndex];
    if (row) {
      const select = row.locator('select');
      await select.selectOption(status);
      await this.page.waitForTimeout(500);
    }
  }

  async verifySelectionStatus(rowIndex: number, expectedStatus: string): Promise<void> {
    const rows = await this.getCandidateRows();
    const row = rows[rowIndex];
    if (row) {
      const select = row.locator('select');
      await expect(select).toHaveValue(expectedStatus);
    }
  }

  async exportCsv(): Promise<void> {
    const downloadPromise = this.page.waitForEvent("download");
    await this.exportCsvButton.click();
    const download = await downloadPromise;
    return download;
  }

  async exportXlsx(): Promise<void> {
    const downloadPromise = this.page.waitForEvent("download");
    await this.exportXlsxButton.click();
    const download = await downloadPromise;
    return download;
  }

  async verifyCandidateCount(expectedCount: number): Promise<void> {
    const rows = await this.getCandidateRows();
    expect(rows.length).toBe(expectedCount);
  }
}