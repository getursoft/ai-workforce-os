# Release Process

Sprint 5.0 Phase 25/28.

## Versioning

Semantic versioning is not currently enforced by tooling (`package.json` version is `0.0.0` across the
workspace) — `commitlint`/`husky` are configured for conventional-commit messages
(`commitlint.config.cjs`), which is the input a future `semantic-release`-style tool would need. Adding
automated version bumping is not part of this pass; commit discipline is already in place to support it
later.

## Migration compatibility policy

**A release's Prisma migrations must be backward-compatible with the previous release's application
code.** Concretely: adding a nullable column or a new table is safe; renaming or dropping a column the
previous release still reads is not — that requires an expand/contract migration split across two releases
(release N adds the new column and dual-writes, release N+1 stops reading the old one, release N+2 drops
it). This is what makes rollback safe (see below) — a rollback never needs a down-migration because forward
migrations never break the previous version's code path.

`pnpm db:migrate` (`prisma migrate deploy`) runs as one controlled step in the deploy pipeline — never
`prisma migrate dev` outside local development, and never run by application replicas themselves on boot
(concurrent replicas racing to migrate is the exact footgun this avoids).

## Feature flags for staged rollout

`FeatureFlagService` (Sprint 5.0 Phase 26) gates rollout of high-risk integrations independent of a code
deploy — ship the code disabled, enable it for one pilot organization
(`setOrganizationFlag(orgId, key, true)`), then platform-wide once confirmed. Suggested flag keys for the
integrations the original spec calls out as high-risk:

- `REAL_WHATSAPP_OUTBOUND`
- `REAL_EMAIL`
- `DISTRIBUTED_QUEUE` (once producers actually migrate onto `QueueConsumerWorker` — see Phase 4 gap)
- `BILLING_ENFORCEMENT` (redundant with `BILLING_ENFORCEMENT_ENABLED` env var today — the env var is the
  simpler global kill switch; use the flag only if per-organization staged rollout of enforcement itself
  is ever needed)
- `EXTERNAL_OBJECT_STORAGE` (`STORAGE_PROVIDER=s3` is already an env-level switch; a flag adds
  per-organization staging on top if needed during a storage migration)
- `AUTOMATIC_COLLABORATION`
- `SCHEDULED_PROACTIVE_MESSAGES`

No flags are pre-seeded — `isEnabled()` defaults to `false` for anything never explicitly set, so nothing
changes behavior until someone deliberately turns a flag on.

## Rollback

Because migrations are additive-only within a release (see above), rollback is: **redeploy the previous
container image tag.** No down-migration, no database rollback. This is why `docker-compose.production-like.yml`
and the reference deployment (`docs/production/deployment.md`) both assume immutable, tagged images rather
than in-place updates.

## Production change checklist

Before deploying a release that touches anything covered by this Sprint 5.0 pass:

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass
- [ ] New/changed env vars documented in `docs/production/environment-variables.md`
- [ ] Migration reviewed for backward compatibility (see policy above)
- [ ] If touching billing/entitlements: confirm `BILLING_ENFORCEMENT_ENABLED` kill switch still works
- [ ] If touching auth/rate-limiting: confirm the change doesn't accidentally rate-limit `/health/live`
  or `/health/ready` (both must stay `@RateLimitExempt()`)
- [ ] Container images built and (ideally) scanned (Trivy step in CI)
- [ ] Rollback plan is "redeploy previous tag" — confirm nothing in this release breaks that assumption

## Known-issues template

```
## Known issues in this release
- [Component]: [what's broken/limited] — [workaround if any] — [tracking reference]
```

## Release notes template

```
## vX.Y.Z — YYYY-MM-DD
### Added
### Changed
### Fixed
### Security
### Known issues
(see Known Issues above)
```
