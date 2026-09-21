-- CreateEnum
CREATE TYPE "interaction_status" AS ENUM ('OPEN', 'ACTIVE', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "interaction_channel" AS ENUM ('WEB_CHAT', 'WHATSAPP', 'VOICE');

-- CreateEnum
CREATE TYPE "interaction_notification_type" AS ENUM ('EMAIL', 'SMS', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "interaction_notification_status" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "interactions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "reference_id" VARCHAR(20) NOT NULL,
    "conversation_id" UUID,
    "voice_session_id" UUID,
    "channel_connection_id" UUID,
    "customer_profile_id" UUID,
    "external_user_id" VARCHAR(64),
    "phone_number" VARCHAR(24),
    "email" VARCHAR(160),
    "channel" "interaction_channel" NOT NULL,
    "transport" VARCHAR(40),
    "status" "interaction_status" NOT NULL DEFAULT 'ACTIVE',
    "entry_agent_id" UUID,
    "current_agent_id" UUID,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "resolution_summary" TEXT,
    "reference_communicated_at" TIMESTAMP(3),
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interaction_notifications" (
    "id" UUID NOT NULL,
    "interaction_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "type" "interaction_notification_type" NOT NULL,
    "destination_masked" VARCHAR(160) NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "status" "interaction_notification_status" NOT NULL DEFAULT 'PENDING',
    "provider_message_id" VARCHAR(200),
    "failure_reason" VARCHAR(200),
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interaction_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "interactions_reference_id_key" ON "interactions"("reference_id");

-- CreateIndex
CREATE INDEX "interactions_organization_id_status_idx" ON "interactions"("organization_id", "status");

-- CreateIndex
CREATE INDEX "interactions_organization_id_conversation_id_idx" ON "interactions"("organization_id", "conversation_id");

-- CreateIndex
CREATE INDEX "interactions_organization_id_voice_session_id_idx" ON "interactions"("organization_id", "voice_session_id");

-- CreateIndex
CREATE INDEX "interactions_organization_id_channel_connection_id_external_idx" ON "interactions"("organization_id", "channel_connection_id", "external_user_id", "status");

-- CreateIndex
CREATE INDEX "interactions_organization_id_created_at_idx" ON "interactions"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "interaction_notifications_organization_id_interaction_id_idx" ON "interaction_notifications"("organization_id", "interaction_id");

-- CreateIndex
CREATE INDEX "interaction_notifications_organization_id_status_idx" ON "interaction_notifications"("organization_id", "status");

-- AddForeignKey
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interaction_notifications" ADD CONSTRAINT "interaction_notifications_interaction_id_fkey" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

