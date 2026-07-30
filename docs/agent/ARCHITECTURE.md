# Architecture Reference — AI Workforce OS

Extracted from the actual repository (`apps/api/src`, `database/prisma/schema.prisma`, `docs/*.md`)
as of 2026-07-27 (updated through Stage 9F). This is a reference, not an aspiration — where current code falls short of the
platform principles in `SYSTEM_INSTRUCTIONS.md`, that is called out explicitly under "Known
architectural gaps" rather than smoothed over.

## 1. High-level platform architecture

pnpm workspace, Turborepo-driven. NestJS API (`apps/api`), Next.js dashboard (`apps/dashboard`),
shared packages (`packages/kernel`, `domain`, `plugin-sdk`, `shared`), a plugin workspace
(`plugins/`, currently `travel-employee`), Prisma schema at the repo root
(`database/prisma/schema.prisma`), Docker Compose Postgres (`pgvector/pgvector:pg16`, required for
the Knowledge module's embeddings).

Intended request pipeline (from the platform charter, partially realized today — see §11):

```
Skill Runtime → Capability Decision → Workflow Runtime → Capability Execution → Tools/Connectors
```

## 2. Modules (`apps/api/src/`)

| Module | Role |
|---|---|
| `identity` | Auth, RBAC, organizations, users, sessions. Foundational; oldest module. |
| `teams`, `service-accounts` | Team membership, API keys, service accounts. |
| `plugins` | Plugin installation lifecycle, AI provider configuration per installation. |
| `agents` | The agent execution loop: `AgentService`/`AgentController`, `MemoryService`, `agent.runtime.ts`, `request-classifier.ts`. The central orchestrator that wires Skills, Workflows, Capability Execution, and the legacy Travel Runtime together for one HTTP turn. |
| `skills` | Skill Runtime: `SkillRegistry`, `SkillRuntimeService`, `SkillExecutionService`, typed `InputDecision`/capability-execution contracts, and the one registered skill, `travel.plan-trip` (`skills/travel/`). |
| `workflows` | Workflow Runtime: `WorkflowExecutionService` (generic persistence), `WorkflowCoordinator` (sole routing authority), and three workflow types: `contact-capture`, `booking-handoff`, `trip-submission`. |
| `travel` | The Travel AI Employee's execution-provider code: `travel.runtime.ts` (legacy orchestrator + provider), `travel-lead.service.ts`, `currency.service.ts`. See §11 for its still-incomplete separation from business-state ownership. |
| `connectors` | Tenant-scoped external-system integration framework: `connector.runtime.ts`, `connector.service.ts`, reference connectors (`dummy-crm`, `generic-http`, `hubspot`). |
| `knowledge` | Employee-scoped RAG: collections → documents → chunks → pgvector embeddings, grounded retrieval (`knowledge.search.ts`). |
| `channels` | Inbound/outbound channel connections (e.g. WhatsApp via Twilio) and message processing, separate from the HTTP agent-run API. |
| `conversation` | Employee-agnostic, DI-free conversation primitives: affirmative/negative detection, phone normalization/extraction, lead-reference generation (`conversation-completion.ts`). Deliberately the one module built platform-first for reuse beyond Travel. |
| `customer-identity` | Customer/end-user identity linked to conversations, independent of the organization's own `identity` module. |
| `infrastructure` | Prisma module/service, cross-cutting infra. |
| `production` | Production config validation. |

## 3. Persistence (Prisma models — `database/prisma/schema.prisma`, ~1350 lines)

Key model families:

- **Identity/tenancy**: `Organization`, `OrganizationSetting`, `User`, `Team`, `TeamMember`, `Role`,
  `Permission`, `RolePermission`, `UserRole`, `ServiceAccount`, `ApiKey`, `ServiceAccountRole`,
  `Invitation`, `AuthenticationSession`.
- **Plugins**: `Plugin`, `PluginConfiguration`, `PluginAiConfiguration`.
- **Agent runtime**: `Conversation`, `ConversationMessage`, `CustomerProfile`, `AgentExecution`,
  `AgentToolExecution`, `AgentMemory`.
- **Skill Runtime**: `SkillExecution` (durable mirror lifecycle — see §6).
- **Workflow Runtime**: `WorkflowExecution` (`WorkflowType`, `WorkflowStatus` enums — see §7).
- **Connectors**: `ConnectorDefinition`, `ConnectorTool`, `ConnectorInstallation`,
  `ConnectorExecution`, `ConnectorEvent`, `ConnectorAuditEvent`, `DummyCrmLead`.
- **Knowledge**: `KnowledgeCollection`, `KnowledgeDocument`, `KnowledgeChunk` (pgvector
  `embedding vector(1536)`, HNSW index).
- **Channels**: `ChannelConnection`, `ChannelMessage`.
- **Travel domain**: `TravelEmployeeConfiguration`, `TravelLead` (+ `TravelLeadStatus`,
  `TravelLeadCrmSyncStatus`).

Enterprise-wide persistence conventions used throughout: optimistic locking via a `revision`
column, idempotent turn processing via a bounded `processedTurnIds`-style list, "one active row per
scope" via a nullable-but-unique `activeKey`, and organization-scoped queries everywhere.

## 4. Agent runtime (`agents/agent.service.ts`, `AgentService.execute`)

The single entry point for a conversational turn (`POST /api/v1/agents/run`). Within one call, in
priority order:

1. **Pending workflow dispatch** (`dispatchPendingWorkflowTurn` → `WorkflowCoordinator.dispatchTurn`)
   — if a workflow is active/waiting for this conversation, or this turn starts one, it owns the
   turn and the rest of the pipeline is skipped for that turn.
2. **Authoritative Skill Runtime decision** (`InputDecisionService` → `TravelDecisionAdapter.route`)
   when the authoritative-config rollout allows it for this installation.
3. **Capability Execution** (`CapabilityExecutionAdapter`) when the route requires it — deterministic
   calculation, LLM-orchestrated delegation, tool delegation, or workflow-pending, never
   reimplementing the underlying business logic.
4. **Legacy Travel Runtime fallback** (`travel.runtime.ts`) when the route is `LEGACY_FALLBACK` /
   `SKILL_ERROR`, or when the authoritative Skill Runtime path isn't enabled for this installation.

`MemoryService` (same file) owns `AgentMemory` CRUD/search, scoped by
`AgentMemoryScope` (`USER`/`CONVERSATION`/`PLUGIN`/`ORGANIZATION`) — explicitly not authoritative
business state (see §11).

## 5. Skill Runtime (`skills/`)

Contracts (`skill-runtime.contracts.ts`): `SkillHandler.evaluate(context, input)` returns a
`SkillEvaluation` (`decision` + `transition` + `validation`). A `SkillTurnDecision.action` is
`"ASK_FOR_INPUT" | "READY"` — never a free-form string. `InputDecision` (re-exported from
`travel/input-decision.dto.ts`) is the typed representation of "what input is still missing."

Only one skill is registered: `travel.plan-trip` (`PlanTripSkillHandler`, `skills/travel/`). It was
brought up in phases (see `docs/skill-runtime-shadow.md`):

- Phase/Stage 1–3: shadow comparison only — runs after the legacy runtime, never affects the
  response (`AgentExecution.metadata.skillShadow`).
- Stage 4: durable mirror (`SkillExecution` persisted, `ACTIVE`/`WAITING_FOR_INPUT`/`READY`/
  `COMPLETED`/`CANCELLED`/`FAILED`), still shadow-only — `travel.trip_state` (legacy `AgentMemory`)
  remains sole production truth.
- Stage 5: diagnostic reporting endpoints (`/api/v1/skills/diagnostics/travel-plan-trip/...`).
- Stage 6: rollout policy capabilities (`itinerary`/`estimate`/`liveSearch`/`booking` booleans),
  UAT fixture pack.
- Stage 7: real shadow review sessions/sampling/recommendation engine
  (`docs/travel-plan-trip-shadow-review.md`).
- Stage 8/8B: `InputDecisionService`/`InputCollectionService` become **authoritative** for input
  collection for rolled-in installations (`skill-runtime-authoritative-config.ts` gates this),
  feeding `TravelDecisionAdapter` → `CapabilityExecutionAdapter`.
- Stage 9A: `CapabilityExecutionAdapter` formalized — typed `ExecutionDecision`
  (`capability`/`executionStatus`/`executionType`/`executionTarget`/`requiresWorkflow`/
  `requiresHumanApproval`/`metadata`), never free-form.

`TravelDecisionRoute.action` is one of `ASK_QUESTION | GENERATE_ITINERARY | ESTIMATE_BUDGET |
SEARCH_LIVE | BOOKING_WORKFLOW_PENDING | SKILL_ERROR | LEGACY_FALLBACK`.

## 6. Workflow Runtime (`workflows/`)

**`WorkflowExecutionService`** (`workflow-execution.service.ts`) — generic, workflow-type-agnostic
persistence over the `WorkflowExecution` model:

- `findActiveWorkflow` / `findActiveWorkflowsForConversation` (cross-type, ordered by
  `updatedAt desc`).
- `createWorkflow` — idempotent via a unique `activeKey` conflict → loser looks up and returns the
  winner.
- `updateWorkflowState` — turnId-guarded two-phase idempotency plus `revision` optimistic lock
  (`WorkflowExecutionRevisionConflictError` on stale revision).
- `markCompleted` / `markFailed` / `markCancelled` — accept an optional `currentStep` override.

**`WorkflowCoordinator`** (`workflow-coordinator.ts`) — the sole routing authority (see
`SYSTEM_INSTRUCTIONS.md` §6 for the priority order it enforces). Contains no business logic itself;
`dispatchTurn` / `dispatchSignal` / `startBookingHandoff` / private `resume` / `dispatchResumeResult`
/ `cancel` / `migrateHistoricalContactState` / `detectWorkflowCancellationPhrase` /
`cancellationConfirmation`. Constructor takes all three workflow services plus
`WorkflowExecutionService` (unchanged since Stage 9C/9D), plus a Stage 9E.1-added 5th **optional**
parameter (`@Optional() @Inject(WORKFLOW_SIGNAL_PROVIDERS) signalProviders?`) — every existing test
that constructs it with exactly 4 args is unaffected.

Typed contracts (`workflow-runtime.contracts.ts`): `WorkflowType = "CONTACT_CAPTURE" |
"BOOKING_HANDOFF" | "TRIP_SUBMISSION"`; `WorkflowStatus = "ACTIVE" | "WAITING_FOR_INPUT" |
"COMPLETED" | "FAILED" | "CANCELLED"`; `WorkflowResumeDecision = "ASK_FOR_INPUT" | "CONTINUE" |
"COMPLETE" | "FAIL" | "CANCELLED" | "DEFER" | "NOT_APPLICABLE"` (`DEFER` added Stage 9E.1 — see
"Semantic-detour deferral" below); `WorkflowStartSource` (typed trigger origin — never inferred from
generated response text): `CALLBACK_MENU_SELECTION | CALLBACK_INTENT_PHRASE |
PROVIDER_FAILURE_RECOVERY | BOOKING_READY_CAPABILITY | TRIP_SUBMISSION_CONFIRMATION |
STANDALONE_CONTACT_VOLUNTEERED | BELOW_MINIMUM_BUDGET_FEASIBILITY | HISTORICAL_STATE_MIGRATION`
(the last two added Stage 9E); `WorkflowStartRequest` (typed start payload). `WorkflowDispatchOutcome`
and `WorkflowDispatchSignals` (the per-turn Travel-context bundle) now live here too (moved from
`workflow-coordinator.ts` in Stage 9E so the signal registry/engine could share them without either
file importing the other).

### Workflow Signal Engine (Stage 9E)

Before Stage 9E, `WorkflowCoordinator.dispatchTurn` directly called
`contactCapture.shouldStart(...)`/`tripSubmission.shouldStart(...)` inline to decide whether a new
workflow should start — meaning the coordinator itself contained per-workflow-type branching. Stage
9E extracts that evaluation into two new, smaller pieces so `workflow-coordinator.ts` never needs to
change again to add a workflow type's start trigger:

- **`WorkflowSignal`** (`workflow-signal.contracts.ts`) — the typed contract a signal source emits:
  `signalType` (`NONE | START_CONTACT_CAPTURE | START_TRIP_SUBMISSION | START_BOOKING_HANDOFF`),
  `workflowType`, `source` (a `WorkflowStartSource`), `sourceTurnId`, `sourceSkillExecutionId`,
  `payload`, `confidence`. `noWorkflowSignal(turnId)` is the typed "didn't fire" sentinel (matching
  this codebase's established `"NONE"`-over-`null` convention, e.g. `TripSubmissionStartTrigger`).
- **`WorkflowSignalEngine`** (`workflow-signal-engine.ts`) — the only place that evaluates "does this
  turn's free text want to start a new workflow." Calls `contactCapture.shouldStart`/
  `tripSubmission.shouldStart` (unchanged) and wraps the result into a `WorkflowSignal`.
  `BOOKING_HANDOFF` is never evaluated here (it never starts from free text); the BELOW_MINIMUM
  `TRIP_SUBMISSION` trigger is also not evaluated here — Travel Runtime emits that one directly (see
  §8).
- **`WorkflowSignalRegistry`** (`workflow-signal-registry.ts`) — a generic
  `WorkflowSignalType -> WorkflowSignalHandler` map with no workflow-specific code in the class
  itself. `register` throws `WORKFLOW_SIGNAL_HANDLER_ALREADY_REGISTERED` on a duplicate signal type
  (Stage 9E.1 — a configuration bug must be loud at startup, never a silent overwrite).
- **`WorkflowSignalProvider`** (Stage 9E.1, `workflow-signal-registry.ts`) — `{ signalType, handler }`,
  the unit a module contributes via dependency injection under the `WORKFLOW_SIGNAL_PROVIDERS` token.
  `buildDefaultWorkflowSignalProviders(contactCapture, bookingHandoff, tripSubmission)` builds today's
  three; `agent.module.ts` supplies them to `WORKFLOW_SIGNAL_PROVIDERS` via a NestJS `useFactory`
  provider (the established idiom for "many providers under one token," since NestJS has no
  Angular-style `multi: true`). `WorkflowCoordinator`'s constructor `@Optional()`-injects this array
  and builds its registry from it; when nothing is injected (every direct-construction test), it
  falls back to the same default providers — so this is a genuine, DI-driven pluggability point, not
  just a manual factory call, while staying 100% backward compatible. Proven with a non-Travel test
  double in `workflow-signal-registry.spec.ts`/`workflow-coordinator.spec.ts` (a fixture provider the
  coordinator/registry have zero compile-time knowledge of) — see §11/§14 for the honest limit of what
  this proves (one process's DI container, not a real second employee).
- **`WorkflowCoordinator.dispatchSignal(scope, signal, turnId, dispatchSignals, text)`** — the
  single generic entry point every workflow start now funnels through: `dispatchTurn`'s free-text
  path calls it with the engine's derived signal; `startBookingHandoff` (kept as a thin wrapper for
  `AgentService`'s existing call site) constructs a `START_BOOKING_HANDOFF` signal and calls it;
  Travel Runtime's BELOW_MINIMUM business result (now covering both the common case and the
  CRM-tool sales-handoff variant — see §8) reaches it via `AgentService`'s post-turn hook. Returns
  `null` (never overwriting an active/waiting workflow) exactly like the old `startBookingHandoff`
  already did. Stage 9E.1: if a real (non-`NONE`) signal resolves to no registered handler, this logs
  `WORKFLOW_SIGNAL_HANDLER_MISSING` before returning `null` — a missing handler is a configuration bug
  made loud, never a silent fall-through that looks identical to "nothing fired."
- **Historical state migration** — `WorkflowCoordinator.migrateHistoricalContactState` (private,
  called from `dispatchTurn` before the normal waiting/active check) and
  `TripSubmissionWorkflowService.migrateFromLegacyState` (public): for a conversation whose legacy
  `pendingInputAction`/`completionStage` memory already shows a pending contact question (from
  before Stage 9E shipped, or from a signal-dispatch failure — see §8) but has no `WorkflowExecution`
  row yet, this silently creates one in the matching `WAITING_FOR_INPUT` state (no response text —
  the legacy engine's last turn already asked the right question) and the SAME `dispatchTurn` call
  immediately resumes it with the current turn's text. Uses a migration-specific turnId
  (`` `${turnId}:historical-migration` ``), never the caller's own turnId, so the create step and the
  immediate resume step are never mistaken for the same idempotent turn. Idempotent/restart-safe via
  the same `activeKey` uniqueness every workflow start already relies on. Stage 9E.1 fix: also carries
  forward the legacy engine's volunteered-but-unconfirmed `pendingContactValue`
  (`TripSubmissionStartSignals.legacyPendingContactValue`) when migrating a `CONFIRM_STANDALONE_CONTACT_USE`
  conversation — without it, a migrated "yes, use it" confirmation had nothing to confirm and
  (correctly, but unhelpfully) deferred instead of completing; found and fixed while adding the
  semantic-detour deferral below (which made a previously-silent mis-classification visible as a
  test failure instead of an accidentally-still-passing one).
- **Semantic-detour deferral (Stage 9E.1)** — `TripSubmissionWorkflowService.resume()`'s "default"
  branch (an unrecognized reply while `WAITING_FOR_INPUT`, e.g. a policy question asked mid-contact-
  collection) now returns `decision: "DEFER"` with `responseText: null` and no persistence write,
  instead of re-asking. `WorkflowCoordinator.dispatchResumeResult` translates `DEFER` into the
  generic `NOT_HANDLED` outcome (`handled: false`) for every workflow type uniformly — the workflow
  itself is completely untouched (same revision, same `pendingInput`, still `WAITING_FOR_INPUT`), and
  `AgentService.dispatchPendingWorkflowTurn` returns `null`, letting the turn fall through to the
  normal pipeline for that turn only. Because Travel Runtime's own legacy `pendingInputAction` memory
  is deliberately still kept in sync (§8), a deferred turn reaching Travel Runtime is processed with
  its full, pre-existing semantic-arbitration richness (`arbitrateConversationTurn`'s supersede
  logic) — this is what lets a deferred budget question get a real numeric answer instead of a canned
  "please provide your number" repeat, restoring behavior that briefly regressed when BELOW_MINIMUM
  was first migrated onto a real, turn-owning workflow (Stage 9E) and was caught by an existing e2e
  test (`travel.contact-routing.e2e.spec.ts`) before this stage shipped.

### Current workflow types

| Type | Purpose | Notes |
|---|---|---|
| `CONTACT_CAPTURE` | Advisor-callback contact collection. | First workflow built (Stage 9B/9C). Narrow, deliberately-scoped `shouldStart` triggers (menu selection, explicit callback phrase, `completionStage === "OFFERED"` affirmative) — an earlier attempt to widen its triggers caused real E2E regressions (see `LAST_RUN_HANDOFF.md` history / commit history for the reasoning) and was reverted. |
| `BOOKING_HANDOFF` | Scaffolding-only preservation of booking intent. **Never performs real booking, payment, or human approval.** | Built in Stage 9C to prove `WorkflowExecutionService` generalizes across workflow types. Starts only from a `READY_FOR_BOOKING` capability decision, never from free text. |
| `TRIP_SUBMISSION` | Submitting a prepared trip request: confirm submission, confirm/collect contact, create the internal lead exactly once, truthful completion. | Built in Stage 9D to retire the legacy `confirm_booking_lead_capture` / `CONFIRM_STANDALONE_CONTACT_USE` flows as authoritative. Directly reuses Travel Runtime's own exported pure functions/message builders (`resolveTravelInput`, `arbitrateConversationTurn`, `isBookingConfirmation`, `buildContactRequestMessage`, etc.) rather than reimplementing contact/decline/ack classification — this is why it achieved legacy-fidelity behavior while moving state authority to `WorkflowExecutionService`. Its `shouldStart` explicitly refuses to start when the legacy engine's own signals (`pendingInputAction === AWAITING_LEAD_CONTACT/CONFIRM_STANDALONE_CONTACT_USE`, `completionStage === AWAITING_CONTACT/CAPTURED`) show the legacy engine already owns or has already finished this turn. |

All three share: typed pending-input enums, `emptyXState()` builders, two-phase idempotent
completion (turnId-guarded state update, then side-effect, then `markCompleted`), and a
never-throw try/catch with a safe-retry-message fallback.

### Execution order (Stage 9E.1)

The exact order one turn moves through, as actually implemented (`AgentService.execute` →
`dispatchPendingWorkflowTurn` → `WorkflowCoordinator.dispatchTurn`):

```
Incoming turn
  │
  ▼
findActiveWorkflowsForConversation (organizationId+pluginInstallationId+conversationId)
  │
  ├─ nothing WAITING_FOR_INPUT, nothing else active ──► migrateHistoricalContactState
  │                                                        (legacy pendingInputAction/completionStage
  │                                                         → real WorkflowExecution, no response text)
  │
  ▼
a workflow is WAITING_FOR_INPUT for this conversation?
  │
  ├─ yes ──► cancellation phrase? ──► cancel() ──► CANCELLED (handled)
  │      │
  │      └─ no ──► that workflow's own resume()
  │                  │
  │                  ├─ ASK_FOR_INPUT / COMPLETE / FAIL / CANCELLED ──► handled:true, return to caller
  │                  │
  │                  └─ DEFER ──► handled:false (NOT_HANDLED) — workflow untouched, turn continues ↓
  │
  └─ no, but some OTHER workflow is active (non-waiting) ──► NOT_HANDLED (never bypassed either)
  │
  ▼ (only reached when nothing is active/waiting, OR the active workflow just DEFERred)
[turn continues to] canonical extraction / Skill Runtime / Knowledge / Capability Execution / Travel
Runtime — Travel Runtime's own business computation may ADDITIONALLY emit a BELOW_MINIMUM signal here
  │
  ▼
WorkflowSignalEngine.deriveSignal(text, signals, turnId)  [only for the FREE-TEXT start path, run
                                                            BEFORE domain processing, in the same early
                                                            dispatchPendingWorkflowTurn call above —
                                                            see note below]
  │
  ▼
WorkflowCoordinator.dispatchSignal(scope, signal, turnId, dispatchSignals, text)
  │  re-checks findActiveWorkflowsForConversation — if ANY workflow now exists (including one another
  │  signal/turn created concurrently), returns null: never overwrites, never duplicates
  ▼
WorkflowSignalRegistry.resolve(signal.signalType) → handler.start(...) → new WorkflowExecution row
```

**Important nuance, disclosed rather than smoothed over**: there are actually TWO signal-derivation
moments, not one — `WorkflowSignalEngine`'s free-text derivation runs EARLY (inside
`dispatchPendingWorkflowTurn`, before Travel Runtime/domain processing ever runs for that turn, which
is what lets a workflow-owned phone-number reply skip the AI provider entirely), while Travel
Runtime's own BELOW_MINIMUM-computed signal can only be known AFTER domain processing runs (feasibility
is a business calculation Travel Runtime performs), so `AgentService`'s post-turn hook calls
`dispatchSignal` a second time, later in the same request. Both funnel through the exact same
`dispatchSignal` → registry → `WorkflowExecutionService.createWorkflow` (activeKey-unique) path, so the
invariants hold regardless of which moment produced the signal: existing workflow always wins, signals
never bypass an active workflow, duplicate signals never create duplicate rows.

**Conflict/priority rules verified by dedicated tests** (`workflow-coordinator.spec.ts`): an active
workflow is never bypassed by a same-turn free-text start trigger (including a DIFFERENT workflow
type's trigger phrase); a `DEFER`red turn never starts a conflicting second workflow; legacy
pending-contact memory never migrates (or otherwise overrides) while a real workflow — even a
different type — is already active; cancellation still targets the correct workflow after a
deferred turn; historical migration is idempotent under concurrent/duplicate attempts.

## 7. Capability Execution (`skills/travel/capability-execution.adapter.ts`)

`CapabilityExecutionAdapter.execute` translates a `TravelDecisionRoute` into a typed
`ExecutionDecision` (`capability: ITINERARY | ESTIMATE | LIVE_SEARCH | BOOKING | NOT_APPLICABLE`;
`executionStatus: EXECUTED | PREPARED | DELEGATED | DEFERRED | FAILED | NOT_APPLICABLE`;
`executionType: DETERMINISTIC_CALCULATION | LLM_ORCHESTRATED | TOOL_DELEGATED | WORKFLOW_PENDING |
NONE`). It never performs business logic itself — it either calls an existing pure Travel Runtime
function directly (`EXECUTED`), assembles an invocation target for the existing tool pipeline
(`PREPARED`), or explicitly defers to Travel Runtime's own orchestration (`DELEGATED`) — designed
never to throw; failures fall back to legacy Travel Runtime.

## 8. Travel Runtime (`travel/travel.runtime.ts`) — the AI Employee under active migration

Two large classes: `TravelEmployeeProvider` (deterministic + LLM-backed trip planning) and
`TravelEmployeeLlmOrchestrator`. Historically owned everything: intent classification, a private
state machine (`TravelPendingInputAction`, `ConversationCompletionStage`), response text, and lead
capture. It is being migrated turn-by-turn to become a pure execution provider, with business-state
ownership moving to Skill Runtime / Workflow Runtime. See §11 for exactly how far this has gotten.

Key legacy internals still present:

- `TravelPendingInputAction`: `AWAITING_LEAD_CONTACT | AWAITING_LEAD_CONSENT (dead) |
  CONFIRM_STANDALONE_CONTACT_USE | AWAITING_PASSENGER_COMPOSITION | AWAITING_TRAVEL_YEAR | null`.
- `ConversationCompletionStage`: `NOT_OFFERED | OFFERED | AWAITING_CONTACT | CAPTURED | DECLINED`.
- `arbitrateConversationTurn` / `resolveTravelInput` — the shared arbitration function used for
  contact classification **and** unrelated date/passenger/budget classification; cannot be safely
  partially gutted, which is why the workflow layer calls it rather than replacing it.
- `beginOrResumeLeadCapture` (private, 4 call sites) — provably unreachable in the integrated
  `AgentService` path (upstream `WorkflowCoordinator` interception proven via passing E2E tests),
  but **not deleted**: `travel.llm.spec.ts` contains direct unit tests constructing
  `TravelEmployeeLlmOrchestrator` standalone that exercise this code as regression coverage for real
  historical bugs. Deleting it would remove that coverage for zero behavioral benefit. This is
  disclosed legacy behaviour, not platform authority — see §11.
- The BELOW_MINIMUM-budget-triggered contact collection is fully migrated as of Stage 9E.1 — both the
  common case (Stage 9E) and the CRM-tool sales-handoff variant (Stage 9E.1) now emit the same
  `START_TRIP_SUBMISSION` signal in `PLATFORM_MANAGED` mode. Previously, when a CRM connector tool was
  available, this engine called it directly as the PRIMARY action (via `toolResult`), with no internal
  `TravelLead` created at all, and the confirmation text depended on that call's own success/failure.
  Stage 9E.1 converges this onto `TRIP_SUBMISSION`: the internal lead is always created first
  (deterministically, never depending on any connector), and `AgentService`'s existing
  `syncLeadToCrmBestEffort` (already used for every workflow-captured lead) mirrors it to whatever CRM
  connector is installed — tracked via `TravelLead.crmSyncStatus` (`PENDING/SYNCED/FAILED/SKIPPED`),
  never surfaced in the conversational response either way. `STANDALONE_COMPATIBILITY` mode (direct
  construction, e.g. `travel.llm.spec.ts`) keeps the original CRM-tool-as-primary-action behavior
  unchanged.

### `TravelRuntimeExecutionMode` (Stage 9E)

Both `TravelEmployeeProvider` and `TravelEmployeeLlmOrchestrator` take a final constructor parameter,
`executionMode: "PLATFORM_MANAGED" | "STANDALONE_COMPATIBILITY"`, defaulting to
`STANDALONE_COMPATIBILITY` so every existing direct-construction unit test (which never passes this
parameter) is behaviorally unaffected. `AgentService` is the only caller that passes
`"PLATFORM_MANAGED"` explicitly.

In **both** modes, the BELOW_MINIMUM budget-feasibility business result still transitions the
engine's own `completionStage`/`pendingInputAction` fields exactly as before Stage 9E — this was
deliberately kept (not skipped) after an initial attempt to skip it broke an unrelated downstream
branch (`tag()`'s Conversation-Completion-offer gate, which also reads `completionStage`) and, more
importantly, because it is what makes `WorkflowCoordinator.migrateHistoricalContactState` a safe,
self-healing fallback if the signal dispatch below ever fails on its own turn. In
`PLATFORM_MANAGED` mode only, the engine **additionally** sets a `lastWorkflowSignal` getter
(`TravelWorkflowSignalDraft`, a minimal, workflows/-module-independent shape:
`{ signalType: "START_TRIP_SUBMISSION", trigger: "BELOW_MINIMUM_BUDGET" }`) — reset to `null` at the
start of every `complete()` call. `AgentService` reads this once, after the turn's response text is
already finalized, and (if non-null) builds a full `WorkflowSignal` and calls
`WorkflowCoordinator.dispatchSignal` as a silent side effect: this turn's already-computed response
text is never altered; only which mechanism owns the NEXT turn's contact reply changes.

**Stage 9E.1 legacy-mutation audit** (full text lives as a doc comment on `TravelRuntimeExecutionMode`
itself in `travel.runtime.ts` — grep `executionMode === "PLATFORM_MANAGED"` for the exhaustive, exactly-
two-call-sites list). Summary: every `PLATFORM_MANAGED`-reachable legacy mutation was reviewed and
classified; none were found to be **obsolete authority**, so none were removed.
`completionStage`/`pendingInputAction` are classified **required compatibility mirror + historical
migration support** (self-healing fallback if a signal dispatch fails; removing it was tried and broke
`tag()`'s unrelated completion-offer gate — proven by a byte-for-byte STANDALONE-vs-PLATFORM_MANAGED
response-text comparison test). `pendingAction`/`providerFailure` resets are classified
**standalone-only Travel Runtime hygiene, not legacy workflow authority at all** (neither field exists
on `WorkflowExecution` or is read by any workflow service). A dedicated regression test
(`workflow-coordinator.spec.ts`, "Runtime-authority guarantee") proves legacy pending-contact memory is
structurally incapable of overriding or restarting an already-active workflow, including a DIFFERENT
workflow type, because `dispatchTurn` always checks `findActiveWorkflowsForConversation` before ever
consulting legacy memory.

**A narrowing found (and then resolved within the same overall effort) while implementing this**: once
a real `TRIP_SUBMISSION` `WorkflowExecution` exists and is `WAITING_FOR_INPUT` for a mobile number,
`AgentService`'s workflow dispatch intercepts every subsequent turn for that conversation *before*
Travel Runtime ever runs (the existing, intentional "an active workflow always owns the turn" rule,
Stage 9C). Before Stage 9E, a BELOW_MINIMUM-triggered pending-contact turn had no real
`WorkflowExecution` yet, so the full legacy Travel Runtime still ran every turn and could answer an
unrelated semantic detour (e.g. "what's the minimum possible budget?") while still awaiting the phone
number; migrating BELOW_MINIMUM onto a real workflow (Stage 9E) initially lost that, since
`TripSubmissionWorkflowService.resume()`'s "default" branch just re-asked. **Stage 9E.1 restores this**
via the semantic-detour `DEFER` decision (see above): the deferred turn falls through to the normal
pipeline, where Travel Runtime — still holding its own legacy `pendingInputAction` awareness (kept
deliberately, see the audit above) — answers it with its full pre-existing richness. See
`travel.contact-routing.e2e.spec.ts`'s test for the concrete, now-passing-again case.

## 9. Connectors (`connectors/`, `docs/connectors.md`)

Organization-scoped, trusted, in-process adapters. An organization installs a
`ConnectorDefinition`, supplies non-secret config + write-only credentials (AES-256-GCM encrypted),
grants declared capabilities, enables the installation. Connector code never runs inside the agent
loop directly — connector tools register through the existing tool registry/executor, same as any
other tool. Reference connectors: `dummy-crm` (credential-free, tenant-scoped leads),
`generic-http` (allowlisted methods/paths under one configured base URL, delegates to the platform
HTTP tool's SSRF/DNS/redirect/timeout/size controls), `hubspot`. Inbound events are idempotent by
installation + external event ID.

## 10. Knowledge / RAG (`knowledge/`, `docs/enterprise-knowledge.md`)

Hierarchy: `Organization → AI Employee (Plugin installation) → KnowledgeCollection →
KnowledgeDocument → KnowledgeChunk (+ embedding)`. Every read/write API is nested under an AI
Employee id — there is no organization-wide knowledge view, and `KnowledgeChunk` denormalizes
`pluginInstallationId` + `collectionId` directly so retrieval can never cross an employee boundary.
Embeddings are real pgvector (`vector(1536)`, HNSW, cosine distance), standardized at 1536
dimensions across every provider including the deterministic dev/test one. Ranking blends semantic
similarity, keyword overlap, title boost, metadata (heading-path) boost, exact-phrase boost, and a
conflict penalty (`SCORE_WEIGHTS` in `knowledge.search.ts`). Knowledge/RAG never determines business
state — it only informs response generation.

## 11. Authority boundaries — Platform authority / Compatibility layer / Legacy behaviour

Per the mandatory reporting distinction in `SYSTEM_INSTRUCTIONS.md` §11, here is the honest current
state (as of Stage 9E.1, 2026-07-27):

**Platform authority (genuinely generic today):**
- `WorkflowExecutionService` — tenant-scoped, employee-agnostic persistence; any future employee's
  workflow can use it unmodified.
- `WorkflowCoordinator` — employee-agnostic routing MECHANISM (dispatch, priority, cancellation,
  signal resolution, semantic-detour deferral) — though only ever instantiated with Travel's three
  workflow types today; no second employee exists yet to prove it end-to-end. It contains zero
  hardcoded per-workflow-type "should this start" branching (moved to `WorkflowSignalEngine`, Stage
  9E) and, as of Stage 9E.1, its start-time registry is built from an `@Optional()`-injected
  `WorkflowSignalProvider[]` (`WORKFLOW_SIGNAL_PROVIDERS` token) rather than a hardcoded factory call
  — a future module can contribute a handler via DI without editing `workflow-coordinator.ts`. Resume
  dispatch (per-`workflowType` `if` branches calling the concrete service's own `.resume()`) remains
  the one part of this class not yet DI-generalized — see Compatibility layer below.
- `WorkflowSignalRegistry` (the class itself) and `WorkflowSignalProvider` (the DI contract) — fully
  generic, proven with a non-Travel test-double fixture in `workflow-signal-registry.spec.ts` and
  `workflow-coordinator.spec.ts` (a fixture the coordinator/registry have zero compile-time knowledge
  of). The honest limit of what this proves: one process's NestJS DI container composing an array
  from providers it was handed, not a real second AI Employee module contributing across a module
  boundary — see §14.
- `WorkflowResumeDecision`'s `DEFER` outcome and `WorkflowCoordinator.dispatchResumeResult` — a
  generic translation (any workflow type's `resume()` can return `DEFER`) applied uniformly, not a
  Travel-only special case, even though only `TripSubmissionWorkflowService` uses it today.
- Typed contracts: `WorkflowStartRequest`, `WorkflowTurnResult`, `WorkflowSignal`, `ExecutionDecision`,
  `InputDecision`, `SkillEvaluation`.
- `conversation/conversation-completion.ts` — explicitly built employee-agnostic (no NestJS DI, no
  employee-domain imports): affirmative/negative detection, phone normalization/extraction,
  lead-reference generation.

**Compatibility layer (intentional bridges, not yet generic — real debt):**
- `AgentService` directly imports Travel-specific types (`TravelConversationMemory`,
  `entitiesToStoredState`, `TRAVEL_TRIP_STATE_MEMORY_KEY`) to keep the legacy `/state` HTTP
  endpoint truthful after a `TRIP_SUBMISSION` workflow completes (bumping the legacy
  `travel.trip_state` `AgentMemory` blob's `completionStage`/`capturedLeadReference`). A
  platform-level class currently contains employee-specific knowledge.
- `ContactCaptureWorkflowService` / `BookingHandoffWorkflowService` /
  `TripSubmissionWorkflowService` are correctly modeled as workflows, but their internals import
  `travel.runtime.ts` functions and text builders directly, and contact validation
  (`phone-validation.ts`) is India-phone-number-specific. A future non-Travel employee could not
  reuse these workflows without forking them.
- `buildDefaultWorkflowSignalProviders` (in `workflow-signal-registry.ts`) and the still-per-type
  `if` branches in `WorkflowCoordinator.resume()`/`cancel()` are, by design, the remaining places in
  the Workflow Runtime that know the concrete Contact Capture/Trip Submission/Booking Handoff
  services — necessary composition-root wiring (the former) or an accepted, disclosed scope limit for
  this stage (the latter — see §14), kept out of the START-time dispatch path but not yet eliminated
  from resume/cancel.
- Travel Runtime's `TravelRuntimeExecutionMode` plumbing (both engines) is itself a compatibility
  seam: it lets Travel Runtime keep its full legacy state-machine behavior for every direct/
  standalone caller while additionally emitting a signal for `AgentService`'s integrated path. This
  is intentional dual-mode compatibility, not a fully "clean" execution-provider implementation.

**Legacy behaviour (still present, not platform, not fully retired):**
- `travel.runtime.ts`'s intent classification + state machine (`arbitrateConversationTurn`,
  `resolveTravelInput`, `TravelPendingInputAction`, `ConversationCompletionStage`,
  `beginOrResumeLeadCapture`) still exists in full, and still runs its own legacy
  `completionStage`/`pendingInputAction` transitions even in `PLATFORM_MANAGED` mode (kept
  deliberately, audited in §8 — self-healing fallback + the semantic-detour deferral depends on this
  memory staying in sync). It is provably unreachable for the `CONTACT_CAPTURE`/`TRIP_SUBMISSION`-
  covered paths (now including BOTH BELOW_MINIMUM variants — the common case since Stage 9E, and the
  CRM-tool sales-handoff variant since Stage 9E.1) in the integrated `AgentService` flow, but it is
  retained deliberately (not an oversight) because `travel.llm.spec.ts` depends on it directly for
  regression coverage of historical bugs.
- **Do not describe Travel Runtime as "just an execution provider" without this caveat** — it is
  not yet true in full; it's true only for the workflow-covered paths, and even those paths still
  run Travel Runtime's own legacy state transitions as an inert-but-present safety net.

## 12. Travel Runtime: Stage 9F targeted correctness fixes

Stage 9F was scoped as Travel Employee behavioral/state defects found in UAT, explicitly NOT a
Workflow Engine redesign. Rather than build the charter's full proposed new type system
(`BudgetConstraintType`/`TravelBudgetConstraint`, `DerivedTravelResultMetadata`, a separate
`travelStyle` field, etc.), each defect was root-caused against the ACTUAL existing code first —
most of the underlying infrastructure already existed and was more mature than the charter's framing
suggested; the real bugs were narrower (regex patterns not matching specific phrasings, one
confirmed-field-override gate). What actually changed:

- **Budget state ("OPEN" budget)**: no new type — this codebase already models "no fixed number" as
  `TravelBudgetMode` (`FLEXIBLE`/`AGENT_RECOMMENDED`, both already exempt from
  `computeMissingEntityFields`'s budget requirement). The gap was purely pattern coverage:
  `FLEXIBLE_BUDGET_PATTERN` now matches `budget (is)? open\w*` (covering "budget is open", the
  "openb" typo, and "budget is open boss" as a prefix match) and `open budget`;
  `AGENT_RECOMMENDED_BUDGET_PATTERN` now matches `you estimate (the/my/your budget)?`. Deliberately
  did NOT add the charter's own "give me your estimate" phrase — too generic, could follow an
  already-fixed budget and would wrongly downgrade it (`detectBudgetModeSignal` has no awareness of
  current state).
- **Display currency ("I need in AED", "budget in AED")**: no new state — `displayCurrency` and the
  whole `CurrencyService`/`effectiveDisplayCurrency` mechanism already existed and already handled
  most phrasings correctly. The gap: `CurrencyService`'s `CHANGE_CUE` verb list didn't include
  "need"/"budget", so those two specific cue words silently failed to register as a display-currency
  request. Both are now safe cues — the existing "in/to/into/as + bare currency token, no number in
  between" adjacency requirement still prevents a stated amount ("I need 5000 AED") from being
  misread as a currency-only preference change.
- **Explicit budget corrections silently discarded (root cause of "AED 5,000 survives an AED 10,000
  correction")**: found via a genuine, previously-undiscovered bug in `mergeConfirmedEntities` —
  once a field is `confirmed: true`, only an `intent === "modify_trip"` turn (or a city field) may
  override it (`allowOverride = !isConfirmed || isExplicitCorrection || isCityField`). A bare
  budget-only reply ("10000 AED") gets classified `provide_trip_details` by both
  `classifyIntentDeterministically` and (in this session's e2e reproduction) a representative fake
  LLM response, so the correction was silently dropped and the OLD confirmed budget survived. Fixed
  with a new deterministic override in `TravelEmployeeLlmOrchestrator.safeExtractAndClassify`: when
  the DETERMINISTIC parser itself (never model inference) finds a budget in the raw text that
  differs from the already-known one, `intent` is forced to `"modify_trip"` regardless of what the
  LLM/fallback classified it as — matching this file's existing "deterministic override, independent
  of how the model classifies" pattern used throughout. This also directly fixes `itineraryAlreadyPresented && intent === "modify_trip"`'s existing "re-run recommendations immediately" branch, so a
  correction after a shown plan now re-quotes fresh numbers rather than silently keeping stale ones.
- **`extractBudget` gap uncovered by the above**: the deterministic override's signal
  (`deterministic.budget`) required `extractBudget` to actually parse the correction text, and it
  didn't — it only recognized "<currency> <amount>" (prefix) ordering, and only for USD/INR/EUR; AED
  (used throughout the UAT charter) wasn't recognized at all. Added a postfix
  "<amount> <currency-code>" pattern covering every currency this codebase already treats as a
  first-class display currency (USD/INR/EUR/AED/GBP/SGD/CAD/AUD/THB/JPY), so a stated amount is
  recognized the same way regardless of word order.
- **Workflow trigger re-evaluation** (the one genuinely new mechanism this stage adds): `TripSubmissionState` gained `triggerReason: TripSubmissionStartTrigger | null`, set at `start()` time
  (`null` for a historically-migrated workflow — unknown provenance, safe default is never
  auto-cancel). New `TripSubmissionWorkflowService.cancelIfBelowMinimumTriggerResolved(execution)`:
  cancels a still-`WAITING_FOR_INPUT` workflow ONLY if its own recorded trigger was
  `BELOW_MINIMUM_BUDGET` (never one started by an explicit `CONFIRM_SUBMISSION`/`STANDALONE_CONTACT`
  request — a budget change must never silently invalidate a genuine, explicit submission ask). New
  `WorkflowCoordinator.reevaluateBelowMinimumTrigger(scope, stillBelowMinimum)`: finds the
  conversation's active `TRIP_SUBMISSION` workflow (if any) and delegates to the above. Wired into
  `AgentService`: once per turn where `TravelEmployeeLlmOrchestrator` recomputed feasibility (this
  includes a turn a workflow `DEFER`red, since the turn then reaches Travel Runtime normally), the
  freshly-computed `classification` decides whether to call this. Cancelled workflows get
  `currentStep: "SUPERSEDED_BUDGET_CORRECTED"` — a new, self-describing terminal marker, not a
  silent deletion (the audit row remains, per this codebase's existing "never delete, only mark
  terminal" convention). **Disclosed scope limit**: only wired for the LLM-orchestrator path — the
  deterministic `TravelEmployeeProvider` does not expose an equivalent `lastDiagnostics.feasibility`
  getter today, so a below-minimum trigger corrected under a `DETERMINISTIC` provider configuration
  is not automatically re-evaluated (see gaps below).
- **`luxary`/`luxury`**: added as a typo-tolerant variant to `HOTEL_TIER_CUE_PATTERN` (the gate that
  legitimizes a `hotelStars` value). This cue never touches `budget` or `cabinClass` — "luxury
  reopening budget" or "luxury stored as cabin class" were not actually reachable failure modes in
  the existing code, only the typo-recognition itself was missing.
- **Explicitly NOT implemented this stage** (see gaps below for the full list): a distinct
  `travelStyle`/cabin-class/hotel-tier type separation beyond what already exists; any trip-state
  versioning or `DerivedTravelResultMetadata`-style invalidation system (the workflow-trigger
  re-evaluation above is a narrow, single-purpose analog, not a general mechanism); day-wise
  itinerary generation quality work; hotel-recommendation area/geo resolution; lead-list/RBAC access
  behavior; the broader `HOTEL_RECOMMENDATION`/`ITINERARY_GENERATION`/numbered-choice-context intent-
  routing hardening; a general normalization dictionary beyond the two typo fixes above; vegetarian/
  preference persistence review beyond confirming it already survives via existing entity persistence.

## 13. Completed implementation stages (for orientation, not a task list)

Sprint 0–1: bootstrap, identity. Sprint 2.3–2.4: teams, service accounts. Sprint 3.1–3.2: plugin
runtime + SDK. Sprint 3.3: agent runtime (tool loop, memory). Sprint 3.4: AI provider runtime.
Sprint 3.5: connector framework. Sprint 4.2: Travel Employee conversation engine (legacy,
monolithic). Sprint 4.3: employee-scoped knowledge + grounded RAG (pgvector). Skill Runtime Stages
1–9A (shadow → durable mirror → diagnostics → UAT → real shadow review → authoritative input
collection → capability execution adapter). Workflow Runtime Stage 9B (Contact Capture, generic
`WorkflowExecutionService`), 9C (Workflow Authority Consolidation — `WorkflowCoordinator`,
`BOOKING_HANDOFF` proves generalization, typed `WorkflowStartRequest`), 9D (Trip Submission
workflow, partial legacy contact-state retirement), 9E (Workflow Signal Engine — generic
`WorkflowSignal`/`WorkflowSignalRegistry`/`WorkflowSignalEngine`, `WorkflowCoordinator.dispatchSignal`
as the single workflow-start entry point, BELOW_MINIMUM budget migrated to `TRIP_SUBMISSION` for the
common case, `TravelRuntimeExecutionMode`, historical legacy-state migration), **9E.1 (Workflow
Engine Finalisation** — the CRM-tool sales-handoff variant of BELOW_MINIMUM converged onto the same
signal; semantic-detour `DEFER` resume outcome restoring mid-collection question-answering; DI-pluggable
`WORKFLOW_SIGNAL_PROVIDERS` signal registration proven with a test double; a full audit of every
`PLATFORM_MANAGED` legacy-field mutation with none found obsolete; a found-and-fixed historical-migration
gap around carrying forward a volunteered contact value), 9F (Travel Runtime targeted correctness
fixes — open-budget/currency-cue/luxury-typo pattern gaps closed; a genuine `mergeConfirmedEntities`
confirmed-field-override bug found and fixed via a deterministic `explicitBudgetCorrection` signal;
`extractBudget` gained postfix-currency and AED support; the new `reevaluateBelowMinimumTrigger`
workflow-trigger-supersession mechanism — see §12 for the full account, including what the stage's
much larger charter explicitly did not get implemented) — see §11 for what's genuinely retired vs.
still legacy.

## 14. Known architectural gaps (do not paper over these)

**Resolved by Stage 9E.1** (kept here, struck through in spirit, so a future session doesn't have to
re-derive that these were once true): the CRM-tool sales-handoff variant of BELOW_MINIMUM is no
longer legacy-owned (converged onto `TRIP_SUBMISSION`, see §8); `TripSubmissionWorkflowService.
resume()`'s "default" branch no longer just re-asks on an unrelated semantic detour — it `DEFER`s,
restoring the pre-Stage-9E richness (see §6); a real historical-migration bug (the volunteered
contact value never carrying forward for `CONFIRM_STANDALONE_CONTACT_USE`) was found and fixed.

Still open:

1. Travel Runtime is not yet a pure execution provider. Both BELOW_MINIMUM variants are now
   migrated, but Travel Runtime still runs its own legacy `completionStage`/`pendingInputAction`
   transitions even in `PLATFORM_MANAGED` mode (kept as a self-healing fallback AND because the
   semantic-detour deferral depends on this memory staying in sync, §8) — meaning "authority moved"
   is true in practice (the coordinator always intercepts first) but not true in the sense of "Travel
   Runtime no longer touches this state at all." The full legacy state machine is also retained for
   test-coverage reasons (§11, §8).
2. Workflow implementations (`ContactCaptureWorkflowService`, `TripSubmissionWorkflowService`,
   `BookingHandoffWorkflowService`), and `buildDefaultWorkflowSignalProviders`, are not
   employee-agnostic in practice — they import or reference Travel-specific services/functions
   directly. No second AI Employee exists yet to validate genericity.
3. `AgentService`, a platform-level class, contains Travel-specific compatibility logic (the
   legacy `/state` memory bump, and the BELOW_MINIMUM post-turn signal-dispatch hook). This is
   a violation of "no employee-specific assumptions in platform layers," disclosed and intentional
   but unresolved.
4. Human Approval is not yet built as a workflow type — the charter requires it to be one when it
   is built; nothing currently implements it.
5. Booking execution (real reservation/payment) does not exist. `BOOKING_HANDOFF` is scaffolding
   only, by design — never claim otherwise.
6. Only one Skill (`travel.plan-trip`) and one AI Employee (Travel) exist. Every "generic" platform
   claim in this document — including Stage 9E.1's DI-pluggable `WORKFLOW_SIGNAL_PROVIDERS`
   registration, proven only with an in-process test-double fixture, never a real second employee
   module across an actual module boundary — is unproven beyond one concrete instantiation.
7. `WorkflowCoordinator.resume()`/`cancel()` still contain per-`workflowType` `if` branches calling
   the three concrete workflow services' own `.resume()`/`.cancel()`-equivalent methods directly —
   Stage 9E.1 made the START-time path (`dispatchSignal`/registry) DI-pluggable and Travel-agnostic,
   but explicitly scoped RESUME dispatch as a separate, still-per-type-coupled concern (the charter's
   own Part 7 execution-order diagram treats "resume active workflow" as a distinct early step from
   signal handling). A future stage could extend the same `WorkflowSignalProvider`-style DI pattern to
   resume/cancel if full coordinator-level employee-agnosticism is required.
8. **(Stage 9F)** `WorkflowCoordinator.reevaluateBelowMinimumTrigger` is wired only for
   `TravelEmployeeLlmOrchestrator` — the deterministic `TravelEmployeeProvider` has no
   `lastDiagnostics`/feasibility getter today, so a `BELOW_MINIMUM` trigger corrected under a
   `DETERMINISTIC` provider configuration is never automatically superseded; the stale workflow stays
   `WAITING_FOR_INPUT` until the user provides contact or cancels explicitly.
9. **(Stage 9F)** `extractBudget`'s postfix-currency support only covers the codebase's ten
   already-supported display currencies (USD/INR/EUR/AED/GBP/SGD/CAD/AUD/THB/JPY) and only
   ISO-code/symbol forms — word forms like "50000 dollars" or "10000 dirhams" (postfix) are still
   unrecognized (only "$50000"/"USD 50000"-style prefix forms handle word variants, via the
   pre-existing `dollars`/`rupees`/`euros` checks). A real LLM-backed extraction path is unaffected
   (it doesn't depend on this regex), so this only matters for the deterministic-fallback and
   explicit-correction-detection paths.
10. **(Stage 9F, explicitly out of scope for this stage, not attempted)**: no trip-state versioning
    or general derived-result invalidation system exists — the workflow-trigger re-evaluation above
    is a narrow, single-purpose mechanism for exactly one case (`BELOW_MINIMUM` → `TRIP_SUBMISSION`),
    not a general "invalidate stale estimates/itineraries/recommendations when trip facts change"
    capability. Budget/cabin-class/hotel-tier remain modeled as they were (no distinct `travelStyle`
    field). Day-wise itinerary generation quality, hotel-recommendation geo/area resolution, lead-
    list/RBAC access behavior, and the broader `HOTEL_RECOMMENDATION`/`ITINERARY_GENERATION`/numbered-
    choice-context intent-routing hardening the Stage 9F charter also requested were not implemented —
    see §12 for the full list of what Stage 9F did and did not do, and `LAST_RUN_HANDOFF.md` for the
    recommended next stage.
11. Working tree note: as of 2026-07-27, `main` carries a very large uncommitted diff (Stages 8B
    through 9F, ~90+ changed/new files) — none of this is committed yet. Verify with
    `git status --short` before assuming any of the above is durably saved.
