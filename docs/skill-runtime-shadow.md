# Skill Runtime shadow comparison

`travel.plan-trip@1.0.0` currently runs in shadow mode after the authoritative Travel runtime has
finished a turn. It consumes the structured Travel state already produced by that runtime. It does
not select responses, call providers or tools, or write `travel.trip_state`.

## Agreement and disagreement

Agreement means the existing runtime and the shadow skill agree on whether the plan is ready to
proceed. When both are collecting input, agreement also requires that their detectable next missing
canonical field is the same. Readiness-compatible existing categories such as `EXECUTING_TOOL` and
`REQUEST_CONFIRMATION` may therefore agree with a shadow `READY_FOR_PLAN` decision.

Disagreement means that readiness differs, the next detectable missing field differs, the existing
decision cannot be mapped, or the adapter/evaluation was incomplete. A disagreement is diagnostic;
it is not automatically a legacy-runtime bug. The two policies can intentionally differ—for example,
the existing runtime currently accepts a travel month while the canonical skill separately records
that the year is unresolved.

## Inspecting metadata

The comparison is stored on the existing `AgentExecution.metadata.skillShadow` object. It contains
only categories, reason codes, booleans, schema identity, and adapter warnings. It does not contain
messages, contacts, prompts, provider output, credentials, itineraries, or the full skill state.

The corresponding `SKILL_SHADOW_COMPARISON` structured log contains only the organization ID,
execution ID, skill identity, agreement, decision categories, and reason codes.

## Rollout gates

The following reasons should block authoritative rollout until eliminated or explicitly accepted:

- `SHADOW_EVALUATION_FAILED`
- `ADAPTER_INCOMPLETE`
- `DECISION_UNMAPPABLE`
- Any `EXISTING_READY_SHADOW_MISSING_*` reason without an approved policy decision
- `EXISTING_ASKING_SHADOW_READY` where the existing question enforces a required business rule
- `DIFFERENT_MISSING_FIELD` when it can reorder or skip required user input

Before making the skill authoritative, review at least 100 representative applicable real planning
turns across deterministic and configured-LLM runtimes. Include partial dates, total-only traveller
counts, corrections, multi-turn collection, and tool-authorized turns. Low-volume decision pairs
should be supplemented with targeted production-path fixtures rather than treated as proven by the
aggregate percentage alone.

The in-code aggregation helper can summarize exported comparison objects by agreement, reason code,
and decision pair. It is intentionally not a metrics service and stores nothing.

## Durable mirror lifecycle

Phase 4 adds one durable `SkillExecution` for the active `travel.plan-trip` lifecycle scoped by
organization, plugin installation, conversation, and skill ID. It is a shadow mirror only:

- `travel.trip_state` remains the sole source of production truth.
- The legacy Travel runtime still owns responses, routing, RAG, tools, confirmations, lead capture,
  and workflow progression.
- `SkillExecution.state` is loaded only by the shadow skill and cannot affect the legacy runtime.
- No old conversation is backfilled and no existing travel memory is migrated.

The lifecycle statuses are:

- `ACTIVE`: reserved for an active lifecycle before a more specific readiness state is known.
- `WAITING_FOR_INPUT`: canonical validation found a required missing field.
- `READY`: the canonical shadow plan has all currently required fields.
- `COMPLETED`: the shadow lifecycle ended normally; its active key is released.
- `CANCELLED`: the lifecycle was cancelled; it is not returned by active lookup.
- `FAILED`: the durable shadow lifecycle ended because it could not safely continue.

Each update uses the stored revision in its update predicate and increments the revision atomically.
A stale revision is reported as `SKILL_REVISION_CONFLICT`; it is never overwritten and the
authoritative response proceeds unchanged. Other storage failures are reported as
`SKILL_PERSISTENCE_FAILED`, with database details omitted.

Turn idempotency uses the existing Agent request ID, stored in a bounded list on the execution. A
replayed turn is not merged or revision-incremented again. Identical text on a different legitimate
turn has a different request ID and is processed normally. The active-key uniqueness constraint
prevents concurrent creation of two live executions in the same scope; the loser reloads the winner
and applies its distinct turn with optimistic locking.

## Safe inspection and rollback

Inspect `AgentExecution.metadata.skillShadow.persistence` for the execution ID, status, revision,
whether the turn was applied, idempotent replay status, and a redacted warning code. Query the
corresponding `skill_executions` row with an organization filter. The JSON state is canonical trip
fields only; do not copy it into logs or support tickets. Raw messages, contact details, prompts,
credentials, provider output, itineraries, and tool payloads are not stored there.

To roll back Phase 4 application behavior, remove `SkillExecutionService` from `AgentModule` and the
mirror load/update block while retaining Phase 3 comparison. Existing rows can remain inert; do not
delete them during an incident. A later forward migration may remove the table only after retention
and audit requirements are reviewed. The migration itself is forward-only and must not be rolled
back with a database reset.

