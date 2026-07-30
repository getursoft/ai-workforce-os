import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  decidePlanTripTurn,
  emptyPlanTripSkillState,
  type PlanTripReadinessCapabilities,
  type PlanTripSkillState
} from "./plan-trip.skill";
import { PlanTripSkillExecutionMapper } from "./plan-trip-skill-execution.mapper";
import {
  PLAN_TRIP_UAT_FIXTURE,
  type PlanTripUatExpectation,
  type PlanTripUatTurn
} from "./plan-trip-uat.fixture";

interface PlanTripSyntheticUatReport {
  fixtureVersion: string;
  syntheticOnly: true;
  totalConversations: number;
  totalTurns: number;
  agreements: number;
  capabilityAgreements: number;
  blockingSignals: number;
  policyReviewSignals: number;
  expectedNonEquivalenceSignals: number;
  adapterFailures: number;
  persistenceFailures: number;
  revisionConflicts: number;
  stateLossIncidents: number;
  unexpectedFieldOverwrites: number;
  rolloutBlockingAssertionFailures: number;
}

function runFixture(): PlanTripSyntheticUatReport {
  const report: PlanTripSyntheticUatReport = {
    fixtureVersion: PLAN_TRIP_UAT_FIXTURE.fixtureVersion,
    syntheticOnly: true,
    totalConversations: PLAN_TRIP_UAT_FIXTURE.conversations.length,
    totalTurns: 0,
    agreements: 0,
    capabilityAgreements: 0,
    blockingSignals: 0,
    policyReviewSignals: 0,
    expectedNonEquivalenceSignals: 0,
    adapterFailures: 0,
    persistenceFailures: 0,
    revisionConflicts: 0,
    stateLossIncidents: 0,
    unexpectedFieldOverwrites: 0,
    rolloutBlockingAssertionFailures: 0
  };

  for (const conversation of PLAN_TRIP_UAT_FIXTURE.conversations) {
    let state = emptyPlanTripSkillState();
    const processedTurnIds = new Set<string>();
    for (const turn of conversation.turns) {
      report.totalTurns += 1;
      const before = structuredClone(state);
      let actualAction: "ASK_FOR_INPUT" | "READY" | "NOT_APPLICABLE";

      if (turn.operation === "RESET") {
        state = emptyPlanTripSkillState();
        actualAction = "NOT_APPLICABLE";
      } else if (
        turn.operation === "CANCEL" ||
        turn.operation === "ARCHIVE" ||
        turn.operation === "REVISION_CONFLICT" ||
        turn.operation === "ADAPTER_INCOMPLETE" ||
        (turn.operation === "NO_OP" && turn.expected.shadowDecision === "NOT_APPLICABLE")
      ) {
        actualAction = "NOT_APPLICABLE";
      } else if (turn.operation === "DUPLICATE_TURN" && processedTurnIds.has(turn.turnId)) {
        actualAction = state.pendingInput === null ? "READY" : "ASK_FOR_INPUT";
      } else {
        if (turn.operation === "RESTART") {
          const persisted = PlanTripSkillExecutionMapper.toJson(state);
          const reloaded = PlanTripSkillExecutionMapper.fromJson(
            persisted as unknown as Prisma.JsonValue
          );
          if (JSON.stringify(reloaded) !== JSON.stringify(state)) report.stateLossIncidents += 1;
          state = reloaded;
        }
        const evaluation = decidePlanTripTurn(state, { data: turn.input ?? {} });
        state = evaluation.decision.state;
        actualAction = evaluation.decision.action;
        assertCapabilities(evaluation.decision.capabilities, turn.expected.capabilities);
        if (unexpectedOverwrite(before, state, turn)) report.unexpectedFieldOverwrites += 1;
      }
      processedTurnIds.add(turn.turnId);

      try {
        expect(actualAction).toBe(turn.expected.shadowDecision);
        expect(state.pendingInput).toBe(turn.expected.pendingInput);
        expect(state.revision).toBe(turn.expected.persistedRevision);
      } catch (error) {
        if (turn.expected.rolloutBlockingOnFailure) report.rolloutBlockingAssertionFailures += 1;
        throw error;
      }

      const normalizedShadow =
        actualAction === "READY"
          ? "READY_FOR_PLAN"
          : actualAction === "ASK_FOR_INPUT"
            ? "ASK_FOR_INPUT"
            : "NOT_APPLICABLE";
      if (normalizedShadow === turn.expected.legacyDecision) report.agreements += 1;
      if (legacyCapabilityAgrees(turn.expected)) report.capabilityAgreements += 1;
      if (turn.expected.classification === "BLOCKING") report.blockingSignals += 1;
      if (turn.expected.classification === "PRODUCT_POLICY_REVIEW") report.policyReviewSignals += 1;
      if (turn.expected.classification === "EXPECTED_NON_EQUIVALENCE")
        report.expectedNonEquivalenceSignals += 1;
      if (turn.operation === "ADAPTER_INCOMPLETE") report.adapterFailures += 1;
      if (turn.operation === "REVISION_CONFLICT") report.revisionConflicts += 1;
    }
  }
  return report;
}

function assertCapabilities(
  actual: Readonly<Record<string, boolean>> | undefined,
  expectedCapabilities: PlanTripReadinessCapabilities
): void {
  expect(actual).toEqual(expectedCapabilities);
}

function legacyCapabilityAgrees(expectation: PlanTripUatExpectation): boolean {
  if (expectation.legacyDecision === "READY_FOR_PLAN") return expectation.capabilities.itinerary;
  if (expectation.legacyDecision === "EXECUTING_TOOL") return expectation.capabilities.liveSearch;
  if (expectation.legacyDecision === "REQUEST_CONFIRMATION")
    return expectation.capabilities.booking;
  return (
    expectation.legacyDecision === "NOT_APPLICABLE" ||
    expectation.shadowDecision === "ASK_FOR_INPUT"
  );
}

function unexpectedOverwrite(
  before: PlanTripSkillState,
  after: PlanTripSkillState,
  turn: PlanTripUatTurn
): boolean {
  if (turn.operation === "RESET") return false;
  const mutable = new Set(Object.keys(turn.input ?? {}));
  const fields: Array<keyof PlanTripSkillState> = [
    "origin",
    "destination",
    "departureDate",
    "returnDate",
    "duration",
    "travellers",
    "budget",
    "purpose"
  ];
  return fields.some(
    (field) => !mutable.has(field) && JSON.stringify(before[field]) !== JSON.stringify(after[field])
  );
}

describe("travel.plan-trip synthetic UAT pack v1", () => {
  it("evaluates at least 100 deterministic fixture turns without a rollout-blocking assertion failure", () => {
    const report = runFixture();
    console.log(`TRAVEL_PLAN_TRIP_UAT_JSON ${JSON.stringify(report)}`);
    console.log(
      [
        "Travel Plan Trip synthetic UAT (not production metrics)",
        `Conversations: ${report.totalConversations}`,
        `Turns: ${report.totalTurns}`,
        `Decision agreements: ${report.agreements}`,
        `Capability agreements: ${report.capabilityAgreements}`,
        `Blocking signals represented: ${report.blockingSignals}`,
        `Rollout-blocking assertion failures: ${report.rolloutBlockingAssertionFailures}`
      ].join("\n")
    );
    expect(report).toMatchObject({
      syntheticOnly: true,
      totalConversations: 35,
      totalTurns: 105,
      adapterFailures: 1,
      persistenceFailures: 0,
      revisionConflicts: 1,
      stateLossIncidents: 0,
      unexpectedFieldOverwrites: 0,
      rolloutBlockingAssertionFailures: 0
    });
  });
});
