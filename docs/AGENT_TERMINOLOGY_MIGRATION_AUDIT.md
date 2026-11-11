# Agent Terminology Migration — Repository Audit (Sprint 1)

Status: **audit only — no code has been modified.** Awaiting approval before Sprint 2.
Scope: rename the product term "AI Employee" → "AI Agent" for AI-powered digital workers; keep "Employee" wherever it means a human.

## 1. Headline numbers

Measured with `git grep -i employee` over tracked files, excluding `pnpm-lock.yaml`, `backups/`, `dependency-check-report/`, binary/office files, JSON reports, and generated output.

| Metric | Value |
|---|---|
| Tracked files containing "employee" (raw) | 903 |
| …of which are generated/tracked build output (see §2) | ~370 |
| **Real source/doc/config files** | **530** |
| **Matching lines** | **~5,950** |

| Area | Files | Notes |
|---|---|---|
| `apps/api/src` | 284 (108 are `*.spec.ts`) | controllers, services, DTOs, runtime, workforce, billing, knowledge, skills, voice, workflows |
| `apps/dashboard/src` | 149 | `features/` 54, `app/` 51, `marketing/` 40, `components/` 4 |
| `apps/dashboard/tests` (Playwright UAT) | 5 | 3 are named `*-ai-employee-chat*` |
| `apps/ios` (Swift source + tests + xcodeproj) | 24 | `Krevia/Views` 9, `KreviaCore/Sources` 11, `Tests` 4 |
| `database/` | 23 | `schema.prisma`, `seed.ts`, 21 migrations |
| `plugins/` | 10 | 9 `*-employee` plugin packages (each: `plugin.json`, `package.json`, `src/index.ts`, `tsconfig.json`) |
| `packages/` | 3 | `plugin-sdk`, `skill-sdk` |
| `docs/` + `README.md` | 31 | `docs/production/*` and `docs/agent/*` are the heaviest |

### 1.1 Findings that affect planning

1. **Build artifacts are tracked in git.** ~3,577 files under `apps/ios/build`, `apps/ios/KreviaCore/build`, `apps/ios/KreviaCore/.build` and ~278 Playwright report/test-result files are committed (the current `git status` already shows many deleted). They contain ~350 "employee" hits that are compiled copies of source. **They must be excluded from the migration** (and should be removed from tracking and `.gitignore`d as a separate cleanup — not part of this task).
2. **"Agent" is already an overloaded term in the codebase.** `apps/api/src/agents/` (`AgentController`, `AgentService`), models `AgentExecution`, `AgentToolExecution`, `AgentMemory`, enum `AgentMemoryScope`, permissions `agents.read|run|…`, and routes `GET /agents`, `POST /agents/run`. In these, "agent" **already means the AI worker/runtime** — e.g. `GET /agents` is served by a method literally named `employees()`, and the `agents.read` permission is described as "View installed AI employees". So the platform is already half-migrated; the work is mostly making the *rest* match, not inventing a new concept.
3. **Mixed ids in the data model.** A plugin *installation* is the AI worker. It appears as `pluginInstallationId`, `agentId` (e.g. CRM lead `agentId`), `employeeId` (memory, jobs, knowledge), and `employeeInstallationId` (tracing). Same entity, four names.
4. **Plugin identifiers are persisted data.** The slugs `travel-employee`, `hr-employee`, `sales-employee`, `finance-employee`, `legal-employee`, `marketing-employee`, `it-support-employee`, `customer-support-employee`, `receptionist-employee` live in the `plugins` table (`slug`), in `EmployeeRoutingProfile.employeeKey`, in `ChannelConfiguration.allowedEmployeeIds` JSON, are hard-coded ~280 times in `apps/api/src`, and one migration (`sprint_4_3_employee_knowledge_pgvector`) even has `p.slug = 'travel-employee'` in a backfill. They are also dashboard URL paths (`/travel-employee`, `/hr-employee`, …).
5. **Permission keys do not contain "employee"** (`travel.config.read`, `agents.run`, `skill.grant.manage`, …) — only their **human-readable descriptions** do (≈55 strings in `seed.ts`). RBAC keys therefore need **no** change; only seed descriptions. Good news for the "don't break RBAC" requirement.
6. **Genuine human-employee usage exists and must be preserved** (§4).

## 2. Existing naming conventions (as found)