`SkillExecution` is explicitly **not authoritative** in this phase. Promotion requires a separate
review and implementation phase.

## Stage 5 diagnostic reporting

Stage 5 reads the durable mirror and existing `AgentExecution.metadata.skillShadow` records without
changing either source. Administrators with the existing `agents.executions.read` permission can use:

```text
GET /api/v1/skills/diagnostics/travel-plan-trip/summary
GET /api/v1/skills/diagnostics/travel-plan-trip/executions/:id
```

The summary accepts optional ISO `from` and `to` timestamps, a `pluginInstallationId`, and a bounded
`limit` from 1 to 1,000 (default 250). Every query is organization-scoped. The detail endpoint returns
404 for a different tenant rather than revealing whether an identifier exists.

Summary output includes evaluation/execution counts, agreement rate, disagreement reasons, decision
pairs, lifecycle and pending-input distributions, adapter warnings, persistence failures, revision
conflicts, runtime-mode counts, repeated disagreements, long-waiting executions, and terminal/ready
counts. A separate typed diagnostic-signal distribution records policy observations that are not
disagreements, including total-only travellers, optional purpose/budget, confirmation timing,
tool-ready compatibility, non-planning turns, and invalid stored state. Detail output contains only
execution identity/version/status/timestamps/revision, processed
turn count, pending-input name, and a redacted comparison timeline.

Neither endpoint reads messages or returns canonical values. City names, dates, budgets, traveller
counts, contact information, prompts, credentials, provider output, itineraries, tool payloads, and
the JSON skill state are excluded. Timeline field data is reduced to completeness booleans.

### Rollout classifications

The exhaustive typed mapping is defined in `plan-trip-rollout-policy.ts`:

- `BLOCKING`: missing core route/date/traveller/duration fields when legacy is ready, live search with
  unresolved year or traveller composition, incomplete or unmappable adaptation, shadow
  evaluation/persistence failures, revision conflicts, cross-turn state loss, or corrections
  overwriting unrelated fields.
- `PRODUCT_POLICY_REVIEW`: genuinely unresolved missing-field order or confirmation-timing differences.
- `EXPECTED_NON_EQUIVALENCE`: compatible legacy tool execution after canonical readiness, response-stage
  wording differences, non-planning `NOT_APPLICABLE` turns, early itinerary readiness with unresolved
  year/composition, and absent optional purpose/budget.

A disagreement is not automatically a legacy defect. Blocking classifications require technical
resolution or a documented explanation. Product-review classifications require an explicit product
decision before authority. Expected non-equivalence is retained for traceability but does not block by
itself.

### Manual review and rollout gate

Review a tenant- and employee-scoped summary, select repeated disagreements and long-waiting
executions, inspect their redacted timelines, and correlate any necessary customer-facing evidence
through the separately permissioned execution/conversation interfaces. Never copy raw SkillExecution
state into diagnostic reports.

Before authoritative input collection, review at least 100 representative applicable Travel turns and
require:

- zero unexplained `BLOCKING` disagreements;
- zero cross-tenant diagnostic exposure;
- zero unhandled state-validation failures;
- zero duplicate provider or tool calls from Skill Runtime;
- revision conflicts understood and below an approved threshold;
- explicit approval of partial-date/year policy;
- explicit approval of total-only versus composed traveller policy; and
- validation of both deterministic and LLM adapters.

The deterministic fixture report at
`docs/fixtures/travel-plan-trip-synthetic-validation.json` exercises reporting math only. Its metrics
are synthetic test results, **not production agreement rates**, and cannot satisfy the rollout sample
gate.

## Stage 6 policy capabilities and UAT

`travel.plan-trip` policy `1.0.0` publishes four booleans in shadow comparison metadata:
`itinerary`, `estimate`, `liveSearch`, and `booking`. A partial year or total-only traveller count can
therefore agree with early-planning capability while still blocking live search. Purpose and budget
are optional warnings. Duration or return date remains mandatory, and `DAYS`/`NIGHTS` are canonical.
Confirmation stays outside the shadow skill.

The 35-conversation, 105-turn synthetic pack and the production review procedure are documented in
`docs/travel-plan-trip-uat.md`. Passing that pack only establishes readiness to begin the required
100-turn real shadow review; it does not make the skill authoritative.

## Stage 7 real shadow review

Stage 7 adds metadata-backed review sessions and deterministic sampling over real redacted shadow
comparisons. Sessions use existing plugin-scoped AgentMemory, freeze exact sampled turn IDs, remain
strictly tenant scoped, and add no persistence model. The protected API, trend definitions, redaction
rules, and non-authoritative recommendation engine are documented in
`docs/travel-plan-trip-shadow-review.md`.

The engine can recommend `NOT_READY`, `READY_FOR_MORE_UAT`, or `READY_FOR_LIMITED_ROLLOUT`.
`READY_FOR_AUTHORITATIVE_COLLECTION` is deliberately manual-only and is never emitted by code.
