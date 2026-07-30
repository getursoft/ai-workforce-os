/*
  Warnings:

  - Made the column `allowed_employee_ids` on table `channel_connections` required. This step will fail if there are existing NULL values in that column.
  - Made the column `supported_domains` on table `employee_routing_profiles` required. This step will fail if there are existing NULL values in that column.
  - Made the column `supported_intents` on table `employee_routing_profiles` required. This step will fail if there are existing NULL values in that column.
  - Made the column `example_queries` on table `employee_routing_profiles` required. This step will fail if there are existing NULL values in that column.
  - Made the column `excluded_intents` on table `employee_routing_profiles` required. This step will fail if there are existing NULL values in that column.
  - Made the column `routing_keywords` on table `employee_routing_profiles` required. This step will fail if there are existing NULL values in that column.
  - Made the column `enabled_for_channel_routing` on table `employee_routing_profiles` required. This step will fail if there are existing NULL values in that column.
  - Made the column `routing_priority` on table `employee_routing_profiles` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "approval_requests" DROP CONSTRAINT "approval_requests_organization_fkey";

-- DropForeignKey
ALTER TABLE "approval_requests" DROP CONSTRAINT "approval_requests_workflow_execution_fkey";

-- DropForeignKey
ALTER TABLE "employee_routing_profiles" DROP CONSTRAINT "erp_organization_fkey";

-- DropForeignKey
ALTER TABLE "employee_routing_profiles" DROP CONSTRAINT "erp_plugin_fkey";

-- AlterTable
ALTER TABLE "approval_requests" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "approved_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "channel_connections" ALTER COLUMN "token_expires_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "last_webhook_received_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "allowed_employee_ids" SET NOT NULL;

-- AlterTable
ALTER TABLE "employee_routing_profiles" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "supported_domains" SET NOT NULL,
ALTER COLUMN "supported_intents" SET NOT NULL,
ALTER COLUMN "example_queries" SET NOT NULL,
ALTER COLUMN "excluded_intents" SET NOT NULL,
ALTER COLUMN "routing_keywords" SET NOT NULL,
ALTER COLUMN "enabled_for_channel_routing" SET NOT NULL,
ALTER COLUMN "routing_priority" SET NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "skill_executions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "workflow_executions" ALTER COLUMN "id" DROP DEFAULT;

-- CreateTable
CREATE TABLE "subscription_plans" (
    "id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "monthly_credit_allowance" INTEGER NOT NULL,
    "overage_enabled" BOOLEAN NOT NULL DEFAULT false,
    "overage_rate_micros_per_credit" INTEGER NOT NULL DEFAULT 0,
    "active_employee_limit" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_subscriptions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
    "billing_cycle_start" TIMESTAMP(3) NOT NULL,
    "billing_cycle_end" TIMESTAMP(3) NOT NULL,
    "monthly_credit_allowance_override" INTEGER,
    "overage_enabled_override" BOOLEAN,
    "hard_limit_enabled" BOOLEAN DEFAULT false,
    "spending_cap_credits" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organisation_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID,
    "agent_execution_id" UUID,
    "conversation_id" UUID,
    "provider" VARCHAR(80),
    "model" VARCHAR(120),
    "usage_type" VARCHAR(60) NOT NULL,
    "capability" VARCHAR(60),
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "reasoning_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "provider_cost_micros" INTEGER,
    "credits_consumed" INTEGER NOT NULL DEFAULT 0,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "status" VARCHAR(20) NOT NULL DEFAULT 'FINAL',
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "idempotency_key" VARCHAR(300) NOT NULL,
    "metadata_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_code_key" ON "subscription_plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_subscriptions_organization_id_key" ON "organisation_subscriptions"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_events_idempotency_key_key" ON "usage_events"("idempotency_key");

-- CreateIndex
CREATE INDEX "usage_events_organization_id_occurred_at_idx" ON "usage_events"("organization_id", "occurred_at");

-- CreateIndex
CREATE INDEX "usage_events_organization_id_plugin_installation_id_occurre_idx" ON "usage_events"("organization_id", "plugin_installation_id", "occurred_at");

-- CreateIndex
CREATE INDEX "usage_events_organization_id_capability_occurred_at_idx" ON "usage_events"("organization_id", "capability", "occurred_at");

-- CreateIndex
CREATE INDEX "usage_events_organization_id_provider_model_occurred_at_idx" ON "usage_events"("organization_id", "provider", "model", "occurred_at");

-- CreateIndex
CREATE INDEX "usage_events_agent_execution_id_idx" ON "usage_events"("agent_execution_id");

-- AddForeignKey
ALTER TABLE "organisation_subscriptions" ADD CONSTRAINT "organisation_subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_subscriptions" ADD CONSTRAINT "organisation_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_workflow_execution_id_fkey" FOREIGN KEY ("workflow_execution_id") REFERENCES "workflow_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_routing_profiles" ADD CONSTRAINT "employee_routing_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_routing_profiles" ADD CONSTRAINT "employee_routing_profiles_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "approval_requests_org_status_created_idx" RENAME TO "approval_requests_organization_id_status_created_at_idx";

-- RenameIndex
ALTER INDEX "approval_requests_workflow_execution_idx" RENAME TO "approval_requests_workflow_execution_id_idx";

-- RenameIndex
ALTER INDEX "channel_connections_org_waba_idx" RENAME TO "channel_connections_organization_id_whatsapp_business_accou_idx";

-- RenameIndex
ALTER INDEX "employee_routing_profiles_org_enabled_idx" RENAME TO "employee_routing_profiles_organization_id_enabled_for_chann_idx";

-- RenameIndex
ALTER INDEX "employee_routing_profiles_plugin_unique" RENAME TO "employee_routing_profiles_plugin_installation_id_key";

-- RenameIndex
ALTER INDEX "skill_executions_conversation_skill_version_idx" RENAME TO "skill_executions_conversation_id_skill_id_skill_version_idx";

-- RenameIndex
ALTER INDEX "skill_executions_org_plugin_conversation_skill_idx" RENAME TO "skill_executions_organization_id_plugin_installation_id_con_idx";

-- RenameIndex
ALTER INDEX "skill_executions_org_status_updated_idx" RENAME TO "skill_executions_organization_id_status_updated_at_idx";

-- RenameIndex
ALTER INDEX "workflow_executions_org_plugin_conversation_type_idx" RENAME TO "workflow_executions_organization_id_plugin_installation_id__idx";

-- RenameIndex
ALTER INDEX "workflow_executions_org_status_updated_idx" RENAME TO "workflow_executions_organization_id_status_updated_at_idx";
