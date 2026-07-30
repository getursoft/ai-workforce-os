import type {
  PlanTripReadinessCapabilities,
  PlanTripSkillInputData,
  PlanTripSkillState
} from "./plan-trip.skill";
import type {
  PlanTripRolloutClassification,
  PlanTripDiagnosticReason
} from "./plan-trip-rollout-policy";
import type { SkillShadowDecisionCategory } from "./plan-trip-shadow-comparison";

export type PlanTripUatMode = "DETERMINISTIC" | "LLM";
export type PlanTripUatOperation =
  | "APPLY"
  | "NO_OP"
  | "DUPLICATE_TURN"
  | "RESTART"
  | "RESET"
  | "CANCEL"
  | "ARCHIVE"
  | "REVISION_CONFLICT"
  | "ADAPTER_INCOMPLETE";

export interface PlanTripUatExpectation {
  legacyDecision: SkillShadowDecisionCategory;
  shadowDecision: "ASK_FOR_INPUT" | "READY" | "NOT_APPLICABLE";
  pendingInput: PlanTripSkillState["pendingInput"];
  capabilities: PlanTripReadinessCapabilities;
  persistedRevision: number;
  reasonCode: PlanTripDiagnosticReason | null;
  classification: PlanTripRolloutClassification | "NONE";
  manualReviewRequired: boolean;
  rolloutBlockingOnFailure: boolean;
}

export interface PlanTripUatTurn {
  turnId: string;
  userInput: string;
  operation: PlanTripUatOperation;
  input?: PlanTripSkillInputData;
  expected: PlanTripUatExpectation;
}

export interface PlanTripUatConversation {
  id: string;
  title: string;
  coverage: readonly string[];
  mode: PlanTripUatMode;
  turns: PlanTripUatTurn[];
}

export interface PlanTripUatFixture {
  fixtureVersion: "1.0.0";
  skillId: "travel.plan-trip";
  skillVersion: "1.0.0";
  syntheticOnly: true;
  conversations: PlanTripUatConversation[];
}

const NONE: PlanTripReadinessCapabilities = {
  itinerary: false,
  estimate: false,
  liveSearch: false,
  booking: false
};
const EARLY: PlanTripReadinessCapabilities = {
  itinerary: true,
  estimate: true,
  liveSearch: false,
  booking: false
};
const ALL: PlanTripReadinessCapabilities = {
  itinerary: true,
  estimate: true,
  liveSearch: true,
  booking: true
};
const source = "USER_EXPLICIT" as const;
const value = <T>(input: T) => ({ value: input, source });
const date = (year: number | null, month = 1, day: number | null = 12) =>
  value({
    value:
      year === null
        ? day === null
          ? "January"
          : "12 January"
        : `${year}-${String(month).padStart(2, "0")}-${String(day ?? 1).padStart(2, "0")}`,
    day,
    month,
    year
  });
const duration = (count: number, unit: "DAYS" | "NIGHTS") => value({ value: count, unit });
const composition = (adults = 2, children = 0, infants = 0) => value({ adults, children, infants });
const totalOnly = (total: number) => value({ total, adults: null, children: null, infants: null });

function expected(
  pendingInput: PlanTripSkillState["pendingInput"],
  capabilities: PlanTripReadinessCapabilities,
  persistedRevision: number,
  options: Partial<
    Pick<
      PlanTripUatExpectation,
      | "legacyDecision"
      | "shadowDecision"
      | "reasonCode"
      | "classification"
      | "manualReviewRequired"
      | "rolloutBlockingOnFailure"
    >
  > = {}
): PlanTripUatExpectation {
  return {
    legacyDecision: options.legacyDecision ?? (pendingInput ? "ASK_FOR_INPUT" : "READY_FOR_PLAN"),
    shadowDecision: options.shadowDecision ?? (pendingInput ? "ASK_FOR_INPUT" : "READY"),
    pendingInput,
    capabilities,
    persistedRevision,
    reasonCode: options.reasonCode ?? null,
    classification: options.classification ?? "NONE",
    manualReviewRequired: options.manualReviewRequired ?? false,
    rolloutBlockingOnFailure: options.rolloutBlockingOnFailure ?? true
  };
}

