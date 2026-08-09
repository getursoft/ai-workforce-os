#!/usr/bin/env bash
# Sprint 5.0 Phase 15: PostgreSQL restore, paired with backup-database.sh's custom-format (-Fc) dumps.
# Restores into the TARGET database named in DATABASE_URL — refuses to run unless that database name
# contains "restore_test" or "_test", or CONFIRM_PRODUCTION_RESTORE=yes is explicitly set, so this can
# never be pointed at a live production database by a copy-pasted command.
#
# Usage:
#   ./scripts/restore-database.sh ./backups/ai-workforce-os-<timestamp>.dump "postgresql://.../db_restore_test"
set -euo pipefail

DUMP_FILE="${1:-}"
TARGET_URL="${2:-${DATABASE_URL:-}}"

if [[ -z "$DUMP_FILE" || ! -f "$DUMP_FILE" ]]; then
  echo "ERROR: pass the path to a .dump file produced by backup-database.sh as \$1." >&2
  exit 1
fi
if [[ -z "$TARGET_URL" ]]; then
  echo "ERROR: no target database URL — pass as \$2 or set DATABASE_URL." >&2
  exit 1
fi

DB_NAME="${TARGET_URL##*/}"
DB_NAME="${DB_NAME%%\?*}"
if [[ "$DB_NAME" != *"_test"* && "$DB_NAME" != *"restore"* && "${CONFIRM_PRODUCTION_RESTORE:-}" != "yes" ]]; then
  echo "ERROR: target database '${DB_NAME}' doesn't look like a restore/test database." >&2
  echo "This script restores by DROPPING the target database's contents — never point it at production" >&2
  echo "without deliberately setting CONFIRM_PRODUCTION_RESTORE=yes, and even then, only during a" >&2
  echo "declared incident with a second person confirming." >&2
  exit 1
fi

echo "Restoring ${DUMP_FILE} into ${DB_NAME} ..."
STARTED_AT=$(date +%s)
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$TARGET_URL" "$DUMP_FILE"
ENDED_AT=$(date +%s)

echo "Restore complete in $((ENDED_AT - STARTED_AT))s."
echo "Now run the verification checklist in docs/operations/backup-and-restore.md — a restore that"
echo "completes without error is not the same claim as a restore that produced a correct database."