| Layer | Convention today | Examples |
|---|---|---|
| Prisma models | `<Domain>EmployeeConfiguration`, `Employee*` | `TravelEmployeeConfiguration`, `EmployeeRoutingProfile`, `EmployeeAiProfileAssignment`, `EmployeeDelegatedTask`, `EmployeeDelegationJoin`, `EmployeeSkillGrant` |
| DB tables | snake_case via `@@map` | `travel_employee_configurations`, `employee_routing_profiles`, `employee_delegated_tasks`, `employee_skill_grants`, `employee_ai_profile_assignments` |
| DB columns | `employee_*` | `employee_id` (memory, jobs, knowledge), `employee_key`, `employee_type`, `employee_installation_id`, `default_employee_id`, `allowed_employee_ids`, `active_employee_limit`, `source/target_employee_installation_id` |
| Prisma enums | `EMPLOYEE_*` / `EMPLOYEE` values | `MemoryScope.EMPLOYEE` (**persisted**), `EmployeeDelegatedTaskStatus`, interaction type `EMPLOYEE_DELEGATION` |
| String defaults persisted in rows | PascalCase source tags | `source = "TravelEmployee"`, `"HrEmployee"`, `"SalesEmployee"` … (default on lead/ticket tables); `requester_type = "EMPLOYEE"`, `requested_by_actor_type = "EMPLOYEE"` |
| Backend modules | `employees/`, `<domain>/<domain>-employee.{controller,service}.ts`, `workforce/employee-*.ts`, `channels/employee-router.*` | `EmployeeService`, `EmployeeRegistry`, `EmployeeRuntime`, `EmployeeRouterService`, `EmployeeLlmOrchestrator` |
| REST routes | kebab, plugin-specific | `/travel-employee/*`, `/hr-employee/*`, … `/legal-employee/documents`, `/workforce/employees`, `/billing/usage/employees[/:id]`, `/billing/usage/by-employee`, `/billing/usage/trend-by-employee`, `/knowledge/employees/:employeeId/*`, `/ai-configuration/employees/:pluginId/assignments`, `/skills…/employees/:employeeId/skills`, `…/grants/:employeeId` |
| Error codes | `*_EMPLOYEE_*` | `NO_ELIGIBLE_EMPLOYEE`, `WORKFORCE_EMPLOYEE_NOT_INSTALLED` (map to HTTP statuses in `api-exception.filter.ts`; **client-visible contract**) |
| Plugin manifests | `routing.employeeKey`, `routing.employeeType`, `displayName: "X Employee"`, id `x-employee` | `packages/plugin-sdk` `EmployeeRoutingManifest` |
| Dashboard routes | `/ai-employees`, `/ai-employees/[id]`, `/<domain>-employee`, marketing `/meet-ai-employees/*` | `/meet-ai-employees` is in `sitemap.ts` (**SEO/public URLs**) |
| Dashboard code | `features/employees/*`, `features/agents/*` (the latter already uses "agent"), `marketing/components/ai-employees/*`, `marketing/content/ai-employees.ts` | `EmployeeCard`, `EmployeeHero`, `agentsApi.employees()`, `billingApi.trendByEmployee()` |
| iOS | `Views/Employees/*`, ViewModels | `EmployeesListView`, `EmployeeDetailView`, `EmployeeChatView`, `EmployeeCatalogView` + view models; iOS already shows `"AI Employee"` next to `lead.agentId` |

## 3. Classification of occurrences

### A. User-visible copy — **change (low risk)**
- Dashboard: sidebar labels in `components/layout/dashboard-shell.tsx` ("AI Employees", "Travel Employee", "HR Employee", "Finance Employee", "IT Support Employee", …), `dashboard-home.tsx` metrics ("AI Employees in Use", "Time Saved by AI Employee", "Credits/Tokens by AI Employee"), ~160 UI-string lines in 55 non-spec files, all marketing content (`marketing/content/ai-employees.ts` + 40 marketing files), page titles/SEO metadata, empty states.
- iOS: ~9 view files ("AI Employees" screen titles, empty-state copy, "AI Employee" detail row).
- Plugin manifests: `name`, `displayName`, `description` (e.g. "Travel Employee", "AI travel planning employee…"). **Caveat:** `displayName` is seeded into DB rows at install time → existing installations keep the old name unless a data update is run (§6).
- Seed permission descriptions (~55 strings) — `seed.ts` is an upsert, so descriptions update on next seed.
- LLM-facing prompts/fallback replies in backend (`"…no AI provider has been configured for ${employeeName}"`, system-prompt text in runtime/skills) — change; **needs review** because prompt wording affects model behaviour and existing tests assert exact strings.
- Docs and README.

