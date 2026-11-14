/**
 * Platform-owner release walkthrough.
 *
 * Logs in through the real UI as the seeded platform owner, deploys every AI Agent from the Agent
 * Marketplace, holds a conversation with each one, and opens every authenticated dashboard page —
 * capturing a full-page screenshot of each step and failing on any server error (5xx), permission
 * denial (403), forced logout, or visible error state.
 *
 * Run (API on :4000 and dashboard on :3000 must already be up):
 *   pnpm --filter @ai-workforce-os/dashboard exec playwright test tests/uat/specs/00-platform-owner-walkthrough.spec.ts --project=recruitment-diagnostic
 *
 * Screenshots go to OWNER_UAT_SCREENSHOT_DIR (default: test-results/owner-walkthrough) together with a
 * summary.json listing every page/agent checked and any issue found.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page, type Response } from "@playwright/test";

const OWNER = {
  email: process.env.PLATFORM_OWNER_EMAIL ?? "krpandey25646@gmail.com",
  password: process.env.PLATFORM_OWNER_PASSWORD ?? "PlatformOwner@25646",
  organization: process.env.PLATFORM_OWNER_ORG ?? "krevia-ai"
};
const API_BASE = process.env.UAT_API_BASE_URL ?? "http://localhost:4000/api/v1";
const SHOTS = process.env.OWNER_UAT_SCREENSHOT_DIR ?? join(process.cwd(), "test-results", "owner-walkthrough");

/** One realistic opening message per agent, matched to its domain. */
const AGENT_PROMPTS: Record<string, string> = {
  "receptionist-employee": "Hi, I need help planning a business trip.",
  "travel-employee": "Plan a 5 day trip from New Delhi to Dubai for 2 adults in March, budget 3000 USD.",
  "hr-employee": "What is the leave policy?",
  "finance-employee": "I need help submitting an expense claim.",
  "it-support-employee": "My VPN is not working.",
  "sales-employee": "Can I get a quote for your product?",
  "marketing-employee": "Help me plan a campaign for a product launch.",
  "legal-employee": "I need to draft a reply to a legal notice.",
  "customer-support-employee": "Where is my order?"
};

const PAGES = [
  "/dashboard",
  "/agents",
  "/workforce",
  "/ask-krevia",
  "/travel-agent",
  "/travel-agent/bookings",
  "/hr-agent",
  "/finance-agent",
  "/it-support-agent",
  "/sales-agent",
  "/marketing-agent",
  "/legal-agent",
  "/customer-support-agent",
  "/dashboard/recruitment/jobs",
  "/dashboard/recruitment/jobs/new",
  "/conversations",
  "/interactions",
  "/tasks",
  "/dashboard/approvals",
  "/execution-history",
  "/memory",
  "/knowledge",
  "/skills",
  "/tools",
  "/connectors",
  "/integrations",
  "/channels",
  "/channels/new",
  "/voice-calls",
  "/scheduler",
  "/observability",
  "/crm",
  "/dashboard/sales-leads",
  "/team",
  "/teams",
  "/usage",
  "/usage/buy-credits",
  "/dashboard/organization",
  "/dashboard/organizations",
  "/dashboard/plugins",
  "/dashboard/service-accounts",
  "/dashboard/settings/users",
  "/dashboard/settings/roles",
  "/dashboard/settings/permissions",
  "/dashboard/settings/invitations",
  "/dashboard/settings/payments",
  "/settings",
  "/settings/ai-providers",
  "/settings/sessions",
  "/profile"
];

const ERROR_TEXT =
  /something went wrong|application error|access denied|you do not have permission|you don't have permission|not authori[sz]ed|unable to load|failed to load/i;

interface Issue {
  step: string;
  problem: string;
}
interface StepResult {
  step: string;
  screenshot: string;
  ok: boolean;
  notes?: string;
}

const issues: Issue[] = [];
const results: StepResult[] = [];
let shotIndex = 0;

function slug(value: string): string {
  return value.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "") || "root";
}

/** Watches every API response for the lifetime of a page and records 5xx / 403 against the current step. */
function watchApi(page: Page, currentStep: () => string): void {
  page.on("response", (response: Response) => {
    const url = response.url();
    if (!url.includes("/api/v1/")) return;
    const status = response.status();
    if (status >= 500 || status === 403) {
      issues.push({ step: currentStep(), problem: `${response.request().method()} ${url} -> ${status}` });
    }
  });
  page.on("pageerror", (error) => {
    issues.push({ step: currentStep(), problem: `uncaught page error: ${error.message}` });
  });
}

