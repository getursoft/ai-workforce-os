-- CreateEnum
CREATE TYPE "channel_provider" AS ENUM ('TWILIO');

-- CreateEnum
CREATE TYPE "channel_type" AS ENUM ('WHATSAPP');

-- CreateEnum
CREATE TYPE "channel_connection_status" AS ENUM ('DRAFT', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "channel_message_direction" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "channel_message_status" AS ENUM ('RECEIVED', 'PROCESSING', 'SENT', 'FAILED');

-- DropIndex
DROP INDEX "plugins_organization_id_slug_deleted_at_idx";

-- AlterTable
ALTER TABLE "api_keys" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "connector_audit_events" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "connector_definitions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "connector_events" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "connector_executions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "connector_installations" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "connector_tools" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "channel_connection_id" UUID,
ADD COLUMN     "external_user_id" VARCHAR(64),
ALTER COLUMN "created_by_user_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "dummy_crm_leads" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "service_accounts" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "teams" ALTER COLUMN "id" DROP DEFAULT;

-- CreateTable
CREATE TABLE "channel_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "provider" "channel_provider" NOT NULL,
    "channel_type" "channel_type" NOT NULL,
    "status" "channel_connection_status" NOT NULL DEFAULT 'DRAFT',
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "encrypted_secrets" JSONB NOT NULL,
    "secret_metadata" JSONB NOT NULL DEFAULT '{}',
    "last_tested_at" TIMESTAMP(3),
    "last_test_status" VARCHAR(32),
    "last_error_code" VARCHAR(100),
    "last_error_message" VARCHAR(500),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "channel_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_messages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "channel_connection_id" UUID NOT NULL,
    "conversation_id" UUID,
    "agent_execution_id" UUID,
    "provider" "channel_provider" NOT NULL,
    "direction" "channel_message_direction" NOT NULL,
    "status" "channel_message_status" NOT NULL DEFAULT 'RECEIVED',
    "provider_message_sid" VARCHAR(100),
    "from_address" VARCHAR(64) NOT NULL,
    "to_address" VARCHAR(64) NOT NULL,
    "body" TEXT,
    "media_metadata" JSONB NOT NULL DEFAULT '[]',
    "error_code" VARCHAR(100),
    "error_message" VARCHAR(500),
    "processing_attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_connections_organization_id_status_deleted_at_idx" ON "channel_connections"("organization_id", "status", "deleted_at");

-- CreateIndex
CREATE INDEX "channel_connections_organization_id_provider_channel_type_idx" ON "channel_connections"("organization_id", "provider", "channel_type");

-- CreateIndex
CREATE INDEX "channel_messages_organization_id_channel_connection_id_crea_idx" ON "channel_messages"("organization_id", "channel_connection_id", "created_at");

-- CreateIndex
CREATE INDEX "channel_messages_organization_id_status_idx" ON "channel_messages"("organization_id", "status");

-- CreateIndex
CREATE INDEX "channel_messages_conversation_id_idx" ON "channel_messages"("conversation_id");

-- CreateIndex
CREATE INDEX "channel_messages_status_next_attempt_at_idx" ON "channel_messages"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "channel_messages_channel_connection_id_provider_message_sid_key" ON "channel_messages"("channel_connection_id", "provider_message_sid");

-- CreateIndex
CREATE INDEX "conversations_organization_id_channel_connection_id_externa_idx" ON "conversations"("organization_id", "channel_connection_id", "external_user_id", "status");

-- CreateIndex
CREATE INDEX "plugins_organization_id_slug_idx" ON "plugins"("organization_id", "slug");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_connection_id_fkey" FOREIGN KEY ("channel_connection_id") REFERENCES "channel_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_channel_connection_id_fkey" FOREIGN KEY ("channel_connection_id") REFERENCES "channel_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "agent_memories_organization_id_plugin_installation_id_user_id_c" RENAME TO "agent_memories_organization_id_plugin_installation_id_user__key";

-- RenameIndex
ALTER INDEX "connector_events_connector_installation_id_external_event_id_ke" RENAME TO "connector_events_connector_installation_id_external_event_i_key";

-- RenameIndex
ALTER INDEX "conversation_messages_organization_id_conversation_id_created_a" RENAME TO "conversation_messages_organization_id_conversation_id_creat_idx";

-- RenameIndex
ALTER INDEX "plugin_ai_configurations_organization_id_plugin_installation_id" RENAME TO "plugin_ai_configurations_organization_id_plugin_installatio_idx";
