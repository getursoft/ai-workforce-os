# Publishing Skills

## `SkillPublisherService.sync()`

`apps/api/src/skills-platform/skill-publisher.service.ts` synchronizes the process-local
`SkillRegistryService` (built-in adapters registered via NestJS DI) into the `Skill`/`SkillVersion`
database tables. The manifest code is authoritative for built-in adapter *behavior*; the database
rows are authoritative for marketplace/install *state* — `sync()` is the bridge between them.

### When it runs

`SkillPlatformBootstrapService.onApplicationBootstrap()`
(`apps/api/src/skills-platform/skill-platform.module.ts:40-65`), a NestJS `OnApplicationBootstrap`
hook, runs on every application boot: register the five built-in adapters into
`SkillRegistryService`, then call `publisher.sync()`. There is no separate CLI command or admin
action to trigger it in this sprint — it is purely a boot-time sync. If you change a built-in
manifest, the next process restart republishes it.

### What it does

For every adapter in the registry:

1. Validates the manifest with `SkillManifestValidator.validate()` (see `docs/skills/manifest.md`
   for what that checks).
2. `skill.upsert({ where: { key: manifest.key }, ... })` — creates the `Skill` row if it doesn't
   exist, or updates `name`/`description`/`category`/`author`/`visibility` if it does. **Never**
   touches `Skill.icon` on update (only set on create) and never overwrites anything on the
   `SkillInstallation` side.
3. `skillVersion.findUnique({ skillId_version })` then create-or-update that exact `(skillId,
   version)` row with the manifest's schemas, permissions, capabilities, dependencies, and billing
   category (`versionData()` helper, `skill-publisher.service.ts:114-135`). Publishing the same
   `key@version` twice in a row updates the existing row in place — it never creates a duplicate
   `SkillVersion`.
4. After the loop, recomputes each `Skill.latestVersion` from its `PUBLISHED` versions via
   `latestVersion()` (the SDK's stable-version-picking helper), so `latestVersion` never drifts from
   what's actually published.

Crucially: **`sync()` never touches `SkillInstallation` rows.** An organization's install, its
`enabled` state, and its `configurationJson` are completely untouched by a manifest republish —
upgrading a built-in skill's manifest (say, tightening its `inputSchema`) does not silently change
what any organization already has installed. An org must explicitly call `updateVersion()`
(`docs/skills/versioning.md`) to move onto a newer published version.

### On manifest validation failure

If `SkillManifestValidator.validate()` throws for a given adapter, that adapter's manifest is
**logged and skipped**, not treated as a fatal error — the loop continues to the next adapter, and
the rejected key/version is collected into `result.rejected` (returned to the caller and logged as
`SKILL_MANIFEST_REJECTED` per-adapter, `SKILL_PUBLICATION_PARTIAL` as a summary in the bootstrap
service if any rejections occurred).

If `sync()` itself throws (e.g. the `Skill`/`SkillVersion` tables don't exist yet because migrations
haven't run), `SkillPlatformBootstrapService` catches it and logs
`SKILL_PUBLICATION_SYNC_FAILED` — **the application still boots**. The comment in the bootstrap
service is explicit about the intended failure mode: "the platform will retry the sync on the next
startup." A deployment with missing/unmigrated skill tables boots successfully with zero installable
skills, rather than crash-looping. This mirrors the general production posture in this codebase (see
`docs/production/architecture.md`) of preferring a degraded-but-running state over a hard failure
when a subsystem's storage isn't ready.

## The explicit boundary: built-in only, no third-party skill packages

The original sprint spec's Phase 20/25 draws a hard line that this implementation respects: **built-in,
trusted platform code is supported today; arbitrary third-party executable skill packages are not.**

Every adapter that exists is written by this codebase's own engineers, compiled into the same
process as the API server, and registered through ordinary NestJS dependency injection — there is no
code path that loads, executes, or even parses a skill package supplied by an organization or a
third party. `SkillVersion.runtimeType` is hardcoded to `"BUILT_IN"` for every row `sync()` creates
(`skill-publisher.service.ts:131`); nothing in the schema, publisher, or installation service treats
any other `runtimeType` as executable.

This is a named limitation, not a footnote: shipping a real marketplace where organizations or
partners upload their own skill code would require a sandbox that does not exist in this codebase —
isolated containers or a worker sandbox, signed packages, package verification, network
restrictions, filesystem isolation, and CPU/memory quotas, at minimum. None of that exists. Do not
describe this platform as supporting "custom" or "uploaded" skills; the `SKILLS_CUSTOM` entitlement
key is declared in `entitlement.types.ts` for exactly this future path but is checked nowhere in the
codebase today (see `docs/skills/marketplace.md`'s entitlement table) — it is reserved, not wired.
