# Skills Platform Architecture

Sprint 6.1 — Universal Skills Platform. This is the big picture: what a Skill is, how it differs
from four adjacent-sounding concepts already in this codebase, and how the pieces (SDK, registry,
installation, runtime) fit together.

## What a Skill is

A **Skill** is a reusable, versioned, installable platform capability — a piece of deterministic or
AI-backed processing logic (read a document, summarize text, extract entities, translate, validate
a file) that any AI Employee, workflow step, or scheduled job can invoke through one stable runtime
entry point: `SkillsRuntimeService.execute()`
(`apps/api/src/skills-platform/skill-runtime.service.ts:68`).

Skills are:
- **Versioned** — semver, with compatible-upgrade and rollback support (`docs/skills/versioning.md`).
- **Installable per organization** — an org must install a skill (`SkillInstallation`) before any
  employee in that org can use it.
- **Granted per employee** — an installed skill still does nothing for a specific AI Employee until
  someone grants it (`EmployeeSkillGrant`).
- **Billed and audited** — every execution produces a `SkillRun` row with token usage, credits
  consumed, and an audit event.
- **Least-privilege** — a skill never receives raw Prisma access or full tenant context; it receives
  a narrow `SkillCapabilities` handle built from exactly what its manifest requested and the
  installation approved (`apps/api/src/skills-platform/skill-capabilities.ts`).

## Five terms this codebase does not conflate

This is a strict-vocabulary codebase. Skill, Tool, Connector, Workflow and Plugin are five distinct
concepts and the Sprint 6.1 spec is explicit that none of them were replaced or merged.

| Term | What it is | Where it lives |
|---|---|---|
| **Skill** (this platform) | A versioned, installable, billed unit of processing logic with a declared manifest, JSON-schema-validated input/output, and least-privilege capabilities. Reusable across any employee/workflow/scheduled job. | `apps/api/src/skills-platform/` (backend), `packages/skill-sdk/` (contracts) |
| **Tool** | A low-level executable capability an agent's LLM can call mid-turn (e.g. a connector action, a knowledge search, or — as of this sprint — a skill). Tools are registered in the agent's `ToolRegistry`/`ToolExecutor`; a skill is exposed to that same mechanism as one `skill.<key>` tool per built-in adapter (see "Reused, not replaced" below). | `apps/api/src/agents/` |
| **Connector** | An integration with an external system (a third-party API/service), with its own install/authenticate/configure/health lifecycle. Structurally similar to a skill installation (both use install/enable/disable/configure), but a connector's job is talking to something outside the platform; a skill's job is processing data inside a turn. | `apps/api/src/connectors/` |
| **Workflow** | A durable, multi-step business process with its own state machine (`CONTACT_CAPTURE`, `BOOKING_HANDOFF`, `TRIP_SUBMISSION`, `EMPLOYEE_DELEGATION`), each hand-written, reading/writing a free-form `state` JSON blob. There is no generic declarative step-type system — see `docs/skills/runtime.md` and `WorkflowSkillStepService` below. | `apps/api/src/workflows/` |
| **Plugin** (= "AI Employee" installation) | A customer-facing domain worker (Travel, HR, Finance, ...) installed into an organization. An `EmployeeSkillGrant` links a `SkillInstallation` to a `Plugin` row — a plugin is *granted* skills, it does not *contain* them. | `apps/api/src/plugins/` |

**A pre-existing, unrelated "Skill" concept**: `apps/api/src/skills/` (singular "Skill",
`SkillRegistry`/`SkillRuntimeService`) is a Travel-only conversational state machine that drives the
`plan-trip` multi-turn flow. It predates Sprint 6.1 by several sprints, has nothing to do with the
Skills Platform, and is never touched by this sprint. `apps/api/src/agents/agent.service.ts:105-108`
carries an explicit comment warning against conflating the two:

```
// Sprint 6.1 — the Universal Skills Platform. Distinct from the pre-existing, unrelated Travel-only
// conversational state machine imported just above (`SkillRegistry`/`SkillRuntimeService`, singular
// "Skill"): `SkillsRuntimeService`/`SkillRegistryService` (plural "Skills") is the versioned,
// billed, tenant-isolated marketplace runtime any employee can invoke. Do not conflate the two.
```

