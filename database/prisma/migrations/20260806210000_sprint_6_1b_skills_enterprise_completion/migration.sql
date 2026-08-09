-- CreateEnum
CREATE TYPE "skill_pipeline_node_failure_mode" AS ENUM ('STOP', 'CONTINUE');

-- CreateEnum
CREATE TYPE "skill_pipeline_execution_status" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "skill_pipeline_node_execution_status" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "skill_pack_installation_status" AS ENUM ('INSTALLED', 'PARTIAL', 'UNINSTALLED');

-- CreateTable
CREATE TABLE "skill_pipelines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "skill_pipelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_pipeline_nodes" (
    "id" UUID NOT NULL,
    "skill_pipeline_id" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "skill_key" VARCHAR(160) NOT NULL,
    "version_constraint" VARCHAR(80),
    "condition_expression" VARCHAR(500),
    "on_failure" "skill_pipeline_node_failure_mode" NOT NULL DEFAULT 'STOP',
    "timeout_ms" INTEGER,
    "max_retries" INTEGER NOT NULL DEFAULT 0,
    "input_mapping_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_pipeline_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_pipeline_executions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "skill_pipeline_id" UUID NOT NULL,
    "plugin_installation_id" UUID,
    "status" "skill_pipeline_execution_status" NOT NULL DEFAULT 'RUNNING',
    "trace_id" VARCHAR(64),
    "trigger_input_json" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_pipeline_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_pipeline_node_executions" (
    "id" UUID NOT NULL,
    "skill_pipeline_execution_id" UUID NOT NULL,
    "skill_pipeline_node_id" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "skill_key" VARCHAR(160) NOT NULL,
    "status" "skill_pipeline_node_execution_status" NOT NULL DEFAULT 'PENDING',
    "skill_run_id" UUID,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(100),
    "error_message_safe" VARCHAR(500),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_pipeline_node_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_packs" (
    "id" UUID NOT NULL,
    "key" VARCHAR(160) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "category" VARCHAR(100) NOT NULL,
    "industry" VARCHAR(100),
    "author" VARCHAR(160) NOT NULL,
    "icon" VARCHAR(500),
    "version" VARCHAR(50) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "skill_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_pack_items" (
    "id" UUID NOT NULL,
    "skill_pack_id" UUID NOT NULL,
    "skill_key" VARCHAR(160) NOT NULL,
    "version_constraint" VARCHAR(80) NOT NULL DEFAULT '*',
    "required" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_pack_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_pack_installations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "skill_pack_id" UUID NOT NULL,
    "pack_version" VARCHAR(50) NOT NULL,
    "status" "skill_pack_installation_status" NOT NULL DEFAULT 'INSTALLED',
    "installed_by_user_id" UUID NOT NULL,
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "skill_pack_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_templates" (
    "id" UUID NOT NULL,
    "key" VARCHAR(160) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "category" VARCHAR(100) NOT NULL,
    "industry" VARCHAR(100),
    "author" VARCHAR(160) NOT NULL,
    "icon" VARCHAR(500),
    "target_plugin_id" VARCHAR(160) NOT NULL,
    "workflow_ref" VARCHAR(160),
    "version" VARCHAR(50) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "skill_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_template_items" (
    "id" UUID NOT NULL,
    "skill_template_id" UUID NOT NULL,
    "skill_key" VARCHAR(160) NOT NULL,
    "version_constraint" VARCHAR(80) NOT NULL DEFAULT '*',
    "order" INTEGER NOT NULL,
    "default_configuration_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_template_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_template_installations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "skill_template_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "installed_by_user_id" UUID NOT NULL,
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_template_installations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "skill_pipelines_organization_id_deleted_at_idx" ON "skill_pipelines"("organization_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "skill_pipeline_nodes_skill_pipeline_id_order_key" ON "skill_pipeline_nodes"("skill_pipeline_id", "order");

-- CreateIndex
CREATE INDEX "skill_pipeline_executions_organization_id_skill_pipeline_id_idx" ON "skill_pipeline_executions"("organization_id", "skill_pipeline_id", "created_at");

-- CreateIndex
CREATE INDEX "skill_pipeline_executions_organization_id_plugin_installati_idx" ON "skill_pipeline_executions"("organization_id", "plugin_installation_id", "created_at");

-- CreateIndex
CREATE INDEX "skill_pipeline_node_executions_skill_pipeline_execution_id__idx" ON "skill_pipeline_node_executions"("skill_pipeline_execution_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "skill_packs_key_key" ON "skill_packs"("key");

-- CreateIndex
CREATE INDEX "skill_packs_category_idx" ON "skill_packs"("category");

-- CreateIndex
CREATE UNIQUE INDEX "skill_pack_items_skill_pack_id_skill_key_key" ON "skill_pack_items"("skill_pack_id", "skill_key");

-- CreateIndex
CREATE INDEX "skill_pack_installations_organization_id_deleted_at_idx" ON "skill_pack_installations"("organization_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "skill_pack_installations_organization_id_skill_pack_id_key" ON "skill_pack_installations"("organization_id", "skill_pack_id");

-- CreateIndex
CREATE UNIQUE INDEX "skill_templates_key_key" ON "skill_templates"("key");

-- CreateIndex
CREATE INDEX "skill_templates_category_idx" ON "skill_templates"("category");

-- CreateIndex
CREATE UNIQUE INDEX "skill_template_items_skill_template_id_skill_key_key" ON "skill_template_items"("skill_template_id", "skill_key");

-- CreateIndex
CREATE INDEX "skill_template_installations_organization_id_skill_template_idx" ON "skill_template_installations"("organization_id", "skill_template_id");

-- CreateIndex
CREATE INDEX "skill_template_installations_organization_id_plugin_install_idx" ON "skill_template_installations"("organization_id", "plugin_installation_id");

-- AddForeignKey
ALTER TABLE "skill_pipelines" ADD CONSTRAINT "skill_pipelines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_pipelines" ADD CONSTRAINT "skill_pipelines_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_pipeline_nodes" ADD CONSTRAINT "skill_pipeline_nodes_skill_pipeline_id_fkey" FOREIGN KEY ("skill_pipeline_id") REFERENCES "skill_pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_pipeline_executions" ADD CONSTRAINT "skill_pipeline_executions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_pipeline_executions" ADD CONSTRAINT "skill_pipeline_executions_skill_pipeline_id_fkey" FOREIGN KEY ("skill_pipeline_id") REFERENCES "skill_pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_pipeline_executions" ADD CONSTRAINT "skill_pipeline_executions_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_pipeline_node_executions" ADD CONSTRAINT "skill_pipeline_node_executions_skill_pipeline_execution_id_fkey" FOREIGN KEY ("skill_pipeline_execution_id") REFERENCES "skill_pipeline_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_pipeline_node_executions" ADD CONSTRAINT "skill_pipeline_node_executions_skill_run_id_fkey" FOREIGN KEY ("skill_run_id") REFERENCES "skill_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_pack_items" ADD CONSTRAINT "skill_pack_items_skill_pack_id_fkey" FOREIGN KEY ("skill_pack_id") REFERENCES "skill_packs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_pack_installations" ADD CONSTRAINT "skill_pack_installations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_pack_installations" ADD CONSTRAINT "skill_pack_installations_skill_pack_id_fkey" FOREIGN KEY ("skill_pack_id") REFERENCES "skill_packs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_pack_installations" ADD CONSTRAINT "skill_pack_installations_installed_by_user_id_fkey" FOREIGN KEY ("installed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_template_items" ADD CONSTRAINT "skill_template_items_skill_template_id_fkey" FOREIGN KEY ("skill_template_id") REFERENCES "skill_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_template_installations" ADD CONSTRAINT "skill_template_installations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_template_installations" ADD CONSTRAINT "skill_template_installations_skill_template_id_fkey" FOREIGN KEY ("skill_template_id") REFERENCES "skill_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_template_installations" ADD CONSTRAINT "skill_template_installations_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_template_installations" ADD CONSTRAINT "skill_template_installations_installed_by_user_id_fkey" FOREIGN KEY ("installed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

