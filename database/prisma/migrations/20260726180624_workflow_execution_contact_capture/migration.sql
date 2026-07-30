-- CreateEnum
CREATE TYPE "workflow_type" AS ENUM ('CONTACT_CAPTURE');

-- CreateEnum
CREATE TYPE "workflow_status" AS ENUM ('ACTIVE', 'WAITING_FOR_INPUT', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "workflow_executions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "workflow_type" "workflow_type" NOT NULL,
    "status" "workflow_status" NOT NULL DEFAULT 'ACTIVE',
    "current_step" VARCHAR(100) NOT NULL,
    "pending_input" VARCHAR(100),
    "state" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "processed_turn_ids" JSONB NOT NULL DEFAULT '[]',
    "active_key" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "workflow_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflow_executions_active_key_key" ON "workflow_executions"("active_key");

-- CreateIndex
CREATE INDEX "workflow_executions_org_plugin_conversation_type_idx" ON "workflow_executions"("organization_id", "plugin_installation_id", "conversation_id", "workflow_type");

-- CreateIndex
CREATE INDEX "workflow_executions_org_status_updated_idx" ON "workflow_executions"("organization_id", "status", "updated_at");

-- AddForeignKey
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
