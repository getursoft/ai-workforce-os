# @ai-workforce-os/skill-sdk

`packages/skill-sdk/` is the standalone contracts package for the Skills Platform: the
`SkillManifest`/`SkillAdapter`/`SkillExecutionContext` shapes, the permission/capability key
constants, semver helpers, and the Ajv-backed manifest validator. It has no dependency on NestJS,
Prisma, or anything else in `apps/api` — it's the boundary a future hosted-skill runtime would also
depend on (see `docs/skills/publishing.md` for why that runtime doesn't exist yet).

`package.json`: `"main": "dist/index.js"`, `"type": "module"`, dependencies are just `ajv` and
`semver`. All exports below are re-exported from `src/index.ts`.

## Types

| Export | File | Description |
|---|---|---|
| `SkillManifest` | `types/manifest.ts` | The declarative contract a skill publishes — see `docs/skills/manifest.md` for the full field reference. Consumed everywhere: `SkillAdapter.manifest`, `SkillPublisherService.sync()`, `SkillInstallationService`, `SkillsRuntimeService`. |
| `SkillVisibility` | `types/manifest.ts` | `"PUBLIC" \| "PRIVATE" \| "ORG_ONLY"`. |
| `SkillBillingCategory` | `types/manifest.ts` | `"DETERMINISTIC" \| "CPU_INTENSIVE" \| "AI_PROVIDER_BACKED" \| "EXTERNAL_PROVIDER_BACKED" \| "STORAGE_HEAVY"`. Drives the `SKILLS_AI_BACKED` entitlement check in `SkillInstallationService.install()`. |
| `SkillStatefulness` | `types/manifest.ts` | `"STATELESS" \| "STATEFUL"`. Declarative only in Sprint 6.1 — nothing in the runtime branches on it yet. |
| `SkillDependencyDeclaration` | `types/manifest.ts` | `{ skillKey, versionConstraint, required }` — one entry in `manifest.dependencies`. |
| `SkillRetryPolicy` | `types/manifest.ts` | `{ maxRetries, backoffMs }` — read by `SkillsRuntimeService.executeResolved()`. |
| `SkillPermissionKey` | `types/permissions.ts` | The union of RBAC-gated HTTP action keys (`"skill.execute"`, `"skill.install"`, ...). |
| `SkillCapabilityKey` | `types/permissions.ts` | The union of runtime capability handle keys (`"object.read"`, `"ai.provider.execute"`, ...). |
| `SkillPermissionDefinition` | `types/permissions.ts` | `{ key, label, description, sensitive }` — the human-readable metadata behind `SKILL_PERMISSION_DEFINITIONS`. |
| `SkillExecutionContext` | `types/context.ts` | What an adapter's `validate`/`execute`/`health` methods receive — identifiers, granted permission/capability sets, merged configuration, and the `capabilities` handle. See `docs/skills/security.md`. |
| `SkillCapabilities` | `types/context.ts` | The object of least-privilege handles (`object`, `ai`, `knowledge`, `network`) built by `buildSkillCapabilities()`. |
| `ObjectReadInput` | `types/context.ts` | `{ organizationId, key, maxBytes? }` — input to `capabilities.object.read()`. |
| `AiCapabilityInput` / `AiCapabilityResult` | `types/context.ts` | Input/output shape for `capabilities.ai.complete()`. |
| `SkillHealthStatus` | `types/result.ts` | `"HEALTHY" \| "DEGRADED" \| "UNHEALTHY" \| "UNKNOWN"`. |
| `SkillHealthCheck` | `types/result.ts` | `{ name, status, detail? }` — one entry in a health report. |
| `SkillHealthResult` | `types/result.ts` | `{ status, checks, checkedAt }` — returned by `SkillAdapter.health()`. |
| `SkillUsage` | `types/result.ts` | `{ inputTokens?, outputTokens?, totalTokens?, provider?, model?, providerCostMicros? }` — optional usage an adapter can report; the runtime estimates tokens itself when omitted. |
| `SkillExecutionResult<T>` | `types/result.ts` | `{ data: T, usage?, warnings? }` — what `SkillAdapter.execute()` returns. |
| `SkillInstaller` | `types/installer.ts` | Optional `install`/`uninstall`/`enable`/`disable`/`migrate`/`health` lifecycle hooks (see below). |
| `SkillAdapter<TInput, TOutput>` | `types/adapter.ts` | The core contract: `manifest`, optional `installer`, `validate()`, `execute()`, `health()`. |
| `SkillDefinition<TInput, TOutput>` | `types/definition.ts` | `{ adapter, manifest }` pairing — a thin convenience wrapper, not used by the runtime directly today. |

## Functions / constants

| Export | File | Description |
|---|---|---|
| `SKILL_PERMISSION_KEYS` | `types/permissions.ts` | The 9-element readonly array backing `SkillPermissionKey`. Used by `SkillManifestValidator` to allowlist `requiredPermissions`. |
| `SKILL_CAPABILITY_KEYS` | `types/permissions.ts` | The 9-element readonly array backing `SkillCapabilityKey`. Used by `SkillManifestValidator` to allowlist `requiredCapabilities`. |
| `SENSITIVE_CAPABILITY_KEYS` | `types/permissions.ts` | A `Set` of capability keys (`object.write`, `knowledge.write`, `memory.read`, `email.send`, `channel.send`, `network.external`) that trigger the `approveSensitivePermissions` install-time gate in `SkillInstallationService.install()`. |
| `SKILL_PERMISSION_DEFINITIONS` | `types/permissions.ts` | Human-readable label/description/sensitivity for each `SkillPermissionKey`, for admin-facing UI. |
| `toSkillDefinition(adapter)` | `types/definition.ts` | Builds a `SkillDefinition` from an adapter. |
| `installerOf(adapter)` | `types/definition.ts` | Returns `adapter.installer` (or `undefined`). Called throughout `SkillInstallationService` before invoking lifecycle hooks. |
| `healthySkillHealth(checks?, checkedAt?)` | `types/result.ts` | Builds a `SkillHealthResult` with `status: "HEALTHY"`. Every built-in skill's `health()` uses this. |
| `degradedSkillHealth(detail, checks?, checkedAt?)` | `types/result.ts` | `status: "DEGRADED"`, prepends a synthetic check describing `detail`. |
| `unhealthySkillHealth(detail, checks?, checkedAt?)` | `types/result.ts` | `status: "UNHEALTHY"`. |
| `unknownSkillHealth(checkedAt?)` | `types/result.ts` | `status: "UNKNOWN"`, no checks — used when a health probe cannot run at all. |
| `SkillManifestValidator` | `validate/manifest.validator.ts` | Ajv-backed runtime manifest validator. See `docs/skills/manifest.md` for what it enforces. Injected as a NestJS provider in `SkillPlatformModule` and used directly by `SkillPublisherService.sync()`. |
| `SkillManifestValidationError` | `validate/manifest.validator.ts` | `Error` subclass carrying `details: readonly string[]` — every accumulated validation failure, not just the first. |
| `isValidSemver(value)` | `version/semver.ts` | Wraps `semver.valid(value) !== null`. |
| `versionSatisfies(version, constraint)` | `version/semver.ts` | Wraps `semver.satisfies`, `false` on any parse error. |
| `resolveCompatibleVersion(versions, constraint)` | `version/semver.ts` | Highest version in `versions` satisfying `constraint`, or `null`. |
| `latestVersion(versions)` | `version/semver.ts` | Highest **stable** (non-prerelease) version, or `null`. |
| `isCompatibleUpgrade(from, to)` | `version/semver.ts` | `true` when `major(from) === major(to)` and `to >= from`. Drives `SkillInstallationService.updateVersion()`'s same-major rule. |
| `major(version)` | `version/semver.ts` | Extracts the major version number, or `null` for an invalid string. |

## No vitest of its own

`packages/skill-sdk/package.json`'s `test` script is `tsc --noEmit -p tsconfig.json` — typecheck
only, no runtime test runner. This matches every other SDK-style package in this monorepo: none of
them run vitest directly. Behavioral tests for the SDK's exports instead live in the consuming
package, by convention — for `skill-sdk` that's
`apps/api/src/skills-platform/skill-sdk-contracts.spec.ts`, which exercises:

- `SkillManifestValidator` — accepting a valid manifest; rejecting an invalid semver, a malformed
  `inputSchema`/`outputSchema`, an unsupported or duplicate permission key, a prototype-pollution
  field name (`__proto__`), a non-slug `key`, a missing required field; and confirming it reports
  *all* accumulated errors rather than stopping at the first.
- The semver helpers — `isValidSemver`, `versionSatisfies`, `resolveCompatibleVersion`,
  `latestVersion`, `isCompatibleUpgrade`, `major` — each with a well-formed and malformed case.

If you add a new export to the SDK, add its behavioral test to `skill-sdk-contracts.spec.ts`, not to
a new test file inside `packages/skill-sdk/`.