async function settle(page: Page): Promise<void> {
  // Several pages poll (refetchInterval), so "networkidle" may never arrive — bound it tightly and then
  // wait for loading skeletons to resolve into real content.
  await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
  // Every full page load first shows the session-restore screen while the refresh cookie is rotated.
  await page
    .getByText("Restoring your authenticated session")
    .waitFor({ state: "hidden", timeout: 15_000 })
    .catch(() => undefined);
  await page
    .locator(".skeleton, [aria-busy='true']")
    .first()
    .waitFor({ state: "detached", timeout: 10_000 })
    .catch(() => undefined);
}

async function capture(page: Page, step: string, ok: boolean, notes?: string): Promise<void> {
  shotIndex += 1;
  const file = `${String(shotIndex).padStart(3, "0")}-${slug(step)}.png`;
  // Animated backgrounds can stall a full-page capture indefinitely under tracing — freeze animations and
  // never let one screenshot hang the whole walkthrough.
  const shot = page.screenshot({ path: join(SHOTS, file), fullPage: true, animations: "disabled", timeout: 30_000 });
  const capped = await Promise.race([
    shot.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 35_000))
  ]);
  if (!capped) issues.push({ step, problem: "screenshot timed out" });
  results.push({ step, screenshot: file, ok, ...(notes ? { notes } : {}) });
}

async function visibleErrorText(page: Page): Promise<string | null> {
  const alerts = page.locator("[role='alert'], .ui-alert--danger, .alert--danger");
  const count = await alerts.count();
  for (let i = 0; i < count; i++) {
    const alert = alerts.nth(i);
    if (!(await alert.isVisible())) continue;
    const text = (await alert.innerText()).trim();
    if (ERROR_TEXT.test(text)) return text.slice(0, 200);
  }
  const body = await page.locator("main").first().innerText().catch(() => "");
  const match = ERROR_TEXT.exec(body);
  return match ? body.slice(Math.max(0, match.index - 40), match.index + 120).replace(/\s+/g, " ") : null;
}

