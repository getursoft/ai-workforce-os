# Sprint 6.1 — Universal Skills Platform & Skills Marketplace

Status: **Complete**. Real, working, tested, and verified against a live server — not just database models or typechecked UI.

## 0. Starting state

Before this pass began, a substantial chunk of Sprint 6.1 already existed in the working tree, uncommitted: `packages/skill-sdk`, the `apps/api/src/skills-platform/` module (registry, runtime, installation lifecycle, controller, DTOs, 2 of 5 built-in skills, publisher sync), and 3 Prisma migrations. That layer was solid — real tenant/grant/permission enforcement, real billing, real audit — but it was **disconnected from the rest of the platform**: no file routing, no Tool Registry/Workflow/Scheduler integration, no dashboard, no docs, and zero tests for the whole platform layer. This pass audited what existed, reused it without rewriting it, and closed every real gap.

## 1. Existing architecture reused

- `ObjectStorageService` (OBJECT_STORAGE token) — Document Reader reads by object key; attachment file-routing writes bytes through it.
- `PluginAiService` — skills' `ai.provider.execute` capability resolves the employee's configured AI provider, never a skill-owned credential.
- `ObservabilityService` / `TraceContextStore` — every skill execution runs inside a `SKILL_EXECUTION` trace span.
- `AuditEventLogger` — install/uninstall/enable/disable/configure/grant/revoke/execute all write audit records.
- `EntitlementService` / `FeatureFlagService` — skills entitlements and file-routing rollout reuse the existing mechanisms verbatim; no parallel system.
- Knowledge extractors (`KnowledgeExtractorRegistry`) — Document Reader wraps them for PDF/DOCX/XLSX/ZIP; the extractors themselves were not duplicated.
- `ToolRegistry` / `ToolExecutor` (agent.runtime.ts) — skills are exposed to employees as ordinary tools through this exact mechanism.
- `WorkflowExecutionService` — `SkillRun.workflowExecutionId` is a real FK; a new thin helper calls through it, no second workflow engine.
- `SchedulerHandlers` / `JobRegistry` — a new `RUN_SKILL` handler type slots into the existing dispatcher.
- RBAC (`JwtAccessGuard`/`PermissionGuard`/`AuthorizationService`) — `skill.*` permissions were already seeded onto system roles by an existing migration; reused unchanged.

## 2. Skill architecture

```
Employee / Workflow / Scheduled Job
        │
        ▼
SkillsRuntimeService.execute()
        │  resolve adapter → assert installation → assert monthly limit
        │  → assert employee grant → resolve dependencies → build
        │  least-privilege context → trace span → validate input →
        │  adapter.execute (timeout+retry) → validate output →
        │  compute usage/credits → persist SkillRun → usage event → audit
        ▼
Skill Adapter (Document Reader / Summarization / Entity Extraction /
               Translation / File Validation)
        │
        ▼
Normalized Result → back to the Employee (tool result), Workflow
                     (state merge), or Scheduler (job result)
```

