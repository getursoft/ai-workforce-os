# Production Architecture

Sprint 5.0 Phase 3/28. How this monorepo maps onto production processes, and why.

## Process roles

One codebase (`apps/api`), multiple deployed process roles via `PROCESS_ROLE`:

| `PROCESS_ROLE` | Runs | Purpose |
|---|---|---|
| `api` | HTTP server only | Handles all inbound requests; no background pollers |
| `scheduler` | `SchedulerService`'s tick loop | Autonomous scheduled jobs (Sprint 4.8) |
| `workforce-worker` | `WorkforceTaskProcessor`, `QueueConsumerWorker` | Async delegated-task dispatch, durable queue consumption |
| `channel-worker` | `ChannelMessageProcessor` | Inbound/outbound WhatsApp/Twilio message processing |
| `maintenance` | `ObservabilityRetentionService`, `QueueConsumerWorker` | Trace/span cleanup, queue consumption |
| `all` | Every poller above | **Local development only** — one process running everything, matching `pnpm dev`'s single-process convenience |

Each poller checks its own role at `onModuleInit()` (e.g. `if (this.config && !this.config.runs("scheduler")) return;`) — an `api`-role process starts zero background loops. This is what makes horizontal API scaling safe: run N `api` replicas behind a load balancer without N copies of every poller also running and duplicating work.

**Do not deploy `PROCESS_ROLE=all` outside local development.** In production, run one `api` deployment (scaled to N replicas) plus one instance each of `scheduler`/`workforce-worker`/`channel-worker`/`maintenance` (or fewer instances covering multiple roles via multiple `PROCESS_ROLE` values in separate deployments — never multiple values in the same process).

## The database is still the single source of truth

Every poller's actual state (what's due, what's claimed, what failed) lives in Postgres — `ScheduledJob`/`ScheduledExecution`, `EmployeeDelegatedTask`, `ChannelMessage`, and now `QueueMessage`. Losing a worker process loses no state; the next poller cycle (on that role, wherever it's running) picks up where the crashed one left off. This is why Phase 4's durable queue was designed as an *additional* layer over the existing polling tables, not a replacement requiring a rewrite of any of them — see `docs/production/architecture.md`'s companion note in the Phase 4 section of the Sprint 5.0 final report for what's actually wired vs. scaffolded as of this pass.

## Request path

```
Client → Load Balancer (TLS termination) → API replicas (PROCESS_ROLE=api)
                                              ├─ RateLimitGuard (global default GENERAL_API,
                                              │   per-route overrides via @RateLimit(...))
                                              ├─ JwtAccessGuard + PermissionGuard (per-controller)
                                              ├─ BillingEnforcementService (AgentService.execute() only)
                                              ├─ EntitlementService (plugin install, etc.)
                                              └─ PrismaService → Postgres (pooled, statement-timeout-bounded)
                                                              → ObjectStorageService → S3-compatible storage
```

## Dashboard

Next.js, built standalone (`output: 'standalone'` via `Dockerfile.dashboard`), served as its own container/process — stateless, scales independently of the API.

## What's NOT yet true (honest gaps as of Sprint 5.0)

- Scheduler/workforce/channel processors still poll their own dedicated tables directly rather than
  publishing through the new `QueueMessage` table — the queue infrastructure is correct, tested, and
  health-checked, but not yet the thing actually driving those three processors.

  This was investigated concretely, not just deferred on suspicion: an atomic-claim guard was added to
  `WorkforceOrchestratorService.dispatch()` (the natural place to prevent the double-execution a second
  trigger path would risk) and run against the real e2e suite. It broke 5 previously-passing tests. Root
  cause: `dispatch()`'s existing retry mechanism (`failTask()`, on a retryable failure) re-enters
  `dispatch()` while the task's status is still `RUNNING` — not `QUEUED` — relying on the *absence* of an
  atomicity check to make that legitimate, sequential retry work. A naive "only proceed if status is
  QUEUED" guard can't distinguish that legitimate internal re-entry from a genuinely concurrent second
  trigger (a poller and a queue handler racing on the same task). Making both safe at once needs the
  claim to happen at the *processor* level (before calling `dispatch()`) rather than inside `dispatch()`
  itself, without double-incrementing `attemptCount` — a real design change, not a quick patch. The
  attempted fix was reverted cleanly (verified via `git diff` showing zero changes, and 59/59 workforce
  tests passing) rather than shipped partially working. This is the concrete reason producer migration
  remains a distinct follow-up rather than something to rush: the risk was real, not hypothetical.
