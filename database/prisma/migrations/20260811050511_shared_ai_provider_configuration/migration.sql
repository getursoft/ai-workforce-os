-- CreateEnum
CREATE TYPE "ai_provider_connection_status" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ai_provider_health_status" AS ENUM ('HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ai_profile_purpose" AS ENUM ('DEFAULT', 'ROUTING', 'CONVERSATION', 'REASONING', 'EXTRACTION', 'SUMMARIZATION', 'EMBEDDING');

-- CreateTable
CREATE TABLE "ai_provider_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "provider_type" "plugin_ai_provider_type" NOT NULL,
    "base_url" VARCHAR(500),
    "encrypted_credential_json" JSONB NOT NULL,
    "encryption_version" INTEGER NOT NULL DEFAULT 1,
    "status" "ai_provider_connection_status" NOT NULL DEFAULT 'ACTIVE',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "last_health_check_at" TIMESTAMP(3),
    "last_health_status" "ai_provider_health_status" NOT NULL DEFAULT 'UNKNOWN',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_provider_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_model_profiles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider_connection_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "purpose" "ai_profile_purpose" NOT NULL DEFAULT 'DEFAULT',
    "model" VARCHAR(160),
    "embedding_model" VARCHAR(160),
    "temperature" DECIMAL(3,2),
    "max_output_tokens" INTEGER,
    "timeout_ms" INTEGER,
    "additional_settings_json" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_model_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_ai_profile_assignments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "model_profile_id" UUID NOT NULL,
    "purpose" "ai_profile_purpose" NOT NULL DEFAULT 'DEFAULT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_ai_profile_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_ai_defaults" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "default_profile_id" UUID,
    "routing_profile_id" UUID,
    "reasoning_profile_id" UUID,
    "embedding_profile_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_ai_defaults_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_provider_connections_organization_id_idx" ON "ai_provider_connections"("organization_id");

-- CreateIndex
CREATE INDEX "ai_provider_connections_organization_id_status_idx" ON "ai_provider_connections"("organization_id", "status");

-- CreateIndex
CREATE INDEX "ai_model_profiles_organization_id_idx" ON "ai_model_profiles"("organization_id");

-- CreateIndex
CREATE INDEX "ai_model_profiles_organization_id_purpose_idx" ON "ai_model_profiles"("organization_id", "purpose");

-- CreateIndex
CREATE INDEX "ai_model_profiles_organization_id_purpose_is_default_idx" ON "ai_model_profiles"("organization_id", "purpose", "is_default");

-- CreateIndex
CREATE INDEX "ai_model_profiles_provider_connection_id_idx" ON "ai_model_profiles"("provider_connection_id");

-- CreateIndex
CREATE INDEX "employee_ai_profile_assignments_organization_id_idx" ON "employee_ai_profile_assignments"("organization_id");

-- CreateIndex
CREATE INDEX "employee_ai_profile_assignments_model_profile_id_idx" ON "employee_ai_profile_assignments"("model_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_ai_profile_assignments_organization_id_plugin_inst_key" ON "employee_ai_profile_assignments"("organization_id", "plugin_installation_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "organization_ai_defaults_organization_id_key" ON "organization_ai_defaults"("organization_id");

-- AddForeignKey
ALTER TABLE "ai_provider_connections" ADD CONSTRAINT "ai_provider_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_provider_connections" ADD CONSTRAINT "ai_provider_connections_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_model_profiles" ADD CONSTRAINT "ai_model_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_model_profiles" ADD CONSTRAINT "ai_model_profiles_provider_connection_id_fkey" FOREIGN KEY ("provider_connection_id") REFERENCES "ai_provider_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_ai_profile_assignments" ADD CONSTRAINT "employee_ai_profile_assignments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_ai_profile_assignments" ADD CONSTRAINT "employee_ai_profile_assignments_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_ai_profile_assignments" ADD CONSTRAINT "employee_ai_profile_assignments_model_profile_id_fkey" FOREIGN KEY ("model_profile_id") REFERENCES "ai_model_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_ai_defaults" ADD CONSTRAINT "organization_ai_defaults_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_ai_defaults" ADD CONSTRAINT "organization_ai_defaults_default_profile_id_fkey" FOREIGN KEY ("default_profile_id") REFERENCES "ai_model_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_ai_defaults" ADD CONSTRAINT "organization_ai_defaults_routing_profile_id_fkey" FOREIGN KEY ("routing_profile_id") REFERENCES "ai_model_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_ai_defaults" ADD CONSTRAINT "organization_ai_defaults_reasoning_profile_id_fkey" FOREIGN KEY ("reasoning_profile_id") REFERENCES "ai_model_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_ai_defaults" ADD CONSTRAINT "organization_ai_defaults_embedding_profile_id_fkey" FOREIGN KEY ("embedding_profile_id") REFERENCES "ai_model_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "receptionist_handoffs_organization_id_conversation_id_status_id" RENAME TO "receptionist_handoffs_organization_id_conversation_id_statu_idx";

-- RenameIndex
ALTER INDEX "receptionist_handoffs_organization_id_customer_identity_id_stat" RENAME TO "receptionist_handoffs_organization_id_customer_identity_id__idx";

-- RenameIndex
ALTER INDEX "receptionist_handoffs_organization_id_target_employee_installat" RENAME TO "receptionist_handoffs_organization_id_target_employee_insta_idx";
