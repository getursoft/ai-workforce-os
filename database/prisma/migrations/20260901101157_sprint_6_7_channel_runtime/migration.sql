-- CreateEnum
CREATE TYPE "conversation_message_actor_type" AS ENUM ('USER', 'AI', 'HUMAN_AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "conversation_ai_control_state" AS ENUM ('AI_ACTIVE', 'HUMAN_ACTIVE');

-- AlterEnum
ALTER TYPE "channel_message_status" ADD VALUE 'DELIVERED';

-- AlterTable
ALTER TABLE "channel_messages" ADD COLUMN     "attachment_ref" JSONB,
ADD COLUMN     "computed_response_attachments" JSONB,
ADD COLUMN     "computed_response_text" TEXT;

-- AlterTable
ALTER TABLE "conversation_messages" ADD COLUMN     "actor_type" "conversation_message_actor_type" NOT NULL DEFAULT 'AI',
ADD COLUMN     "actor_user_id" UUID;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "ai_control_state" "conversation_ai_control_state" NOT NULL DEFAULT 'AI_ACTIVE',
ADD COLUMN     "ai_paused_reason" VARCHAR(40),
ADD COLUMN     "taken_over_at" TIMESTAMP(3),
ADD COLUMN     "taken_over_by_user_id" UUID;

-- CreateTable
CREATE TABLE "channel_delivery_attempts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "channel_message_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "provider" "channel_provider" NOT NULL,
    "attempted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider_request_id" VARCHAR(160),
    "success" BOOLEAN NOT NULL,
    "error_code" VARCHAR(60),
    "error_message" VARCHAR(500),
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_delivery_attempts_channel_message_id_attempt_number_idx" ON "channel_delivery_attempts"("channel_message_id", "attempt_number");

-- CreateIndex
CREATE INDEX "channel_delivery_attempts_organization_id_created_at_idx" ON "channel_delivery_attempts"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "channel_delivery_attempts" ADD CONSTRAINT "channel_delivery_attempts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_delivery_attempts" ADD CONSTRAINT "channel_delivery_attempts_channel_message_id_fkey" FOREIGN KEY ("channel_message_id") REFERENCES "channel_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
