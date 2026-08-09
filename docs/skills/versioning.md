# Skill Versioning

## Semver support

`packages/skill-sdk/src/version/semver.ts` wraps the `semver` npm package with the platform's own
constraint semantics:

- **Exact version**: `resolveByConstraint(key, "1.2.0")` in `SkillRegistryService` checks
  `versions.get("1.2.0")` first, before falling back to constraint resolution.
- **Compatible/range constraints**: any string `semver.satisfies()` understands — carets (`^1.0.0`),
  tildes (`~1.2.0`), or full range expressions (`>=1.2.0 <2.0.0`) — resolved via
  `resolveCompatibleVersion(versions, constraint)`, which filters to valid-semver, constraint-
  satisfying candidates and returns the highest one.
- **No constraint**: resolves to `latestVersion(versions)` — the highest **stable** (non-prerelease)
  registered version.

These same helpers are used on both sides of the platform: `SkillRegistryService` resolves an
*adapter* by key/constraint (in-process), and `SkillInstallationService.resolvePublishedVersion()`
resolves a *database* `SkillVersion` row by the same logic — they can diverge only if the registered
adapters and the published `SkillVersion` rows are out of sync, which `SkillPublisherService.sync()`
exists to prevent (see `docs/skills/publishing.md`).

## Same-major compatible upgrades

`SkillInstallationService.updateVersion(organizationId, userId, installationId, versionConstraint)`
(`skill-installation.service.ts:306-357`) is the only way an installation's version changes after
install. It:

1. Resolves the target published version via `resolvePublishedVersion()`.
2. Throws `SKILL_INSTALLATION_STATE_CONFLICT` if the target is the same version already installed.
3. Calls `isCompatibleUpgrade(currentVersion, targetVersion)` — `true` only when
   `semver.major(from) === semver.major(to)` **and** `semver.gte(to, from)`. If false (a major
   version bump, or a target that's actually older), throws `SKILL_DEPENDENCY_VERSION_CONFLICT` with
   the message "Incompatible major version; rollback not possible automatically". There is no
   mechanism in this sprint to force a cross-major upgrade — a skill's own major-version bump is
   treated as a breaking change the installation service refuses to apply automatically.

```typescript
export function isCompatibleUpgrade(from: string, to: string): boolean {
  if (!isValidSemver(from) || !isValidSemver(to)) return false;
  return semver.major(from) === semver.major(to) && semver.gte(to, from);
}
```

## Configuration preservation and the rollback trail

Upgrading preserves configuration rather than resetting it. If the *new* version's adapter provides
an `installer.migrate(fromVersion, toVersion, configuration)` hook, it's called and its return value
becomes the new configuration (a thrown error from `migrate()` is turned into
`SKILL_INVALID_CONFIGURATION`, aborting the upgrade). If no `migrate()` hook exists, the existing
configuration is carried forward as-is. Either way, the resulting configuration is re-validated
against the *target* manifest's `configurationSchema` before being persisted.

Before persisting, `updateVersion()` stamps the outgoing version onto the configuration itself:

```typescript
const meta = readRecord(configuration._meta);
meta.previousSkillVersionId = installation.skillVersionId;
configuration = { ...configuration, _meta: meta };
```

This is what makes `rollbackVersion()` possible without a separate history table: it reads
`configuration._meta.previousSkillVersionId` back out, looks up that `SkillVersion` (must still be
`PUBLISHED`), and points the installation back at it — then strips `_meta` from the restored
configuration (`skill-installation.service.ts:373-374`) so a rollback doesn't itself leave a stale
pointer behind. Because `_meta.previousSkillVersionId` is only ever one version deep, rollback
supports exactly one step back — there is no multi-step undo history. If no `_meta` is present (never
upgraded, or already rolled back once), `rollbackVersion()` throws
`SKILL_INSTALLATION_STATE_CONFLICT` with "No previous version to roll back to".

Every lifecycle transition — install, uninstall, enable, disable, `updateVersion`,
`rollbackVersion` — records a matching audit event (`SKILL_INSTALLED`, `SKILL_VERSION_UPDATED`,
`SKILL_VERSION_ROLLED_BACK`, etc.) via `AuditEventLogger`, including `fromVersion`/`toVersion` for the
version-change events.

## `SkillRun` permanently records the exact version used

`SkillRun.skillVersion` (`schema.prisma:3531`) is set from `manifest.version` at execution time
(`createRun()` in `skill-runtime.service.ts:339-364`) and never updated afterward. This means an
installation's execution history is not silently rewritten when the installation is later upgraded
or rolled back — a `SkillRun` from before an upgrade still shows the version that actually ran, even
though `SkillInstallation.skillVersionId` now points somewhere else. This is deliberate: billing,
audit, and debugging all need to reflect what code actually executed, not what's currently installed.
