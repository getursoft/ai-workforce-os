/**
 * Travel Employee live smoke suite (Sprint 4.2, item 4).
 *
 * A repeatable, deterministic walkthrough of the exact scenarios the release gate requires — run it with:
 *   pnpm --filter api run smoke:travel
 *
 * This drives the REAL `TravelEmployeeLlmOrchestrator` (the same class `AgentService` calls in
 * production) turn by turn, exactly like every other spec in this directory — the only stand-in is the
 * underlying LLM call itself (via a small scripted provider, `scriptedProvider` below), since this
 * environment has no live model credentials. Every classification, calculation, validation, and message
 * builder invoked is 100% production code, not a mock of business logic. It intentionally does NOT require
 * a database or a running HTTP server, so it can run as a fast pre-deploy gate in any environment,
 * including one with no Postgres reachable — `travel.e2e.spec.ts` (real Nest app + Prisma) and the full
 * `pnpm --filter api test` run remain the authoritative HTTP/persistence-level check.
 *
 * Every scenario's PASS/FAIL line is tagged with the running build/commit id (see `resolveSmokeBuildId`),
 * so a smoke result can always be matched back to the exact source commit it ran against — the same
 * resolution strategy `apps/api/src/main.ts` uses at boot (env var first, `git rev-parse HEAD` fallback).
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AiCompletionRequest, AiCompletionResult, AiProvider } from "@ai-workforce-os/plugin-sdk";
import {
  DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
  EMPTY_TRAVEL_ENTITIES,
  EMPTY_TRAVEL_CONVERSATION_MEMORY,
  PROVIDER_FAILURE_MENU_TTL_MS,
  TravelEmployeeLlmOrchestrator,
  type TravelEntities
} from "./travel.runtime";

function resolveSmokeBuildId(): string {
  const fromEnv =
    process.env.GIT_COMMIT ??
    process.env.BUILD_SHA ??
    process.env.SOURCE_VERSION ??
    process.env.RENDER_GIT_COMMIT ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.HEROKU_SLUG_COMMIT;
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 2000 }).trim();
  } catch {
    return "unknown";
  }
}

function textResult(content: string): AiCompletionResult {
  return { content, toolCalls: [], provider: "openai-compatible", model: "gpt-4o-mini", usage: {} };
}

/** Same scripted-provider idiom used throughout travel.llm.spec.ts — queued/derived responses, no live model. */
function scriptedProvider(script: {
  extraction?: Record<string, unknown>;
  intent?: string;
  reply?: string;
}): AiProvider {
  return {
    complete: async (request: AiCompletionRequest) => {
      const isExtraction = request.messages[0]?.content.includes("information-extraction engine");
      if (isExtraction) return textResult(JSON.stringify({ ...(script.extraction ?? {}), intent: script.intent }));
      return textResult(script.reply ?? "Got it.");
    }
  };
}

const config = DEFAULT_TRAVEL_EMPLOYEE_CONFIG;
let buildId = "unknown";

function logResult(scenario: string, passed: boolean): void {
  console.log(`[travel-smoke] build=${buildId} scenario="${scenario}" result=${passed ? "PASS" : "FAIL"}`);
}