Naming convention to keep straight while reading code: the legacy travel skill uses **singular**
`Skill*` service names (`SkillRegistry`, `SkillRuntimeService`); the Skills Platform uses **plural**
`Skills*` service names (`SkillsRuntimeService`, `SkillRegistryService`) but singular `Skill*` model
names (`Skill`, `SkillVersion`, `SkillRun`). This isn't beautiful, but it's what's in the tree — don't
"fix" it while doing something else.

The Prisma schema itself states the boundary at `database/prisma/schema.prisma:3362-3364`:

> Reusable, versioned, installable platform capabilities. Distinct from the AI Employee/plugin
> (a customer-facing domain worker), from a Tool (a low-level executable capability) and from a
> Workflow (a durable multi-step process). Skills complement those systems — they never replace them.

## The install → grant → execute flow

```
                    ┌─────────────────────────────────────────────────────┐
                    │  Skill author (built-in only, Sprint 6.1)            │
                    │  writes a SkillAdapter + SkillManifest               │
                    └──────────────────────┬────────────────────────────--┘
                                            │ registered via DI in
                                            │ SkillPlatformModule
                                            ▼
                    ┌───────────────────────────────────────────────────┐
                    │  SkillRegistryService (process-local, in-memory)   │
                    │  keyed by "key@version"                            │
                    └──────────────────────┬────────────────────────────┘
                                            │ SkillPublisherService.sync()
                                            │ (on every app boot)
                                            ▼
                    ┌───────────────────────────────────────────────────┐
                    │  Skill / SkillVersion tables (Postgres)            │
                    │  marketplace metadata, authoritative for install   │
                    └──────────────────────┬────────────────────────────┘
                                            │ admin: POST /skills/install
                                            ▼
                    ┌───────────────────────────────────────────────────┐
                    │  SkillInstallation (org-scoped)                    │
                    │  status, enabled, configurationJson                │
                    └──────────────────────┬────────────────────────────┘
                                            │ admin: POST .../grants
                                            ▼
                    ┌───────────────────────────────────────────────────┐
                    │  EmployeeSkillGrant (org + employee-scoped)        │
                    │  links SkillInstallation → Plugin (AI Employee)    │
                    └──────────────────────┬────────────────────────────┘
                                            │ employee turn / workflow step /
                                            │ scheduled job calls
                                            ▼
                    ┌───────────────────────────────────────────────────┐
                    │  SkillsRuntimeService.execute()                    │
                    │  idempotency → installation → grant → dependency   │
                    │  → least-privilege context → schema validate →     │
                    │  adapter.execute() → schema validate output →      │
                    │  usage/credits → SkillRun → UsageEvent → audit     │
                    └──────────────────────┬────────────────────────────┘
                                            ▼
                    ┌───────────────────────────────────────────────────┐
                    │  Employee turn continues / workflow step result /  │
                    │  scheduled job result                              │
                    └───────────────────────────────────────────────────┘
```

In words: a skill exists in the process registry the moment the app boots (built-in adapters are
constructed by NestJS DI). `SkillPublisherService` then makes that adapter *installable* by upserting
its manifest into `Skill`/`SkillVersion`. An organization administrator installs it
(`SkillInstallationService.install`), which is a per-org decision — installing does not expose the
skill to any employee yet. A second, separate step grants the installation to a specific AI Employee
(`grantToEmployee`) — this is what makes `skillsForEmployee()` return it for tool discovery. Only
once both an enabled installation and an enabled grant exist can `SkillsRuntimeService.execute()`
actually run the adapter; see `docs/skills/runtime.md` and `docs/skills/security.md` for the full
five-layer check sequence.

## What already existed and was reused (not rebuilt)

The Skills Platform is additive plumbing over existing services — no parallel infrastructure was
built where a shared one already existed:

