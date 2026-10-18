-- CreateEnum
CREATE TYPE "recruitment_whatsapp_link_status" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "recruitment_call_status" AS ENUM ('QUEUED', 'INITIATED', 'COMPLETED', 'FAILED', 'NOT_ATTEMPTED');

-- CreateEnum
CREATE TYPE "recruitment_export_scope" AS ENUM ('ALL_AUTHORIZED', 'FILTERED', 'SELECTED', 'CURRENT_JOB', 'CROSS_JOB');

-- CreateEnum
CREATE TYPE "recruitment_export_format" AS ENUM ('CSV', 'XLSX');

-- CreateEnum
CREATE TYPE "recruitment_export_status" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- AlterTable
ALTER TABLE "recruitment_candidates" ADD COLUMN     "current_city" VARCHAR(120),
ADD COLUMN     "current_country" VARCHAR(120),
ADD COLUMN     "current_state" VARCHAR(120),
ADD COLUMN     "location_extracted_at" TIMESTAMP(3),
ADD COLUMN     "location_extraction_confidence" DOUBLE PRECISION,
ADD COLUMN     "location_extraction_version" VARCHAR(40),
ADD COLUMN     "location_source" VARCHAR(24),
ADD COLUMN     "normalized_region" VARCHAR(120),
ADD COLUMN     "notice_period" VARCHAR(80),
ADD COLUMN     "preferred_work_locations" JSONB,
ADD COLUMN     "willing_to_relocate" BOOLEAN,
ADD COLUMN     "work_mode_preference" "recruitment_work_mode";

-- CreateTable
CREATE TABLE "recruitment_whatsapp_links" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "whatsapp_number" VARCHAR(24) NOT NULL,
    "status" "recruitment_whatsapp_link_status" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "verification_code_hash" VARCHAR(128),
    "verification_expires_at" TIMESTAMP(3),
    "verification_attempts" INTEGER NOT NULL DEFAULT 0,
    "linked_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by_user_id" UUID,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_whatsapp_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_whatsapp_sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "link_id" UUID NOT NULL,
    "whatsapp_number" VARCHAR(24) NOT NULL,
    "menu_state" VARCHAR(40) NOT NULL DEFAULT 'MAIN_MENU',
    "current_job_id" UUID,
    "active_filters" JSONB,
    "pagination_cursor" VARCHAR(100),
    "awaiting_upload" BOOLEAN NOT NULL DEFAULT false,
    "last_provider_message_id" VARCHAR(100),
    "last_interaction_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_whatsapp_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_call_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "job_id" UUID,
    "application_id" UUID,
    "initiated_by_user_id" UUID NOT NULL,
    "channel" VARCHAR(32) NOT NULL,
    "status" "recruitment_call_status" NOT NULL DEFAULT 'QUEUED',
    "attempted_at" TIMESTAMP(3),
    "outcome" VARCHAR(40),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_export_jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "job_id" UUID,
    "scope" "recruitment_export_scope" NOT NULL,
    "format" "recruitment_export_format" NOT NULL,
    "filters" JSONB,
    "field_selection" JSONB,
    "selected_ids" JSONB,
    "status" "recruitment_export_status" NOT NULL DEFAULT 'QUEUED',
    "row_count" INTEGER,
    "storage_key" VARCHAR(500),
    "download_token" VARCHAR(64),
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" VARCHAR(500),
    "expires_at" TIMESTAMP(3),
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "last_downloaded_at" TIMESTAMP(3),

    CONSTRAINT "recruitment_export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_filter_presets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "filters" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_filter_presets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recruitment_whatsapp_links_organization_id_user_id_idx" ON "recruitment_whatsapp_links"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "recruitment_whatsapp_links_whatsapp_number_status_idx" ON "recruitment_whatsapp_links"("whatsapp_number", "status");

-- CreateIndex
CREATE INDEX "recruitment_whatsapp_sessions_organization_id_link_id_idx" ON "recruitment_whatsapp_sessions"("organization_id", "link_id");

-- CreateIndex
CREATE INDEX "recruitment_whatsapp_sessions_expires_at_idx" ON "recruitment_whatsapp_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_whatsapp_sessions_whatsapp_number_key" ON "recruitment_whatsapp_sessions"("whatsapp_number");

-- CreateIndex
CREATE INDEX "recruitment_call_logs_organization_id_candidate_id_idx" ON "recruitment_call_logs"("organization_id", "candidate_id");

-- CreateIndex
CREATE INDEX "recruitment_call_logs_organization_id_job_id_idx" ON "recruitment_call_logs"("organization_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_export_jobs_download_token_key" ON "recruitment_export_jobs"("download_token");

-- CreateIndex
CREATE INDEX "recruitment_export_jobs_organization_id_status_idx" ON "recruitment_export_jobs"("organization_id", "status");

-- CreateIndex
CREATE INDEX "recruitment_export_jobs_expires_at_idx" ON "recruitment_export_jobs"("expires_at");

-- CreateIndex
CREATE INDEX "recruitment_filter_presets_organization_id_user_id_idx" ON "recruitment_filter_presets"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_filter_presets_user_id_name_key" ON "recruitment_filter_presets"("user_id", "name");

-- CreateIndex
CREATE INDEX "recruitment_candidates_organization_id_current_city_idx" ON "recruitment_candidates"("organization_id", "current_city");

-- CreateIndex
CREATE INDEX "recruitment_candidates_organization_id_normalized_region_idx" ON "recruitment_candidates"("organization_id", "normalized_region");

-- AddForeignKey
ALTER TABLE "recruitment_whatsapp_links" ADD CONSTRAINT "recruitment_whatsapp_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_whatsapp_links" ADD CONSTRAINT "recruitment_whatsapp_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_whatsapp_links" ADD CONSTRAINT "recruitment_whatsapp_links_revoked_by_user_id_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_whatsapp_sessions" ADD CONSTRAINT "recruitment_whatsapp_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_whatsapp_sessions" ADD CONSTRAINT "recruitment_whatsapp_sessions_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "recruitment_whatsapp_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_whatsapp_sessions" ADD CONSTRAINT "recruitment_whatsapp_sessions_current_job_id_fkey" FOREIGN KEY ("current_job_id") REFERENCES "recruitment_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_call_logs" ADD CONSTRAINT "recruitment_call_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_call_logs" ADD CONSTRAINT "recruitment_call_logs_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "recruitment_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_call_logs" ADD CONSTRAINT "recruitment_call_logs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "recruitment_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_call_logs" ADD CONSTRAINT "recruitment_call_logs_initiated_by_user_id_fkey" FOREIGN KEY ("initiated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_export_jobs" ADD CONSTRAINT "recruitment_export_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_export_jobs" ADD CONSTRAINT "recruitment_export_jobs_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_export_jobs" ADD CONSTRAINT "recruitment_export_jobs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "recruitment_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_filter_presets" ADD CONSTRAINT "recruitment_filter_presets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_filter_presets" ADD CONSTRAINT "recruitment_filter_presets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

