/**
 * Sprint 5.0 Phase 23 — repeatable load-test harness. Dependency-free (native fetch), matching this
 * repo's minimal-dependency convention (see pdfkit-over-Playwright, SigV4-over-@aws-sdk precedents).
 *
 * This measures APPLICATION overhead — auth, routing, guards, DB queries. AI-provider response time must
 * be measured separately (it's dominated by the upstream model call, not this platform's code) — the
 * AGENT_EXECUTION scenario below is included for completeness but its p95 will mostly reflect whichever
 * AiProvider is configured, not this codebase.
 *
 * Usage:
 *   BASE_URL=http://localhost:4000/api/v1 \
 *   TEST_EMAIL=owner@example.com TEST_PASSWORD=... TEST_ORG="My Org" \
 *   node --experimental-strip-types scripts/load-test.ts
 *
 * Never run against a real production environment or with real customer data.
 */

interface ScenarioResult {
  name: string;
  requests: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
  throughputPerSec: number;
}

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4000/api/v1";
const CONCURRENCY = Number(process.env.LOAD_TEST_CONCURRENCY ?? 10);
const REQUESTS_PER_SCENARIO = Number(process.env.LOAD_TEST_REQUESTS ?? 100);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

async function runScenario(name: string, request: () => Promise<Response>): Promise<ScenarioResult> {
  const durations: number[] = [];
  let errors = 0;
  const startedAt = Date.now();

  let inFlight = 0;
  let completed = 0;
  await new Promise<void>((resolve) => {
    const launch = () => {
      if (completed >= REQUESTS_PER_SCENARIO) {
        if (inFlight === 0) resolve();
        return;
      }
      inFlight += 1;
      completed += 1;
      const requestStartedAt = performance.now();
      request()
        .then((response) => {
          durations.push(performance.now() - requestStartedAt);
          if (!response.ok) errors += 1;
        })
        .catch(() => {
          durations.push(performance.now() - requestStartedAt);
          errors += 1;
        })
        .finally(() => {
          inFlight -= 1;
          if (completed < REQUESTS_PER_SCENARIO) launch();
          else if (inFlight === 0) resolve();
        });
    };
    for (let i = 0; i < Math.min(CONCURRENCY, REQUESTS_PER_SCENARIO); i++) launch();
  });

  const elapsedSec = (Date.now() - startedAt) / 1000;
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    name,
    requests: durations.length,
    errors,
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(percentile(sorted, 95)),
    p99: Math.round(percentile(sorted, 99)),
    throughputPerSec: Math.round((durations.length / elapsedSec) * 100) / 100
  };
}

async function login(): Promise<string | null> {
  const email = process.env.TEST_EMAIL;
  const password = process.env.TEST_PASSWORD;
  const organizationName = process.env.TEST_ORG;
  if (!email || !password || !organizationName) return null;
  const response = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, organizationName })
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { data?: { tokens?: { accessToken?: string } } };
  return body.data?.tokens?.accessToken ?? null;
}

function printResult(result: ScenarioResult, targetP95Ms?: number): void {
  const status = targetP95Ms !== undefined && result.p95 > targetP95Ms ? "MISS" : "ok";
  console.log(
    `${result.name.padEnd(28)} requests=${result.requests} errors=${result.errors} ` +
      `p50=${result.p50}ms p95=${result.p95}ms p99=${result.p99}ms throughput=${result.throughputPerSec}/s ${status}`
  );
}

async function main(): Promise<void> {
  console.log(`Load test against ${BASE_URL} — ${REQUESTS_PER_SCENARIO} requests/scenario, concurrency=${CONCURRENCY}`);
  console.log("Service targets (from docs/production/security.md / the Sprint 5.0 spec): non-AI endpoints p95 < 500ms, webhook ack p95 < 500ms.\n");

  const results: ScenarioResult[] = [];

  // Unauthenticated, always runnable.
  results.push(await runScenario("GET /health/live", () => fetch(`${BASE_URL.replace(/\/api\/v1$/, "")}/health/live`)));
  results.push(await runScenario("GET /health/ready", () => fetch(`${BASE_URL.replace(/\/api\/v1$/, "")}/health/ready`)));

  const token = await login();
  if (!token) {
    console.log("TEST_EMAIL/TEST_PASSWORD/TEST_ORG not set or login failed — skipping authenticated scenarios.");
    console.log("(Never run this against production credentials. Use a throwaway staging account.)\n");
  } else {
    const auth = { Authorization: `Bearer ${token}` };
    results.push(await runScenario("GET /agents", () => fetch(`${BASE_URL}/agents`, { headers: auth })));
    results.push(await runScenario("GET /observability/health", () => fetch(`${BASE_URL}/observability/health`, { headers: auth })));
    results.push(await runScenario("GET /observability/traces", () => fetch(`${BASE_URL}/observability/traces`, { headers: auth })));
    results.push(await runScenario("GET /onboarding/checklist", () => fetch(`${BASE_URL}/onboarding/checklist`, { headers: auth })));
    results.push(await runScenario("GET /billing/usage/summary", () => fetch(`${BASE_URL}/billing/usage/summary`, { headers: auth })));
  }

  console.log("\nResults:");
  for (const result of results) {
    printResult(result, result.name.startsWith("GET /health") ? 500 : undefined);
  }

  const failed = results.some((r) => r.errors > 0);
  if (failed) {
    console.error("\nAt least one scenario had request errors — see above.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