### B. Internal identifiers (TS) — **optional, defer by default**
~65 backend/plugin files are named `*employee*`; thousands of identifiers (`EmployeeService`, `employeeId`, `EmployeeLlmOrchestrator`, `EmployeeRegistry`, …). Renaming gives no user value and touches 284 backend files incl. 108 specs. **Recommendation: do not mass-rename.** Rename only a small, high-visibility surface behind aliases (see §7).

### C. Persisted data / wire contracts — **do not change in place**
Plugin slugs, `MemoryScope.EMPLOYEE`, source/requester string defaults, JSON keys (`employeeId`, `employeeName`, `employeeType`, `employeeKey` in API payloads consumed by dashboard **and iOS**), routing profile keys, error codes, route paths. Changing these breaks existing rows, installed plugins, the iOS app already in users' hands, and external API consumers.

### D. Human-employee usage — **must remain "Employee"** (confirmed in code)
| Where | What |
|---|---|
| `HrLeaveRequest.employeeUserId` (`employee_user_id`) | the human employee requesting leave |
| `HrLeaveStatus.SUBMITTED_BY_EMPLOYEE`, `EMPLOYEE_WITHDREW` | human leave workflow; also in `hr/hr-leave.service.ts` |
| `HrTicket.employeeName` (`employee_name`) and `ItSupportTicket.employeeName` | name of the human who raised an HR / IT ticket. (`nameField: "employeeName"` in `employees/employee-registry.ts`) |
| `ApproverType.EMPLOYEE` and `ApprovalRequest.requesterType` default `"EMPLOYEE"` | the *human staff* approver/requester in the approval engine |
| `HrEmployeeConfiguration` / HR plugin domain text | the **HR Agent's** config is an AI worker (rename), but its *domain content* (HR policies about employees, payroll, leave) is human-employee language (keep) |
| `extractEmployeeName()` / `buildEmployeeNameRequest()` in `employees/employee-runtime.ts` | extracts the *human* employee's name from chat for HR/IT tickets — name collides with the AI-employee module naming; **do not rename mechanically** |
| Docs: HR/Finance/recruitment copy | e.g. "employee onboarding", "employee leave policy" |

Note the dangerous collision: `employeeName` means **a human** in HR/IT tickets, but `EmployeeService`/`employeeId` means **an AI worker** elsewhere. A global find/replace would corrupt the former. Each file needs context-aware handling.

### E. Ambiguous / needs your decision
- `ApproverType.EMPLOYEE` / `requesterType "EMPLOYEE"` — I read these as a human requester/approver. Please confirm.
- `MemoryScope.EMPLOYEE` / `AgentMemoryScope` — "an AI Employee's working memory" → semantically AI, but persisted enum value. Rename only via additive `AGENT` value (§5), if at all.
- `activeEmployeeLimit` on subscription plans (`active_employee_limit`) — AI workers count, but it is a billing/plan field; low value to rename.
- "Recruitment Consultant: internal-only employee" in `plugins/recruitment-consultant` and recruitment WhatsApp code — AI worker, but candidate/"employee" mentions may be about humans.
- Public marketing URLs `/meet-ai-employees/*` and `/ai-employees` — rename implies SEO redirects.

## 4. Potential breaking changes (ranked)

| # | Risk | Why |
|---|---|---|
| 1 | **Plugin slug rename** (`travel-employee` → `travel-agent`) | Slug is referenced by DB rows, routing profiles, channel `allowedEmployeeIds`, a migration backfill, ~280 code literals, package names, dashboard URLs, UAT tests. High blast radius. |
| 2 | **Prisma model/table/column/enum rename** | Needs `ALTER ... RENAME` migrations on ~15 tables / ~12 columns; every `prisma.<model>` call (284 files) and raw SQL (pgvector knowledge queries) changes; `db-guard.ts` may flag destructive diffs. |
| 3 | **JSON field renames in API responses** | Dashboard and the **shipped iOS app** decode `employeeId`/`employeeName`/etc. Old iOS builds would break. |
| 4 | **Route renames** | External consumers / service accounts / API keys may call `/travel-employee/*`, `/workforce/employees`, `/billing/usage/employees`. |
| 5 | **Error-code renames** | `NO_ELIGIBLE_EMPLOYEE`, `WORKFORCE_EMPLOYEE_NOT_INSTALLED` are client-visible strings. |
| 6 | **Persisted enum/string values** | `MemoryScope.EMPLOYEE`, `source="TravelEmployee"`, `requester_type="EMPLOYEE"` – queries filter on them; analytics/reporting joins too. |
| 7 | **Exact-string test assertions** | e.g. `dashboard-home.spec.tsx` asserts `"AI Employees in Use"`; many API specs assert prompt/reply text; Playwright UAT specs assert labels and paths. They must be updated together with copy. |
| 8 | **LLM prompt text changes** | Alters model behaviour subtly; tests with fixtures/golden replies may shift. |
| 9 | **Public URLs / SEO** | `/meet-ai-employees/*` in `sitemap.ts`. Needs 301 redirects. |
| 10 | **Docs/UAT artefacts** | `Krevia_Sprint_*` UAT docs/JSON and `docs/production/*` sprint reports are historical records — rewriting rewrites history. |

