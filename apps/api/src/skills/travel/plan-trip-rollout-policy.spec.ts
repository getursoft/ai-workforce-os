import { describe, expect, it } from "vitest";
import {
  PLAN_TRIP_ROLLOUT_CLASSIFICATION,
  classifyPlanTripReason
} from "./plan-trip-rollout-policy";

describe("travel.plan-trip rollout policy", () => {
  it("uses exhaustive typed classifications", () => {
    expect(classifyPlanTripReason("ADAPTER_INCOMPLETE")).toBe("BLOCKING");
    expect(classifyPlanTripReason("EXISTING_READY_SHADOW_MISSING_TRAVEL_YEAR")).toBe(
      "EXPECTED_NON_EQUIVALENCE"
    );
    expect(classifyPlanTripReason("EXISTING_LIVE_SEARCH_SHADOW_MISSING_TRAVEL_YEAR")).toBe(
      "BLOCKING"
    );
    expect(classifyPlanTripReason("TOOL_EXECUTION_WHILE_SHADOW_READY")).toBe(
      "EXPECTED_NON_EQUIVALENCE"
    );
    expect(Object.keys(PLAN_TRIP_ROLLOUT_CLASSIFICATION)).toHaveLength(26);
  });
});
