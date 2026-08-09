# Skills Platform Security

What's actually enforced, where it's checked in code, and what is explicitly not yet defended
against. Written from the actual implementation, not the spec's aspirations.

## Two different key sets, on purpose

`packages/skill-sdk/src/types/permissions.ts` defines two distinct string-key unions that are easy to
conflate but serve different jobs:

- **`SkillPermissionKey`** (`SKILL_PERMISSION_KEYS`) — RBAC-gated HTTP action keys:
  `skill.execute`, `skill.install`, `skill.update`, `skill.uninstall`, `skill.configure`,
  `skill.marketplace.read`, `skill.execution.read`, `skill.health.read`, `skill.grant.manage`. These
  are checked by `PermissionGuard` + `@RequirePermission(...)` on `SkillPlatformController` routes —
  standard RBAC, answering "is this *user* allowed to call this HTTP endpoint at all?"
- **`SkillCapabilityKey`** (`SKILL_CAPABILITY_KEYS`) — runtime-provided least-privilege handles:
  `object.read`, `object.write`, `knowledge.read`, `knowledge.write`, `memory.read`, `email.send`,
  `channel.send`, `network.external`, `ai.provider.execute`. These are never checked against a user's
  RBAC role; they're built into a skill's `SkillExecutionContext.capabilities` object by
  `buildSkillCapabilities()`, answering "what can *this skill's code* actually touch during this
  specific execution?"

