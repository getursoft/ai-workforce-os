-- Repair databases where the Sprint 2.2 migration was applied before the
-- users.deleted_at soft-delete column was added to its migration file.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);