## 5. Database migration requirements

The schema already uses `agent_*` names for execution/runtime data (`agent_executions`, `agent_tool_executions`, `agent_memories`, `agent_id` columns), but the per-worker configuration, routing, delegation, skill-grant and AI-assignment tables, plus `employee_id` columns, still say "employee". A full rename is therefore a real schema migration. Options:

| Option | Migration | Safety | Value |
|---|---|---|---|
| **A. No schema change (recommended default)** | none | Zero risk. Terminology lives in UI, docs, API aliases, manifests display text. | Meets the acceptance criterion ("platform *presents* as Agents") |
| B. Cosmetic Prisma-only rename | `@map` keeps real names; rename only Prisma model names (e.g. `model TravelAgentConfiguration { … @@map("travel_employee_configurations") }`) | No SQL migration, data untouched; but touches every `prisma.xxx` call. | Code consistency only |
| C. Full physical rename | `ALTER TABLE … RENAME`, `RENAME COLUMN`, `ALTER TYPE … RENAME VALUE`, data `UPDATE` for slugs/strings; constraints/indexes renamed | Non-destructive but atomic cutover; needs expand/contract if rolling deploys; Postgres `RENAME` is metadata-only (fast, keeps data and FKs) | High effort, high blast radius, little user value |

If C is ever chosen, use **expand/contract**: (1) add new names / views / `AGENT` enum value; (2) dual-read/dual-write; (3) backfill; (4) switch reads; (5) drop old in a later release — never in the same release. `MemoryScope` enum value rename must use `ALTER TYPE … RENAME VALUE` (Postgres ≥10), which preserves rows.

**Data-only updates that are safe and worth doing under Option A** (idempotent SQL, no schema change):
- `plugins.name/display_name/description` for the 9 built-in plugins (so existing installations show "Travel Agent" rather than "Travel Employee"). Must be reviewed — it is data a tenant may have customised.
- Seed permission descriptions (via existing `seed.ts` upsert).

## 6. API compatibility considerations

- Backend serves ~14 controllers with employee paths (§2). Proposed pattern: **add** new Agent-named routes as additional decorators on the same handler (`@Get(["employees", "agents-list"])` style via Nest path arrays) so old and new both work, return **both** old and new JSON keys during a deprecation window (`employeeId` + `agentId`), and mark old ones deprecated (response header `Deprecation`/`Sunset`, and OpenAPI/docs note).
- Collision to resolve: `GET /agents` already exists and returns the installed-AI-worker list (via method `employees()`); the new canonical route for "My Agents" can simply be that existing route — no new path needed. For `workforce/employees`, `billing/usage/employees`, `knowledge/employees/…`, `ai-configuration/employees/…`, and `…/<domain>-employee`, add `…/agents…` / `<domain>-agent` aliases.
- Do **not** rename error codes in place; add new codes only with new routes, keep old mapped.
- RBAC: permission keys unchanged ⇒ guards, role seeds, service-account scopes, API-key scopes all continue to work.
- iOS: decodes current field names; keep emitting old keys until a minimum iOS version that reads the new keys ships.
- `@nestjs/swagger` is in use (`apps/api/package.json`; controllers such as `agent.controller.ts` and `ai-configuration.controller.ts` import it). Swagger tags/summaries/descriptions that say "employee" will be updated in Sprint 2, and alias routes need `@ApiOperation` deprecation notes. Markdown API docs under `docs/` are updated in Sprint 4.

## 7. Recommended migration strategy

Principle: **change what users and integrators *see*; keep stable what is *stored or wired*; add aliases where a name is a public contract.** This matches your rule "do not rename internal modules if it creates risk without business value."

