# Travel plan-trip real shadow review

Stage 7 adds a read-only, tenant-scoped review workflow for real `travel.plan-trip@1.0.0` shadow
metadata. It does not change Travel routing, responses, providers, tools, RAG, confirmation, workflow,
`travel.trip_state`, or authority.

## Review sessions

A session is stored as an existing plugin-scoped `AgentMemory` record. No Prisma model or migration is
added. Its lifecycle is `CREATED → RUNNING → COMPLETED → ARCHIVED`. It stores only reviewer identity,
bounded filters, timestamps, operational notes, and frozen conversation/AgentExecution identifiers.
Notes are never returned verbatim.

Protected endpoints use the existing `agents.executions.read` permission:

```text
POST /api/v1/skills/diagnostics/travel-plan-trip/review-sessions
GET  /api/v1/skills/diagnostics/travel-plan-trip/review-sessions/:id
POST /api/v1/skills/diagnostics/travel-plan-trip/review-sessions/:id/start
POST /api/v1/skills/diagnostics/travel-plan-trip/review-sessions/:id/complete
POST /api/v1/skills/diagnostics/travel-plan-trip/review-sessions/:id/archive
GET  /api/v1/skills/diagnostics/travel-plan-trip/review-sessions/:id/report
```

Create body:

```json
{
  "from": "2026-07-01T00:00:00.000Z",
  "to": "2026-07-31T23:59:59.999Z",
  "pluginInstallationId": "<uuid>",
  "runtimeMode": "ALL",
  "conversationCount": 100,
  "turnCount": 1000,
  "notes": "Operational notes only; never include customer or trip data."
}
```

Starting a session deterministically sorts eligible AgentExecutions by creation time and ID, filters
to applicable shadow comparisons, applies tenant/plugin/date/runtime bounds, then freezes exact
conversation and turn IDs. Re-reading a running/completed session cannot silently add later traffic.

## Redaction and report content

Reports expose diagnostic identifiers, categories, reason codes, lifecycle statuses, revisions,
pending-input names, completeness booleans, capability booleans, and aggregates only. They never query
conversation messages and never return prompts, names, destinations, dates, traveller counts, budgets,
contacts, raw canonical state, provider output, itineraries, or tool payloads. Cross-tenant session
lookups return 404.

The report includes `RolloutSummary`, `ConversationSummary`, `ExecutionSummary`,
`CapabilityAgreement`, `BlockingIssue`, `PolicyIssue`, and `TrendSummary`. Trend rates use sampled
applicable turns except state-loss/overwrite rates, which use sampled conversations. A completeness
flag changing from true to false within the same SkillExecution is treated as state loss. Typed
redacted overwrite signals are used when present; messages are never inspected to infer overwrites.

Example:

```json
{
  "conversationCount": 120,
  "turnCount": 382,
  "agreementCount": 374,
  "blockingCount": 0,
  "policyCount": 5,
  "adapterWarningCount": 2,
  "revisionConflictCount": 0,
  "stateLossCount": 0,
  "unexpectedOverwriteCount": 0,
  "capabilityAgreement": {
    "evaluated": 310,
    "agreements": 304,
    "mismatches": 6,
    "agreementPercentage": 98.06
  },
  "recommendation": "READY_FOR_LIMITED_ROLLOUT"
}
```

This example is illustrative, not a production result.

## Recommendation rules

- Any blocking issue, state loss, or unexpected overwrite: `NOT_READY`.
- Fewer than 100 reviewed conversations: `READY_FOR_MORE_UAT`.
- At least 100 conversations, zero blocking/state-loss/overwrite issues, and at least 95% agreement:
  `READY_FOR_LIMITED_ROLLOUT`.
- Below the agreement threshold without a blocker: `READY_FOR_MORE_UAT`.
- `READY_FOR_AUTHORITATIVE_COLLECTION` is never generated automatically.

Human approval remains mandatory. Even `READY_FOR_LIMITED_ROLLOUT` does not make the Skill Runtime
authoritative and does not authorize Stage 8.