function turn(
  turnId: string,
  userInput: string,
  input: PlanTripSkillInputData | undefined,
  expectation: PlanTripUatExpectation,
  operation: PlanTripUatOperation = "APPLY"
): PlanTripUatTurn {
  return { turnId, userInput, operation, ...(input ? { input } : {}), expected: expectation };
}

function standard(
  id: string,
  title: string,
  coverage: readonly string[],
  mode: PlanTripUatMode,
  options: { budget?: boolean; purpose?: boolean; nights?: boolean } = {}
): PlanTripUatConversation {
  return {
    id,
    title,
    coverage,
    mode,
    turns: [
      turn(
        `${id}-1`,
        "Plan Delhi to Dubai",
        { origin: value("Delhi"), destination: value("Dubai") },
        expected("DEPARTURE_DATE", NONE, 1)
      ),
      turn(
        `${id}-2`,
        options.nights ? "12 Jan 2027 for 4 nights" : "12 Jan 2027 for 4 days",
        {
          departureDate: date(2027),
          duration: duration(4, options.nights ? "NIGHTS" : "DAYS"),
          ...(options.budget ? { budget: value({ amount: 50_000, currency: "INR" }) } : {}),
          ...(options.purpose ? { purpose: value("LEISURE" as const) } : {})
        },
        expected("TRAVELLERS", NONE, 2)
      ),
      turn(`${id}-3`, "2 adults", { travellers: composition() }, expected(null, ALL, 3))
    ]
  };
}

