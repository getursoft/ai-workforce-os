-- CreateEnum
CREATE TYPE "skill_execution_status" AS ENUM (
  'ACTIVE',
  'WAITING_FOR_INPUT',
  'READY',
  'COMPLETED',
  'CANCELLED',
  'FAILED'
);

-- CreateTable
CREATE TABLE "skill_executions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "plugin_installation_id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "skill_id" VARCHAR(160) NOT NULL,
  "skill_version" VARCHAR(50) NOT NULL,
  "schema_version" INTEGER NOT NULL,
  "status" "skill_execution_status" NOT NULL DEFAULT 'ACTIVE',
  "state" JSONB NOT NULL,
  "pending_input" VARCHAR(100),
  "originating_agent_execution_id" UUID,
  "latest_agent_execution_id" UUID,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "processed_turn_ids" JSONB NOT NULL DEFAULT '[]',
  "active_key" VARCHAR(500),
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "completion_reason" VARCHAR(160),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "skill_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "skill_executions_active_key_key" ON "skill_executions"("active_key");
CREATE INDEX "skill_executions_org_plugin_conversation_skill_idx"
  ON "skill_executions"("organization_id", "plugin_installation_id", "conversation_id", "skill_id");
CREATE INDEX "skill_executions_org_status_updated_idx"
  ON "skill_executions"("organization_id", "status", "updated_at");
CREATE INDEX "skill_executions_conversation_skill_version_idx"
  ON "skill_executions"("conversation_id", "skill_id", "skill_version");

-- AddForeignKey
ALTER TABLE "skill_executions"
  ADD CONSTRAINT "skill_executions_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "skill_executions"
  ADD CONSTRAINT "skill_executions_plugin_installation_id_fkey"
  FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "skill_executions"
  ADD CONSTRAINT "skill_executions_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "skill_executions"
  ADD CONSTRAINT "skill_executions_originating_agent_execution_id_fkey"
  FOREIGN KEY ("originating_agent_execution_id") REFERENCES "agent_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "skill_executions"
  ADD CONSTRAINT "skill_executions_latest_agent_execution_id_fkey"
  FOREIGN KEY ("latest_agent_execution_id") REFERENCES "agent_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
