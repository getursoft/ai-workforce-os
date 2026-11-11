# Agent Terminology Standard

**AI Workforce OS — An Enterprise AI Agent Operating System**

This is the authoritative naming guide for the platform. It replaces the older "AI Employee" wording. For how and why the migration was done, see [`AGENT_TERMINOLOGY_MIGRATION_AUDIT.md`](AGENT_TERMINOLOGY_MIGRATION_AUDIT.md).

## 1. Official product terminology

| Say | Never say (for AI workers) |
|---|---|
| **AI Agent** / **Agent** | AI Employee, digital employee |
| **Agents** | Employees |
| **Travel Agent**, **HR Agent**, **Finance Agent**, **IT Support Agent**, **Sales Agent**, **Marketing Agent**, **Legal Agent**, **Customer Support Agent** | "Travel Employee", … |
| **Agent Marketplace** (catalogue of deployable agents) | Employee catalog |
| **My Agents** (the organisation's deployed agents) | AI Employees page |
| **Discover Agents** / **Deploy Agent** / **Configure Agent** | Install Employee … |
| **Agent Permissions** | Employee permissions |
| **Agent Execution History** | Execution history of employees |
| **Agent Skills**, **Agent Memory**, **Agent Runtime**, **Agent Configuration**, **Agent Deployment**, **Agent Profile**, **Agent Dashboard**, **Agent Activity** | Employee … |

The product tagline is **"AI Workforce OS — An Enterprise AI Agent Operating System"**. The customer-facing brand on the marketing site remains Krevia.ai ("The Enterprise AI Agent Operating System").

Style: "AI Agent" on first use in a sentence or page, "Agent" afterwards. Capitalise as a proper noun only in product labels and titles ("Agent Marketplace"); in running prose write "an agent", "your agents".

## 2. Human employees are still employees

An *employee* is a **person** who works for a customer organisation. That word keeps its meaning. Never rename it.

| Concept | Term | Examples in this repo |
|---|---|---|
| AI-powered digital worker | **Agent** | a deployed Travel Agent, the AI Receptionist |
| Person who works at the tenant organisation | **Employee** | HR leave requests (`HrLeaveRequest.employeeUserId`), leave statuses `SUBMITTED_BY_EMPLOYEE` / `EMPLOYEE_WITHDREW`, the `employeeName` on HR and IT support tickets, the `EMPLOYEE` approver/requester type in the approval engine |
| Person using the platform to run agents | **User**, **Operator**, **Administrator** | RBAC users and roles |
| Customer or end user talking to an agent | **Customer**, **Traveller**, **Candidate**, … | leads, bookings |

Rule of thumb: if the sentence is still true after replacing the word with "person on payroll", it is a human employee — leave it. HR-agent copy such as "answers employee questions about leave" is correct as written: the agent is the AI; the employees are the people asking.

## 3. Architectural concepts

Use these names in docs, UI and new code. The right-hand column shows where each lives today; legacy internal names are intentionally kept (§4).

| Concept | Where it lives |
|---|---|
| Agent Registry | `apps/api/src/workforce/employee-registry.ts` (installed agents + collaboration profiles); plugin catalogue in `apps/api/src/plugins/` |
| Agent Runtime | `apps/api/src/agents/agent.service.ts`, domain engines in `apps/api/src/employees/` and `apps/api/src/<domain>/` |
| Agent Lifecycle Management | plugin install / enable / disable / uninstall in `apps/api/src/plugins/plugin.service.ts` |
| Agent Orchestration | `apps/api/src/workforce/workforce-orchestrator.service.ts`, the AI Receptionist (`apps/api/src/receptionist/`) |
| Agent Marketplace | `GET /plugins/available`; dashboard "Agent Marketplace" section of **My Agents** |
| Agent Configuration | per-agent `<Domain>EmployeeConfiguration` tables, `PluginConfiguration`, AI profile assignments |
| Agent Permissions | RBAC keys (`agents.*`, `<domain>.config.*`, `skill.*`) and each plugin installation's granted permissions |
| Agent Skills | `apps/api/src/skills-platform/` (installation, grants, pipelines) |
| Agent Memory | `apps/api/src/memory/` (scopes `USER`, `EMPLOYEE`, `ORGANIZATION`, `CONVERSATION`; `EMPLOYEE` = agent scope, see §4) |
| Agent Execution History | `AgentExecution` model, `GET /executions` |
| Agent Monitoring | `apps/api/src/observability/` |
| Agent Communication | channels (`apps/api/src/channels/`): web chat, WhatsApp, voice |
| Agent-to-Agent Collaboration | delegation via `WorkforceOrchestratorService` and the delegation-task tables |

## 4. Technical naming guidelines

**New code uses Agent names.** New modules, classes, variables, DTO fields, routes, tests and docs say `agent`.

**Existing internal names are kept unless there is a business reason to change them.** The migration deliberately did *not* rename:

- TypeScript symbols and files such as `EmployeeService`, `EmployeeRegistry`, `employeeId`, `employee-runtime.ts`, `TravelEmployeeConfiguration`;
- plugin ids and slugs (`travel-employee`, `hr-employee`, …) and `routing.employeeKey` / `employeeType` — they are persisted in tenant data and referenced across the code;
- persisted enum/string values (`MemoryScope.EMPLOYEE`, `source = "TravelEmployee"`, `requester_type = "EMPLOYEE"`) and error codes (`NO_ELIGIBLE_EMPLOYEE`, `WORKFORCE_EMPLOYEE_NOT_INSTALLED`);
- Swift types and JSON `CodingKeys` in the iOS app.

Treat these as **legacy identifiers**. When you touch one of these modules for another reason you may add an Agent-named export/alias (e.g. `AgentRoutingManifest` for `EmployeeRoutingManifest`), but do not do repo-wide renames: they carry migration risk and no user value.

**User-facing text never says "Employee" for an AI worker** — UI labels, empty states, notifications, tooltips, breadcrumbs, page titles, Swagger summaries/tags, seed permission descriptions, plugin `name` / `displayName` / `description`, LLM system prompts, error messages, docs and marketing copy.

**Do not "fix" human-employee code.** Before changing any occurrence of `employee`, decide with §2 whether it is a person.

## 5. API naming conventions

- **Canonical paths use `agent`**; the legacy `employee` paths remain as permanent aliases so existing consumers (service accounts, API keys, the shipped iOS app) keep working. Both are registered on the same handler with a Nest path array, canonical first:

  | Canonical | Legacy alias |
  |---|---|
  | `/travel-agent`, `/hr-agent`, `/finance-agent`, `/it-support-agent`, `/sales-agent`, `/marketing-agent`, `/legal-agent`, `/customer-support-agent` (+ `/legal-agent/documents`) | `/<domain>-employee` |
  | `/workforce/agents` | `/workforce/employees` |
  | `/billing/usage/agents`, `/billing/usage/agents/:id`, `/billing/usage/by-agent`, `/billing/usage/trend-by-agent` | `…/employees`, `…/by-employee`, `…/trend-by-employee` |
  | `/knowledge/agents/:agentId/…` | `/knowledge/employees/:employeeId/…` |
  | `/ai-configuration/agents/:pluginId/assignments` | `/ai-configuration/employees/:pluginId/assignments` |
  | `/skills/agents/:agentId/skills` | `/skills/employees/:employeeId/skills` |
  | `GET /agents` (list), `POST /agents/run` | (already agent-named) |

- **Response fields:** where a body carried an employee-named key, the canonical key is added next to it and both carry the same value (`agentName` ↔ `employeeName`, `agents` ↔ `employees`). Consumers should read the Agent key; the legacy key is deprecated and will not be removed without notice.
- **Do not rename or reuse error codes.** New errors use `AGENT_*` codes; existing `*_EMPLOYEE_*` codes keep their meaning and HTTP status.
- **RBAC permission keys** are unchanged and have never contained "employee" (`agents.run`, `travel.config.read`, …). Only their human-readable descriptions use Agent wording.
- **Deprecation policy:** an alias is removed only after (a) a published notice, (b) at least one full release with both paths live, and (c) confirmation that no supported client (dashboard, iOS, service accounts) still calls it.
- Every alias is covered by `apps/api/src/agent-route-aliases.spec.ts`. Adding a route that uses a legacy name should add an Agent alias and extend that spec.

## 6. Database naming conventions

- **No schema rename was performed.** Table, column and enum names containing `employee` (`employee_routing_profiles`, `employee_delegated_tasks`, `employee_skill_grants`, `travel_employee_configurations`, `employee_id`, …) are legacy physical names.
- **New tables and columns use `agent`** (`agent_*`, `agent_id`), consistent with the existing `agent_executions`, `agent_tool_executions`, `agent_memories`.
- When a Prisma model name and its table differ, keep the table name via `@@map` and the column names via `@map` — never rename the physical object just for terminology.
- A physical rename, if ever required, must follow expand/contract (add → dual write/read → backfill → switch → drop in a later release) and be a non-destructive migration; see §5 of the audit.
- **Display text stored in rows** (plugin `name` / `display_name` / `description`, routing profile `display_name`) is migrated by the data-only migration `20261111120000_agent_terminology_display_names`, which only touches values still equal to the shipped default.

## 7. Frontend conventions

- Dashboard routes: `/agents`, `/agents/[id]`, `/<domain>-agent`. Marketing: `/meet-ai-agents/*`. The old `/ai-employees`, `/<domain>-employee`, `/meet-ai-employees` URLs are permanent (308) redirects in `apps/dashboard/next.config.ts`; keep them indefinitely (bookmarks, emailed links, search results).
- Standard labels: **My Agents**, **Agent Marketplace**, **Discover Agents**, **Deploy Agent**, **Configure Agent**, **Agent Permissions**, **Agent Execution History**.
- Keep the existing design system; this is a naming change only.

## 8. Checklist for a change that adds or edits an agent

1. UI/prompt/doc text says Agent; no "Employee" for the AI worker.
2. New identifiers are `agent…`; legacy identifiers left alone unless you have a business reason.
3. Routes: canonical `…agent…` path, plus alias only if a legacy path already exists.
4. New DB objects `agent_*`; no renames of existing physical objects.
5. Human-employee features (leave, payroll, HR tickets, approvals) keep "employee".
6. Update this document if you introduce a new term.
