CREATE TYPE "plugin_ai_provider_type" AS ENUM ('DETERMINISTIC', 'OPENAI_COMPATIBLE', 'AZURE_OPENAI');
CREATE TABLE "plugin_ai_configurations" (
  "id" UUID NOT NULL, "organization_id" UUID NOT NULL, "plugin_installation_id" UUID NOT NULL,
  "provider_type" "plugin_ai_provider_type" NOT NULL, "configuration" JSONB NOT NULL,
  "encrypted_secrets" JSONB NOT NULL, "encryption_version" INTEGER NOT NULL DEFAULT 1,
  "updated_by" UUID NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL, CONSTRAINT "plugin_ai_configurations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "plugin_ai_configurations_plugin_installation_id_key" ON "plugin_ai_configurations"("plugin_installation_id");
CREATE INDEX "plugin_ai_configurations_organization_id_provider_type_idx" ON "plugin_ai_configurations"("organization_id", "provider_type");
CREATE INDEX "plugin_ai_configurations_organization_id_plugin_installation_id_idx" ON "plugin_ai_configurations"("organization_id", "plugin_installation_id");
ALTER TABLE "plugin_ai_configurations" ADD CONSTRAINT "plugin_ai_configurations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plugin_ai_configurations" ADD CONSTRAINT "plugin_ai_configurations_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plugin_ai_configurations" ADD CONSTRAINT "plugin_ai_configurations_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