**Tier 1 — do (Sprints 2–4)**
1. All user-visible strings (dashboard, marketing, iOS, plugin display text, seed descriptions, notifications, empty states, titles/SEO metadata) → Agent terminology, using the label set you specified (My Agents, Agent Marketplace, Discover Agents, Deploy Agent, Configure Agent, Agent Permissions, Agent Execution History). The existing "AI Employees" catalog = "Agent Marketplace"; installed list = "My Agents".
2. New Agent-named URL aliases: dashboard `/agents` (+ `/agents/[id]`, `/<domain>-agent`) with permanent redirects from old paths; marketing `/meet-ai-agents/*` with 301s from `/meet-ai-employees/*`; API alias routes per §6.
3. LLM-facing prompt/fallback text updated, with spec updates, reviewed case by case.
4. Tests updated alongside copy; new tests asserting both old and new routes respond.
5. Docs: new `docs/AGENT_TERMINOLOGY_STANDARD.md`, README tagline "AI Workforce OS — An Enterprise AI Agent Operating System", rewrite living docs (`docs/agent-runtime.md`, `docs/plugin-runtime.md`, `docs/enterprise-knowledge.md`, `docs/skills/*`, `docs/production/architecture.md`, `docs/product/*`). Historical sprint reports and UAT docs: **leave untouched** (add a one-line terminology note in the standard instead).

**Tier 2 — only with explicit approval**
6. Cosmetic rename of a few high-visibility internal names behind re-exports (e.g. `EmployeeRoutingManifest` → `AgentRoutingManifest` in `plugin-sdk` with a deprecated alias; `features/employees/` → `features/agents/` merge on the dashboard where `agents-api` already exists).
7. Plugin slug aliasing (accept `travel-agent` as an alias of `travel-employee`) — not a rename.

**Tier 3 — not recommended now**
8. Physical DB renames, enum value renames, plugin slug renames, TypeScript mass-renames of `Employee*` symbols, renaming the 108 specs' identifiers.

**Sprint plan after approval**
- **Sprint 2 (backend):** prompt/fallback/description text; seed descriptions; plugin manifest display text; API alias routes + dual JSON keys; no schema change under Option A; idempotent data-update migration for built-in plugin display names (if approved).
- **Sprint 3 (frontend):** dashboard nav/labels/pages/routes+redirects, marketing site, iOS strings, Playwright UAT updates.
- **Sprint 4 (docs + verification):** standard doc, README, living docs, then full verification (§8) and final report.

## 8. Verification plan (to be executed in Sprint 4; nothing has been run yet)

Commands available in the repo: `pnpm lint`, `pnpm typecheck`, `pnpm test` (turbo: API vitest with DB prep `scripts/prepare-test-database.ts`; dashboard vitest), `pnpm --filter api test:e2e` (auth/RBAC, plugin, agent runtime, knowledge, memory suites), `prisma validate`, `pnpm db:migrate:status`, `pnpm format:check`, dashboard Playwright UAT. **Caveat:** the API suite needs a Postgres test DB (+pgvector); At audit time `pg_isready` reports **no Postgres listening on 127.0.0.1:5432** (`psql` and `docker` are installed; `.env.test.example` expects `ai_workforce_os_test` on 5432). To run API integration/e2e/RBAC suites I will need to start a local Postgres+pgvector (e.g. via `docker-compose.yml`) — free and local, no cloud cost — and I'll do that before Sprint 2 to capture a **baseline test run on unmodified code**. If suites cannot run, I will say so rather than claim a pass.

Post-change sweep: `git grep -i 'ai employee\|employee'` with an allow-list of the §3-D human contexts; every remaining hit reviewed manually.

## 9. Decisions requested before Sprint 2

1. **DB strategy:** Option A (no schema change, recommended) / B / C?
2. **Plugin slugs and API/JSON field names:** keep as-is with aliases added (recommended), or plan a physical rename?
3. **URL renames** (`/ai-employees` → `/agents`, `/meet-ai-employees` → `/meet-ai-agents`, `/<domain>-employee` → `/<domain>-agent`) with 301/redirects — OK?
4. **Existing tenant data:** may I include an idempotent data migration updating built-in plugin display names/descriptions for existing installations?
5. **Historical docs** (sprint reports, UAT .docx/.json): leave unchanged (recommended)?
6. **Ambiguities in §3-E:** confirm `ApproverType.EMPLOYEE`/`requesterType` are human; confirm recruitment-consultant wording is AI-only.
7. **Tracked build artifacts** (iOS `build/`, Playwright reports): out of scope here — want a separate cleanup?

---

## 10. Sprint 2 outcome (backend) — decisions applied

