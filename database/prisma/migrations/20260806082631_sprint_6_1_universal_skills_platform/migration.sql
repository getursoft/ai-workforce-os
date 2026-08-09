-- CreateEnum
CREATE TYPE "skill_visibility" AS ENUM ('PUBLIC', 'PRIVATE', 'ORG_ONLY');

-- CreateEnum
CREATE TYPE "skill_version_status" AS ENUM ('DRAFT', 'PUBLISHED', 'DEPRECATED', 'RETIRED');

-- CreateEnum
CREATE TYPE "skill_installation_status" AS ENUM ('INSTALLED', 'ENABLED', 'DISABLED', 'FAILED', 'UNINSTALLED');

-- CreateEnum
CREATE TYPE "skill_run_status" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "skill_billing_category" AS ENUM ('DETERMINISTIC', 'CPU_INTENSIVE', 'AI_PROVIDER_BACKED', 'EXTERNAL_PROVIDER_BACKED', 'STORAGE_HEAVY');

-- CreateTable
CREATE TABLE "skills" (
    "id" UUID NOT NULL,
    "key" VARCHAR(160) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "category" VARCHAR(100) NOT NULL,
    "author" VARCHAR(160) NOT NULL,
    "visibility" "skill_visibility" NOT NULL DEFAULT 'PUBLIC',
    "icon" VARCHAR(500),
    "latestVersion" VARCHAR(50) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_versions" (
    "id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "version" VARCHAR(50) NOT NULL,
    "manifest_json" JSONB NOT NULL,
    "input_schema_json" JSONB NOT NULL,
    "output_schema_json" JSONB NOT NULL,
    "configuration_schema_json" JSONB,
    "required_permissions_json" JSONB NOT NULL DEFAULT '[]',
    "required_capabilities_json" JSONB NOT NULL DEFAULT '[]',
    "dependency_manifest_json" JSONB,
    "billingCategory" "skill_billing_category" NOT NULL DEFAULT 'DETERMINISTIC',
    "runtimeType" VARCHAR(40) NOT NULL DEFAULT 'BUILT_IN',
    "status" "skill_version_status" NOT NULL DEFAULT 'PUBLISHED',
    "published_at" TIMESTAMP(3),
    "deprecated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_installations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "skill_version_id" UUID NOT NULL,
    "status" "skill_installation_status" NOT NULL DEFAULT 'INSTALLED',
    "configuration_json" JSONB NOT NULL DEFAULT '{}',
    "installed_by_user_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "skill_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_skill_grants" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "skill_installation_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "configuration_override_json" JSONB,
    "granted_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_skill_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "skill_installation_id" UUID NOT NULL,
    "plugin_installation_id" UUID,
    "agent_execution_id" UUID,
    "workflow_execution_id" UUID,
    "conversation_id" UUID,
    "trace_id" VARCHAR(64),
    "idempotency_key" VARCHAR(300) NOT NULL,
    "skill_key" VARCHAR(160) NOT NULL,
    "skill_version" VARCHAR(50) NOT NULL,
    "status" "skill_run_status" NOT NULL DEFAULT 'RUNNING',
    "input_summary_json" JSONB NOT NULL DEFAULT '{}',
    "output_summary_json" JSONB,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "credits_consumed" INTEGER NOT NULL DEFAULT 0,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(100),
    "error_message_safe" VARCHAR(500),
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_dependencies" (
    "id" UUID NOT NULL,
    "skill_version_id" UUID NOT NULL,
    "dependency_skill_key" VARCHAR(160) NOT NULL,
    "versionConstraint" VARCHAR(80) NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "skills_key_key" ON "skills"("key");

-- CreateIndex
CREATE INDEX "skills_category_idx" ON "skills"("category");

-- CreateIndex
CREATE INDEX "skills_isActive_deleted_at_idx" ON "skills"("isActive", "deleted_at");

-- CreateIndex
CREATE INDEX "skill_versions_skill_id_status_idx" ON "skill_versions"("skill_id", "status");

-- CreateIndex
CREATE INDEX "skill_versions_skill_id_status_version_idx" ON "skill_versions"("skill_id", "status", "version");

-- CreateIndex
CREATE UNIQUE INDEX "skill_versions_skill_id_version_key" ON "skill_versions"("skill_id", "version");

-- CreateIndex
CREATE INDEX "skill_installations_organization_id_enabled_deleted_at_idx" ON "skill_installations"("organization_id", "enabled", "deleted_at");

-- CreateIndex
CREATE INDEX "skill_installations_organization_id_deleted_at_idx" ON "skill_installations"("organization_id", "deleted_at");

-- CreateIndex
CREATE INDEX "skill_installations_skill_version_id_idx" ON "skill_installations"("skill_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "skill_installations_organization_id_skill_version_id_key" ON "skill_installations"("organization_id", "skill_version_id");

-- CreateIndex
CREATE INDEX "employee_skill_grants_organization_id_skill_installation_id_idx" ON "employee_skill_grants"("organization_id", "skill_installation_id");

-- CreateIndex
CREATE INDEX "employee_skill_grants_organization_id_plugin_installation_i_idx" ON "employee_skill_grants"("organization_id", "plugin_installation_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "employee_skill_grants_organization_id_plugin_installation_i_key" ON "employee_skill_grants"("organization_id", "plugin_installation_id", "skill_installation_id");

-- CreateIndex
CREATE INDEX "skill_runs_organization_id_skill_installation_id_created_at_idx" ON "skill_runs"("organization_id", "skill_installation_id", "created_at");

-- CreateIndex
CREATE INDEX "skill_runs_organization_id_plugin_installation_id_created_a_idx" ON "skill_runs"("organization_id", "plugin_installation_id", "created_at");

-- CreateIndex
CREATE INDEX "skill_runs_organization_id_trace_id_idx" ON "skill_runs"("organization_id", "trace_id");

-- CreateIndex
CREATE UNIQUE INDEX "skill_runs_organization_id_idempotency_key_key" ON "skill_runs"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "skill_dependencies_skill_version_id_dependency_skill_key_key" ON "skill_dependencies"("skill_version_id", "dependency_skill_key");

-- AddForeignKey
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_installations" ADD CONSTRAINT "skill_installations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_installations" ADD CONSTRAINT "skill_installations_skill_version_id_fkey" FOREIGN KEY ("skill_version_id") REFERENCES "skill_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_installations" ADD CONSTRAINT "skill_installations_installed_by_user_id_fkey" FOREIGN KEY ("installed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_skill_grants" ADD CONSTRAINT "employee_skill_grants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_skill_grants" ADD CONSTRAINT "employee_skill_grants_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_skill_grants" ADD CONSTRAINT "employee_skill_grants_skill_installation_id_fkey" FOREIGN KEY ("skill_installation_id") REFERENCES "skill_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_skill_grants" ADD CONSTRAINT "employee_skill_grants_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_skill_installation_id_fkey" FOREIGN KEY ("skill_installation_id") REFERENCES "skill_installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_agent_execution_id_fkey" FOREIGN KEY ("agent_execution_id") REFERENCES "agent_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_workflow_execution_id_fkey" FOREIGN KEY ("workflow_execution_id") REFERENCES "workflow_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_dependencies" ADD CONSTRAINT "skill_dependencies_skill_version_id_fkey" FOREIGN KEY ("skill_version_id") REFERENCES "skill_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

