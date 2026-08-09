# Skills Marketplace: REST API and Dashboard

## REST API surface

All routes are under `/skills`, defined in `apps/api/src/skills-platform/skill-platform.controller.ts`.
The whole controller is guarded by `@UseGuards(JwtAccessGuard, PermissionGuard)`; every route also
declares its own `@RequirePermission(...)` (one of the `SkillPermissionKey`s — see
`docs/skills/security.md`). Request/response DTOs are in `skill-platform.dto.ts`. Every response is
wrapped `{ data: ... }`.

| Method | Path | Permission | Request body | Response `data` |
|---|---|---|---|---|
| GET | `/skills/marketplace` | `skill.marketplace.read` | — | `{ items: SkillMarketplaceItem[] }` — every active `Skill` with its published versions and this org's install state |
| GET | `/skills/installations` | `skill.marketplace.read` | — | `SkillInstallation[]` — this org's installations, each with `skillVersion` (incl. `skill`, `dependencies`) and `_count: { grants, executions }` |
| GET | `/skills/installations/:installationId` | `skill.marketplace.read` | — | `SkillInstallationDetail` — one installation with `grants[]` (raw grant rows with `pluginInstallation` summary) instead of `_count` |
| POST | `/skills/install` | `skill.install` | `SkillInstallDto`: `{ skillKey, versionConstraint?, configuration?, enabled?, approveSensitivePermissions? }` | The created `SkillInstallationDetail` (HTTP 201) |
| DELETE | `/skills/installations/:installationId` | `skill.uninstall` | — | `{ uninstalled: true, installationId }` |
| PATCH | `/skills/installations/:installationId/enable` | `skill.update` | — | Updated `SkillInstallationDetail` |
| PATCH | `/skills/installations/:installationId/disable` | `skill.update` | — | Updated `SkillInstallationDetail` |
| PATCH | `/skills/installations/:installationId/configure` | `skill.configure` | `SkillConfigureDto`: `{ configuration }` | Updated `SkillInstallationDetail` |
| POST | `/skills/installations/:installationId/update-version` | `skill.update` | `SkillVersionUpdateDto`: `{ versionConstraint }` | Updated `SkillInstallationDetail` (same-major compatible upgrade only — see `docs/skills/versioning.md`) |
| POST | `/skills/installations/:installationId/rollback` | `skill.update` | — | `SkillInstallationDetail` restored to the previously recorded version |
| GET | `/skills/installations/:installationId/grants` | `skill.grant.manage` | — | `EmployeeSkillGrant[]` for this installation, across employees |
| POST | `/skills/installations/:installationId/grants` | `skill.grant.manage` | `SkillGrantDto`: `{ pluginInstallationId, configurationOverride? }` | The employee's grant list (HTTP 201) |
| DELETE | `/skills/installations/:installationId/grants/:employeeId` | `skill.grant.manage` | — | The employee's remaining grant list |
| PATCH | `/skills/installations/:installationId/grants/:employeeId/state` | `skill.grant.manage` | `SkillGrantStateDto`: `{ enabled }` | The employee's grant list |
| POST | `/skills/execute` | `skill.execute` | `SkillExecuteDto`: `{ skillKey, versionConstraint?, pluginInstallationId?, conversationId?, agentExecutionId?, workflowExecutionId?, idempotencyKey?, input? }` | `SkillExecuteResult` — see `docs/skills/runtime.md` |
| GET | `/skills/employees/:employeeId/skills` | `skill.execute` | — | Capability discovery: skills installed *and* granted to this employee (`skillsForEmployee()`) |
| GET | `/skills/installations/:installationId/executions` | `skill.execution.read` | Query `SkillPageDto`: `{ page?, pageSize? }` (1-100) | `{ items: SkillRun[] (safe fields only), total }` — never raw input/output summaries, see `docs/skills/runtime.md` |
| GET | `/skills/installations/:installationId/health` | `skill.health.read` | — | `{ status, checks, checkedAt }` from the adapter's `health()` |

All DTOs use `class-validator` decorators (`@IsString`, `@IsUUID("4")`, `@MaxLength`, etc.) — the
NestJS `ValidationPipe` rejects malformed bodies before the controller method ever runs, before any
of the runtime's own schema validation happens. Every controller method that can throw a `SkillError`
wraps the call in `try { ... } catch (error) { throw toSkillHttpError(error); }`, converting the
platform's internal error codes to the NestJS exception shapes documented in `docs/skills/runtime.md`.

## Dashboard: `/skills` page

`apps/dashboard/src/app/(dashboard)/skills/page.tsx` renders `SkillsPage` from
`apps/dashboard/src/features/skills/skill-pages.tsx`. The nav entry lives in
`apps/dashboard/src/components/layout/dashboard-shell.tsx`'s `ADMIN_ITEMS`:

```typescript
{ href: "/skills", label: "Skills", icon: Sparkles, permission: "skill.marketplace.read" }
```

`skill-api.ts` (`createSkillApi(client)`) is a thin typed wrapper around every route in the table
above, used by all five tabs.

The page is five tabs (`TAB_DEFINITIONS`, `skill-pages.tsx:40-46`), each requiring its own RBAC
permission to be visible:

| Tab | Permission | Renders | Backed by |
|---|---|---|---|
| **Marketplace** | `skill.marketplace.read` | `MarketplaceTab` — every published skill, install state, and an install action | `GET /skills/marketplace`, `POST /skills/install` |
| **Installed** | `skill.marketplace.read` | `InstallationList` (left) + `InstalledDetail` (right) — an installation's status, configuration, version, dependencies, and enable/disable/configure/update-version/rollback/uninstall actions | `GET /skills/installations`, `GET /skills/installations/:id`, the lifecycle PATCH/POST/DELETE routes |
| **Employee Grants** | `skill.grant.manage` | `GrantsPanel` — grant/revoke a selected installation to/from an AI Employee, toggle a grant's enabled state | `GET/POST/DELETE /skills/installations/:id/grants`, `PATCH .../grants/:employeeId/state` |
| **Executions** | `skill.execution.read` | `ExecutionsPanel` — paginated run history for a selected installation (status, duration, tokens, credits, retry count, error code — never raw content) | `GET /skills/installations/:id/executions` |
| **Health** | `skill.health.read` | `HealthPanel` — the adapter's live health report for a selected installation | `GET /skills/installations/:id/health` |

Selecting the Installed/Employee Grants/Executions/Health tabs shares a common
`InstallationList` + `useSelectedInstallation` pattern (`skill-pages.tsx:212-282`, `ManagePanel`) —
the left-hand installation list stays visible and the right-hand panel switches based on
`activeTab`; `statusTone()` (`skill-pages.tsx:48-51`) maps status strings (`COMPLETED`/`HEALTHY`/
`ENABLED`/`INSTALLED` → success, `FAILED`/`UNHEALTHY`/`TIMEOUT` → danger) to the shared badge
component's visual tone across all five tabs.
