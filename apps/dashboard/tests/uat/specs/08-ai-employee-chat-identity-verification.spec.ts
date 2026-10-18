import { test, expect, APIRequestContext } from "@playwright/test";
import { createTestUser } from "../utils/test-config";
import { createApiContext, registerTestUser, installRecruitmentConsultant, authenticatePage, type AuthTokens } from "../utils/api-helpers";

/**
 * Sprint 7.17 follow-up (2026-10-18) — Recruitment Consultant is an internal org tool, not a public
 * application: "anyone can create a job and apply for that job" via an unauthenticated-feeling chat was
 * flagged as something to restrict. A brand-new user's very first message must be gated behind a
 * phone/email + one-time-code check before any tool runs, on both the dashboard and iOS chat surfaces
 * (both call the same `/agents/run` endpoint, so this one HTTP-level mechanism covers both).
 *
 * The OTP is sent via MockSmsProvider in this environment (no live Twilio/SMTP credential is configured,
 * per this project's standing rule against calling live external providers from automated tests) — the
 * backend logs the code via a debug line that is only ever emitted alongside that fake, non-delivered
 * mock send (RecruitmentChatIdentityVerificationService.sendOtp, gated on `!twilioSms.isConfigured()`),
 * never alongside a real send. This spec reads that log line back to drive the real chat UI through the
 * full flow, proving the actual rendered welcome/OTP/verified messages in a real browser, not just the
 * HTTP-level mechanism (already covered by apps/api/src/agents/agent.e2e.spec.ts's equivalent test).
 */

async function readLastOtpFromServerLog(logPath: string): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(logPath, "utf8");
  const matches = [...text.matchAll(/RECRUITMENT_CHAT_OTP_CODE_DEV_ONLY_MOCK_SMS[\s\S]{0,200}?"code":\s*"(\d{6})"/g)];
  const last = matches.at(-1);
  if (!last) throw new Error(`No OTP debug log line found in ${logPath} — is the dev-only debug log still present and is the server using MockSmsProvider (no Twilio configured)?`);
  return last[1]!;
}

const SERVER_LOG_PATH = process.env.KREVIA_API_LOG_PATH ?? "/tmp/krevia-api-restart-otp-gate.log";

let apiContext: APIRequestContext;
let auth: AuthTokens;
const testUser = createTestUser();
let pluginId: string;

test.beforeAll(async () => {
  apiContext = await createApiContext();
  auth = await registerTestUser(apiContext, testUser);
  pluginId = await installRecruitmentConsultant(apiContext, auth.accessToken);
});

test.afterAll(async () => {
  await apiContext.dispose();
});

test("IDENTITY-001 a brand-new user is welcomed and must verify a phone number via OTP before Recruitment Consultant does anything real", async ({ page }) => {
  auth.refreshToken = await authenticatePage(page, auth.refreshToken, `/ai-employees/${pluginId}`);

  // Turn 1: first contact — welcomed, asked to verify, NOT a tool reply or an AI answer.
  await page.locator("#agent-message").fill("Hi");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("text=/Welcome to the Krevia Recruitment team/i").first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator("text=/mobile number or email/i").first()).toBeVisible();
  await page.screenshot({ path: "test-results/evidence/IDENTITY-001a_Welcome_Prompt.png", fullPage: true });

  // Turn 2: supply a phone number — an OTP is generated and "sent" (MockSmsProvider; see file doc comment).
  const phone = "+15557654321";
  await page.locator("#agent-message").fill(phone);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("text=/verification code/i").first()).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: "test-results/evidence/IDENTITY-001b_OTP_Sent.png", fullPage: true });

  const otpCode = await readLastOtpFromServerLog(SERVER_LOG_PATH);

  // Turn 3: a wrong code is rejected without crashing and without granting access.
  const wrongCode = otpCode === "000000" ? "111111" : "000000";
  await page.locator("#agent-message").fill(wrongCode);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("text=/wasn't right/i").first()).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: "test-results/evidence/IDENTITY-001c_Wrong_Code.png", fullPage: true });

  // Turn 4: the correct code verifies the user.
  await page.locator("#agent-message").fill(otpCode);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("text=/verified/i").first()).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: "test-results/evidence/IDENTITY-001d_Verified.png", fullPage: true });

  // Turn 5: now verified, the SAME generic no-provider-configured path from 06-ai-employee-chat.spec.ts
  // applies (this org never configured an AI provider either) — proof the gate only blocked unverified
  // turns and never interferes once passed, by reaching the real pipeline instead of the welcome prompt.
  const messageCountBefore = await page.locator("text=/Welcome to the Krevia Recruitment team/i").count();
  await page.locator("#agent-message").fill("Hi again");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("text=/no AI provider has been configured/i").first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator("text=/Welcome to the Krevia Recruitment team/i")).toHaveCount(messageCountBefore);
  await page.screenshot({ path: "test-results/evidence/IDENTITY-001e_Post_Verification_Normal_Chat.png", fullPage: true });
});
