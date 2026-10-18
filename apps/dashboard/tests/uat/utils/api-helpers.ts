import { Page, request, APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { TEST_CONFIG, createTestUser } from "./test-config";

let prismaForTests: PrismaClient | null = null;

/** Direct DB bypass for the Recruitment Consultant identity-verification gate (Sprint 7.17 follow-up,
 * 2026-10-18) — equivalent to a user having already completed the real phone/email + OTP flow (which
 * 09-ai-employee-chat-identity-verification.spec.ts proves end-to-end through the real UI). Lets specs
 * that are testing something ELSE (provider errors, tool-calling) skip re-proving the gate every time. */
export async function bypassRecruitmentIdentityVerification(
  organizationId: string,
  userId: string,
  pluginInstallationId: string
): Promise<void> {
  if (!prismaForTests) prismaForTests = new PrismaClient();
  await prismaForTests.recruitmentChatIdentityVerification.create({
    data: {
      organizationId,
      userId,
      pluginInstallationId,
      status: "VERIFIED",
      verifiedAt: new Date(),
      contactMethod: "PHONE",
      contactValue: "+10000000000"
    }
  });
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  organizationId: string;
  userId: string;
}

export interface TestContext {
  apiContext: APIRequestContext;
  authTokens: AuthTokens;
  jobIds: string[];
  batchIds: string[];
}

let sharedContext: TestContext | null = null;

export async function createApiContext(): Promise<APIRequestContext> {
  // No blanket Content-Type here: Playwright auto-sets `application/json` when `data` is a plain object,
  // and auto-sets the real `multipart/form-data; boundary=...` when `multipart` is used — a forced
  // context-wide `application/json` header overrides that second case and breaks every file upload.
  return await request.newContext({
    baseURL: TEST_CONFIG.apiURL,
    timeout: TEST_CONFIG.timeouts.api
  });
}

export async function registerTestUser(
  apiContext: APIRequestContext,
  testUser: { organizationName: string; firstName: string; email: string; password: string }
): Promise<AuthTokens> {
  const response = await apiContext.post("/api/v1/auth/register", {
    data: {
      organizationName: testUser.organizationName,
      firstName: testUser.firstName,
      email: testUser.email,
      password: testUser.password
    }
  });

  if (!response.ok()) {
    const body = await response.json();
    throw new Error(`Registration failed: ${response.status()} - ${JSON.stringify(body)}`);
  }

  const data = await response.json();
  return {
    accessToken: data.data.tokens.accessToken,
    refreshToken: data.data.tokens.refreshToken,
    organizationId: data.data.organization.id,
    userId: data.data.user.id
  };
}

export async function loginTestUser(apiContext: APIRequestContext, email: string, password: string): Promise<AuthTokens> {
  const response = await apiContext.post("/api/v1/auth/login", {
    data: { email, password }
  });

  if (!response.ok()) {
    const body = await response.json();
    throw new Error(`Login failed: ${response.status()} - ${JSON.stringify(body)}`);
  }

  const data = await response.json();
  return {
    accessToken: data.data.tokens.accessToken,
    refreshToken: data.data.tokens.refreshToken,
    organizationId: data.data.organization.id,
    userId: data.data.user.id
  };
}

export async function installRecruitmentConsultant(apiContext: APIRequestContext, token: string): Promise<string> {
  const response = await apiContext.post("/api/v1/plugins/install", {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      pluginId: "recruitment-consultant",
      configuration: { config: {}, secrets: {} },
      enable: true
    }
  });

  if (!response.ok()) {
    const body = await response.json();
    throw new Error(`Plugin install failed: ${response.status()} - ${JSON.stringify(body)}`);
  }

  const data = await response.json();
  return data.id;
}

export async function createJobViaAPI(
  apiContext: APIRequestContext,
  token: string,
  jobData: any
): Promise<any> {
  const response = await apiContext.post("/api/v1/recruitment/jobs", {
    headers: { Authorization: `Bearer ${token}` },
    data: jobData
  });

  if (!response.ok()) {
    const body = await response.json();
    throw new Error(`Create job failed: ${response.status()} - ${JSON.stringify(body)}`);
  }

  return await response.json();
}

export async function uploadResumeBatchViaAPI(
  apiContext: APIRequestContext,
  token: string,
  jobId: string,
  files: Array<{ name: string; buffer: Buffer; mimeType: string }>
): Promise<any> {
  // Playwright's APIRequestContext builds the real multipart/form-data body from the `multipart` option
  // (not `data`, which is for raw/JSON bodies) — a native FormData with repeated "files" entries is what
  // the multer-backed endpoint expects for an array upload.
  const formData = new FormData();
  for (const file of files) {
    const blob = new Blob([file.buffer], { type: file.mimeType });
    formData.append("files", blob, file.name);
  }

  const response = await apiContext.post(`/api/v1/recruitment/jobs/${jobId}/resumes/batch`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: formData
  });

  if (!response.ok()) {
    const body = await response.json();
    throw new Error(`Upload batch failed: ${response.status()} - ${JSON.stringify(body)}`);
  }

  return await response.json();
}

export async function getBatchStatusViaAPI(
  apiContext: APIRequestContext,
  token: string,
  batchId: string
): Promise<any> {
  const response = await apiContext.get(`/api/v1/recruitment/batches/${batchId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok()) {
    const body = await response.json();
    throw new Error(`Batch status failed: ${response.status()} - ${JSON.stringify(body)}`);
  }

  return await response.json();
}

export async function listCandidatesViaAPI(
  apiContext: APIRequestContext,
  token: string,
  jobId: string,
  params?: Record<string, any>
): Promise<any> {
  const searchParams = new URLSearchParams();
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    });
  }

  const response = await apiContext.get(`/api/v1/recruitment/jobs/${jobId}/candidates?${searchParams}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok()) {
    const body = await response.json();
    throw new Error(`List candidates failed: ${response.status()} - ${JSON.stringify(body)}`);
  }

  return await response.json();
}

