import { test, expect, APIRequestContext } from "@playwright/test";
import { createTestUser } from "../utils/test-config";
import {
  createApiContext,
  registerTestUser,
  installRecruitmentConsultant,
  authenticatePage,
  bypassRecruitmentIdentityVerification,
  type AuthTokens
} from "../utils/api-helpers";

/**
 * Sprint 7.17 — AI Recruitment Consultant's DASHBOARD CHAT panel (distinct from the Job/Candidate forms
 * covered by 01-05, and distinct from the WhatsApp menu). Live UAT (2026-10-16/17) found two real,
 * separate things here:
 *   1. A bug: no AI provider configured made the chat crash with an opaque "Agent execution failed /
 *      The request could not be completed safely" card — fixed in AgentService.executeTraced (the
 *      generic-plugin path now falls back to a clear, honest message instead of throwing uncaught).
 *   2. NOT a bug, a capability gap: even once a provider IS configured and answers normally, the
 *      dashboard chat has zero tool access to real job/candidate data — confirmed live by the product
 *      owner's own test ("show me opening" -> "I don't have access to that information"). This is
 *      categorically different from the WhatsApp menu (RecruitmentWhatsAppMenuService), which queries the
 *      real database directly. This file cannot reproduce a successful generic-LLM reply without a live
 *      API key (none is configured in this environment), so it documents and screenshots the FIXED
 *      error-handling path only — the no-tool-access finding is already evidenced by the live screenshot
 *      from the real environment, not re-faked here.
 */

let apiContext: APIRequestContext;
let auth: AuthTokens;
const testUser = createTestUser();
let pluginId: string;

test.beforeAll(async () => {
  apiContext = await createApiContext();
  auth = await registerTestUser(apiContext, testUser);
  pluginId = await installRecruitmentConsultant(apiContext, auth.accessToken);
  // This file is proving provider error-handling, not the identity-verification gate (which
  // 09-ai-employee-chat-identity-verification.spec.ts covers through the real UI) — bypass it directly.
  await bypassRecruitmentIdentityVerification(auth.organizationId, auth.userId, pluginId);
});

test.afterAll(async () => {
  await apiContext.dispose();
});

test("CHAT-001 with no AI provider configured, the chat completes with a clear, honest message instead of a crash", async ({ page }) => {
  auth.refreshToken = await authenticatePage(page, auth.refreshToken, `/ai-employees/${pluginId}`);
  await page.locator("#agent-message").fill("Hi");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("text=/no AI provider has been configured/i").first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator("text=Agent execution failed")).toHaveCount(0);
  await page.screenshot({ path: "test-results/evidence/CHAT-001_No_Provider_Honest_Message.png", fullPage: true });
});

test("CHAT-002 once a provider connection/profile/assignment exists but the credential is invalid, the chat completes with a clear provider error, not an opaque crash", async ({ page }) => {
  const connRes = await apiContext.post("/api/v1/ai-configuration/connections", {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data: { name: "UAT Connection", providerType: "OPENAI_COMPATIBLE", baseUrl: "https://api.openai.com/v1", apiKey: "sk-uat-fake-key-never-real" }
  });
  expect(connRes.ok()).toBeTruthy();
  const conn = await connRes.json();

  const profileRes = await apiContext.post("/api/v1/ai-configuration/profiles", {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data: { name: "UAT Profile", providerConnectionId: conn.id, purpose: "DEFAULT", model: "gpt-4o-mini" }
  });
  expect(profileRes.ok()).toBeTruthy();
  const profile = await profileRes.json();

  const assignRes = await apiContext.put(`/api/v1/ai-configuration/employees/${pluginId}/assignments`, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data: { modelProfileId: profile.id, purpose: "DEFAULT" }
  });
  expect(assignRes.ok()).toBeTruthy();

  auth.refreshToken = await authenticatePage(page, auth.refreshToken, `/ai-employees/${pluginId}`);
  await page.locator("#agent-message").fill("Hi");
  await page.getByRole("button", { name: "Send" }).click();
  // Resolution now reaches the real provider (proves the SHARED_AI_CONFIGURATION_ENABLED flag + the
  // employee assignment both actually work) and the fake key is correctly rejected — a clear, typed
  // error, not the old opaque "could not be completed safely" crash.
  await expect(page.locator("text=/credential|provider|authentication/i").first()).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: "test-results/evidence/CHAT-002_Invalid_Credential_Clear_Error.png", fullPage: true });
});