Decisions taken (approved "as proposed"): Option A (no schema change); plugin slugs / persisted values / JSON keys kept with aliases added; URL aliasing with legacy paths preserved; data-only update of built-in display names for existing tenants (customised values untouched); historical sprint reports and UAT files left as-is; `ApproverType.EMPLOYEE` / `requesterType "EMPLOYEE"` and all HR/IT ticket `employeeName` usage treated as human and left unchanged.

What changed:
- **Backend text:** onboarding checklist, out-of-scope / routing replies, knowledge-grounding prompt, memory prompt section, reminder fallbacks, observability alert, billing "Removed Agent", skill/delegation error *messages*, Swagger tags, seed permission descriptions, skill-sdk permission labels. Error **codes** (`NO_ELIGIBLE_EMPLOYEE`, …) are unchanged. The chat-routing regexes now also recognise "hr agent", "finance agent", etc.; detection of an earlier "…correct employee" routing offer still works for conversations created before this change.
- **Plugin manifests (9 built-ins):** `name`, `displayName`, lead-in of `description`, `routing.displayName` and the runtime notice → "X Agent". Slugs, ids, `employeeKey`/`employeeType`, package names untouched.
- **Route aliases (legacy paths still served):** `/{travel,hr,finance,it-support,sales,marketing,legal,customer-support}-agent`, `/legal-agent/documents`, `/workforce/agents`, `/billing/usage/{by-agent,trend-by-agent,agents,agents/:id}`, `/knowledge/agents/:employeeId/*`, `/ai-configuration/agents/:pluginId/assignments`, `/skills/agents/:employeeId/skills`. Agent path is listed first (canonical) in each decorator.
- **JSON mirror keys:** `agentName` beside `employeeName` (usage by agent), `agents` beside `employees` (usage trend).
- **Migration** `20261111120000_agent_terminology_display_names` (data-only, idempotent, no DDL): updates `plugins.{name,display_name,description,manifest}` and `employee_routing_profiles.display_name` only where a value still equals the shipped default. Verified on stand-in tables, run twice; tenant-customised value preserved; human-employee sentence in the HR description preserved.
- **Tests:** stale display-name expectations updated; new `agent-route-aliases.spec.ts` (19 tests), a billing mirror-key test, and a real-HTTP assertion that `/workforce/agents` and `/workforce/employees` return identical bodies.

Verification (all executed, local Postgres 17 + pgvector; baseline = unmodified code):
| Check | Baseline | After |
|---|---|---|
| `prisma validate` | – | valid |
| `prisma migrate status` | – | up to date (new migration applied) |
| `tsc --noEmit` (api) | 38 errors, all in `*.spec.ts` | identical 38 (none from this work) |
| ESLint (api) | 84 problems | identical 84 |
| Full API suite (`pnpm test`) | 2944 passed / 10 failed | 2971 passed / 10 failed (+27 new tests) |
| `pnpm test:e2e` (auth, RBAC, plugin, agent runtime, knowledge, memory) | 61/61 | 61/61 on re-run* |
| Related e2e/unit suites in isolation (employees, workforce, receptionist, leads, skills, attachments, …) | 339/339 | all pass |

\* One run showed 60/61: `knowledge.e2e` "signed download URL" replaces the first hex char of an HMAC with `0`, so it fails ~1 time in 16 when the real signature already starts with `0`. Unrelated to this work; passed 4/4 on re-run. The full-suite failures that remain at baseline and after are pre-existing: several e2e files fail in cleanup due to cross-spec foreign-key pollution of the shared test DB (which suites are hit varies by run; each passes in isolation), plus `channel-delivery` and two date-dependent `travel.llm` tests.

Not done / not verified: dashboard and iOS (Sprint 3), docs (Sprint 4), plugin-runtime regression beyond the suites above. The build of `plugins/*` and `skill-sdk` was re-run so the on-disk manifests match.

---

## 11. Sprint 3 outcome (dashboard + iOS)

**Routes (folders renamed with `git mv`; old URLs permanently redirect, query strings preserved)**
`/ai-employees[/…]` → `/agents[/…]`; `/{travel,hr,finance,it-support,sales,marketing,legal,customer-support}-employee[/…]` → `…-agent[/…]`; marketing `/meet-ai-employees[/…]` → `/meet-ai-agents[/…]`. Redirects live in `apps/dashboard/next.config.ts` (HTTP 308). Verified against the running app: all 7 sampled legacy URLs return 308 to the new path (including `?conversationId=` preserved); new URLs return 200. The sitemap, marketing links, in-app links, header/footer navigation and the Playwright UAT paths use the new URLs.