Why two systems: a permission answers "can Alice click install," a capability answers "can the
Document Reader skill's code read arbitrary tenant object storage." Conflating them would mean either
every skill implicitly gets every capability its installer is RBAC-permitted to grant (too broad —
the skill's own code becomes the trust boundary, not the manifest), or every RBAC action would need
its own capability handle (too narrow — a human clicking "install" doesn't need a `SkillCapabilities`
object at all). Keeping them separate means a manifest's `requiredCapabilities` array is the *only*
source of what a skill's code can reach, independent of who is allowed to install or configure it.

## `SENSITIVE_CAPABILITY_KEYS` and the install-time gate

`SENSITIVE_CAPABILITY_KEYS` (`permissions.ts:64-71`) is a `Set` of capabilities that carry security,
cost, or cross-tenant risk: `object.write`, `knowledge.write`, `memory.read`, `email.send`,
`channel.send`, `network.external`. `object.read` and `ai.provider.execute` are notably **not**
sensitive — a skill can request either without extra approval.

`SkillInstallationService.install()` (`skill-installation.service.ts:119-124`) intersects
`manifest.requiredCapabilities` against `SENSITIVE_CAPABILITY_KEYS`; if any match and the caller
didn't pass `approveSensitivePermissions: true`, install throws `SKILL_SENSITIVE_PERMISSION_REQUIRED`.
This forces an administrator to explicitly acknowledge (via the install request body, ultimately a
dashboard checkbox) that they understand the skill wants a capability like `network.external` before
it can be installed at all — a skill cannot silently upgrade its own reach after installation, since
`updateVersion()` re-validates configuration against the *new* manifest but does not re-run this
sensitive-permission gate (worth knowing: if a future skill version adds a sensitive capability it
didn't have before, `updateVersion()` does not re-prompt for approval today).

## Five layers, and where each is actually checked

A skill execution must clear all five of these independently. None of them substitute for another.

| # | Layer | Enforced by | Code location |
|---|---|---|---|
| 1 | Org entitlement | `EntitlementService.assertFeature`/`getLimit`/`consumeCapacity` | `SkillInstallationService.install()` (`SKILLS_MARKETPLACE`, `SKILLS_INSTALL`, `SKILLS_MAX_INSTALLED`, `SKILLS_AI_BACKED`, `SKILLS_EXTERNAL_NETWORK`); `grantToEmployee()` (`SKILLS_MAX_PER_EMPLOYEE`); `SkillsRuntimeService.assertMonthlyExecutionLimit()` (`SKILLS_EXECUTION_MONTHLY_LIMIT`) |
| 2 | Skill installation grant | `SkillInstallation.enabled` + `deletedAt: null`, org-scoped | `SkillsRuntimeService.assertInstallation()` |
| 3 | Employee grant | `EmployeeSkillGrant.enabled`, org + employee + installation-scoped | `SkillsRuntimeService.assertEmployeeGrant()` (only when a `pluginInstallationId` is present on the request) |
| 4 | User RBAC permission | `PermissionGuard` + `@RequirePermission(...)` | `SkillPlatformController` — every route (e.g. `skill.execute` on `POST /skills/execute`, `skill.install` on `POST /skills/install`) |
| 5 | Runtime policy | Schema validation, timeout, capability construction | `SkillsRuntimeService.executeResolved()` — input/output schema, `buildSkillCapabilities()` only attaching handles for capabilities the manifest declared *and* the runtime chose to grant |

Layers 1-3 and 5 run inside `SkillsRuntimeService.execute()` itself, so they apply identically no
matter which caller invokes it (HTTP, agent tool call, workflow step, scheduled job). Layer 4 (RBAC)
only applies to the HTTP surface — a scheduled job or workflow step calling `execute()` directly does
not go through `PermissionGuard` at all, because there is no HTTP request; those callers are trusted
system-internal code paths, and layers 1-3+5 are what protect tenant boundaries for them.

## Tenant isolation

Every Prisma query in the platform is `organizationId`-scoped — there is no query that resolves a
`SkillInstallation`, `EmployeeSkillGrant`, or `SkillRun` by ID alone. The canonical example is
`SkillsRuntimeService.assertInstallation()`:

```typescript
private async assertInstallation(
  organizationId: string,
  skillKey: string,
  version: string
): Promise<{ id: string; configurationJson: unknown }> {
  const installation = await this.prisma.skillInstallation.findFirst({
    where: {
      organizationId,
      deletedAt: null,
      skillVersion: { skill: { key: skillKey }, version }
    },
    select: { id: true, configurationJson: true, enabled: true, status: true }
  });
  if (!installation) throw new SkillError("SKILL_NOT_INSTALLED");
  ...
}
```

`organizationId` always comes from the JWT-derived principal (`org(principal)` in the controller,
`request.organizationId` on the internal contracts) — never from a client-supplied body/query field —
matching the tenant-isolation convention documented in `docs/production/security.md`. Cross-tenant
access is covered by `skill-platform.e2e.spec.ts`'s "denies cross-tenant access to another
organization's skill installation" and "denies a cross-tenant grant onto an employee that belongs to
a different organization" tests. Inside a capability handle itself, `buildSkillCapabilities()`'s
`object.read` implementation adds a second check — if a skill's own code somehow constructs an
`ObjectReadInput` with a different `organizationId` than its execution context, the handle throws
`SKILL_ORGANIZATION_DENIED` rather than trusting the caller-supplied value
(`skill-capabilities.ts:27-28`).

## Confused-deputy prevention: the tool-call path is re-verified, not trusted

`AgentService.registerSkillTools()` (`apps/api/src/agents/agent.service.ts:2352-2392`) registers one
`skill.<key>` tool per built-in adapter into the shared `ToolRegistry`. This registry is
process-global — every organization's agent process sees the same tool definitions. What actually
restricts which employee can call which skill is the per-turn `available` set, built from
`SkillsRuntimeService.skillsForEmployee()` (only returns granted + enabled skills) at
`agent.service.ts:766-773`. The code comment at `agent.service.ts:2358-2362` states the deeper
guarantee explicitly:

> Even if a tool name were somehow reachable without being in `available`,
> `SkillsRuntimeService.execute()` independently re-verifies installation, employee grant and tenant
> scope — an LLM can never invoke an uninstalled skill merely by naming it.

In other words: tool *availability* (what the LLM is told it can call) and tool *authorization* (what
actually happens when it tries) are two separate checks. If a prompt-injection or model bug caused
the LLM to attempt calling `skill.translation` for an employee that was never granted it, the tool
executor's call into `SkillsRuntimeService.execute()` would hit `assertInstallation()`/
`assertEmployeeGrant()` and throw `SKILL_NOT_INSTALLED`/`SKILL_EMPLOYEE_GRANT_DENIED` regardless of
what the LLM believed was available. This is the same defense-in-depth pattern the rest of the tool
registry uses — availability is a UX/prompt-shaping concern, not a security boundary.

## Which tests cover which security property

From `apps/api/src/skills-platform/skill-runtime.service.spec.ts`
(`describe("SkillsRuntimeService.execute — security and lifecycle")`):

- `"scopes the installation lookup by organizationId (tenant isolation at the query layer)"` —
  layer 2 / tenant isolation.
- `"throws SKILL_NOT_INSTALLED when the organization has no installation of this skill"` — layer 2.
- `"throws SKILL_DISABLED when the installation exists but is disabled"` — layer 2.
- `"throws SKILL_EMPLOYEE_GRANT_DENIED when a pluginInstallationId is supplied without a grant"` /
  `"succeeds for a granted employee installation"` — layer 3.
- `"rejects input that fails the skill's declared JSON schema"` /
  `"rejects output that fails the skill's declared output schema"` — layer 5, schema enforcement.
- `"times out when the adapter exceeds the manifest's timeoutMs"` /
  `"retries a transient failure up to the manifest's retryPolicy and succeeds on a later attempt"` —
  layer 5, resource bounding.
- `"replays a completed execution by idempotency key instead of re-running the adapter"` — replay
  safety (prevents duplicate billing/side effects on retried calls).
- `"throws SKILL_LIMIT_REACHED once the organization's monthly execution entitlement is exhausted"` /
  `"allows execution when usage is below the monthly execution entitlement"` — layer 1.
- `"SkillError carries a stable, safe code distinct from raw error internals"` — confirms error
  messages persisted/returned are bounded and safe, not raw provider/internal output.

From `apps/api/src/skills-platform/skill-platform.e2e.spec.ts` (full HTTP-level flow):

- `"rejects an unauthenticated marketplace request"` — layer 4 (RBAC/auth guard).
- `"denies skill execution before the employee has a grant"` — layer 3, end to end.
- `"denies cross-tenant access to another organization's skill installation"` /
  `"denies a cross-tenant grant onto an employee that belongs to a different organization"` — tenant
  isolation, end to end.
- `"rejects a skill execution with input that fails the skill's declared schema"` — layer 5, end to
  end.
- `"revokes the employee grant and denies further execution"` — layer 3, revocation actually takes
  effect immediately.
- `"stops all execution once the installation is disabled, but keeps history visible"` — layer 2
  disable takes effect, while confirming execution history (audit trail) is not deleted alongside it.

From `apps/api/src/skills-platform/skill-installation.service.spec.ts`:

- `"requires explicit approval before installing a skill that requests a sensitive capability"` /
  `"allows a sensitive-capability skill when approveSensitivePermissions is explicitly true"` — the
  sensitive-capability install gate.
- `"blocks installation when a required dependency is not already installed"` — dependency ordering
  (see cycle-prevention note below).
- `"enforces the SKILLS_MAX_INSTALLED entitlement via consumeCapacity"` /
  `"enforces the SKILLS_MAX_PER_EMPLOYEE entitlement when granting a new (not-yet-granted) skill"` —
  layer 1.
- `"rejects granting to an employee installation that does not belong to this organization"` —
  tenant isolation at the grant boundary.

From `apps/api/src/attachments/attachment.service.spec.ts` (file-routing security surface):

- `"falls back to the legacy extractor when SKILLS_FILE_ROUTING_ENABLED is off"` — feature-flag gate
  respected.
- `"falls back to the legacy extractor when the employee has no granted skill supporting this MIME
  type"` — layer 3 applied to the attachment path specifically.
- `"falls back to the legacy extractor when the skill runtime throws, never failing the upload"` —
  a skill-side failure cannot break an otherwise-working upload path (fail-safe, not fail-open on
  *security*, but fail-open on *availability* — worth being precise about which).

## What is NOT yet defended (be honest about this)

- **No explicit dependency-cycle graph detector.** `SKILL_DEPENDENCY_CYCLE` exists as a declared
  error code in `skill-error.ts` and has an HTTP mapping, but grep confirms nothing in
  `SkillInstallationService` or `SkillsRuntimeService` ever throws it. Cycles are prevented
  *structurally*, not algorithmically: `assertRequiredDependenciesInstalled()` requires a dependency
  to already be `PUBLISHED` and installed *before* the dependent skill can itself be installed
  (`skill-installation.service.ts:576-600`). Since installation order is a strict prerequisite chain
  (A cannot install until B is installed, if A requires B), two skills can never both declare a hard
  `required` dependency on each other and both successfully install — whichever tries to install
  second will fail `SKILL_DEPENDENCY_MISSING` because the other doesn't have a completed installation
  yet to depend on circularly. This is implicit prevention via ordering, not a named graph-cycle
  algorithm, and it only covers `required: true` dependencies at *install* time — a manifest's
  `dependencies` array itself could still declare a cycle on paper (nothing rejects that at publish
  time); it simply could never be satisfied by two mutually-dependent *installations* actually
  succeeding.
- **Rate limiting on the Skills HTTP surface is whatever the platform's global default is**
  (`GENERAL_API`/`AI_EXECUTION` categories per `docs/production/security.md`) — there is no
  skill-specific per-route rate limit beyond the monthly execution entitlement (layer 1), which is a
  cost/abuse control, not a request-rate control.
- **`network.external` is declared but not implemented.** `buildSkillCapabilities()` sets
  `capabilities.network = { available: false }` when granted — no skill can actually reach the
  network through this capability in Sprint 6.1, regardless of manifest declaration or install-time
  approval. The `SKILLS_EXTERNAL_NETWORK` entitlement gate exists and is checked at install/enable
  time, but there is nothing yet to gate *because* the capability itself is a stub.
- **`knowledge.read` is declared but not implemented.** `buildSkillCapabilities()` attaches a
  `capabilities.knowledge.read` handle that unconditionally throws `SKILL_ENTITLEMENT_DENIED` with
  the message "knowledge.read is not implemented in Sprint 6.1" (`skill-capabilities.ts:70-76`). Any
  manifest declaring `knowledge.read` as a required capability will install and pass validation, but
  every execution that actually invokes the handle will fail at runtime. Do not build a skill against
  this capability yet.
- **No per-skill rate limit or circuit breaker** distinct from the platform-wide monthly execution
  cap — a single misbehaving skill/employee combination consuming most of an org's monthly allowance
  cannot be isolated from other skills in that org today.
