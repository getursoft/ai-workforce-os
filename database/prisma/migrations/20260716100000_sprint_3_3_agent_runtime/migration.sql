CREATE TYPE "conversation_status" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "conversation_message_role" AS ENUM ('SYSTEM', 'USER', 'ASSISTANT', 'TOOL');
CREATE TYPE "agent_execution_status" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT');
CREATE TYPE "agent_tool_execution_status" AS ENUM ('REQUESTED', 'RUNNING', 'COMPLETED', 'FAILED', 'DENIED', 'TIMED_OUT');
CREATE TYPE "agent_memory_scope" AS ENUM ('USER', 'CONVERSATION', 'PLUGIN', 'ORGANIZATION');

CREATE TABLE "conversations" (
  "id" UUID NOT NULL, "organization_id" UUID NOT NULL, "plugin_installation_id" UUID NOT NULL,
  "created_by_user_id" UUID NOT NULL, "title" VARCHAR(160) NOT NULL,
  "status" "conversation_status" NOT NULL DEFAULT 'ACTIVE', "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3), CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "conversation_messages" (
  "id" UUID NOT NULL, "conversation_id" UUID NOT NULL, "organization_id" UUID NOT NULL,
  "tool_execution_id" UUID, "role" "conversation_message_role" NOT NULL, "content" TEXT NOT NULL,
  "content_json" JSONB, "model" VARCHAR(120), "input_tokens" INTEGER, "output_tokens" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "agent_executions" (
  "id" UUID NOT NULL, "organization_id" UUID NOT NULL, "conversation_id" UUID NOT NULL,
  "plugin_installation_id" UUID NOT NULL, "user_id" UUID NOT NULL,
  "status" "agent_execution_status" NOT NULL DEFAULT 'QUEUED', "model_provider" VARCHAR(80), "model" VARCHAR(120),
  "started_at" TIMESTAMP(3), "completed_at" TIMESTAMP(3), "latency_ms" INTEGER,
  "input_tokens" INTEGER NOT NULL DEFAULT 0, "output_tokens" INTEGER NOT NULL DEFAULT 0, "total_tokens" INTEGER NOT NULL DEFAULT 0,
  "estimated_cost" DECIMAL(12,6), "error_code" VARCHAR(100), "error_message" VARCHAR(500), "request_id" VARCHAR(100),
  "metadata" JSONB NOT NULL DEFAULT '{}', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_executions_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "agent_tool_executions" (
  "id" UUID NOT NULL, "organization_id" UUID NOT NULL, "execution_id" UUID NOT NULL,
  "tool_name" VARCHAR(160) NOT NULL, "tool_version" VARCHAR(50) NOT NULL,
  "status" "agent_tool_execution_status" NOT NULL DEFAULT 'REQUESTED', "input" JSONB NOT NULL, "output" JSONB,
  "error_code" VARCHAR(100), "error_message" VARCHAR(500), "started_at" TIMESTAMP(3), "completed_at" TIMESTAMP(3),
  "latency_ms" INTEGER, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_tool_executions_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "agent_memories" (
  "id" UUID NOT NULL, "organization_id" UUID NOT NULL, "plugin_installation_id" UUID NOT NULL,
  "user_id" UUID, "conversation_id" UUID, "scope" "agent_memory_scope" NOT NULL, "key" VARCHAR(160) NOT NULL,
  "value" JSONB NOT NULL, "searchable_text" TEXT, "metadata" JSONB NOT NULL DEFAULT '{}', "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL, "deleted_at" TIMESTAMP(3),
  CONSTRAINT "agent_memories_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "conversations_organization_id_status_updated_at_idx" ON "conversations"("organization_id", "status", "updated_at");
CREATE INDEX "conversations_organization_id_plugin_installation_id_idx" ON "conversations"("organization_id", "plugin_installation_id");
CREATE INDEX "conversation_messages_organization_id_conversation_id_created_at_idx" ON "conversation_messages"("organization_id", "conversation_id", "created_at");
CREATE INDEX "conversation_messages_tool_execution_id_idx" ON "conversation_messages"("tool_execution_id");
CREATE INDEX "agent_executions_organization_id_created_at_idx" ON "agent_executions"("organization_id", "created_at");
CREATE INDEX "agent_executions_organization_id_status_idx" ON "agent_executions"("organization_id", "status");
CREATE INDEX "agent_executions_conversation_id_idx" ON "agent_executions"("conversation_id");
CREATE INDEX "agent_tool_executions_organization_id_execution_id_idx" ON "agent_tool_executions"("organization_id", "execution_id");
CREATE UNIQUE INDEX "agent_memories_organization_id_plugin_installation_id_user_id_conversation_id_scope_key_key" ON "agent_memories"("organization_id", "plugin_installation_id", "user_id", "conversation_id", "scope", "key");
CREATE INDEX "agent_memories_organization_id_plugin_installation_id_scope_idx" ON "agent_memories"("organization_id", "plugin_installation_id", "scope");
CREATE INDEX "agent_memories_organization_id_user_id_deleted_at_idx" ON "agent_memories"("organization_id", "user_id", "deleted_at");

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_tool_executions" ADD CONSTRAINT "agent_tool_executions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_tool_executions" ADD CONSTRAINT "agent_tool_executions_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "agent_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_tool_execution_id_fkey" FOREIGN KEY ("tool_execution_id") REFERENCES "agent_tool_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