**Labels (standard set):** sidebar "My Agents"; the page's catalogue section is "Agent Marketplace" ("Discover Agents and deploy one to get started"); the install button is "Deploy Agent" and the per-card link "Configure Agent"; plugin install form legend "Agent Permissions"; "Agent Execution History" (nav, page title, back link). Dashboard home metrics ("AI Agents in Use", "Credits/Tokens by AI Agent"), billing/usage tabs, channels, knowledge, skills, scheduler, workforce, memory ("Agent Memory"), AI-configuration ("Agent Assignments"), per-domain configuration pages ("Travel Agent", "HR Agent", …), empty states and error messages all use Agent wording. HR-page copy about *human* employees ("Answers employee questions…") is unchanged.

**Marketing site:** all "AI Employee(s)" copy, role pages ("Travel AI Agent", …), page titles/metadata, blog/solutions/security/platform text, public-chat system prompt. Site tagline is now "The Enterprise AI Agent Operating System"; root metadata description "AI Workforce OS — an Enterprise AI Agent Operating System". The marketing chatbot keeps the legacy "AI employee" keywords **and** matches the new "AI agent" ones. Blog post URL slugs were left unchanged (public links).

**API calls:** the dashboard and iOS clients still call the legacy endpoints/JSON keys (e.g. `/travel-employee/…`, `/billing/usage/by-employee`, `employeeName`), which Sprint 2 keeps working, so old and new clients can be deployed in any order. Switching clients to the Agent aliases is optional follow-up.

**iOS:** user-visible strings ("AI Agents" home card, catalogue/list empty states, "By AI Agent", lead detail row, conversations empty state) and doc comments. Swift identifiers (`EmployeesListView`, `employeeId`, JSON `CodingKeys`) are unchanged. **Not compiled or tested here** — the iOS build folders are tracked in git, so running `swift test`/`xcodebuild` would rewrite hundreds of tracked artefacts; changes are string literals only.

**Verification (executed; baseline = unmodified code)**
| Check | Baseline | After |
|---|---|---|
| Dashboard vitest | 2 failed tests + 8 Playwright files wrongly collected by vitest (10 failing files) / 186 passed | the same 2 + 8 / **187 passed** (+1 new test) |
| `tsc --noEmit` | not measured on HEAD; stale `.next/types` showed 21 errors before rebuild | **0 errors** after build |
| ESLint | 836 problems | identical 836 (same files) |
| `next build` (production, placeholder HTTPS API URL) | – | succeeds; all new routes listed |
| Redirects at runtime | – | 308 + new URL 200 (above) |

Not run: the Playwright UAT specs (`tests/uat`, they need the full stack, seeded data and a browser run) — their navigation paths were updated but are unexercised. The two baseline vitest failures (`channel-api.spec`, `ai-employees.spec` placeholder hint) pre-date this work and remain.

---

## 12. Sprint 4 outcome and final migration report

**Documentation**
- New [`AGENT_TERMINOLOGY_STANDARD.md`](AGENT_TERMINOLOGY_STANDARD.md): official terms, the human-employee-versus-agent rule, architectural concept map (Registry, Runtime, Lifecycle, Orchestration, Marketplace, Configuration, Permissions, Skills, Memory, Execution History, Monitoring, Communication, Agent-to-Agent Collaboration → real modules), technical / API / database / frontend naming rules, alias and deprecation policy, change checklist.
- `README.md`: tagline "An Enterprise AI Agent Operating System" and a Terminology section.
- Living docs rewritten (prose only; code spans, fenced blocks and identifiers untouched): `agent-runtime`, `connectors`, `enterprise-knowledge`, `interaction-reference`, `product/krevia-crm`, `production/{architecture,onboarding,operations}`, `skill-runtime-shadow`, `sprint-4.8-autonomous-scheduler`, `agent/{ARCHITECTURE,SYSTEM_INSTRUCTIONS}`, `skills/*`. Diff scanned for human-employee context and identifier damage: none found.
- **Deliberately unchanged (historical record):** `docs/production/sprint-*-report.md`, `full-platform-uat-*.md`, `docs/agent/LAST_RUN_HANDOFF.md`, the `Krevia_Sprint_*` UAT files, applied Prisma migrations.

