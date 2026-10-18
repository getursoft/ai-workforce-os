-- CreateEnum
CREATE TYPE "lead_source" AS ENUM ('WEB_CHAT', 'WHATSAPP', 'VOICE', 'MANUAL', 'API', 'OTHER');

-- CreateEnum
CREATE TYPE "lead_status" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'FOLLOW_UP', 'CONVERTED', 'LOST');

-- CreateEnum
CREATE TYPE "lead_priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "lead_activity_type" AS ENUM ('CREATED', 'UPDATED', 'STATUS_CHANGED', 'ASSIGNED', 'NOTE_ADDED', 'CONTACTED', 'CONVERTED', 'LOST');

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_reference_id" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160),
    "phone" VARCHAR(24),
    "email" VARCHAR(160),
    "source" "lead_source" NOT NULL,
    "agent_id" UUID,
    "conversation_id" UUID,
    "interaction_id" UUID,
    "voice_session_id" UUID,
    "requirement" TEXT,
    "status" "lead_status" NOT NULL DEFAULT 'NEW',
    "priority" "lead_priority" NOT NULL DEFAULT 'MEDIUM',
    "assigned_to_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "converted_at" TIMESTAMP(3),
    "lost_at" TIMESTAMP(3),

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_activities" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "type" "lead_activity_type" NOT NULL,
    "note" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "actor_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leads_lead_reference_id_key" ON "leads"("lead_reference_id");

-- CreateIndex
CREATE INDEX "leads_organization_id_status_created_at_idx" ON "leads"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "leads_organization_id_source_idx" ON "leads"("organization_id", "source");

-- CreateIndex
CREATE INDEX "leads_organization_id_agent_id_idx" ON "leads"("organization_id", "agent_id");

-- CreateIndex
CREATE INDEX "leads_organization_id_assigned_to_user_id_idx" ON "leads"("organization_id", "assigned_to_user_id");

-- CreateIndex
CREATE INDEX "leads_organization_id_conversation_id_idx" ON "leads"("organization_id", "conversation_id");

-- CreateIndex
CREATE INDEX "leads_organization_id_interaction_id_idx" ON "leads"("organization_id", "interaction_id");

-- CreateIndex
CREATE INDEX "lead_activities_lead_id_created_at_idx" ON "lead_activities"("lead_id", "created_at");

-- CreateIndex
CREATE INDEX "lead_activities_organization_id_created_at_idx" ON "lead_activities"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