async function apiToken(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${API_BASE}/auth/login`, {
    data: { email: OWNER.email, password: OWNER.password, organizationName: OWNER.organization }
  });
  expect(response.status(), "platform owner API login").toBe(200);
  const body = (await response.json()) as { data: { tokens: { accessToken: string } } };
  return body.data.tokens.accessToken;
}

// Screenshots are the evidence here; full tracing on every step makes captures of animated pages stall.
test.use({ trace: "off", video: "off" });

// Deploying ~10 agents and chatting with each takes minutes, not the 30s Playwright default.
test.describe.configure({ mode: "serial", timeout: 600_000 });

test.describe("Platform owner walkthrough — every agent, every page", () => {
  let page: Page;
  let step = "setup";

  test.beforeAll(async ({ browser }) => {
    mkdirSync(SHOTS, { recursive: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    watchApi(page, () => step);
  });

  test.afterAll(async () => {
    writeFileSync(
      join(SHOTS, "summary.json"),
      JSON.stringify({ owner: OWNER.email, checkedAt: new Date().toISOString(), results, issues }, null, 2)
    );
    await page.close();
  });

  test("logs in through the UI as the platform owner", async () => {
    step = "login";
    await page.goto("/login");
    await settle(page);
    await page.locator("#email").fill(OWNER.email);
    await page.locator("#password").fill(OWNER.password);
    await page.locator("#organizationName").fill(OWNER.organization);
    await capture(page, "login-form", true);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/(dashboard|onboarding|agents)/, { timeout: 30_000 });
    await settle(page);
    await capture(page, "after-login", true);
    expect(page.url()).not.toContain("/login");
  });

  test("deploys every agent from the Agent Marketplace", async () => {
    step = "agent-marketplace";
    await page.goto("/agents");
    await settle(page);
    await capture(page, "my-agents-before-deploy", true);
    const deployButtons = page.getByRole("button", { name: /^Deploy / });
    // Each deploy re-renders the marketplace list, so always click the first remaining button.
    for (let guard = 0; guard < 20 && (await deployButtons.count()) > 0; guard++) {
      const label = (await deployButtons.first().getAttribute("aria-label")) ?? "Deploy agent";
      step = `agent-marketplace: ${label}`;
      const remaining = await deployButtons.count();
      await deployButtons.first().click();
      await expect
        .poll(async () => deployButtons.count(), { timeout: 30_000, message: `${label} did not complete` })
        .toBeLessThan(remaining);
      await settle(page);
    }
    await capture(page, "my-agents-after-deploy", true);
    expect(await deployButtons.count(), "every marketplace agent deployed").toBe(0);
  });

  test("holds a conversation with every chat agent", async ({ request }) => {
    const token = await apiToken(request);
    const listed = await request.get(`${API_BASE}/agents`, { headers: { authorization: `Bearer ${token}` } });
    expect(listed.status()).toBe(200);
    const raw = (await listed.json()) as unknown;
    const agents = (Array.isArray(raw) ? raw : ((raw as { data?: unknown[] }).data ?? [])) as Array<{
      id?: string;
      pluginInstallationId?: string;
      slug?: string;
      pluginId?: string;
      displayName?: string;
      status?: string;
    }>;
    const chatAgents = agents.filter((agent) => AGENT_PROMPTS[agent.slug ?? agent.pluginId ?? ""]);
    expect(chatAgents.length, "chat agents installed").toBe(Object.keys(AGENT_PROMPTS).length);

    for (const agent of chatAgents) {
      const key = agent.slug ?? agent.pluginId ?? "";
      const id = agent.pluginInstallationId ?? agent.id ?? "";
      step = `chat: ${agent.displayName ?? key}`;
      await page.goto(`/agents/${id}`, { waitUntil: "domcontentloaded" });
      await settle(page);
      const bubbles = page.locator(".chat-bubble");
      const composer = page.locator("#agent-message");
      await expect(composer, `${key} composer visible`).toBeVisible({ timeout: 20_000 });
      const before = await bubbles.count();
      await composer.fill(AGENT_PROMPTS[key] ?? "Hello");
      await page.getByRole("button", { name: "Send" }).click();
      // A reply means: our message plus at least one new bubble after it, and the newest one is the agent's.
      let replied = true;
      await expect
        .poll(
          async () =>
            (await bubbles.count()) >= before + 2 &&
            ((await bubbles.last().getAttribute("class")) ?? "").includes("chat-bubble--assistant"),
          { timeout: 60_000 }
        )
        .toBe(true)
        .catch(() => {
          replied = false;
        });
      await settle(page);
      const reply = replied ? (await bubbles.last().innerText()).trim().slice(0, 300) : "";
      if (!replied || !reply) issues.push({ step, problem: "agent did not reply" });
      const errorText = await visibleErrorText(page);
      if (errorText) issues.push({ step, problem: `visible error: ${errorText}` });
      await capture(page, `chat-${key}`, replied && !errorText, reply.replace(/\s+/g, " ").slice(0, 200));
    }
  });

  test("opens every dashboard page without errors", async () => {
    for (const path of PAGES) {
      step = `page: ${path}`;
      const started = Date.now();
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      const loadedAt = Date.now();
      await settle(page);
      const settledAt = Date.now();
      const problems: string[] = [];
      if (!response || response.status() >= 400) problems.push(`document status ${response?.status() ?? "none"}`);
      if (new URL(page.url()).pathname.startsWith("/login")) problems.push("redirected to login (session lost)");
      const errorText = await visibleErrorText(page);
      if (errorText) problems.push(`visible error: ${errorText}`);
      const checkedAt = Date.now();
      for (const problem of problems) issues.push({ step, problem });
      await capture(page, `page${path}`, problems.length === 0, problems.join("; ") || undefined);
      console.log(
        `${path}: goto ${loadedAt - started}ms, settle ${settledAt - loadedAt}ms, checks ${checkedAt - settledAt}ms, ` +
          `screenshot ${Date.now() - checkedAt}ms${problems.length ? ` — ${problems.join("; ")}` : ""}`
      );
    }
  });

  test("reports no issues across the whole walkthrough", () => {
    expect(issues, JSON.stringify(issues, null, 2)).toEqual([]);
  });
});