export async function reviewApplicationViaAPI(
  apiContext: APIRequestContext,
  token: string,
  applicationId: string,
  decision: string,
  overrideReason?: string
): Promise<any> {
  const response = await apiContext.post(`/api/v1/recruitment/applications/${applicationId}/review`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { recruiterDecision: decision, overrideReason }
  });

  if (!response.ok()) {
    const body = await response.json();
    throw new Error(`Review application failed: ${response.status()} - ${JSON.stringify(body)}`);
  }

  return await response.json();
}

export async function exportCandidatesViaAPI(
  apiContext: APIRequestContext,
  token: string,
  jobId: string,
  format: "csv" | "xlsx" = "csv"
): Promise<Buffer> {
  const url = format === "csv" 
    ? `/api/v1/recruitment/jobs/${jobId}/export`
    : `/api/v1/recruitment/jobs/${jobId}/export.xlsx`;

  const response = await apiContext.get(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok()) {
    const body = await response.text();
    throw new Error(`Export failed: ${response.status()} - ${body}`);
  }

  return Buffer.from(await response.body());
}

export async function parseJobDescriptionViaAPI(
  apiContext: APIRequestContext,
  token: string,
  description: string
): Promise<any> {
  const response = await apiContext.post("/api/v1/recruitment/jobs/parse-description", {
    headers: { Authorization: `Bearer ${token}` },
    data: { text: description }
  });

  if (!response.ok()) {
    const body = await response.json();
    throw new Error(`Parse JD failed: ${response.status()} - ${JSON.stringify(body)}`);
  }

  return await response.json();
}

export async function waitForBatchCompletion(
  apiContext: APIRequestContext,
  token: string,
  batchId: string,
  maxWaitMs: number = 60000,
  pollIntervalMs: number = 2000
): Promise<any> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitMs) {
    const status = await getBatchStatusViaAPI(apiContext, token, batchId);
    
    if (status.status === "COMPLETED" || status.status === "COMPLETED_WITH_ERRORS" || status.status === "FAILED") {
      return status;
    }
    
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  
  const finalStatus = await getBatchStatusViaAPI(apiContext, token, batchId);
  return finalStatus;
}

export async function setupTestEnvironment(): Promise<TestContext> {
  if (sharedContext) {
    return sharedContext;
  }

  const apiContext = await createApiContext();
  const authTokens = await registerTestUser(apiContext, createTestUser());
  await installRecruitmentConsultant(apiContext, authTokens.accessToken);

  sharedContext = {
    apiContext,
    authTokens,
    jobIds: [],
    batchIds: []
  };

  return sharedContext;
}

export function getSharedContext(): TestContext | null {
  return sharedContext;
}

export async function cleanupTestEnvironment(): Promise<void> {
  if (sharedContext) {
    await sharedContext.apiContext.dispose();
    sharedContext = null;
  }
}

/** Bypasses the UI login form (and its strict auth rate limit) by seeding the same httpOnly refresh-token
 * cookie the real login/register flow sets, then letting the app's own silent-refresh bootstrap
 * (auth-provider's `initialize()` -> `/auth/refresh`) hydrate a real session on next navigation. This is
 * for test setup only — tests that specifically validate login still go through the real UI form.
 *
 * Refresh tokens are single-use and rotate on every call, so this returns the NEW token read back out of
 * the browser's cookie jar. Callers sharing one `auth` object across serial tests (the real UI only ever
 * logs in once per session, but our suite re-authenticates per test for isolation) MUST reassign
 * `auth.refreshToken = await authenticatePage(...)` — reusing the stale pre-call value here trips the
 * backend's reuse-detection and silently logs the "session" back out on the next test. */
export async function authenticatePage(page: Page, refreshToken: string, targetPath: string = "/dashboard"): Promise<string> {
  await page.context().addCookies([
    {
      name: "aiwos_refresh_token",
      value: refreshToken,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax"
    }
  ]);
  // A single full navigation only — the app's auth bootstrap consumes/rotates the single-use refresh
  // token on every full page load, so a second full goto() here would race a second rotation against
  // the same dev-mode double-effect-invocation and can trip the backend's reuse-detection, logging the
  // session back out. Callers that need a specific page should pass it as targetPath instead of
  // following up with their own goto().
  // Next.js middleware only checks cookie PRESENCE before serving /dashboard, so waitForURL resolves
  // before the client's own silent /auth/refresh call (which actually rotates the cookie) has finished —
  // reading cookies right after navigation would still see the stale, now-consumed token. Wait for that
  // response explicitly before reading the rotated value back out.
  const refreshResponse = page.waitForResponse((res) => res.url().includes("/auth/refresh"), {
    timeout: TEST_CONFIG.timeouts.navigation
  });
  await page.goto(targetPath);
  // Wait for the actual target, not a hardcoded "/dashboard" substring — targetPath may be a sibling
  // authenticated route like /ai-employees/:id that never contains the literal word "dashboard" (it's a
  // Next.js route GROUP, (dashboard), which doesn't appear in the URL at all).
  await page.waitForURL(`**${targetPath.split("?")[0]}**`, { timeout: TEST_CONFIG.timeouts.navigation });
  await refreshResponse;
  const cookies = await page.context().cookies();
  const rotated = cookies.find((c) => c.name === "aiwos_refresh_token");
  return rotated?.value ?? refreshToken;
}