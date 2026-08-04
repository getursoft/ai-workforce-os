-- CreateEnum
CREATE TYPE "scheduled_job_status" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "scheduled_job_trigger_type" AS ENUM ('ONE_TIME', 'CRON', 'INTERVAL', 'DAILY', 'WEEKLY', 'MONTHLY', 'EVENT', 'DATE', 'AFTER_APPROVAL', 'AFTER_BOOKING', 'AFTER_WORKFLOW', 'AFTER_PAYMENT', 'AFTER_UPLOAD');

-- CreateEnum
CREATE TYPE "scheduled_job_priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT', 'CRITICAL');

-- CreateEnum
CREATE TYPE "scheduled_execution_status" AS ENUM ('QUEUED', 'RUNNING', 'FAILED', 'RETRYING', 'COMPLETED', 'CANCELLED', 'TIMEOUT', 'DEAD_LETTERED');

-- AlterEnum
ALTER TYPE "workflow_type" ADD VALUE 'AUTONOMOUS_REMINDER';

-- CreateTable
CREATE TABLE "job_definitions" (
    "id" UUID NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(500) NOT NULL DEFAULT '',
    "category" VARCHAR(60) NOT NULL DEFAULT 'PLATFORM',
    "handler_type" VARCHAR(60) NOT NULL,
    "retry_policy" VARCHAR(20) NOT NULL DEFAULT '5_MIN',
    "max_retry" INTEGER NOT NULL DEFAULT 5,
    "timeout_ms" INTEGER NOT NULL DEFAULT 30000,
    "event_name" VARCHAR(120),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_templates" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(500) NOT NULL DEFAULT '',
    "definition_key" VARCHAR(120) NOT NULL,
    "trigger_type" "scheduled_job_trigger_type" NOT NULL,
    "cron_expression" VARCHAR(120),
    "interval_ms" INTEGER,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "priority" "scheduled_job_priority" NOT NULL DEFAULT 'NORMAL',
    "max_retry" INTEGER NOT NULL DEFAULT 5,
    "timeout_ms" INTEGER NOT NULL DEFAULT 30000,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID,
    "workflow_id" UUID,
    "definition_key" VARCHAR(120) NOT NULL,
    "trigger_type" "scheduled_job_trigger_type" NOT NULL,
    "cron_expression" VARCHAR(120),
    "interval_ms" INTEGER,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "status" "scheduled_job_status" NOT NULL DEFAULT 'ACTIVE',
    "priority" "scheduled_job_priority" NOT NULL DEFAULT 'NORMAL',
    "next_run" TIMESTAMP(3),
    "last_run" TIMESTAMP(3),
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "max_retry" INTEGER NOT NULL DEFAULT 5,
    "timeout_ms" INTEGER NOT NULL DEFAULT 30000,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "context" JSONB NOT NULL DEFAULT '{}',
    "dedupe_key" VARCHAR(500),
    "paused_at" TIMESTAMP(3),
    "paused_by" UUID,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_executions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "employee_id" UUID,
    "definition_key" VARCHAR(120) NOT NULL,
    "trigger_type" "scheduled_job_trigger_type" NOT NULL,
    "priority" "scheduled_job_priority" NOT NULL DEFAULT 'NORMAL',
    "status" "scheduled_execution_status" NOT NULL DEFAULT 'QUEUED',
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "next_attempt_at" TIMESTAMP(3),
    "trace_id" VARCHAR(64),
    "worker_id" VARCHAR(100),
    "result" JSONB DEFAULT '{}',
    "error_code" VARCHAR(100),
    "error_message" VARCHAR(1000),
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "dedupe_key" VARCHAR(600),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_locks" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "worker_id" VARCHAR(100) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "locked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_locks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_definitions_key_key" ON "job_definitions"("key");

-- CreateIndex
CREATE INDEX "job_definitions_category_enabled_idx" ON "job_definitions"("category", "enabled");

-- CreateIndex
CREATE INDEX "job_templates_organization_id_definition_key_idx" ON "job_templates"("organization_id", "definition_key");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_jobs_dedupe_key_key" ON "scheduled_jobs"("dedupe_key");

-- CreateIndex
CREATE INDEX "scheduled_jobs_organization_id_status_next_run_idx" ON "scheduled_jobs"("organization_id", "status", "next_run");

-- CreateIndex
CREATE INDEX "scheduled_jobs_organization_id_trigger_type_status_idx" ON "scheduled_jobs"("organization_id", "trigger_type", "status");

-- CreateIndex
CREATE INDEX "scheduled_jobs_organization_id_employee_id_idx" ON "scheduled_jobs"("organization_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_executions_dedupe_key_key" ON "scheduled_executions"("dedupe_key");

-- CreateIndex
CREATE INDEX "scheduled_executions_organization_id_status_scheduled_for_idx" ON "scheduled_executions"("organization_id", "status", "scheduled_for");

-- CreateIndex
CREATE INDEX "scheduled_executions_organization_id_job_id_created_at_idx" ON "scheduled_executions"("organization_id", "job_id", "created_at");

-- CreateIndex
CREATE INDEX "scheduled_executions_organization_id_status_priority_idx" ON "scheduled_executions"("organization_id", "status", "priority");

-- CreateIndex
CREATE INDEX "scheduled_executions_organization_id_trace_id_idx" ON "scheduled_executions"("organization_id", "trace_id");

-- CreateIndex
CREATE INDEX "scheduled_executions_status_next_attempt_at_idx" ON "scheduled_executions"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "job_locks_job_id_key" ON "job_locks"("job_id");

-- CreateIndex
CREATE INDEX "job_locks_organization_id_lease_expires_at_idx" ON "job_locks"("organization_id", "lease_expires_at");

-- AddForeignKey
ALTER TABLE "job_templates" ADD CONSTRAINT "job_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_executions" ADD CONSTRAINT "scheduled_executions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_executions" ADD CONSTRAINT "scheduled_executions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "scheduled_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_locks" ADD CONSTRAINT "job_locks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
