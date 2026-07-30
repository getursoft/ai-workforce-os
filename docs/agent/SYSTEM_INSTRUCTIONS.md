# System Instructions — AI Workforce OS Repository Continuity

This file is the permanent operating manual for every Claude Code session working in this
repository. It rarely changes. Session-specific state (what was done, what's next) lives in
`LAST_RUN_HANDOFF.md`, not here. Platform architecture lives in `ARCHITECTURE.md`, not here.

## 1. Repository startup protocol

Every new session MUST start like this, in order:

1. Read `docs/agent/SYSTEM_INSTRUCTIONS.md` (this file).
2. Read `docs/agent/LAST_RUN_HANDOFF.md`.
3. Read **only** the files listed under that handoff's `Files to read next`.
4. Continue from that handoff's `Next action`.

Do not read the entire repository. Do not re-run broad exploration (`find`, wide `grep`, reading
whole modules) unless the handoff's next action genuinely requires it or the handoff is missing/stale
(see §2). `ARCHITECTURE.md` exists precisely so a session never has to rediscover module layout,
naming, or design decisions from source — read it instead of re-deriving it.

## 2. Continuation protocol

- Trust `LAST_RUN_HANDOFF.md` as the last known state, but verify cheaply before acting on it:
  `git status --short`, `git log --oneline -5`, and (only if the handoff names specific
  files/symbols you're about to act on) confirm they still exist with a targeted `grep`/`Read`.
  A stale handoff is a reason to reconcile and correct it, not a reason to re-explore everything.
- If the working tree doesn't match the handoff (uncommitted changes it doesn't mention, a
  different branch, files it references that are gone), reconcile this at the start of the
  session and say so, rather than silently proceeding on stale assumptions.
- Never assume a stage is "done" because a handoff or a past report says so if the charter's
  Output Requirements (§13) would call it incomplete — e.g. legacy authority still present. Say
  what is actually true of the current tree.

## 3. Token-saving strategy

- Prefer `ARCHITECTURE.md` + `LAST_RUN_HANDOFF.md` + the specific files named in "files to read
  next" over independent repository exploration.
- Use `grep`/targeted `Read` with line ranges instead of reading full large files when only a
  symbol or section is needed.
- Do not re-run `find`/broad `grep` sweeps that a previous handoff already recorded the answer to.
- When a task is finished or context is getting large, stop opening unrelated files immediately —
  see §14 (End-of-context rule) — and write the handoff instead of continuing to explore.
- Delegate wide, multi-file research to a subagent (Explore / general-purpose) only when the
  question cannot be answered from `ARCHITECTURE.md` plus a small number of targeted reads; don't
  spawn agents to re-derive things this continuity system already recorded.

## 4. Repository discovery rules

When discovery genuinely is required (new area, `ARCHITECTURE.md` silent or stale on the question):

- Module boundaries live under `apps/api/src/<domain>/` — one NestJS module per business domain
  (`agents`, `skills`, `workflows`, `travel`, `connectors`, `knowledge`, `channels`, `identity`,
  `teams`, `service-accounts`, `plugins`, `conversation`, `customer-identity`, `production`).
- The Prisma schema (`database/prisma/schema.prisma`) is the ground truth for all persisted state
  and enums — check it before assuming a field or status value exists.
- `git status --short` reveals whether work described in the handoff is committed, staged, or
  still a local working-tree diff — this repository has historically carried large uncommitted
  stage-by-stage diffs on `main`; never assume "implemented" implies "committed."
- Prefer the project's own real test/build invocations (§9) over inventing new ones.

## 5. Coding standards

- TypeScript strict mode throughout; Prettier for formatting; ESLint for linting
  (`pnpm format:check`, `pnpm lint`, `pnpm typecheck` / `tsc --noEmit`).
- Typed contracts over free-form strings everywhere: decisions, statuses, and routes are always
  named union types or enums, never ad hoc strings inferred from text.
- Small, composable services with constructor dependency injection; `@Optional()` + a
  constructor-default fallback (e.g. `x ?? new X()` or `x ?? null`) is this codebase's established
  pattern for keeping services unit-testable without a full Nest testing module.
- Pure functions for business/decision logic where possible (see `TravelDecisionAdapter`,
  `resolveTravelInput`); adapters translate between typed decisions, they never reimplement the
  underlying classification logic.
- No premature abstraction: three similar lines beats a speculative shared helper. No
  backwards-compatibility shims, `// removed` comments, or renamed-but-unused variables.

## 6. Architecture principles (see ARCHITECTURE.md for full detail)

- LLMs are reasoning engines only — never the source of truth, never a workflow engine.
- Authoritative business state is always typed and persisted (Prisma-backed), never derived from
  conversation history or prompt memory.
- Missing-input representation is always a typed decision object, never inferred ad hoc per call
  site.
- Every multi-turn business process is a persisted workflow: owns its own state/validation,
  survives restarts, is resumable, and is idempotent under retries/duplicates.
- `WorkflowCoordinator` is the **only** workflow-routing authority in the system. Its priority
  order (also enforced in code, see `workflow-coordinator.ts`):
  1. An active `WAITING_FOR_INPUT` workflow always owns the current turn.
  2. A cancellation phrase beats resuming, within that owned turn.
  3. Otherwise the owning workflow's own `resume()` decision applies.
  4. Only when nothing is active/waiting can a new workflow start from this turn's text.
- An execution-provider domain module (e.g. Travel Runtime) must not classify business state, own
  workflow state, collect contact info, manage approvals, or own booking state — those are
  platform/workflow concerns, not domain concerns. See `ARCHITECTURE.md` §"Known architectural
  gaps" for where this repository currently still violates this rule.
- Connectors are tenant/capability-scoped, contain no business logic, and connector-specific code
  never runs inside the agent loop (see `docs/connectors.md`).
- Tools perform actions, never decide; every tool execution is tracked, persisted, idempotent, and
  auditable, and must never be double-executed.
- Knowledge is employee-scoped (Organization → AI Employee → Collection → Document → Chunk →
  Embedding) and never determines business state (see `docs/enterprise-knowledge.md`).
- Memory (`AgentMemory`) is not canonical business state; it is scoped, searchable context, and any
  legacy state mirrored into it for a compatibility reason must be labeled as such.
- Human approval, when built, is itself a workflow — never a prompt/message-based inference.
- Booking is not itinerary, lead capture, or callback scheduling. Never claim a reservation,
  ticket, or payment is complete unless externally confirmed. Booking execution is a future,
  not-yet-built workflow.
- Strict idempotency everywhere a business event, persistence write, or tool execution could
  otherwise happen twice: duplicate messages, retries, restarts, and page refreshes must each
  produce exactly one effect.
- Full tenant (organization) isolation in every query, and RBAC/audit/deterministic-execution/
  typed-contract/optimistic-locking/versioned-state/workflow-persistence/failure-recovery/
  retry-safety guarantees are enterprise requirements that must never be replaced by prompting.

## 7. When implementing a feature — checklist

Before writing code, answer:

1. Is this a Skill (a capability an AI Employee can reason about) or a Workflow (a multi-turn,
   stateful business process)?
2. Does this need to be reusable by a future AI Employee beyond the one requesting it? If so, does
   the implementation actually avoid importing employee-specific modules directly (see
   `ARCHITECTURE.md`'s note that today's workflows still import `travel.runtime.ts` directly — a
   known, disclosed gap, not a pattern to copy)?
3. Does this require a persisted Workflow, or can it be answered synchronously within one turn?
4. Does this require a Connector (external system integration) or a Tool (an in-agent-loop action)?
5. Does this touch Knowledge/RAG? If so, is retrieval properly employee-scoped?
6. Does this touch Memory? If so, is it clearly non-authoritative, or does it need to become a
   typed persisted workflow/entity instead?
7. Does this require Human Approval? If so, model it as a workflow, not a message pattern.

## 8. When writing code

Prefer: typed contracts, dependency injection, small services, pure functions, composition,
immutability, explicit idempotency guards.

Avoid: God classes, large untyped switch statements, duplicated orchestration logic, parsing
intent out of generated prompt/response text, magic strings, hidden/implicit workflow state,
duplicated business rules across modules.

## 9. Testing strategy

- Full-suite / regression verification MUST use `pnpm test` (root) or, from `apps/api`,
  `node --experimental-strip-types ../../scripts/prepare-test-database.ts && vitest run
  --no-file-parallelism`. Running bare `npx vitest run` (default parallelism) against this suite
  produces spurious cross-file failures from shared-database races across unrelated e2e suites
  (Channels, Plugins, Identity, Teams, Service Accounts) — these are not real regressions, but they
  look like some. Always use the project's real invocation for anything you report as a regression
  result.
- Fast iteration on a single file/module: plain `npx vitest run <path>` from `apps/api` is fine.
- `pnpm --filter @ai-workforce-os/api test:e2e` runs the named e2e suites specifically;
  `smoke:travel` and `uat:travel-plan-trip` are narrower Travel-specific checks.
- Before reporting any stage complete: `tsc --noEmit` clean, `eslint` clean, and a full-suite run
  with before/after pass counts, explicitly separating pre-existing known failures (currently: a
  small, stable set of Knowledge/pgvector failures — confirm the current count in
  `LAST_RUN_HANDOFF.md` rather than trusting a remembered number) from anything newly broken.
- New behavior needs new unit tests colocated with the code (`*.spec.ts`); changed end-to-end
  behavior needs the relevant `*.e2e.spec.ts` updated, with an inline comment explaining *why* an
  assertion changed when it does (architecture changed, not just "test fixed").

## 10. Migration strategy

- Prisma is schema-first: edit `database/prisma/schema.prisma`, then hand-write (or generate) a
  migration under `database/prisma/migrations/<timestamp>_<name>/migration.sql`.
- Adding an enum value: a standalone `ALTER TYPE "..." ADD VALUE '...'` migration is safe on its
  own, but the new value cannot be *used* in the same transaction that adds it — that's fine for a
  migration applied ahead of the code that starts using the value (this repository's pattern: add
  the enum value in one migration, wire up the feature that uses it after).
- Apply migrations to both the dev database (`pnpm db:migrate` / `prisma migrate dev`) and the test
  database before running tests that depend on new schema; `scripts/prepare-test-database.ts`
  handles the test database as part of `pnpm test`.
- Never roll back an already-applied forward migration by editing history; add a new migration.

## 11. Reporting requirements

Every implementation response for a feature/stage must include, in this order:

1. **Architecture changes** — what platform concept this adds/changes (Skill, Workflow, Capability
   Execution, Connector, Tool, etc.), not just "files changed."
2. **Files changed** — grouped by concern.
3. **Typed contracts** — any new/changed types, enums, interfaces.
4. **Execution flow** — how a turn/request actually moves through the change, in order.
5. **Backward compatibility** — what still works unchanged, what is now dead/unreachable, what
   remains a compatibility shim.
6. **Test coverage** — what was added and why it's sufficient.
7. **Full-suite results** — actual pass/fail counts from the correct invocation (§9), with any
   pre-existing failures explicitly named and distinguished from new ones.
8. **Remaining risks** — named, not hand-waved.
9. **Recommended next stage** — a concrete suggestion, not an open-ended "let me know what's next."

**Critical rule: never claim architecture is complete if legacy authority still exists.** Always
explicitly distinguish, for anything touched:

- **Platform authority** — genuinely generic, persisted, reusable by any future AI Employee.
- **Compatibility layer** — intentionally bridges platform and a still-domain-specific reality
  (name what makes it non-generic and why it's temporary).
- **Legacy behaviour** — old code that still exists, whether or not it's currently reachable, and
  why it wasn't removed if it wasn't.

## 12. Handoff requirements

At the end of every session (or when §14's end-of-context rule triggers), update **only**
`LAST_RUN_HANDOFF.md` using its standard template. Do not edit `ARCHITECTURE.md` for
session-specific state, and do not edit this file for anything except a genuine, durable change to
how sessions should operate (rare).

## 13. Bug-fixing philosophy

Never patch a symptom. Find the architectural cause: is a layer doing another layer's job (e.g.
Travel Runtime classifying business state instead of Skill Runtime/Workflow Runtime)? Is a rule
duplicated instead of shared? Introduce a reusable abstraction if the same shape of bug could recur
elsewhere; avoid one-off special cases that only fix the reported instance.

## 14. End-of-context rule

When context is getting large or the remaining token budget is low:

- Stop opening unrelated files immediately.
- Finish only the current atomic task (don't start a new one).
- Update `LAST_RUN_HANDOFF.md` with: completed work, incomplete work, test results, files changed,
  next action, and files to read next.
- Do not attempt to "wrap up" by summarizing in chat instead of writing the handoff file — the
  handoff file is what the next session actually reads.

## 15. Coding philosophy

Choose architecture over convenience. A correct, typed, persisted, idempotent implementation that
takes longer beats a fast one that silently reintroduces prompt-based state, hidden coupling, or
duplicated business rules.

## Session Completion Rule (Mandatory)

A coding session is considered FAILED if:

- LAST_RUN_HANDOFF.md was not updated.
- NEXT ACTION was not recorded.
- FILES TO READ NEXT was not updated.
- Tests were executed but not recorded.
- Architecture changed but ARCHITECTURE.md was not updated.

Never end a coding session without updating the repository continuity documents.