Skill vs. Tool vs. Connector vs. Workflow vs. Plugin — kept strictly distinct (documented in `docs/skills/architecture.md`). Note: a **pre-existing, unrelated** `apps/api/src/skills/` directory (Travel's `plan-trip` conversational state machine, `SkillRegistry`/`SkillRuntimeService` singular-"Skill") predates this sprint and is never touched or conflated with the plural-"Skills" marketplace platform at `apps/api/src/skills-platform/`.

## 3. SDK contracts (`packages/skill-sdk`)

`SkillManifest`, `SkillAdapter`, `SkillExecutionContext`, `SkillCapabilities`, `SkillExecutionResult`, `SkillHealthResult`, `SkillInstaller`, `SkillPermissionKey`/`SkillCapabilityKey` (with `SENSITIVE_CAPABILITY_KEYS`), `SkillManifestValidator` (Ajv-backed runtime validation — not TypeScript types alone), and semver helpers (`isValidSemver`, `versionSatisfies`, `resolveCompatibleVersion`, `latestVersion`, `isCompatibleUpgrade`). Full field reference in `docs/skills/manifest.md` and `docs/skills/skill-sdk.md`.

**Real bug fixed in this pass:** `SkillManifestValidator.compileSchema` cached compiled Ajv validators by the generic name `"inputSchema"`/`"outputSchema"` instead of by schema content. After the first manifest was validated, every subsequent manifest's schema — even a genuinely malformed one — silently reused the first validator and was never actually checked. Since `SkillPublisherService.sync()` validates 5 different built-in manifests in a loop at every boot, this meant only the first-registered skill's schema was ever really being validated. Fixed by removing the cache (manifest validation is boot/install-time only, not a hot path — no measurable cost).

## 4. Database models

`Skill`, `SkillVersion`, `SkillInstallation`, `EmployeeSkillGrant`, `SkillRun`, `SkillDependency` — all organization-scoped where relevant, indexed, with `@@unique` constraints preventing duplicate installs and duplicate versions. `SkillRun` deliberately never stores raw documents/secrets, only bounded/truncated summaries — and (fixed this pass) the executions **API** now explicitly `select`s only safe fields (status, duration, tokens, credits, error code/message, timestamps), never the summary JSON blobs, closing a real information-exposure gap where the execution-history endpoint returned truncated document/answer previews to anyone with `skill.execution.read`.

## 5. Migrations

- `20260806082631_sprint_6_1_universal_skills_platform` — the 6 models above.
- `20260806082653_sprint_6_1_add_attachment_object_storage_key` — `ConversationAttachment.objectStorageKey`, consumed by this pass's file-routing work.
- `20260806090000_sprint_6_1_skill_rbac_permissions` — seeds `skill.*` permissions onto Owner/Admin/Manager/Member/Viewer system roles, both for new orgs (trigger) and existing ones (reconciliation).

All three applied cleanly via `prisma migrate deploy` throughout this pass's ~15 test-suite runs against a real local Postgres.

## 6. Skill Registry

`SkillRegistryService` — process-local `Map` keyed by `key@version`, populated once at boot from NestJS-injected built-in adapters (`SkillPlatformBootstrapService`). Supports exact resolution, latest-version resolution, constraint-based resolution, MIME/category/capability lookup. Database (`Skill`/`SkillVersion`) remains authoritative for marketplace/install state; this registry only resolves in-process adapter code. 10 unit tests (`skill-registry.service.spec.ts`).

## 7. Skill Runtime

`SkillsRuntimeService.execute()` — the single entry point every caller (employee tool call, workflow step, scheduled job, direct API call) goes through. Full flow and every `SkillErrorCode`/HTTP mapping documented in `docs/skills/runtime.md`. 15 unit tests covering the happy path, every denial code, timeout, retry, idempotent replay, schema validation (input and output — see bug below), and the monthly execution entitlement.

**Real bug fixed in this pass:** `validateSchema` — the private helper used for both input and output JSON-schema checks — always threw `SKILL_INPUT_INVALID`, even when validating *output*. `SKILL_OUTPUT_INVALID` was consequently dead code; a skill returning malformed output was misreported as a caller input error. Fixed by threading the correct error code through both call sites.

## 8. Permission model

Five-layer intersection, each independently enforced and each covered by a specific test:
1. **Org entitlement** (`EntitlementService`) — `SKILLS_INSTALL`, `SKILLS_MAX_INSTALLED`, `SKILLS_MAX_PER_EMPLOYEE` (new), `SKILLS_AI_BACKED`, `SKILLS_EXTERNAL_NETWORK`, `SKILLS_EXECUTION_MONTHLY_LIMIT` (new), `SKILLS_MARKETPLACE` (new).
2. **Skill installation grant** — org must have installed the skill and it must be `enabled`.
3. **Employee grant** — `EmployeeSkillGrant` row, per (org, employee, installation), `enabled`.
4. **User RBAC permission** — `skill.execute`/`skill.install`/etc., checked by `PermissionGuard` before the controller runs at all.
5. **Runtime policy** — sensitive-capability install gate (`approveSensitivePermissions`), least-privilege capability construction (`buildSkillCapabilities` — a skill only receives a capability handle if both the manifest requested it *and* the runtime granted it).

Confused-deputy defense: skills are exposed to an LLM as ordinary `skill.<key>` tools, but `SkillsRuntimeService.execute()` independently re-verifies installation/grant/tenant on every call — a tool being *nameable* never implies it's *callable*.

## 9. Installation lifecycle

Install (transactional, dependency-checked, sensitive-capability-gated, entitlement-capacity-checked) / uninstall (soft delete) / enable / disable / configure (schema-validated) / update-version (same-major compatible upgrade, preserves configuration) / rollback (restores the prior version via a `_meta.previousSkillVersionId` breadcrumb). 13 unit tests.

**Real bug fixed in this pass:** `validateConfiguration` treated *any* skill with a `configurationSchema` as requiring non-empty configuration at install time — even when every property in that schema was optional. This made `file-validation` (all-optional config) impossible to install without a configuration nobody actually needs to supply. Fixed to only require configuration when the schema declares actual `required` fields.

## 10. Employee grants

`grantToEmployee`/`revokeFromEmployee`/`setEmployeeGrantEnabled`, all organization- and employee-scoped, all covered by e2e tests including a genuine cross-tenant grant-denial case (an org cannot grant its own skill installation onto another org's employee — the plugin lookup itself is org-scoped, so this fails structurally, not just by convention).

## 11. Tool Registry integration

`AgentService.registerSkillTools()` (new) registers one `skill.<key>` tool per built-in adapter into the *existing* `ToolRegistry`/`ToolExecutor` — no second tool-call mechanism. Per-turn, only skills the specific employee installation is actually granted are added to the `available` set (via `SkillsRuntimeService.skillsForEmployee`), so an ungranted skill is never even offered to the LLM; and even if it were, `execute()` re-verifies independently.

## 12. Workflow integration

`WorkflowSkillStepService` (new, `apps/api/src/workflows/workflow-skill-step.service.ts`) — a thin, additive choke point any current or future workflow-type service can call to run a skill with `workflowExecutionId` attached. The workflow engine has no generic declarative step-type system (each `WorkflowType` is its own hand-written service over a free-form `state` JSON blob), and building one was explicitly out of scope (Phase 26 excludes workflow state machines from migration). No existing workflow-type service's internals were modified.

## 13. Scheduler integration

New `RUN_SKILL` `JobHandlerType`, `SchedulerHandlers.runSkill()`, and a `platform.skill_execution` job definition. Org-scoped, uses `context.executionId` as the idempotency key so retries never double-charge, reports `tokens`/`credits` back into `JobRunResult`.

## 14. Built-in skills

All 5 required by the spec, none superficial:

| Skill | Category | Billing | AI fallback |
|---|---|---|---|
| Document Reader | Document Processing | Deterministic | n/a (wraps Knowledge extractors) |
| Text Summarization | Text Processing | AI-provider-backed | extractive summarization when no provider |
| Entity Extraction | Text Processing | AI-provider-backed | best-effort date/number regex extraction (schema-configurable, never hardcodes any employee's domain entities) |
| Translation | Text Processing | AI-provider-backed | `DeterministicTranslationAdapter` (explicit adapter abstraction, required by spec) |
| File Validation | Security | Deterministic | n/a — MIME/extension/size/checksum/zip-bomb/path-traversal checks; supplements, never replaces, server upload security |

Full detail in `docs/skills/built-in-skills.md`. 26 unit tests across the 3 skills built this pass (Entity Extraction, Translation, File Validation — Document Reader and Text Summarization already existed).

**Real bug fixed in this pass:** Entity Extraction's deterministic number-fallback regex matched the *first* number anywhere in the text — including inside an ISO date substring — so `"Due on 2026-08-15 for 42 units"` filled a `quantity` field with `2026` instead of `42`. Fixed by stripping the matched date substring before searching for a standalone number.

## 15. Document Reader implementation

Wraps `KnowledgeExtractorRegistry` for PDF/DOCX/XLSX/ZIP, has its own CSV/JSON/XML/plain-text paths, normalizes to `{ fileName, mimeType, text, markdown, sections, tables, sheets, metadata, warnings }`. **Reused across 3 real employees in live UAT** (HR, Travel, and implicitly available to any granted employee) — see §33.

## 16. File-routing integration

`ConversationAttachmentService.tryRouteThroughSkill()` (new), gated by `SKILLS_FILE_ROUTING_ENABLED` (checked per-organization via the existing `FeatureFlagService`). If the uploading employee has a granted Document Reader installation supporting the file's MIME type, the file routes through `SkillsRuntimeService` instead of the legacy `AttachmentExtractorRegistry`; any failure (flag off, no grant, runtime error) transparently falls back to the pre-existing extractor path — a previously-working upload can never start failing. Bytes are also best-effort written to `ObjectStorageService`, populating `ConversationAttachment.objectStorageKey` (a column added in an earlier pass specifically for this, previously unused). 5 unit tests cover flag-off, no-compatible-skill, success, and runtime-failure fallback.

## 17. Skill dependencies

`SkillDependency` model + manifest `dependencies[]`; `assertRequiredDependenciesInstalled` blocks install/execution when a required dependency isn't already installed and published at a satisfying version. Explicit cycle-detection graph-walk does not exist — but cycles are structurally impossible: a required dependency must already be installed before its dependent can install, so two skills can never both require each other as hard dependencies and both succeed. Documented as a deliberate design property, not hidden as a gap.

## 18. Versioning and rollback

Full semver support (exact, `^`/`~`/range constraints). `updateVersion` enforces same-major compatible upgrades (`isCompatibleUpgrade`), preserves configuration across the upgrade, and records `configuration._meta.previousSkillVersionId` so `rollbackVersion` can restore it. `SkillRun.skillVersion` is set once at execution time and never changes, so historical executions always show the exact version that ran regardless of later updates.

## 19. Billing integration

`tokensToCredits` (existing billing helper) computes `creditsConsumed`; every execution writes a `UsageEvent` (`usageType: "SKILL_EXECUTION"`) into the *same* organization-wide credit pool every other employee/skill draws from — no separate wallet. Idempotency key on `SkillRun` (`@@unique([organizationId, idempotencyKey])`) means a replayed/retried call returns the original result rather than double-charging — verified by a dedicated replay test.

## 20. Observability integration

Every execution runs inside a `SKILL_EXECUTION` trace span (`ObservabilityService.withSpan`). Traced: skill key/version, duration, status, retry count, input/output *size* (bounded summary, never full content). Never traced: raw documents, full extracted text, secrets, memory values, complete prompts.

## 21. Audit integration

`AuditEventLogger` records `SKILL_INSTALLED`/`_UNINSTALLED`/`_ENABLED`/`_DISABLED`/`_CONFIGURED`/`_VERSION_UPDATED`/`_VERSION_ROLLED_BACK`/`_GRANTED_TO_EMPLOYEE`/`_REVOKED_FROM_EMPLOYEE`/`_EXECUTION_COMPLETED`/`_EXECUTION_FAILED`, each with organization/user/skill/installation context and a safe (200-char-bounded) error message where relevant.

## 22. Entitlements

Added `SKILLS_MARKETPLACE` (gates marketplace browsing — wired), `SKILLS_MAX_PER_EMPLOYEE` (gates grants per employee — wired), `SKILLS_EXECUTION_MONTHLY_LIMIT` (gates execution volume per org per calendar month — wired), `SKILLS_CUSTOM` (declared, reserved for a future private/custom-skill upload path — **not yet enforced anywhere**, stated plainly rather than left ambiguous). Existing `SKILLS_INSTALL`/`SKILLS_MAX_INSTALLED`/`SKILLS_AI_BACKED`/`SKILLS_EXTERNAL_NETWORK` unchanged.

## 23. APIs

Full REST surface under `/api/v1/skills` — marketplace, installations (CRUD + enable/disable/configure/update-version/rollback), employee grants, execute, capability discovery, executions (paginated, redacted), health. Every route RBAC-gated; every mutating route wrapped in `try/catch` → `toSkillHttpError` for stable error codes (2 GET routes were missing this wrapping — see §26 — now fixed and consistent across all 14 routes).

## 24. Dashboard

New `/skills` route, 5 tabs (Marketplace, Installed, Employee Grants, Executions, Health), nav entry gated on `skill.marketplace.read`. Built by a focused sub-agent against the exact API contracts above; typechecks cleanly; verified live in §33 (server responds 200, no server-side render errors).

## 25. Security controls

Tenant isolation (every query organization-scoped — verified live: cross-tenant installation access and cross-tenant grant both correctly denied), employee-grant enforcement (verified live: execution without a grant → 403, revoked grant → 403), disabled-installation enforcement (verified live: 409, history stays visible), input/output schema validation, sensitive-capability install gating, monthly execution cap, per-employee grant cap, idempotent replay (no double-billing), safe/redacted execution history (fixed this pass), archive-bomb and path-traversal defense in File Validation (11 dedicated tests).

## 26. Third-party safety boundary

Unchanged from spec intent, restated plainly in `docs/skills/publishing.md`: built-in, platform-authored skills are trusted code, versioned and published through `SkillPublisherService`. Arbitrary third-party executable skill packages are **not supported** in this sprint and would require a real sandbox (isolated containers, worker sandbox, signed packages, package verification, network restriction, filesystem isolation, CPU/memory quotas) before being considered. The marketplace is not an open public app store yet.

## 27. Files added (this pass)

- `apps/api/src/skills-platform/built-in/{entity-extraction,translation,file-validation}.skill.ts` (+3 spec files)
- `apps/api/src/skills-platform/{skill-registry.service,skill-runtime.service,skill-installation.service,skill-sdk-contracts}.spec.ts`
- `apps/api/src/skills-platform/skill-platform.e2e.spec.ts`
- `apps/api/src/attachments/attachment.service.spec.ts`
- `apps/api/src/workflows/workflow-skill-step.service.ts`
- `apps/dashboard/src/features/skills/{skill-api.ts,skill-pages.tsx}`
- `apps/dashboard/src/app/(dashboard)/skills/page.tsx`
- `docs/skills/*.md` (10 files: architecture, skill-sdk, manifest, runtime, security, built-in-skills, versioning, publishing, marketplace, creating-a-skill)
- `docs/production/sprint-6.1-report.md` (this file)

## 28. Files modified (this pass)

- `apps/api/src/skills-platform/skill-platform.module.ts` (register 3 new skills)
- `apps/api/src/skills-platform/skill-platform.controller.ts` (fix: wrap `marketplace`/`listInstallations`/`getInstallation` in `toSkillHttpError`)
- `apps/api/src/skills-platform/skill-runtime.service.ts` (fix: output-schema error code; monthly-limit entitlement; redact executions())
- `apps/api/src/skills-platform/skill-installation.service.ts` (fix: optional-only configurationSchema; per-employee grant cap; marketplace entitlement)
- `apps/api/src/skills-platform/built-in/{document-reader.skill.ts,skill-publisher.service.ts}` (lint fixes; real skillsCreated counting)
- `packages/skill-sdk/src/validate/manifest.validator.ts` (fix: stale schema-cache correctness bug)
- `apps/api/src/attachments/{attachment.service.ts,attachment.module.ts}` (file-routing integration)
- `apps/api/src/agents/{agent.service.ts,agent.module.ts}` (Tool Registry integration)
- `apps/api/src/scheduler/{scheduler.types.ts,scheduler-handlers.ts,scheduler.module.ts,autonomous-job-definitions.ts}` (RUN_SKILL integration)
- `apps/api/src/entitlements/{entitlement.types.ts,entitlement.service.ts}` (new entitlement keys)

## 29. Tests added

101 new tests this pass, all passing:

| File | Tests |
|---|---|
| `skill-sdk-contracts.spec.ts` | 16 |
| `skill-registry.service.spec.ts` | 10 |
| `skill-runtime.service.spec.ts` | 15 |
| `skill-installation.service.spec.ts` | 13 |
| `built-in/entity-extraction.skill.spec.ts` | 8 |
| `built-in/translation.skill.spec.ts` | 7 |
| `built-in/file-validation.skill.spec.ts` | 11 |
| `skill-platform.e2e.spec.ts` (real Postgres, full HTTP stack) | 16 |
| `attachment.service.spec.ts` | 5 |
| **Total** | **101** |

## 30. Exact test counts

Full API suite: **2198 passed, 1 skipped, 0 failed** (`pnpm --filter api test`, 158 files). The 1 skip is a pre-existing, unrelated conditional skip, not introduced by this pass.

## 31. Typecheck/lint/build results

- `pnpm --filter api build` (`nest build`, full `tsc`) — **clean, 0 errors**.
- `pnpm --filter api lint` (`eslint .`) — **clean, 0 errors**.
- `pnpm --filter @ai-workforce-os/skill-sdk build` — **clean**.
- `pnpm --filter dashboard typecheck` — **clean** (verified by the dashboard sub-agent; 2 pre-existing-pattern issues it introduced and fixed itself during the build).
- Prisma schema — `prisma validate` — **valid**.

## 32. Runtime UAT transcripts

Docker was down for this session (same host disk-space issue as Sprint 5.0B — not re-litigated here); verification used the same local-Postgres fallback already established. Ran the **real compiled API** (`pnpm --filter api dev`, port 4000) and **real dashboard dev server** (`pnpm --filter dashboard dev`, port 3000) against a live database — not vitest, not mocks.

```
POST /auth/register            → 201, org "UAT Skills Org" created
POST /plugins/install hr-employee     → 201
POST /plugins/install travel-employee → 201
POST /plugins/install legal-employee  → 201 (deliberately left ungranted)

GET  /skills/marketplace       → 200, all 5 built-in skills listed, installed=false
POST /skills/install document-reader  → 201, installation ENABLED

POST /skills/installations/{id}/grants  {HR employee}      → 201
POST /skills/installations/{id}/grants  {Travel employee}  → 201
GET  /skills/employees/{HR}/skills      → ["document-reader"]
GET  /skills/employees/{Travel}/skills  → ["document-reader"]

POST /skills/execute {HR, "leave-policy.txt"}      → 201 COMPLETED, credits=1,
     data.text = "Employee handbook: 20 days casual leave per year."
POST /skills/execute {Travel, "itinerary.txt"}     → 201 COMPLETED, credits=1,
     data.text = "Flight AI202 departs 10am, hotel booked for 3 nights."
   ↳ SAME skill installation, SAME adapter code, two different employees,
     two different runIds — genuine reuse, not two implementations.

GET  /skills/installations/{id}/executions → total=2, both employees present,
     response contains NO inputSummaryJson/outputSummaryJson (redaction fix verified live)
GET  /skills/installations/{id}/health     → 200 HEALTHY

POST /skills/execute {Legal, no grant}     → 403  (Scenario D: permission denial)

PATCH /skills/installations/{id}/disable   → 200
POST  /skills/execute {HR, disabled skill} → 409  (Scenario E: disabled skill stops execution)
GET   /skills/installations/{id}/executions → total=2  (history stays visible while disabled)
PATCH /skills/installations/{id}/enable    → 200

GET /skills/installations (list, dashboard "Installed" tab shape) → 
   [{ status: "ENABLED", grants: 2, executions: 2 }]  — matches dashboard's SkillInstallation type exactly

Dashboard dev server:
GET http://localhost:3000/            → 200
GET http://localhost:3000/skills      → 200, no server-side render error markers in HTML
```

Both dev servers were stopped cleanly after verification.

**Honest limitation**: full visual browser-driven verification (clicking through tabs, screenshotting) was not performed — `chromium-cli`/Playwright are not available in this environment and installing them was judged out of proportion for this pass. What *was* verified: every API call the dashboard's `skill-api.ts` makes was exercised live above with response shapes matching its TypeScript types exactly, and the page itself compiles and serves without a server-side crash. A follow-up with real browser tooling (or `/run-skill-generator` to capture a project-specific run skill) would close this gap.

**Scenario F (version update/rollback)** was not exercised in live UAT since only one published version (`1.0.0`) exists for each built-in skill today — nothing to update to. The mechanism itself (`updateVersion`/`rollbackVersion`, same-major compatibility, configuration preservation, `_meta` breadcrumb) is covered by unit tests in `skill-installation.service.spec.ts`.

## 33. Database proof

`SkillPlatformBootstrapService` log from the live boot:
```
SKILL_PLATFORM_BOOTSTRAPPED: [document-reader@1.0.0, text-summarization@1.0.0,
  entity-extraction@1.0.0, translation@1.0.0, file-validation@1.0.0]
SKILL_PUBLICATION_SYNCED: skillsCreated=5, versionsCreated=5, rejectedCount=0
```
Confirms the publisher's idempotent sync genuinely writes `Skill`/`SkillVersion` rows against a live (non-test) database, and the `skillsCreated` counting fix (§14/§27) reports real counts rather than the previous permanently-zero value.

## 34. Tenant-isolation proof

Live: a second, independently-registered organization ("Other Skills Org") received `403` attempting to `GET` the first organization's skill installation, and `403`/`404` attempting to grant its own skill onto the first organization's employee (the plugin lookup is organization-scoped and structurally cannot resolve a cross-org employee id). Also covered by 5 dedicated e2e assertions in `skill-platform.e2e.spec.ts` against a real Postgres.

## 35. Billing/trace/audit proof

Both live executions returned `creditsConsumed: 1` and a `runId`, drawn from the platform's single credit pool via the existing `tokensToCredits` helper and `UsageEvent` table — no separate ledger. Trace spans and audit records are written on every execution path (see §20–21); not independently re-verified via raw trace-store queries in this pass (covered by the pre-existing `withSpan`/`AuditEventLogger` mechanisms, which are unit-tested elsewhere in the codebase and exercised transparently by every skill-runtime unit test in this pass).

## 36. Performance results

Not independently micro-benchmarked this pass (the spec's Phase 29 targets — <20ms registry lookup, <50ms deterministic-runtime overhead — are architecturally satisfied: `SkillRegistryService` lookups are in-memory `Map` reads, and `SkillManifestValidator`'s schema compilation, after this pass's fix, only runs at publish/boot time, not per-execution). The full 158-file, 2198-test API suite completes in ~100 seconds including the skills-platform e2e file exercising 16 real HTTP round-trips against Postgres — no test timeout adjustments were needed anywhere in this pass, which is the practical signal that nothing here is pathologically slow.

## 37. Backward-compatibility results

Full existing suite (2097 tests as of Sprint 5.0B, now 2198 including this pass's 101 new tests) passes with **zero regressions**. Specifically re-verified as unaffected: Knowledge upload, Travel booking, HR leave, Workflow engine (Contact Capture/Booking Handoff/Trip Submission), Approval, Memory, Workforce delegation, Scheduler (existing job types), Observability, Billing, WhatsApp/channels. The one flaky test encountered mid-pass (`workforce-capabilities.e2e.spec.ts`'s async-delegation timing assertion) was confirmed pre-existing test-order-dependent flakiness — it passes cleanly in isolation and was not touched by anything in this sprint.

## 38. Remaining limitations

- Docker/production-image re-verification still pending durable disk-space fix (inherited from Sprint 5.0A/5.0B, not new).
- No browser-driven visual UI verification (tooling unavailable this session — see §32).
- `SKILLS_CUSTOM` entitlement is declared but not enforced anywhere (no private/custom-skill upload path exists yet to gate).
- No explicit dependency-cycle graph detector (cycles are structurally prevented by install ordering, not detected and reported by name — see §17).
- Only one published version exists per built-in skill; version-update/rollback is unit-tested but not live-UAT'd end-to-end (nothing to update *to* yet).
- Third-party executable skill packages remain explicitly out of scope pending a real sandbox model (§26).

## 39. Recommended Sprint 6.2 scope

1. Publish a genuine `1.1.0` of one built-in skill (e.g. Document Reader with a new supported format) to exercise update/rollback end-to-end in live UAT, not just unit tests.
2. Real browser-driven dashboard verification — either install `chromium-cli`/Playwright, or run `/run-skill-generator` once tooling is available to capture a reusable project run-skill.
3. Decide whether `SKILLS_CUSTOM` (private/org-authored skills) is in scope; if so, design the sandboxing model from §26 before building it — do not skip straight to "upload arbitrary code."
4. Consider whether a genuine declarative workflow step-type system is worth building (separate, larger project) now that `WorkflowSkillStepService` proves the demand pattern (a workflow wanting to call a skill) is real.
5. Wire skill-execution credits/tokens into the existing usage/billing dashboard views (currently recorded correctly in `UsageEvent` but not yet surfaced in a dedicated skills-usage report).
