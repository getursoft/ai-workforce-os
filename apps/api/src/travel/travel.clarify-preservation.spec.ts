import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
  EMPTY_TRAVEL_CONVERSATION_MEMORY,
  EMPTY_TRAVEL_ENTITIES,
  TravelEmployeeLlmOrchestrator,
  buildClarificationConfirmedMessage,
  type TravelEntities
} from "./travel.runtime";

/**
 * Sprint 6.6 — Parts 9-12/29: Travel's own city-clarification mechanism already correctly preserved a
 * candidate across a "yes" (`resolveCityClarificationYes` commits the previously-extracted
 * `proposedValue`) — these tests cover the gap this sprint closes: a "no" that supplies the replacement
 * in the same breath ("No, Dubai") must not be re-asked blindly, discarding "Dubai".
 */

const config = DEFAULT_TRAVEL_EMPLOYEE_CONFIG;

function fakeProvider(response: { extraction?: Record<string, unknown>; intent?: string } = {}) {
  const calls: unknown[] = [];
  return {
    calls,
    async complete(request: unknown) {
      calls.push(request);
      const payload = {
        entities: response.extraction ?? {},
        intent: response.intent ?? "provide_trip_details",
        turnProposal: { answersPendingAction: false, supersedesPendingAction: false, preservePendingAction: true, confidence: 0 }
      };
      return { content: JSON.stringify(payload), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    }
  };
}

describe("Travel city-clarification preservation (Sprint 6.6)", () => {
  it("Test A — candidate survives a plain 'yes'", async () => {
    const priorValues: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" };
    const orchestrator = new TravelEmployeeLlmOrchestrator(fakeProvider(), config, priorValues, {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      pendingClarification: { field: "destinationCity", proposedValue: "Sydney", rawValue: "sidni", confidence: 0.7 }
    });
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "yes" }] });
    expect(orchestrator.lastEntities.destinationCity).toBe("Sydney");
    expect(orchestrator.pendingClarification).toBeNull();
    expect(result.content).toBe(buildClarificationConfirmedMessage("destinationCity", "Sydney"));
  });

  it("Test B — a plain 'no' with no replacement clears the candidate and re-asks, never fabricating a value", async () => {
    const priorValues: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" };
    const orchestrator = new TravelEmployeeLlmOrchestrator(fakeProvider(), config, priorValues, {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      pendingClarification: { field: "destinationCity", proposedValue: "Sydney", rawValue: "sidni", confidence: 0.7 }
    });
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "No" }] });
    expect(orchestrator.lastEntities.destinationCity).toBeNull();
    expect(orchestrator.pendingClarification).toBeNull();
    expect(result.content).not.toMatch(/sydney/i);
  });

  it("Test C — 'No, Dubai' resolves the destination to Dubai, not a re-ask that discards it", async () => {
    const priorValues: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" };
    const orchestrator = new TravelEmployeeLlmOrchestrator(fakeProvider(), config, priorValues, {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      pendingClarification: { field: "destinationCity", proposedValue: "Sydney", rawValue: "sidni", confidence: 0.7 }
    });
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "No, Dubai" }] });
    expect(orchestrator.pendingClarification).toBeNull();
    expect(orchestrator.lastEntities.destinationCity).toBe("Dubai");
    expect(result.content).not.toMatch(/did you mean|sure that's right/i);
  });

  it("Test D — a domain-pivot reply during clarify offers to route away, and never fabricates Sydney as confirmed", async () => {
    const priorValues: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" };
    const orchestrator = new TravelEmployeeLlmOrchestrator(fakeProvider(), config, priorValues, {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      pendingClarification: { field: "destinationCity", proposedValue: "Sydney", rawValue: "sidni", confidence: 0.7 }
    });
    // Travel's own out-of-scope detection (detectOutOfScopeEmployee) runs BEFORE the pendingClarification
    // check and returns early with an offer to route away — "salary" is plainly out of Travel's domain.
    // The Receptionist (not exercised by this unit test, which talks to the orchestrator directly) is what
    // actually decides the destination employee; what THIS layer must guarantee is that Sydney is never
    // silently treated as confirmed just because a clarification happened to be pending when the pivot
    // arrived — Travel's own `pendingClarification` is private per-conversation state that cannot leak
    // into a separate HR conversation regardless, but a false "confirmed" write here would be a real bug.
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "Forget this, salary ka issue hai" }] });
    expect(result.content).toMatch(/route|connect|different (?:team|department|specialist)/i);
    expect(orchestrator.lastEntities.destinationCity).not.toBe("Sydney");
    expect(orchestrator.confirmation.destinationCity?.confirmed).not.toBe(true);
  });
});