**Behaviour dependencies found by the final sweep and fixed**
- `stripDebugWording` removed a leading `"<Name> Employee:"` prefix from customer-facing replies. With the new display names ("Travel Agent:") it would have stopped matching. It now strips both forms; new tests cover both (old prefixes persist in stored conversations and tenant-customised profiles).
- The last remaining LLM system prompt that said "AI Employee" (`employee-runtime.ts`) now says "AI Agent".
- The channel prompt-injection guard recognised "use employee id" but not "use agent id"; both are now matched ("switch me to agent id" already was).

**Final verification (executed on unmodified-vs-modified code; local Postgres 17 + pgvector)**

| Check | Before (HEAD) | After |
|---|---|---|
| Full API suite, fresh DB | 2944 pass / 10 fail | 2965 pass / 11 fail† |
| `test:e2e` script (auth, RBAC, plugin, agent runtime, knowledge, memory) | 61/61 | 61/61 |
| Employee-related suites in isolation (employees, legal, skills, attachments, connectors, workforce, receptionist, leads, memory, knowledge, billing, onboarding, scheduler, route aliases) | 339 pass | 931 pass (incl. suites that break from DB pollution in the full run) |
| plugins / agents / approval | – | 204/204 |
| `src/interaction` | 2 fail | same 2 fail (**also fail on pristine HEAD**) |
| Dashboard vitest | 186 pass, 10 failing files | 187 pass, same 10 failing files |
| `prisma validate` / `migrate status` | – | valid / up to date |
| TypeScript: api / dashboard | 38 spec-only errors / n.a. | identical 38 / 0 |
| ESLint: api / dashboard | 84 / 836 problems | identical 84 / 836 |
| Plugin + package typecheck (`plugins/*`, `packages/*`) | – | all pass |
| Production `next build`, redirects at runtime | – | passes; 308 verified |

The full-suite numbers were taken before the last two small fixes above; those were verified afterwards by targeted runs (`src/conversation` 124/124; `src/channels` only the 5 `channel-delivery` failures above). † The 10 failures that exist on unmodified code: 5 in `channel-delivery.spec`, 2 in `interaction.*.e2e`, 2 date-dependent `travel.llm.spec` tests, 1 recruitment CSV audit test. The 11th is `knowledge.e2e` "signed download URL", which tampers with a signature by overwriting its first character with `0`; it fails whenever the real HMAC already starts with `0` (observed ≈1 run in 8, with no code in that path changed). Fixing that test (flip a character deterministically) is a recommended follow-up. Separately, several e2e files can fail in the *full* run from leftover `channel_connections` rows blocking `plugin.deleteMany()` in later suites' cleanup; which suites are hit varies, and each passes when run in isolation.

**Not executed:** Playwright UAT specs (need the full stack and a browser); iOS compile/tests (Swift build folders are tracked in git); API-integration tests against a deployed environment; load tests.

**Remaining "employee" occurrences — categorised review.** Of ~5,100 matching lines in tracked source/docs (excluding generated output and lockfiles): ~1,530 are in spec/test files (fixtures, identifiers, legacy-wording assertions); ~350 are applied migrations and historical reports; ~180 are `schema.prisma` (legacy model/column names plus comments); ~150 iOS (Swift identifiers and `CodingKeys`); the remainder are legacy TypeScript identifiers, plugin ids/slugs, persisted values, API alias paths, code comments, human-employee features (HR leave, HR/IT tickets, approvals) and docs prose about human employees. I reviewed the categories by targeted search rather than reading all ~5,100 lines: a search for user-visible strings (UI, LLM prompts, error messages, manifests, seed descriptions, Swagger text) containing "AI employee" or "<Role> Employee" returns only code comments, the README's "formerly" note, the chatbot's deliberate legacy search keywords, and historical reports. Human-employee code was verified unchanged.

**Known deliberate remainders (see the Standard §4):** plugin slugs `*-employee`; `MemoryScope.EMPLOYEE`; `source="TravelEmployee"` defaults; `*_EMPLOYEE_*` error codes; `employeeId` / `employeeName` JSON keys (mirrored by Agent keys where responses carried them); physical table/column names; TypeScript/Swift identifiers.

**Suggested follow-ups (not done, not required):** (1) fix the flaky signed-URL test; (2) fix cross-suite test-DB pollution (cleanup order for `channel_connections`); (3) untrack committed build artefacts (`apps/ios/**/build`, `.build`, Playwright reports) and `.gitignore` them; (4) the Vitest config picks up Playwright specs; (5) optionally move dashboard/iOS clients to the Agent API aliases and plan eventual deprecation of the legacy paths per the Standard §5.
