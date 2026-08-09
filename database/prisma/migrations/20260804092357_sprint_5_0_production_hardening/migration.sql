-- CreateEnum
CREATE TYPE "queue_message_status" AS ENUM ('QUEUED', 'CLAIMED', 'COMPLETED', 'FAILED', 'RETRYING', 'DEAD_LETTERED');

-- CreateEnum
CREATE TYPE "queue_category" AS ENUM ('SCHEDULER_JOBS', 'WORKFORCE_TASKS', 'CHANNEL_MESSAGES', 'DELIVERY_RETRIES', 'RETENTION_JOBS', 'NOTIFICATION_JOBS', 'DOCUMENT_PROCESSING');

-- CreateTable
CREATE TABLE "queue_messages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "category" "queue_category" NOT NULL,
    "ref_type" VARCHAR(80) NOT NULL,
    "ref_id" VARCHAR(200) NOT NULL,
    "employee_id" UUID,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" "queue_message_status" NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_attempt_at" TIMESTAMP(3),
    "visibility_ms" INTEGER NOT NULL DEFAULT 60000,
    "worker_id" VARCHAR(100),
    "trace_id" VARCHAR(64),
    "dedupe_key" VARCHAR(600),
    "error_code" VARCHAR(100),
    "error_message" VARCHAR(1000),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "queue_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "key" VARCHAR(120) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "value" JSONB NOT NULL DEFAULT '{}',
    "description" VARCHAR(500),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_retention_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "conversation_days" INTEGER,
    "upload_days" INTEGER,
    "trace_days" INTEGER,
    "memory_days" INTEGER,
    "scheduler_execution_days" INTEGER,
    "channel_message_days" INTEGER,
    "legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_retention_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_support_notes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_support_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "queue_messages_dedupe_key_key" ON "queue_messages"("dedupe_key");

-- CreateIndex
CREATE INDEX "queue_messages_status_available_at_priority_idx" ON "queue_messages"("status", "available_at", "priority");

-- CreateIndex
CREATE INDEX "queue_messages_organization_id_status_category_idx" ON "queue_messages"("organization_id", "status", "category");

-- CreateIndex
CREATE INDEX "queue_messages_category_status_idx" ON "queue_messages"("category", "status");

-- CreateIndex
CREATE INDEX "queue_messages_organization_id_trace_id_idx" ON "queue_messages"("organization_id", "trace_id");

-- CreateIndex
CREATE INDEX "feature_flags_organization_id_idx" ON "feature_flags"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_organization_id_key_key" ON "feature_flags"("organization_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "data_retention_policies_organization_id_key" ON "data_retention_policies"("organization_id");

-- CreateIndex
CREATE INDEX "platform_support_notes_organization_id_created_at_idx" ON "platform_support_notes"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "queue_messages" ADD CONSTRAINT "queue_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_retention_policies" ADD CONSTRAINT "data_retention_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_support_notes" ADD CONSTRAINT "platform_support_notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
