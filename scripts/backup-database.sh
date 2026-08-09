#!/usr/bin/env bash
# Sprint 5.0 Phase 15: PostgreSQL backup. Wraps pg_dump in the custom format (-Fc), which supports
# parallel restore and selective table restore — plain-SQL dumps support neither. Requires DATABASE_URL
# (or pass one as $1) and the `pg_dump` client on PATH (same major version as the target server, ideally).
#
# Usage:
#   ./scripts/backup-database.sh                                   # uses $DATABASE_URL
#   ./scripts/backup-database.sh "postgresql://user:pass@host/db"  # explicit URL
#   BACKUP_DIR=/path/to/backups ./scripts/backup-database.sh       # custom output directory
set -euo pipefail

DATABASE_URL="${1:-${DATABASE_URL:-}}"
if [[ -z "$DATABASE_URL" ]]; then
  echo "ERROR: DATABASE_URL is not set and no URL was passed as \$1." >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTPUT_FILE="${BACKUP_DIR}/ai-workforce-os-${TIMESTAMP}.dump"

echo "Backing up database to ${OUTPUT_FILE} ..."
pg_dump --format=custom --no-owner --no-privileges --file="$OUTPUT_FILE" "$DATABASE_URL"

SIZE_BYTES=$(wc -c < "$OUTPUT_FILE" | tr -d '[:space:]')
echo "Backup complete: ${OUTPUT_FILE} (${SIZE_BYTES} bytes)"

CHECKSUM_FILE="${OUTPUT_FILE}.sha256"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUTPUT_FILE" > "$CHECKSUM_FILE"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$OUTPUT_FILE" > "$CHECKSUM_FILE"
fi
if [[ -f "$CHECKSUM_FILE" ]]; then
  echo "Checksum written: ${CHECKSUM_FILE}"
fi

echo "Reminder: this backs up the database only. Object storage (S3/R2/MinIO) has its own versioning/"
echo "replication — see docs/operations/backup-and-restore.md. Encryption keys and deployment secrets are"
echo "never part of this backup and must be preserved separately (secrets manager / secure vault)."