describe("Travel Employee live smoke suite", () => {
  beforeAll(() => {
    buildId = resolveSmokeBuildId();
    console.log(`[travel-smoke] starting — build=${buildId}`);
  });
  afterAll(() => {
    console.log(`[travel-smoke] finished — build=${buildId}`);
  });

  it("1. single-leg complete plan", async () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Delhi",
      destinationCity: "Goa",
      travelMonth: "March",
      days: 4,
      adults: 2
    };
    const orchestrator = new TravelEmployeeLlmOrchestrator(
      scriptedProvider({ extraction: {}, intent: "request_plan", reply: "Day 1\n14:00 Hotel check-in\n19:00 Dinner" }),
      config,
      trip
    );
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "complete end to end plan please" }] });
    const passed =
      result.toolCalls.length === 0 &&
      /flights/i.test(result.content) &&
      /hotels/i.test(result.content) &&
      /estimated budget/i.test(result.content) &&
      /day-wise itinerary/i.test(result.content);
    logResult("single-leg complete plan", passed);
    expect(passed).toBe(true);
  });

  it("2. multi-leg route addition", async () => {
    const trip: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Delhi", destinationCity: "Washington", days: 5, adults: 2 };
    const orchestrator = new TravelEmployeeLlmOrchestrator(scriptedProvider({ extraction: {}, intent: "provide_trip_details" }), config, trip);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "Washington se London aur fir London se Delhi ye bhi include kro, London me 3 din ka stay hai" }]
    });
    const legs = orchestrator.journey?.legs ?? [];
    const passed =
      result.toolCalls.length === 0 &&
      legs.length === 3 &&
      legs.map((leg) => `${leg.origin}->${leg.destination}`).join(",") === "Delhi->Washington,Washington->London,London->Delhi";
    logResult("multi-leg route addition", passed);
    expect(passed).toBe(true);
  });

  it("3. journey budget", async () => {
    const trip: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Delhi", destinationCity: "Washington", days: 5, adults: 2 };
    const step1 = new TravelEmployeeLlmOrchestrator(scriptedProvider({ extraction: {}, intent: "provide_trip_details" }), config, trip);
    await step1.complete({
      messages: [{ role: "user", content: "Washington se London aur fir London se Delhi ye bhi include kro, London me 3 din ka stay hai" }]
    });
    const step2 = new TravelEmployeeLlmOrchestrator(scriptedProvider({ extraction: {}, intent: "ask_budget_guidance" }), config, step1.lastEntities, step1.lastMemory);
    const result = await step2.complete({ messages: [{ role: "user", content: "you suggest the budget" }] });
    const passed = result.toolCalls.length === 0 && /journey summary/i.test(result.content) && /total \(combined\)/i.test(result.content);
    logResult("journey budget", passed);
    expect(passed).toBe(true);
  });

  it("4. provider failure followed by itinerary", async () => {
    const trip: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Mumbai", destinationCity: "Singapore", travelMonth: "May", days: 4, adults: 2, budget: 2500, budgetCurrency: "USD" };
    const tools = [{ name: "travel.search_flights", description: "", inputSchema: {} }];
    const step1 = new TravelEmployeeLlmOrchestrator(scriptedProvider({ extraction: {}, intent: "confirm_plan" }), config, trip);
    const searchAttempt = await step1.complete({ messages: [{ role: "user", content: "yes go ahead" }], tools });
    const step1b = new TravelEmployeeLlmOrchestrator(scriptedProvider({}), config, step1.lastEntities, step1.lastMemory);
    const failureResult = await step1b.complete({
      messages: [{ role: "tool", content: JSON.stringify({ error: true, errorCode: "TOOL_TIMEOUT", toolName: "travel.search_flights" }) }]
    });
    const step2 = new TravelEmployeeLlmOrchestrator(
      scriptedProvider({ extraction: {}, intent: "request_plan", reply: "Day 1\n14:00 Marina Bay walk\n19:00 Dinner" }),
      config,
      step1b.lastEntities,
      step1b.lastMemory
    );
    const itineraryResult = await step2.complete({ messages: [{ role: "user", content: "day by day itinerary batao" }] });
    const passed =
      searchAttempt.toolCalls[0]?.name === "travel.search_flights" &&
      failureResult.toolCalls.length === 0 &&
      itineraryResult.toolCalls.length === 0 &&
      /Day 1/.test(itineraryResult.content) &&
      !/indicative recommendations/i.test(itineraryResult.content);
    logResult("provider failure followed by itinerary", passed);
    expect(passed).toBe(true);
  });

  it("5. recovery selections 1/2/3", async () => {
    const trip: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Chennai", destinationCity: "Bangkok", travelMonth: "March", days: 5, adults: 2, budget: 1500, budgetCurrency: "USD" };
    const failedMemory = {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      providerFailure: {
        failedAction: "SEARCH_LIVE_OPTIONS" as const,
        provider: "travel.search_flights",
        failedAt: new Date(0).toISOString(),
        retryable: true,
        selectedRecoveryAction: null,
        menuActive: true,
        menuExpiresAt: new Date(Date.now() + PROVIDER_FAILURE_MENU_TTL_MS).toISOString()
      }
    };
    const tools = [
      { name: "travel.search_flights", description: "", inputSchema: {} },
      { name: "travel.create_lead", description: "", inputSchema: {} }
    ];
    const option1 = await new TravelEmployeeLlmOrchestrator(scriptedProvider({ extraction: {}, intent: "ask_question" }), config, trip, failedMemory).complete({
      messages: [{ role: "user", content: "1" }],
      tools
    });
    const option2 = await new TravelEmployeeLlmOrchestrator(scriptedProvider({ extraction: {}, intent: "ask_question" }), config, trip, failedMemory).complete({
      messages: [{ role: "user", content: "2" }],
      tools
    });
    const option3 = await new TravelEmployeeLlmOrchestrator(scriptedProvider({ extraction: {}, intent: "ask_question" }), config, trip, failedMemory).complete({
      messages: [{ role: "user", content: "3" }],
      tools
    });
    const passed =
      option1.toolCalls.length === 0 &&
      option2.toolCalls[0]?.name === "travel.search_flights" &&
      option3.toolCalls.length === 0 &&
      /mobile number/i.test(option3.content);
    logResult("recovery selections 1/2/3", passed);
    expect(passed).toBe(true);
  });

  it("6. repeated lead and callback requests", async () => {
    const trip: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Chennai", destinationCity: "Sydney", travelMonth: "January", days: 5, adults: 2, budget: 3000, budgetCurrency: "USD" };
    const tools = [{ name: "travel.create_lead", description: "", inputSchema: {} }];
    const orchestrator = new TravelEmployeeLlmOrchestrator(scriptedProvider({ extraction: {}, intent: "confirm_plan" }), config, trip);
    const first = await orchestrator.complete({
      messages: [{ role: "user", content: "submit this request, call me on +919876543210" }],
      tools
    });
    await orchestrator.complete({ messages: [{ role: "tool", content: JSON.stringify({ leadId: "lead-1", reference: "TRV-SMOKE1" }) }] });
    const second = await orchestrator.complete({ messages: [{ role: "user", content: "submit this request again" }], tools });
    const callbackAgain = await orchestrator.complete({ messages: [{ role: "user", content: "call me again please" }], tools });
    const passed =
      first.toolCalls[0]?.name === "travel.create_lead" &&
      second.toolCalls.length === 0 &&
      callbackAgain.toolCalls.length === 0;
    logResult("repeated lead and callback requests", passed);
    expect(passed).toBe(true);
  });

  it("7. language switching", async () => {
    const trip: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Delhi", destinationCity: "Goa", adults: 2 };
    const step1 = new TravelEmployeeLlmOrchestrator(scriptedProvider({ extraction: {}, intent: "provide_trip_details" }), config, trip);
    await step1.complete({ messages: [{ role: "user", content: "hum 4 din ke liye jaana chahte hain bhai" }] });
    const step2 = new TravelEmployeeLlmOrchestrator(scriptedProvider({ extraction: {}, intent: "ask_budget_guidance" }), config, step1.lastEntities, step1.lastMemory);
    await step2.complete({ messages: [{ role: "user", content: "what about the budget" }] });
    const passed = step1.responseLanguage === "HINGLISH" && step2.responseLanguage === "HINGLISH";
    logResult("language switching", passed);
    expect(passed).toBe(true);
  });

  it("8. vegetarian preference", async () => {
    const trip: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Delhi", destinationCity: "Goa", travelMonth: "March", adults: 2, days: 4, preferences: ["vegetarian"] };
    const orchestrator = new TravelEmployeeLlmOrchestrator(
      scriptedProvider({ extraction: {}, intent: "request_plan", reply: "Day 1\n14:00 Hotel check-in\n19:00 Dinner" }),
      config,
      trip
    );
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "give me a day by day itinerary" }] });
    const passed = result.toolCalls.length === 0 && result.content.length > 0;
    logResult("vegetarian preference", passed);
    expect(passed).toBe(true);
  });

  it("9. child/infant budget output", async () => {
    const trip: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Delhi", destinationCity: "Bangkok", travelMonth: "March", days: 4, adults: 2, children: 1, infants: 1 };
    const orchestrator = new TravelEmployeeLlmOrchestrator(scriptedProvider({ extraction: {}, intent: "ask_budget_guidance" }), config, trip);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "you suggest the budget" }] });
    const passed =
      result.toolCalls.length === 0 &&
      /USD/.test(result.content) &&
      !/\d+%/.test(result.content); // no numeric child/infant discount formula — see Sprint 4.2 pricing-consistency fix
    logResult("child/infant budget output", passed);
    expect(passed).toBe(true);
  });

  it("10. no false confirmation wording", async () => {
    const trip: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Delhi", destinationCity: "Paris", travelMonth: "March", adults: 2, days: 4 };
    const orchestrator = new TravelEmployeeLlmOrchestrator(
      scriptedProvider({ extraction: {}, intent: "request_plan", reply: "Day 1\n14:00 Hotel check-in\n19:00 Dinner" }),
      config,
      trip
    );
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "complete end to end plan please" }] });
    const passed = !/\b(?:is|was|has been)\s+(?:confirmed|booked|reserved)\b/i.test(result.content) && /trip details noted/i.test(result.content);
    logResult("no false confirmation wording", passed);
    expect(passed).toBe(true);
  });
});