const special: PlanTripUatConversation[] = [
  {
    id: "uat-02",
    title: "Origin supplied after destination",
    coverage: ["missing-origin", "origin-after-destination"],
    mode: "DETERMINISTIC",
    turns: [
      turn("uat-02-1", "Dubai", { destination: value("Dubai") }, expected("ORIGIN", NONE, 1)),
      turn(
        "uat-02-2",
        "from Delhi",
        { origin: value("Delhi") },
        expected("DEPARTURE_DATE", NONE, 2)
      ),
      turn(
        "uat-02-3",
        "12 Jan 2027, 4 days, 2 adults",
        { departureDate: date(2027), duration: duration(4, "DAYS"), travellers: composition() },
        expected(null, ALL, 3)
      )
    ]
  },
  {
    id: "uat-03",
    title: "Destination supplied after origin",
    coverage: ["missing-destination"],
    mode: "LLM",
    turns: [
      turn("uat-03-1", "from Delhi", { origin: value("Delhi") }, expected("DESTINATION", NONE, 1)),
      turn(
        "uat-03-2",
        "Dubai",
        { destination: value("Dubai") },
        expected("DEPARTURE_DATE", NONE, 2)
      ),
      turn(
        "uat-03-3",
        "12 Jan 2027, 4 days, 2 adults",
        { departureDate: date(2027), duration: duration(4, "DAYS"), travellers: composition() },
        expected(null, ALL, 3)
      )
    ]
  },
  {
    id: "uat-04",
    title: "Month-only date followed by year",
    coverage: ["partial-date", "year-only-reply"],
    mode: "DETERMINISTIC",
    turns: [
      turn(
        "uat-04-1",
        "Delhi to Dubai in January for 4 days, 2 adults",
        {
          origin: value("Delhi"),
          destination: value("Dubai"),
          departureDate: date(null, 1, null),
          duration: duration(4, "DAYS"),
          travellers: composition()
        },
        expected("TRAVEL_YEAR", EARLY, 1, {
          legacyDecision: "READY_FOR_PLAN",
          reasonCode: "EXISTING_READY_SHADOW_MISSING_TRAVEL_YEAR",
          classification: "EXPECTED_NON_EQUIVALENCE",
          manualReviewRequired: true,
          rolloutBlockingOnFailure: false
        })
      ),
      turn("uat-04-2", "2027", { departureDate: date(2027, 1, null) }, expected(null, ALL, 2)),
      turn("uat-04-3", "show itinerary", undefined, expected(null, ALL, 2), "NO_OP")
    ]
  },
  {
    id: "uat-05",
    title: "Day and month followed by year",
    coverage: ["partial-date", "year-only-reply"],
    mode: "LLM",
    turns: [
      turn(
        "uat-05-1",
        "Delhi to Dubai on 12 January for 4 nights",
        {
          origin: value("Delhi"),
          destination: value("Dubai"),
          departureDate: date(null),
          duration: duration(4, "NIGHTS")
        },
        expected("TRAVEL_YEAR", NONE, 1)
      ),
      turn(
        "uat-05-2",
        "5 travellers",
        { travellers: totalOnly(5) },
        expected("TRAVEL_YEAR", EARLY, 2, {
          legacyDecision: "READY_FOR_PLAN",
          reasonCode: "EXISTING_READY_SHADOW_MISSING_TRAVEL_YEAR",
          classification: "EXPECTED_NON_EQUIVALENCE",
          manualReviewRequired: true,
          rolloutBlockingOnFailure: false
        })
      ),
      turn(
        "uat-05-3",
        "2027",
        { departureDate: date(2027) },
        expected("TRAVELLER_COMPOSITION", EARLY, 3, {
          legacyDecision: "READY_FOR_PLAN",
          reasonCode: "EXISTING_READY_SHADOW_MISSING_TRAVELLER_COMPOSITION",
          classification: "EXPECTED_NON_EQUIVALENCE",
          manualReviewRequired: true,
          rolloutBlockingOnFailure: false
        })
      )
    ]
  },
  {
    id: "uat-06",
    title: "Total-only travellers then composition",
    coverage: ["total-only-travellers", "adult-child-composition"],
    mode: "DETERMINISTIC",
    turns: [
      turn(
        "uat-06-1",
        "Delhi to Dubai, 12 Jan 2027, 4 days",
        {
          origin: value("Delhi"),
          destination: value("Dubai"),
          departureDate: date(2027),
          duration: duration(4, "DAYS")
        },
        expected("TRAVELLERS", NONE, 1)
      ),
      turn(
        "uat-06-2",
        "5 travellers",
        { travellers: totalOnly(5) },
        expected("TRAVELLER_COMPOSITION", EARLY, 2, {
          legacyDecision: "READY_FOR_PLAN",
          reasonCode: "EXISTING_READY_SHADOW_MISSING_TRAVELLER_COMPOSITION",
          classification: "EXPECTED_NON_EQUIVALENCE",
          manualReviewRequired: true,
          rolloutBlockingOnFailure: false
        })
      ),
      turn(
        "uat-06-3",
        "3 adults and 2 children",
        { travellers: composition(3, 2, 0) },
        expected(null, ALL, 3)
      )
    ]
  },
  {
    id: "uat-07",
    title: "Traveller correction",
    coverage: ["traveller-correction"],
    mode: "LLM",
    turns: [
      turn(
        "uat-07-1",
        "Delhi to Dubai, 12 Jan 2027, 4 days",
        {
          origin: value("Delhi"),
          destination: value("Dubai"),
          departureDate: date(2027),
          duration: duration(4, "DAYS")
        },
        expected("TRAVELLERS", NONE, 1)
      ),
      turn("uat-07-2", "2 adults", { travellers: composition(2, 0, 0) }, expected(null, ALL, 2)),
      turn(
        "uat-07-3",
        "make that 3 adults and 1 child",
        { travellers: composition(3, 1, 0) },
        expected(null, ALL, 3)
      )
    ]
  },
  {
    id: "uat-08",
    title: "Destination correction preserves other fields",
    coverage: ["destination-correction", "unexpected-field-overwrite"],
    mode: "DETERMINISTIC",
    turns: [
      turn(
        "uat-08-1",
        "Delhi to Dubai",
        { origin: value("Delhi"), destination: value("Dubai") },
        expected("DEPARTURE_DATE", NONE, 1)
      ),
      turn(
        "uat-08-2",
        "12 Jan 2027, 4 nights, 2 adults",
        { departureDate: date(2027), duration: duration(4, "NIGHTS"), travellers: composition() },
        expected(null, ALL, 2)
      ),
      turn(
        "uat-08-3",
        "change destination to London",
        { destination: value("London") },
        expected(null, ALL, 3)
      )
    ]
  },
  {
    id: "uat-09",
    title: "Duration correction preserves unit",
    coverage: ["duration-correction", "days-versus-nights"],
    mode: "LLM",
    turns: [
      turn(
        "uat-09-1",
        "Delhi to Dubai, 12 Jan 2027",
        { origin: value("Delhi"), destination: value("Dubai"), departureDate: date(2027) },
        expected("TRAVELLERS", NONE, 1)
      ),
      turn(
        "uat-09-2",
        "2 adults for 4 nights",
        { travellers: composition(), duration: duration(4, "NIGHTS") },
        expected(null, ALL, 2)
      ),
      turn(
        "uat-09-3",
        "change duration to 6 days",
        { duration: duration(6, "DAYS") },
        expected(null, ALL, 3)
      )
    ]
  },
  {
    id: "uat-10",
    title: "Return date satisfies duration policy",
    coverage: ["return-date-without-duration"],
    mode: "DETERMINISTIC",
    turns: [
      turn(
        "uat-10-1",
        "Delhi to Dubai",
        { origin: value("Delhi"), destination: value("Dubai") },
        expected("DEPARTURE_DATE", NONE, 1)
      ),
      turn(
        "uat-10-2",
        "depart 12 Jan 2027 return 16 Jan 2027",
        {
          departureDate: date(2027),
          returnDate: value({ value: "2027-01-16", day: 16, month: 1, year: 2027 })
        },
        expected("TRAVELLERS", NONE, 2)
      ),
      turn("uat-10-3", "2 adults", { travellers: composition() }, expected(null, ALL, 3))
    ]
  },
  {
    id: "uat-11",
    title: "Duplicate turn identifier is idempotent",
    coverage: ["duplicate-turn-identifier"],
    mode: "LLM",
    turns: [
      turn(
        "uat-11-1",
        "Delhi to Dubai",
        { origin: value("Delhi"), destination: value("Dubai") },
        expected("DEPARTURE_DATE", NONE, 1)
      ),
      turn(
        "uat-11-2",
        "12 Jan 2027 for 4 days",
        { departureDate: date(2027), duration: duration(4, "DAYS") },
        expected("TRAVELLERS", NONE, 2)
      ),
      turn(
        "uat-11-2",
        "12 Jan 2027 for 4 days",
        { departureDate: date(2027), duration: duration(4, "DAYS") },
        expected("TRAVELLERS", NONE, 2),
        "DUPLICATE_TURN"
      )
    ]
  },
  {
    id: "uat-12",
    title: "Same text on different turns remains processable",
    coverage: ["same-text-different-turns"],
    mode: "DETERMINISTIC",
    turns: [
      turn(
        "uat-12-1",
        "Delhi to Dubai",
        { origin: value("Delhi"), destination: value("Dubai") },
        expected("DEPARTURE_DATE", NONE, 1)
      ),
      turn(
        "uat-12-2",
        "2 adults",
        { travellers: composition() },
        expected("DEPARTURE_DATE", NONE, 2)
      ),
      turn(
        "uat-12-3",
        "2 adults",
        { travellers: composition(2, 0, 0) },
        expected("DEPARTURE_DATE", NONE, 2)
      )
    ]
  },
  {
    id: "uat-13",
    title: "Application restart resumes canonical state",
    coverage: ["application-restart", "resume", "cross-turn-state-loss"],
    mode: "LLM",
    turns: [
      turn(
        "uat-13-1",
        "Delhi to Dubai",
        { origin: value("Delhi"), destination: value("Dubai") },
        expected("DEPARTURE_DATE", NONE, 1)
      ),
      turn(
        "uat-13-2",
        "restart service",
        undefined,
        expected("DEPARTURE_DATE", NONE, 1),
        "RESTART"
      ),
      turn(
        "uat-13-3",
        "12 Jan 2027, 4 days, 2 adults",
        { departureDate: date(2027), duration: duration(4, "DAYS"), travellers: composition() },
        expected(null, ALL, 2)
      )
    ]
  },
  {
    id: "uat-14",
    title: "Policy query does not mutate plan state",
    coverage: ["policy-query-active-trip"],
    mode: "DETERMINISTIC",
    turns: [
      turn(
        "uat-14-1",
        "Delhi to Dubai",
        { origin: value("Delhi"), destination: value("Dubai") },
        expected("DEPARTURE_DATE", NONE, 1)
      ),
      turn(
        "uat-14-2",
        "what documents are required",
        undefined,
        expected("DEPARTURE_DATE", NONE, 1, {
          legacyDecision: "NOT_APPLICABLE",
          shadowDecision: "NOT_APPLICABLE",
          reasonCode: "NON_PLANNING_NOT_APPLICABLE",
          classification: "EXPECTED_NON_EQUIVALENCE",
          rolloutBlockingOnFailure: false
        }),
        "NO_OP"
      ),
      turn(
        "uat-14-3",
        "12 Jan 2027, 4 days, 2 adults",
        { departureDate: date(2027), duration: duration(4, "DAYS"), travellers: composition() },
        expected(null, ALL, 2)
      )
    ]
  },
  {
    id: "uat-15",
    title: "Knowledge query does not mutate plan state",
    coverage: ["knowledge-query-active-trip"],
    mode: "LLM",
    turns: [
      turn(
        "uat-15-1",
        "Delhi to Dubai",
        { origin: value("Delhi"), destination: value("Dubai") },
        expected("DEPARTURE_DATE", NONE, 1)
      ),
      turn(
        "uat-15-2",
        "what is the company travel policy",
        undefined,
        expected("DEPARTURE_DATE", NONE, 1, {
          legacyDecision: "NOT_APPLICABLE",
          shadowDecision: "NOT_APPLICABLE",
          reasonCode: "NON_PLANNING_NOT_APPLICABLE",
          classification: "EXPECTED_NON_EQUIVALENCE",
          rolloutBlockingOnFailure: false
        }),
        "NO_OP"
      ),
      turn(
        "uat-15-3",
        "12 Jan 2027, 4 days, 2 adults",
        { departureDate: date(2027), duration: duration(4, "DAYS"), travellers: composition() },
        expected(null, ALL, 2)
      )
    ]
  },
  {
    id: "uat-16",
    title: "Lead status does not mutate plan state",
    coverage: ["lead-status-query"],
    mode: "DETERMINISTIC",
    turns: [
      turn(
        "uat-16-1",
        "Delhi to Dubai",
        { origin: value("Delhi"), destination: value("Dubai") },
        expected("DEPARTURE_DATE", NONE, 1)
      ),
      turn(
        "uat-16-2",
        "did you capture my lead",
        undefined,
        expected("DEPARTURE_DATE", NONE, 1, {
          legacyDecision: "NOT_APPLICABLE",
          shadowDecision: "NOT_APPLICABLE",
          reasonCode: "NON_PLANNING_NOT_APPLICABLE",
          classification: "EXPECTED_NON_EQUIVALENCE",
          rolloutBlockingOnFailure: false
        }),
        "NO_OP"
      ),
      turn(
        "uat-16-3",
        "12 Jan 2027, 4 days, 2 adults",
        { departureDate: date(2027), duration: duration(4, "DAYS"), travellers: composition() },
        expected(null, ALL, 2)
      )
    ]
  },
  {
    id: "uat-17",
    title: "Cancellation isolates lifecycle",
    coverage: ["cancellation"],
    mode: "LLM",
    turns: [
      turn(
        "uat-17-1",
        "Delhi to Dubai",
        { origin: value("Delhi"), destination: value("Dubai") },
        expected("DEPARTURE_DATE", NONE, 1)
      ),
      turn(
        "uat-17-2",
        "cancel this trip",
        undefined,
        expected("DEPARTURE_DATE", NONE, 1, {
          legacyDecision: "NOT_APPLICABLE",
          shadowDecision: "NOT_APPLICABLE",
          reasonCode: "NON_PLANNING_NOT_APPLICABLE",
          classification: "EXPECTED_NON_EQUIVALENCE",
          rolloutBlockingOnFailure: false
        }),
        "CANCEL"
      ),
      turn(
        "uat-17-3",
        "thank you",
        undefined,
        expected("DEPARTURE_DATE", NONE, 1, {
          legacyDecision: "NOT_APPLICABLE",
          shadowDecision: "NOT_APPLICABLE",
          reasonCode: "NON_PLANNING_NOT_APPLICABLE",
          classification: "EXPECTED_NON_EQUIVALENCE",
          rolloutBlockingOnFailure: false
        }),
        "NO_OP"
      )
    ]
  },
  {
    id: "uat-18",
    title: "Reset starts isolated canonical state",
    coverage: ["reset", "cross-turn-state-loss"],
    mode: "DETERMINISTIC",
    turns: [
      turn(
        "uat-18-1",
        "Delhi to Dubai",
        { origin: value("Delhi"), destination: value("Dubai") },
        expected("DEPARTURE_DATE", NONE, 1)
      ),
      turn(
        "uat-18-2",
        "start over",
        undefined,
        expected(null, NONE, 0, {
          legacyDecision: "NOT_APPLICABLE",
          shadowDecision: "NOT_APPLICABLE",
          reasonCode: "NON_PLANNING_NOT_APPLICABLE",
          classification: "EXPECTED_NON_EQUIVALENCE",
          rolloutBlockingOnFailure: false
        }),
        "RESET"
      ),
      turn(
        "uat-18-3",
        "Mumbai to Paris",
        { origin: value("Mumbai"), destination: value("Paris") },
        expected("DEPARTURE_DATE", NONE, 1)
      )
    ]
  },
  {
    id: "uat-19",
    title: "Archived execution is isolated",
    coverage: ["archive"],
    mode: "LLM",
    turns: [
      turn(
        "uat-19-1",
        "Delhi to Dubai",
        { origin: value("Delhi"), destination: value("Dubai") },
        expected("DEPARTURE_DATE", NONE, 1)
      ),
      turn(
        "uat-19-2",
        "archive conversation",
        undefined,
        expected("DEPARTURE_DATE", NONE, 1, {
          legacyDecision: "NOT_APPLICABLE",
          shadowDecision: "NOT_APPLICABLE",
          reasonCode: "NON_PLANNING_NOT_APPLICABLE",
          classification: "EXPECTED_NON_EQUIVALENCE",
          rolloutBlockingOnFailure: false
        }),
        "ARCHIVE"
      ),
      turn(
        "uat-19-3",
        "new request",
        undefined,
        expected("DEPARTURE_DATE", NONE, 1, {
          legacyDecision: "NOT_APPLICABLE",
          shadowDecision: "NOT_APPLICABLE",
          reasonCode: "NON_PLANNING_NOT_APPLICABLE",
          classification: "EXPECTED_NON_EQUIVALENCE",
          rolloutBlockingOnFailure: false
        }),
        "NO_OP"
      )
    ]
  },
  {
    id: "uat-20",
    title: "Concurrent revision conflict is blocking",
    coverage: ["concurrent-revision-conflict"],
    mode: "DETERMINISTIC",
    turns: [
      turn(
        "uat-20-1",
        "Delhi to Dubai",
        { origin: value("Delhi"), destination: value("Dubai") },
        expected("DEPARTURE_DATE", NONE, 1)
      ),
      turn(
        "uat-20-2",
        "12 Jan 2027",
        { departureDate: date(2027) },
        expected("DEPARTURE_DATE", NONE, 1, {
          legacyDecision: "UNKNOWN",
          shadowDecision: "NOT_APPLICABLE",
          reasonCode: "SKILL_REVISION_CONFLICT",
          classification: "BLOCKING",
          manualReviewRequired: true
        }),
        "REVISION_CONFLICT"
      ),
      turn(
        "uat-20-3",
        "4 days, 2 adults",
        { duration: duration(4, "DAYS"), travellers: composition() },
        expected("DEPARTURE_DATE", NONE, 2)
      )
    ]
  },
  {
    id: "uat-21",
    title: "Adapter incomplete mandatory fields is blocking",
    coverage: ["adapter-incomplete"],
    mode: "LLM",
    turns: [
      turn(
        "uat-21-1",
        "Plan a trip",
        undefined,
        expected(null, NONE, 0, {
          legacyDecision: "UNKNOWN",
          shadowDecision: "NOT_APPLICABLE",
          reasonCode: "ADAPTER_INCOMPLETE",
          classification: "BLOCKING",
          manualReviewRequired: true
        }),
        "ADAPTER_INCOMPLETE"
      ),
      turn(
        "uat-21-2",
        "Delhi to Dubai",
        { origin: value("Delhi"), destination: value("Dubai") },
        expected("DEPARTURE_DATE", NONE, 1)
      ),
      turn(
        "uat-21-3",
        "12 Jan 2027, 4 days, 2 adults",
        { departureDate: date(2027), duration: duration(4, "DAYS"), travellers: composition() },
        expected(null, ALL, 2)
      )
    ]
  },
  {
    id: "uat-22",
    title: "Multi-city continuation remains a review boundary",
    coverage: ["multi-city-continuation"],
    mode: "DETERMINISTIC",
    turns: [
      turn(
        "uat-22-1",
        "Delhi to Dubai",
        { origin: value("Delhi"), destination: value("Dubai") },
        expected("DEPARTURE_DATE", NONE, 1)
      ),
      turn(
        "uat-22-2",
        "then Dubai to New York",
        { destination: value("New York") },
        expected("DEPARTURE_DATE", NONE, 2, {
          reasonCode: "LEGACY_RESPONSE_STAGE_DIFFERENCE",
          classification: "EXPECTED_NON_EQUIVALENCE",
          manualReviewRequired: true,
          rolloutBlockingOnFailure: false
        })
      ),
      turn(
        "uat-22-3",
        "12 Jan 2027, 8 days, 2 adults",
        { departureDate: date(2027), duration: duration(8, "DAYS"), travellers: composition() },
        expected(null, ALL, 3)
      )
    ]
  },
  {
    id: "uat-23",
    title: "Non-planning conversation",
    coverage: ["non-planning-request"],
    mode: "LLM",
    turns: [
      turn(
        "uat-23-1",
        "hello",
        undefined,
        expected(null, NONE, 0, {
          legacyDecision: "NOT_APPLICABLE",
          shadowDecision: "NOT_APPLICABLE",
          reasonCode: "NON_PLANNING_NOT_APPLICABLE",
          classification: "EXPECTED_NON_EQUIVALENCE",
          rolloutBlockingOnFailure: false
        }),
        "NO_OP"
      ),
      turn(
        "uat-23-2",
        "what can you do",
        undefined,
        expected(null, NONE, 0, {
          legacyDecision: "NOT_APPLICABLE",
          shadowDecision: "NOT_APPLICABLE",
          reasonCode: "NON_PLANNING_NOT_APPLICABLE",
          classification: "EXPECTED_NON_EQUIVALENCE",
          rolloutBlockingOnFailure: false
        }),
        "NO_OP"
      ),
      turn(
        "uat-23-3",
        "thank you",
        undefined,
        expected(null, NONE, 0, {
          legacyDecision: "NOT_APPLICABLE",
          shadowDecision: "NOT_APPLICABLE",
          reasonCode: "NON_PLANNING_NOT_APPLICABLE",
          classification: "EXPECTED_NON_EQUIVALENCE",
          rolloutBlockingOnFailure: false
        }),
        "NO_OP"
      )
    ]
  }
];

