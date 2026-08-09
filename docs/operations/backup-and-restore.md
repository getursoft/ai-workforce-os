# Backup and Restore

Sprint 5.0 Phase 15. This document covers the database. Object storage (S3/R2/MinIO) has its own
durability/versioning story — see "Object storage" below; it is not covered by `scripts/backup-database.sh`.

## What's covered, what isn't

| Data | Backed up by | Notes |
|---|---|---|
| PostgreSQL (all application data) | `scripts/backup-database.sh` (`pg_dump -Fc`) | Logical backup, not PITR/WAL archiving |
| Object storage (tickets, knowledge files, exports) | Managed provider (S3 versioning / R2 / MinIO) | Not this repo's responsibility — enable bucket versioning at the provider |
| Encryption keys (`PLUGIN_SECRETS_ENCRYPTION_KEY`, JWT secrets, etc.) | Your secrets manager | **Never** included in a database backup. Losing these without a backup makes existing encrypted rows unrecoverable — see `docs/operations/runbooks/credential-rotation.md` |
| Deployment/infrastructure config | Your IaC repo / secrets manager | Not covered here |

## Backup

```bash
DATABASE_URL="postgresql://user:pass@host:5432/db" ./scripts/backup-database.sh
# or: BACKUP_DIR=/mnt/backups ./scripts/backup-database.sh "postgresql://..."
```

Produces a timestamped `.dump` (pg_dump custom format `-Fc`, `--no-owner --no-privileges`) plus a
`.sha256` checksum file. Custom format is used specifically because it supports parallel restore
(`pg_restore -j N`) and selective table restore — a plain SQL dump supports neither.

**Run `pg_dump`/`pg_restore` from a client whose major version matches (or exceeds) the server's.** An
older client against a newer server can silently mishandle server-specific types — this platform's
`KnowledgeChunk.embedding` column uses the pgvector `vector` type, which an old client won't understand.
In this repo's own dev setup, the Postgres server runs 16.x in Docker; if your host's `pg_dump` is older,
run it via `docker exec <container> pg_dump ...` instead, exactly as the verification below did.

**Recommended schedule:** automated daily full backup + your managed Postgres provider's continuous
WAL/PITR if available (RDS, Cloud SQL, Neon, Supabase, etc. all offer this — prefer it over relying on
`pg_dump` alone for point-in-time recovery, since `pg_dump` only gives you discrete daily snapshots, not
continuous replay).

## Restore

```bash
./scripts/restore-database.sh ./backups/ai-workforce-os-<timestamp>.dump "postgresql://user:pass@host/db_restore_test"
```

The script refuses to run unless the target database name contains `_test` or `restore`, or
`CONFIRM_PRODUCTION_RESTORE=yes` is explicitly set — a copy-pasted command can never silently overwrite a
live database.

### Verification checklist (run after every restore, not just the first one)

1. Row counts on a handful of high-signal tables match the source (organizations, users, agent_executions,
   execution_traces at minimum).
2. `prisma migrate status --schema=database/prisma/schema.prisma` against the restored database reports no
   pending/failed migrations.
3. The application boots against the restored database and `/health/ready` returns `ready`.
4. A spot-check login against a known test account succeeds (encrypted refresh tokens, password hashes,
   and plugin secrets all round-trip correctly — a restore that "completes" but silently corrupts
   ciphertext is a real failure mode this checklist exists to catch).

## Restore verification — actually performed (Sprint 5.0 Phase 15)

This was not left as an unverified claim. Executed against the local dev Postgres container
(`ai-workforce-os-postgres`, Postgres 16) on 2026-08-05:

1. `pg_dump -Fc` of `ai_workforce_os_test` → 441,665-byte dump, no errors.
2. `pg_restore --clean --if-exists` into a fresh `ai_workforce_os_restore_verify` database → completed
   with no errors.
3. Row-count comparison, source vs. restored:

   | Table | Source | Restored |
   |---|---|---|
   | organizations | 13 | 13 |
   | users | 13 | 13 |
   | plugins | 0 | 0 |
   | agent_executions | 0 | 0 |
   | execution_traces | 10 | 10 |
   | queue_messages | 0 | 0 |

   All matched exactly. The throwaway database and dump file were deleted immediately after verification.

This confirms the backup/restore *mechanism* works end-to-end against this schema. It does **not**
constitute a full production DR drill — that requires exercising it against production-scale data volume,
from a real managed-Postgres provider's backup artifact, restoring into a genuinely separate environment,
and running the application against the result. See `disaster-recovery.md` for RPO/RTO targets and the
staging drill this should graduate to before a real production launch.

### Second verification (Sprint 5.0A) — against the actual production-like compose stack

Repeated against `ai_workforce_os` (not the test DB) inside the running `docker-compose.production-like.yml`
stack, with data created through the real HTTP API (a genuine `POST /auth/register` — real Argon2 hash,
real JWT issuance, real Prisma writes), not seeded directly:

1. `pg_dump -Fc` via `docker exec ai-workforce-os-postgres-1 pg_dump ...` → 411,375-byte dump, no errors.
2. `pg_restore --clean --if-exists` into a fresh `ai_workforce_os_restore_test` database → no errors.
3. `organizations`/`users` row counts and content (name, slug) matched exactly.
4. **Full schema parity**: `information_schema.tables` count matched exactly — 92/92 tables — on both
   sides, not just a handful of high-signal ones.
5. The `vector` extension (pgvector) was present and functional in the restored database.

Together with the first verification, this confirms the backup/restore mechanism is schema-complete (not
just correct for a curated subset of tables) and works against data that flowed through the real
application stack, not just seed fixtures.

## Object storage

If `STORAGE_PROVIDER=s3` (see `docs/production/environment-variables.md`), enable versioning on the bucket
at the provider level (S3 bucket versioning, R2 object versioning, or MinIO's `mc version enable`). This
platform's `ObjectStorageService` does not implement its own versioning — it defers to the provider, which
is the standard pattern for object storage durability.
