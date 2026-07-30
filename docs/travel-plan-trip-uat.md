# Travel plan-trip shadow UAT v1.0.0

This pack validates `travel.plan-trip@1.0.0` in shadow mirror mode. It does not make the skill
authoritative, call a provider or tool, alter `travel.trip_state`, or query production data.

## Approved policy

- A month-only or day/month departure is retained, but `TRAVEL_YEAR` blocks live search and booking.
  A year-only reply completes the partial date without replacing stronger explicit fields.
- Total-only travellers permit itinerary planning and broad estimates. Composition remains unknown;
  passenger-sensitive live search and booking require explicit adults, children, and infants.
- Purpose and budget are optional. Their absence is a warning, never a planning/search blocker, and
  the skill does not invent either value.
- Duration or return date is required. Canonical `DAYS` and `NIGHTS` are preserved exactly.
- Readiness and confirmation are separate. Shadow evaluation never requests confirmation or performs
  an irreversible/user-authorised action.
- Mandatory-field adapter gaps, unexplained revision conflicts, cross-turn state loss, and unrelated
  field overwrites are rollout-blocking.

The typed policy is `PLAN_TRIP_POLICY_VERSION = 1.0.0`. Its capabilities are `itinerary`, `estimate`,
`liveSearch`, and `booking`. The existing `READY` decision means live-search readiness; earlier
capabilities can be true while the decision remains `ASK_FOR_INPUT`.

## Synthetic pack

The machine-readable fixture is
`apps/api/src/skills/travel/plan-trip-uat.fixture.ts`. It contains 35 conversations and 105 ordered
turns with expected legacy category, shadow decision, pending input, capabilities, revision,
classification, manual-review flag, and rollout-blocking flag for every turn. It covers complete and
missing inputs, partial dates/year completion, days/nights, traveller totals/composition/corrections,
destination and duration corrections, multi-city continuation, budget/purpose, idempotency,
restart/resume, deterministic and LLM modes, policy/knowledge/lead-status turns, cancellation, reset,
archive, revision conflict, adapter failure, and non-planning turns. All identities and trip examples
are synthetic.

Run:

```bash
pnpm --filter @ai-workforce-os/api uat:travel-plan-trip
```

The command emits one `TRAVEL_PLAN_TRIP_UAT_JSON` line plus a human-readable summary and exits non-zero
when an expected rollout-blocking assertion fails. It uses pure skill logic and persistence
round-tripping only; it must never be described as a production agreement report.

## Review at least 100 real shadow turns

1. Choose a bounded recent window that includes normal weekday/weekend traffic. Query no more than
   1,000 rows at a time and scope to the target plugin installation:

   ```text
   GET /api/v1/skills/diagnostics/travel-plan-trip/summary?from=<ISO>&to=<ISO>&limit=250&pluginInstallationId=<uuid>
   ```

2. Continue with non-overlapping windows until at least 100 applicable real turns have been reviewed.
   Record tenant, window, plugin installation, reviewer, reviewed count, and diagnostic aggregate—no
   raw messages or canonical field values.
3. Prioritise repeated disagreements, capability disagreements, long-waiting executions, adapter
   warnings, persistence failures, and revision conflicts. Use the redacted detail endpoint:

   ```text
   GET /api/v1/skills/diagnostics/travel-plan-trip/executions/<skillExecutionId>
   ```

4. Inspect only decision categories, completeness booleans, pending input, capabilities, warnings,
   reason codes, revisions, and timestamps. Cross-turn state loss is indicated when a previously true
   completeness flag becomes false without reset/cancel/archive. An unrelated overwrite is indicated
   when a correction changes another field's completeness or pending sequence without policy cause.
5. Classify every disagreement using the typed rollout mapping. `BLOCKING` needs technical resolution
   or a documented, reviewed explanation. Approved capability differences can be
   `EXPECTED_NON_EQUIVALENCE`; any genuinely unresolved product choice is `PRODUCT_POLICY_REVIEW`.
6. Record an approved exception with reason code, capability affected, bounded scope, product owner,
   approval date, evidence window, and expiry/review date. Never record city/date/budget/traveller or
   contact values in the exception log.

Privacy rules: do not export raw messages, prompts, state JSON, contacts, credentials, provider output,
itineraries, or tool payloads. Do not compare or aggregate across tenants. A cross-tenant lookup must
return 404 and is itself rollout-blocking if it exposes data.

## Authoritative-input rollout gate

All conditions are mandatory:

- at least 100 representative real applicable shadow turns reviewed;
- zero unexplained `BLOCKING` disagreements;
- zero cross-turn state-loss incidents;
- zero unrelated-field overwrite incidents;
- zero unhandled state-validation failures;
- zero additional Skill Runtime provider or tool calls;
- zero cross-tenant diagnostic exposure;
- approved partial-date/year policy implemented;
- approved traveller total/composition policy implemented;
- deterministic and LLM adapters both reviewed;
- revision-conflict behaviour accepted; and
- all focused Skill Runtime and Travel tests green.

Passing the synthetic pack means the code is ready to begin this review. It does not satisfy the real
sample gate and must not be used to claim authoritative readiness.
