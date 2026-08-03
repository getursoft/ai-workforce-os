-- AlterTable
ALTER TABLE "agent_executions" ADD COLUMN     "trace_id" VARCHAR(64);

-- AlterTable
ALTER TABLE "channel_messages" ADD COLUMN     "trace_id" VARCHAR(64);

-- AlterTable
ALTER TABLE "employee_delegated_tasks" ADD COLUMN     "trace_id" VARCHAR(64);

-- AlterTable
ALTER TABLE "workflow_executions" ADD COLUMN     "trace_id" VARCHAR(64);

-- CreateTable
CREATE TABLE "execution_traces" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "trace_id" VARCHAR(64) NOT NULL,
    "root_span_id" VARCHAR(64) NOT NULL,
    "parent_trace_id" VARCHAR(64),
    "conversation_id" UUID,
    "agent_execution_id" UUID,
    "workflow_execution_id" UUID,
    "delegated_task_id" UUID,
    "channel_connection_id" UUID,
    "actor_type" VARCHAR(40) NOT NULL,
    "actor_id" VARCHAR(200),
    "status" VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "error_code" VARCHAR(100),
    "error_message_safe" VARCHAR(500),
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "execution_traces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_spans" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "trace_id" VARCHAR(64) NOT NULL,
    "span_id" VARCHAR(64) NOT NULL,
    "parent_span_id" VARCHAR(64),
    "name" VARCHAR(160) NOT NULL,
    "span_type" VARCHAR(40) NOT NULL,
    "component" VARCHAR(80) NOT NULL,
    "employee_installation_id" UUID,
    "workflow_execution_id" UUID,
    "delegated_task_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "input_summary_json" JSONB,
    "output_summary_json" JSONB,
    "error_code" VARCHAR(100),
    "error_message_safe" VARCHAR(500),
    "attributes_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_spans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "observability_alerts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "rule_code" VARCHAR(60) NOT NULL,
    "severity" VARCHAR(20) NOT NULL DEFAULT 'WARNING',
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "title" VARCHAR(200) NOT NULL,
    "details_json" JSONB NOT NULL DEFAULT '{}',
    "related_trace_id" VARCHAR(64),
    "related_entity_type" VARCHAR(40),
    "related_entity_id" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by_user_id" UUID,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "observability_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "observability_settings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "tracing_enabled" BOOLEAN NOT NULL DEFAULT true,
    "sample_rate" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "error_trace_retention_days" INTEGER NOT NULL DEFAULT 30,
    "success_trace_retention_days" INTEGER NOT NULL DEFAULT 7,
    "include_safe_input_summaries" BOOLEAN NOT NULL DEFAULT true,
    "include_safe_output_summaries" BOOLEAN NOT NULL DEFAULT true,
    "provider_detail_visible" BOOLEAN NOT NULL DEFAULT true,
    "tool_detail_visible" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "observability_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "execution_traces_trace_id_key" ON "execution_traces"("trace_id");

-- CreateIndex
CREATE INDEX "execution_traces_organization_id_started_at_idx" ON "execution_traces"("organization_id", "started_at");

-- CreateIndex
CREATE INDEX "execution_traces_organization_id_status_idx" ON "execution_traces"("organization_id", "status");

-- CreateIndex
CREATE INDEX "execution_traces_organization_id_conversation_id_idx" ON "execution_traces"("organization_id", "conversation_id");

-- CreateIndex
CREATE INDEX "execution_traces_agent_execution_id_idx" ON "execution_traces"("agent_execution_id");

-- CreateIndex
CREATE INDEX "execution_traces_workflow_execution_id_idx" ON "execution_traces"("workflow_execution_id");

-- CreateIndex
CREATE INDEX "execution_traces_delegated_task_id_idx" ON "execution_traces"("delegated_task_id");

-- CreateIndex
CREATE UNIQUE INDEX "execution_spans_span_id_key" ON "execution_spans"("span_id");

-- CreateIndex
CREATE INDEX "execution_spans_organization_id_trace_id_idx" ON "execution_spans"("organization_id", "trace_id");

-- CreateIndex
CREATE INDEX "execution_spans_organization_id_span_type_started_at_idx" ON "execution_spans"("organization_id", "span_type", "started_at");

-- CreateIndex
CREATE INDEX "execution_spans_organization_id_status_idx" ON "execution_spans"("organization_id", "status");

-- CreateIndex
CREATE INDEX "execution_spans_parent_span_id_idx" ON "execution_spans"("parent_span_id");

-- CreateIndex
CREATE INDEX "observability_alerts_organization_id_status_idx" ON "observability_alerts"("organization_id", "status");

-- CreateIndex
CREATE INDEX "observability_alerts_organization_id_rule_code_related_enti_idx" ON "observability_alerts"("organization_id", "rule_code", "related_entity_type", "related_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "observability_settings_organization_id_key" ON "observability_settings"("organization_id");

-- CreateIndex
CREATE INDEX "agent_executions_organization_id_trace_id_idx" ON "agent_executions"("organization_id", "trace_id");

-- CreateIndex
CREATE INDEX "channel_messages_organization_id_trace_id_idx" ON "channel_messages"("organization_id", "trace_id");

-- CreateIndex
CREATE INDEX "employee_delegated_tasks_organization_id_trace_id_idx" ON "employee_delegated_tasks"("organization_id", "trace_id");

-- CreateIndex
CREATE INDEX "workflow_executions_organization_id_trace_id_idx" ON "workflow_executions"("organization_id", "trace_id");

-- AddForeignKey
ALTER TABLE "execution_traces" ADD CONSTRAINT "execution_traces_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_spans" ADD CONSTRAINT "execution_spans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observability_alerts" ADD CONSTRAINT "observability_alerts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observability_settings" ADD CONSTRAINT "observability_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
