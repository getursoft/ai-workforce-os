-- CreateEnum
CREATE TYPE "recruitment_job_status" AS ENUM ('DRAFT', 'OPEN', 'ON_HOLD', 'CLOSED');

-- CreateEnum
CREATE TYPE "recruitment_employment_type" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP', 'TEMPORARY');

-- CreateEnum
CREATE TYPE "recruitment_work_mode" AS ENUM ('ONSITE', 'REMOTE', 'HYBRID');

-- CreateEnum
CREATE TYPE "recruitment_parsing_status" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "recruitment_batch_status" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED');

-- CreateEnum
CREATE TYPE "recruitment_ai_recommendation" AS ENUM ('RECOMMENDED_FOR_SHORTLIST', 'BELOW_MATCH_THRESHOLD', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "recruitment_decision" AS ENUM ('PENDING_REVIEW', 'SHORTLISTED', 'NOT_SELECTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'ON_HOLD', 'HIRED');

-- CreateEnum
CREATE TYPE "recruitment_evaluation_status" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "recruitment_jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "job_code" VARCHAR(32) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT NOT NULL,
    "department" VARCHAR(120),
    "location" VARCHAR(160),
    "employment_type" "recruitment_employment_type",
    "work_mode" "recruitment_work_mode",
    "min_experience_years" INTEGER,
    "max_experience_years" INTEGER,
    "required_criteria" JSONB NOT NULL,
    "ai_suggested_criteria" JSONB,
    "responsibilities" TEXT,
    "salary_range_min" INTEGER,
    "salary_range_max" INTEGER,
    "salary_currency" CHAR(3),
    "hiring_manager" VARCHAR(160),
    "number_of_openings" INTEGER NOT NULL DEFAULT 1,
    "application_deadline" TIMESTAMP(3),
    "scoring_config" JSONB NOT NULL,
    "recommendation_threshold" INTEGER NOT NULL DEFAULT 80,
    "status" "recruitment_job_status" NOT NULL DEFAULT 'DRAFT',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "recruitment_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_candidates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "full_name" VARCHAR(160),
    "mobile_number" VARCHAR(24),
    "email" VARCHAR(160),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_resumes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "candidate_id" UUID,
    "resume_code" VARCHAR(32) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "storage_key" VARCHAR(500) NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "file_hash" VARCHAR(64) NOT NULL,
    "extracted_text" TEXT,
    "parsed_data" JSONB,
    "parsing_version" VARCHAR(40),
    "parsing_warnings" JSONB,
    "parsing_status" "recruitment_parsing_status" NOT NULL DEFAULT 'QUEUED',
    "parsing_error" VARCHAR(500),
    "upload_batch_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_resumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_applications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "resume_id" UUID NOT NULL,
    "ai_recommendation" "recruitment_ai_recommendation",
    "recruiter_decision" "recruitment_decision" NOT NULL DEFAULT 'PENDING_REVIEW',
    "override_reason" TEXT,
    "application_status" VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_evaluations" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "match_score" DOUBLE PRECISION,
    "score_breakdown" JSONB,
    "matched_skills" JSONB,
    "missing_skills" JSONB,
    "evidence" JSONB,
    "explanation" TEXT,
    "warnings" JSONB,
    "model_provider" VARCHAR(80),
    "model_version" VARCHAR(80),
    "scoring_version" VARCHAR(40) NOT NULL,
    "evaluation_status" "recruitment_evaluation_status" NOT NULL DEFAULT 'PENDING',
    "evaluation_error" VARCHAR(500),
    "evaluated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_upload_batches" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "total_files" INTEGER NOT NULL,
    "queued_files" INTEGER NOT NULL DEFAULT 0,
    "processing_files" INTEGER NOT NULL DEFAULT 0,
    "completed_files" INTEGER NOT NULL DEFAULT 0,
    "failed_files" INTEGER NOT NULL DEFAULT 0,
    "status" "recruitment_batch_status" NOT NULL DEFAULT 'QUEUED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "recruitment_upload_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recruitment_jobs_organization_id_status_created_at_idx" ON "recruitment_jobs"("organization_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_jobs_organization_id_job_code_key" ON "recruitment_jobs"("organization_id", "job_code");

-- CreateIndex
CREATE INDEX "recruitment_candidates_organization_id_email_idx" ON "recruitment_candidates"("organization_id", "email");

-- CreateIndex
CREATE INDEX "recruitment_candidates_organization_id_mobile_number_idx" ON "recruitment_candidates"("organization_id", "mobile_number");

-- CreateIndex
CREATE INDEX "recruitment_resumes_organization_id_file_hash_idx" ON "recruitment_resumes"("organization_id", "file_hash");

-- CreateIndex
CREATE INDEX "recruitment_resumes_organization_id_candidate_id_idx" ON "recruitment_resumes"("organization_id", "candidate_id");

-- CreateIndex
CREATE INDEX "recruitment_resumes_organization_id_upload_batch_id_idx" ON "recruitment_resumes"("organization_id", "upload_batch_id");

-- CreateIndex
CREATE INDEX "recruitment_resumes_organization_id_parsing_status_idx" ON "recruitment_resumes"("organization_id", "parsing_status");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_resumes_organization_id_resume_code_key" ON "recruitment_resumes"("organization_id", "resume_code");

-- CreateIndex
CREATE INDEX "recruitment_applications_organization_id_job_id_recruiter_d_idx" ON "recruitment_applications"("organization_id", "job_id", "recruiter_decision");

-- CreateIndex
CREATE INDEX "recruitment_applications_organization_id_job_id_ai_recommen_idx" ON "recruitment_applications"("organization_id", "job_id", "ai_recommendation");

-- CreateIndex
CREATE INDEX "recruitment_applications_organization_id_candidate_id_idx" ON "recruitment_applications"("organization_id", "candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_applications_job_id_resume_id_key" ON "recruitment_applications"("job_id", "resume_id");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_evaluations_application_id_key" ON "recruitment_evaluations"("application_id");

-- CreateIndex
CREATE INDEX "recruitment_upload_batches_organization_id_job_id_status_idx" ON "recruitment_upload_batches"("organization_id", "job_id", "status");

-- AddForeignKey
ALTER TABLE "recruitment_jobs" ADD CONSTRAINT "recruitment_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_jobs" ADD CONSTRAINT "recruitment_jobs_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_candidates" ADD CONSTRAINT "recruitment_candidates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_resumes" ADD CONSTRAINT "recruitment_resumes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_resumes" ADD CONSTRAINT "recruitment_resumes_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "recruitment_candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_resumes" ADD CONSTRAINT "recruitment_resumes_upload_batch_id_fkey" FOREIGN KEY ("upload_batch_id") REFERENCES "recruitment_upload_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_applications" ADD CONSTRAINT "recruitment_applications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_applications" ADD CONSTRAINT "recruitment_applications_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "recruitment_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_applications" ADD CONSTRAINT "recruitment_applications_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "recruitment_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_applications" ADD CONSTRAINT "recruitment_applications_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "recruitment_resumes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_applications" ADD CONSTRAINT "recruitment_applications_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_evaluations" ADD CONSTRAINT "recruitment_evaluations_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "recruitment_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_upload_batches" ADD CONSTRAINT "recruitment_upload_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_upload_batches" ADD CONSTRAINT "recruitment_upload_batches_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "recruitment_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_upload_batches" ADD CONSTRAINT "recruitment_upload_batches_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