- `AppConfig` (Sprint 5.0) and the legacy `SecurityConfig` are still two files (Sprint 5.0B consolidated
  their field names, HTTPS policy, and runtime instantiation onto one source of truth — see
  `docs/production/environment-variables.md` "A note on two config systems" — but did not merge them into
  a single file; `SecurityConfig`'s auth-critical validation stays separate and stricter by design).
- `ObjectStorageService` (S3-compatible, signed URLs, tenant-scoped) has **zero real consumers** — grep
  confirms nothing outside its own module and `env.schema.ts` references it. Knowledge document uploads
  (the only actual production file-upload path) still go through `LocalKnowledgeFileStorage` —
  local-disk-only (won't survive across replicas/restarts without a shared volume in a multi-instance
  deployment), no signed URLs, no expiry, and `NoopKnowledgeVirusScanner` is an explicit no-op stub, not a
  real scan. This is the same shape of gap as the Phase 4 queue: a correct, tested, additive abstraction
  that the real production path hasn't been migrated onto yet.
- Knowledge retrieval's confidence gate (`headingPathMatchesQueryIntent`, `apps/api/src/knowledge/knowledge.search.ts`)
  requires a candidate chunk's heading to cover *every* `TERM_GROUPS` topic the query touches. `TERM_GROUPS`
  is a small curated list (cancellation/refund, fare/pricing, infant/child, age/eligibility, hotel,
  booking/reservation) tuned against specific historical UAT bugs. A query can pull in a group from an
  incidental word in its phrasing rather than its actual topic — "what are the benefits of **booking**
  through your portal" pulls in the booking/reservation group purely because it contains the word
  "booking", so the otherwise-exact "## Portal Benefits" heading match gets rejected (it doesn't also
  mention booking/reservation) and the employee answers "I could not find this information" even though
  the document has the answer verbatim. Reproduced in
  `apps/api/src/knowledge/knowledge-grounding.e2e.spec.ts` ("returns the document content for a
  portal-benefits question"). Not fixed in this pass: `TERM_GROUPS`/the heading-matching heuristic is
  shared by ~1300 lines of knowledge tests already tuned against several specific prior regressions
  (see the extensive doc comments in knowledge.search.ts/knowledge.prompt.ts) — a fix needs to distinguish
  "topically wanted" from "incidentally present" words in the query without reopening those, which needs
  dedicated attention, not a one-line patch under time pressure.
- `TravelEmployeeLlmOrchestrator`'s multi-leg Hinglish confirmation flow: after a `bhai multileg hai`
  correction acknowledges a connected Delhi->London->New York journey, a bare Hinglish "ji" (yes) at the
  confirm-plan stage is expected to trigger a search covering *both* legs, but currently returns a generic
  "Got it." acknowledgment instead. Reproduced in `apps/api/src/travel/travel.llm.spec.ts` ("UAT acceptance
  — Scenario B... resolves 'bhai multileg hai' without restarting budget collection"). Not root-caused in
  this pass — needs tracing through the orchestrator's `confirm_plan`-intent handling for multi-leg journey
  state, which is deep, employee-specific conversational logic.
- The full API test suite (`pnpm --filter api test`, `--no-file-parallelism`, one shared Postgres) has
  intermittent cross-file test pollution: `travel.uat-booking-flow.e2e.spec.ts` and
  `workforce-capabilities.e2e.spec.ts` both pass cleanly every time when run alone, but fail
  unpredictably (different assertions each time) when run as part of the full suite, depending on which
  other files ran first — e.g. an approval-policy fixture one file creates appears to leak into another
  file's expected auto-approve behavior. Not root-caused or fixed in this pass; treat a full-suite failure
  in either of these two files as suspect until reproduced in isolation before concluding it's a real
  regression.
- Knowledge document upload only accepts `.pdf`/`.docx`/`.txt`/`.md` (`KNOWLEDGE_MIME_TYPES`) — Excel and
  ZIP are not supported at all (any upload attempt gets `KNOWLEDGE_FILE_TYPE_UNSUPPORTED`), CSV and images
  are not supported for the Knowledge library specifically. The separate `attachments` module (used for
  chat/channel message attachments, not the Knowledge library) does support CSV, images (OCR via
  tesseract.js), PDF, and DOCX/DOC — but still no Excel or ZIP anywhere in the codebase. `jszip` is a
  package.json dependency but is only pulled in transitively by `mammoth` (DOCX files are zip containers
  internally) — there is no user-facing "upload a ZIP" feature despite the dependency existing.
