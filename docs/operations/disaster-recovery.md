# Disaster Recovery

Sprint 5.0 Phase 15. Companion to `backup-and-restore.md` — that document covers the mechanics; this one
covers targets and the drill process.

## Target values

These are *targets to design toward*, not measured guarantees of any specific managed Postgres provider —
your actual RPO/RTO depend on which provider you deploy to and its PITR granularity.

| Scenario | RPO (data loss window) | RTO (time to restore service) |
|---|---|---|
| Database corruption/accidental delete, PITR-capable provider available | Seconds to minutes (continuous WAL replay) | Provider-dependent, typically 10–60 min |
| Database corruption/accidental delete, `pg_dump` snapshot only | Up to 24h (since last scheduled backup) | 30–90 min (restore time scales with data volume) |
| Full region/provider outage | Depends on cross-region replica strategy (not configured by this repo — infrastructure responsibility) | Depends on failover strategy |
| Object storage loss | Near-zero if provider versioning is enabled | Minutes (provider-dependent) |

**Prefer a PITR-capable managed Postgres provider over relying on `pg_dump` alone.** `pg_dump` backups are
discrete daily snapshots — anything written between backups is unrecoverable through that mechanism.

## What this repo does NOT configure

Per the honest audit in Phase 1: this repository does not configure WAL archiving, streaming replication,
cross-region failover, or automated backup scheduling/retention — those are managed-provider or
infrastructure-as-code responsibilities, layered on top of `scripts/backup-database.sh` and
`scripts/restore-database.sh`. Do not claim production DR readiness based on this repo's contents alone.

## Staging DR drill (do this before a real production launch)

The Phase 15 verification in `backup-and-restore.md` proved the backup/restore *mechanism* works against
this schema, using a small local dataset. Before trusting this in production, run the full drill at
production-like scale:

1. Take a backup of the staging database (or a production-scale synthetic dataset — never real customer
   data outside production).
2. Provision a genuinely separate Postgres instance (not the same server/container).
3. Restore the backup into it, timing the full restore (this is your realistic RTO baseline for that data
   volume).
4. Point a staging copy of the API at the restored database (`DATABASE_URL` override) and run:
   - `prisma migrate status` — no pending/failed migrations
   - `GET /health/ready` — `ready`
   - A real login + one AI execution + one knowledge search, to confirm encrypted columns (refresh tokens,
     plugin secrets) decrypt correctly — a restore that silently corrupts ciphertext still "succeeds" by
     `pg_restore`'s own exit code.
5. Record the actual RTO observed and compare it against the target table above. If it's meaningfully
   higher, that's a real input into whether `pg_dump` snapshots alone are sufficient or a PITR-capable
   provider is required.
6. Tear down the drill environment; never leave a restored copy of production data sitting in staging.

## Encryption key loss

`PLUGIN_SECRETS_ENCRYPTION_KEY` (and, once in use, `PLATFORM_ENCRYPTION_KEY`) are never included in a
database backup. If the key is lost with no rotation history, every row it encrypted (connector
credentials, plugin secrets, payment gateway config) becomes permanently unrecoverable — the ciphertext
is still there, but nothing can decrypt it. Store these in a secrets manager with its own backup/versioning
(AWS Secrets Manager, Azure Key Vault, HashiCorp Vault), separate from the database backup path entirely.
See `docs/operations/runbooks/credential-rotation.md`.

## Incident severity → response

| Severity | Example | Response |
|---|---|---|
| SEV1 | Database unreachable, API down for all tenants | Page on-call immediately, follow `runbooks/database-unavailable.md` |
| SEV2 | One organization's data corrupted, others unaffected | Restore that org's data from backup if isolable; otherwise full restore during a maintenance window |
| SEV3 | Degraded but functional (queue backlog, slow queries) | Follow the relevant runbook, no immediate restore needed |

See `docs/operations/incident-response.md` for the general incident process and
`docs/operations/runbooks/` for scenario-specific steps.
