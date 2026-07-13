DROP INDEX IF EXISTS "plugins_organization_id_slug_key";
CREATE UNIQUE INDEX "plugins_organization_id_slug_active_key" ON "plugins"("organization_id","slug") WHERE "deleted_at" IS NULL;
