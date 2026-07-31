-- CreateEnum
CREATE TYPE "memory_scope" AS ENUM ('USER', 'EMPLOYEE', 'ORGANIZATION', 'CONVERSATION', 'GLOBAL');

-- CreateEnum
CREATE TYPE "memory_importance" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "memory_source" AS ENUM ('CONVERSATION', 'DASHBOARD', 'TOOL', 'SYSTEM', 'RULE_EXTRACTION', 'LLM_EXTRACTION', 'IMPORT');

-- CreateEnum
CREATE TYPE "memory_audit_action" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'EXPIRE', 'RECALL', 'SEARCH', 'SUMMARIZE', 'MERGE', 'RANK');

-- CreateTable
CREATE TABLE "memory_records" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID,
    "user_id" UUID,
    "conversation_id" UUID,
    "scope" "memory_scope" NOT NULL,
    "category" VARCHAR(80) NOT NULL,
    "key" VARCHAR(160) NOT NULL,
    "value" JSONB NOT NULL,
    "searchable_text" TEXT,
    "confidence" DECIMAL(4,3) NOT NULL DEFAULT 1,
    "importance" "memory_importance" NOT NULL DEFAULT 'MEDIUM',
    "source" "memory_source" NOT NULL DEFAULT 'DASHBOARD',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "embedding" vector(1536),
    "embedding_model" VARCHAR(160),
    "embedding_dimensions" INTEGER,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "memory_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_audit_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "actor_id" UUID,
    "memory_id" UUID NOT NULL,
    "action" "memory_audit_action" NOT NULL,
    "scope" "memory_scope" NOT NULL,
    "key" VARCHAR(160) NOT NULL,
    "category" VARCHAR(80) NOT NULL,
    "change_summary" VARCHAR(500),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_summaries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "summarized_message_count" INTEGER NOT NULL,
    "summary_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memory_records_organization_id_scope_deleted_at_idx" ON "memory_records"("organization_id", "scope", "deleted_at");

-- CreateIndex
CREATE INDEX "memory_records_organization_id_employee_id_scope_deleted_at_idx" ON "memory_records"("organization_id", "employee_id", "scope", "deleted_at");

-- CreateIndex
CREATE INDEX "memory_records_organization_id_user_id_scope_deleted_at_idx" ON "memory_records"("organization_id", "user_id", "scope", "deleted_at");

-- CreateIndex
CREATE INDEX "memory_records_organization_id_conversation_id_scope_delete_idx" ON "memory_records"("organization_id", "conversation_id", "scope", "deleted_at");

-- CreateIndex
CREATE INDEX "memory_records_organization_id_category_key_deleted_at_idx" ON "memory_records"("organization_id", "category", "key", "deleted_at");

-- CreateIndex
CREATE INDEX "memory_records_organization_id_updated_at_idx" ON "memory_records"("organization_id", "updated_at");

-- CreateIndex
CREATE INDEX "memory_audit_events_organization_id_memory_id_idx" ON "memory_audit_events"("organization_id", "memory_id");

-- CreateIndex
CREATE INDEX "memory_audit_events_organization_id_created_at_idx" ON "memory_audit_events"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_summaries_conversation_id_key" ON "conversation_summaries"("conversation_id");

-- CreateIndex
CREATE INDEX "conversation_summaries_organization_id_updated_at_idx" ON "conversation_summaries"("organization_id", "updated_at");

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_audit_events" ADD CONSTRAINT "memory_audit_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_audit_events" ADD CONSTRAINT "memory_audit_events_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memory_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
