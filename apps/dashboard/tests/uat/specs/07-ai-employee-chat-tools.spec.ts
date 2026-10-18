import { test, expect, APIRequestContext } from "@playwright/test";
import { createCipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTestUser } from "../utils/test-config";
import { createApiContext, registerTestUser, installRecruitmentConsultant, authenticatePage, type AuthTokens } from "../utils/api-helpers";
import { PrismaClient } from "@prisma/client";

// Same AES-256-GCM scheme as PluginSecretsEncryptionService.encrypt() (apps/api/src/plugins/plugin.runtime.ts)
// — replicated here because this test has no NestJS DI container, only Prisma + the real backend's own
// encryption key (read from the repo-root .env, same file the backend process itself loads).
function encryptEmptySecrets(): { version: number; iv: string; tag: string; ciphertext: string } {
  const envText = readFileSync(resolve(__dirname, "../../../../../.env"), "utf8");
  const match = /^PLUGIN_SECRETS_ENCRYPTION_KEY=(.+)$/m.exec(envText);
  if (!match) throw new Error("PLUGIN_SECRETS_ENCRYPTION_KEY not found in root .env");
  const key = Buffer.from(match[1]!.trim().replace(/^"|"$/g, ""), "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({}), "utf8"), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

/**
 * Real UAT (2026-10-17) found a live bug the plain error-handling tests in 06-ai-employee-chat.spec.ts
 * couldn't catch: a tool-calling conversation with a real OpenAI-compatible provider failed outright
 * ("messages with role 'tool' must be a response to a preceeding message with 'tool_calls'") on both
 * the very first tool call AND on history replay in a later turn. Fixed in AgentService/plugin-ai.runtime.
 *
 * No live LLM API key exists in this environment, so this file uses the SAME "DETERMINISTIC" test
 * provider the backend's own e2e suite uses (apps/api/src/agents/agent.e2e.spec.ts) — a real NestJS
 * app, a real browser, real HTTP, real database writes, real tool execution against
 * RecruitmentJobService/RecruitmentCandidateQueryService — only the AI model's decision of which tool to
 * call is a scripted stand-in instead of a live GPT call. This is a LOCAL/SIMULATED verification of the
 * mechanism, not a live-provider verification of model quality; see the chat summary for that
 * distinction.
 */
let apiContext: APIRequestContext;
let auth: AuthTokens;
const testUser = createTestUser();
let pluginId: string;
const prisma = new PrismaClient();

test.beforeAll(async () => {
  apiContext = await createApiContext();
  auth = await registerTestUser(apiContext, testUser);
  pluginId = await installRecruitmentConsultant(apiContext, auth.accessToken);

  const plugin = await prisma.plugin.findUniqueOrThrow({ where: { id: pluginId } });
  const owner = await prisma.user.findFirstOrThrow({ where: { organizationId: plugin.organizationId } });
  await prisma.pluginAiConfiguration.create({
    data: {
      organizationId: plugin.organizationId,
      pluginInstallationId: pluginId,
      providerType: "DETERMINISTIC",
      configuration: { timeoutMs: 30000 },
      encryptedSecrets: encryptEmptySecrets(),
      updatedBy: owner.id
    }
  });
  // This file is proving tool-calling behavior, not the identity-verification gate (which
  // 09-ai-employee-chat-identity-verification.spec.ts covers through the real UI) — bypass it directly.
  await prisma.recruitmentChatIdentityVerification.create({
    data: {
      organizationId: plugin.organizationId,
      userId: owner.id,
      pluginInstallationId: pluginId,
      status: "VERIFIED",
      verifiedAt: new Date(),
      contactMethod: "PHONE",
      contactValue: "+10000000000"
    }
  });
});

test.afterAll(async () => {
  await apiContext.dispose();
  await prisma.$disconnect();
});

test("CHAT-TOOLS-001 a full multi-turn chat: greeting, list jobs, then create a job, all through the real browser UI with real tool execution", async ({ page }) => {
  auth.refreshToken = await authenticatePage(page, auth.refreshToken, `/ai-employees/${pluginId}`);

  // Turn 1: greeting (no tools involved — proves the baseline still works). The DETERMINISTIC test
  // provider's reply text doesn't matter here (it's a generic travel-themed stand-in) — what matters is
  // that the turn completes at all, with no crash.
  await page.locator("#agent-message").fill("Hi");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("text=Agent execution failed")).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator(".chat-composer__field")).toBeEditable({ timeout: 15000 });
  await page.screenshot({ path: "test-results/evidence/CHAT-TOOLS-001a_Greeting.png", fullPage: true });

  // Turn 2: "show me open jobs" — the exact phrase from the live UAT, no jobs exist yet.
  await page.locator("#agent-message").fill("show me open jobs");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("text=Agent execution failed")).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator("text=/job openings/i").first()).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: "test-results/evidence/CHAT-TOOLS-001b_ListJobs_Empty.png", fullPage: true });

  // Turn 3: "create a job" — the exact phrase from the live UAT that reproduced the history-replay bug
  // (fails only when PRIOR turns in the conversation already included a tool call/response).
  await page.locator("#agent-message").fill(
    "Create a new job titled 'Senior Backend Engineer' with description: We need a backend engineer with Python and SQL experience."
  );
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("text=Agent execution failed")).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator("text=/Job posted successfully/i").first()).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: "test-results/evidence/CHAT-TOOLS-001c_CreateJob.png", fullPage: true });

  // Real proof: a genuine RecruitmentJob row now exists, created by the tool, not hallucinated text.
  const job = await prisma.recruitmentJob.findFirst({
    where: { organizationId: (await prisma.plugin.findUniqueOrThrow({ where: { id: pluginId } })).organizationId, title: "Senior Backend Engineer" }
  });
  expect(job).not.toBeNull();
  expect(job?.status).toBe("OPEN");

  // Turn 4: "show me open jobs" again — now with TWO prior tool-calling turns in history (the exact
  // scenario that reproduced the history-replay bug a second time in the live environment).
  await page.locator("#agent-message").fill("show me open jobs");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("text=Agent execution failed")).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator("text=Senior Backend Engineer").first()).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: "test-results/evidence/CHAT-TOOLS-001d_ListJobs_AfterHistory.png", fullPage: true });
});