const standardScenarios: PlanTripUatConversation[] = [
  standard(
    "uat-01",
    "Complete deterministic request",
    ["complete-request", "deterministic-mode"],
    "DETERMINISTIC"
  ),
  standard("uat-24", "Complete LLM request", ["complete-request", "llm-mode"], "LLM"),
  standard("uat-25", "Four nights survive evaluation", ["days-versus-nights"], "DETERMINISTIC", {
    nights: true
  }),
  standard("uat-26", "Budget explicitly present", ["budget-present"], "LLM", { budget: true }),
  standard("uat-27", "Budget absent is optional", ["budget-absent"], "DETERMINISTIC"),
  standard("uat-28", "Purpose explicitly present", ["purpose-present"], "LLM", { purpose: true }),
  standard("uat-29", "Purpose absent is optional", ["purpose-absent"], "DETERMINISTIC"),
  standard("uat-30", "Persistence resume baseline", ["application-restart", "resume"], "LLM"),
  standard(
    "uat-31",
    "Accurate passenger composition",
    ["adult-child-composition"],
    "DETERMINISTIC"
  ),
  standard("uat-32", "Canonical days remain days", ["days-versus-nights"], "LLM"),
  standard("uat-33", "Deterministic adapter baseline", ["deterministic-mode"], "DETERMINISTIC"),
  standard("uat-34", "LLM adapter baseline", ["llm-mode"], "LLM"),
  standard(
    "uat-35",
    "No provider or tool side effects",
    ["no-provider-call", "no-tool-call"],
    "DETERMINISTIC"
  )
];

export const PLAN_TRIP_UAT_FIXTURE: PlanTripUatFixture = {
  fixtureVersion: "1.0.0",
  skillId: "travel.plan-trip",
  skillVersion: "1.0.0",
  syntheticOnly: true,
  conversations: [...special, ...standardScenarios].sort((left, right) =>
    left.id.localeCompare(right.id)
  )
};