| Existing service | Reused for |
|---|---|
| `ObjectStorageService` (`apps/api/src/storage/`) | The `object.read` capability handle (`skill-capabilities.ts:24-32`) and best-effort attachment byte storage in `attachment.service.ts` |
| `PluginAiService` (`apps/api/src/plugins/plugin-ai.service.ts`) | The `ai.provider.execute` capability handle — resolves the employee's configured AI provider, same as agent conversation turns do |
| `ObservabilityService` / `TraceContext` | `SKILL_EXECUTION` trace spans wrapping every `execute()` call (`skill-runtime.service.ts:94-120`) |
| `AuditEventLogger` | `SKILL_INSTALLED`/`SKILL_EXECUTION_COMPLETED`/etc. audit events |
| `EntitlementService` | Plan-tier gating (`SKILLS_MARKETPLACE`, `SKILLS_INSTALL`, `SKILLS_MAX_INSTALLED`, `SKILLS_MAX_PER_EMPLOYEE`, `SKILLS_AI_BACKED`, `SKILLS_EXTERNAL_NETWORK`, `SKILLS_EXECUTION_MONTHLY_LIMIT`) — see `docs/skills/security.md` |
| `FeatureFlagService` | Gates `attachment.service.ts`'s skill-routing behind `SKILLS_FILE_ROUTING_ENABLED`, org-scoped |
| Knowledge extractors (`KnowledgeExtractorRegistry`, `normalizeKnowledgeText`) | The Document Reader skill's actual parsing logic — it does not reimplement PDF/DOCX/XLSX parsing, it calls the same extractors Knowledge document upload uses |
| `ToolRegistry`/`ToolExecutor` (agent tool-calling) | `AgentService.registerSkillTools()` registers one `skill.<key>` tool per built-in adapter into the *existing* mechanism — not a second tool-call path |
| `tokensToCredits` (`apps/api/src/billing/billing.service.ts`) | Converts a skill run's token usage into billed credits, same formula as agent executions |

What's genuinely new: `SkillRegistryService`, `SkillPublisherService`, `SkillInstallationService`,
`SkillsRuntimeService`, the five built-in skill adapters, the `packages/skill-sdk` package, the
`Skill`/`SkillVersion`/`SkillInstallation`/`EmployeeSkillGrant`/`SkillRun`/`SkillDependency` tables,
and the thin integration hooks in `agent.service.ts`, `workflow-skill-step.service.ts`,
`scheduler-handlers.ts`, and `attachment.service.ts`.

## Integration points are additive hooks, not a second engine

Each of the four integration points is a genuinely additive choke point into an existing engine:

- **Agent tool-calling** (`apps/api/src/agents/agent.service.ts`, `registerSkillTools()`, search
  "Sprint 6.1 — Phase 12"): registers `skill.<key>` tools into the existing `ToolRegistry`. Per-turn
  availability is filtered to only what `SkillsRuntimeService.skillsForEmployee()` says this employee
  is actually granted — and `execute()` independently re-checks installation/grant regardless, so an
  LLM cannot invoke an uninstalled skill merely by naming the tool (defense in depth; see
  `docs/skills/security.md`).
- **Workflows** (`apps/api/src/workflows/workflow-skill-step.service.ts`): the workflow engine has no
  generic declarative step-type system — each `WorkflowType` is its own hand-written service.
  `WorkflowSkillStepService` is a thin, additive choke point any current/future workflow-type service
  can call to run a skill with `workflowExecutionId` attached. It does not merge results into a
  workflow's `state` JSON itself — that stays the calling workflow-type service's job, exactly as
  with every other step result. No existing workflow-type service's internals were modified.
- **Scheduler** (`apps/api/src/scheduler/scheduler-handlers.ts`'s `runSkill`, `RUN_SKILL` job handler
  type, `platform.skill_execution` job definition): scheduled skill execution, org-scoped, uses
  `context.executionId` as the idempotency key so retries replay instead of double-charging.
- **Attachments** (`apps/api/src/attachments/attachment.service.ts`'s `tryRouteThroughSkill()`):
  behind `SKILLS_FILE_ROUTING_ENABLED` (org-scoped feature flag), routes an upload through Document
  Reader instead of the legacy `AttachmentExtractorRegistry` when the uploading employee has a
  granted, MIME-compatible installation. Any failure — flag off, no grant, runtime error — falls back
  to the pre-existing extractor path transparently; see `docs/skills/built-in-skills.md`.

See `docs/skills/runtime.md` for the execute() flow in detail and `docs/skills/security.md` for the
full permission model.
