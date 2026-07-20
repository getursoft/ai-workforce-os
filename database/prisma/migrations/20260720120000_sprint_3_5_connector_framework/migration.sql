CREATE TYPE "connector_auth_type" AS ENUM ('NONE', 'API_KEY', 'BEARER_TOKEN', 'BASIC_AUTH', 'OAUTH2', 'CUSTOM');
CREATE TYPE "connector_definition_status" AS ENUM ('ACTIVE', 'DEPRECATED', 'DISABLED');
CREATE TYPE "connector_installation_status" AS ENUM ('DRAFT', 'CONNECTED', 'READY', 'DISABLED', 'AUTH_FAILED', 'EXPIRED', 'DEGRADED', 'FAILED', 'DISCONNECTED', 'ARCHIVED');
CREATE TYPE "connector_health_status" AS ENUM ('UNKNOWN', 'READY', 'DEGRADED', 'FAILED', 'AUTH_FAILED', 'EXPIRED', 'RATE_LIMITED', 'DISCONNECTED');
CREATE TYPE "connector_risk_level" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "connector_operation_type" AS ENUM ('READ', 'WRITE');
CREATE TYPE "connector_execution_status" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'DENIED', 'TIMED_OUT');
CREATE TYPE "connector_actor_type" AS ENUM ('USER', 'SERVICE_ACCOUNT', 'AGENT', 'SYSTEM');
CREATE TYPE "connector_event_status" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED', 'DUPLICATE');

CREATE TABLE "connector_definitions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "key" VARCHAR(100) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "description" VARCHAR(1000) NOT NULL,
  "category" VARCHAR(80) NOT NULL,
  "version" VARCHAR(50) NOT NULL,
  "auth_type" "connector_auth_type" NOT NULL,
  "manifest" JSONB NOT NULL,
  "declared_capabilities" JSONB NOT NULL,
  "configuration_schema" JSONB NOT NULL,
  "credential_schema" JSONB NOT NULL,
  "status" "connector_definition_status" NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "connector_definitions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "connector_definitions_key_key" ON "connector_definitions"("key");
CREATE INDEX "connector_definitions_status_category_idx" ON "connector_definitions"("status", "category");

CREATE TABLE "connector_tools" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "connector_id" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "display_name" VARCHAR(160) NOT NULL,
  "description" VARCHAR(1000) NOT NULL,
  "input_schema" JSONB NOT NULL,
  "output_schema" JSONB,
  "required_capability" VARCHAR(120) NOT NULL,
  "operation_type" "connector_operation_type" NOT NULL,
  "risk_level" "connector_risk_level" NOT NULL,
  "timeout_ms" INTEGER NOT NULL DEFAULT 10000,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "connector_tools_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "connector_tools_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connector_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "connector_tools_connector_id_name_key" ON "connector_tools"("connector_id", "name");
CREATE INDEX "connector_tools_connector_id_enabled_idx" ON "connector_tools"("connector_id", "enabled");

CREATE TABLE "connector_installations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "connector_id" UUID NOT NULL,
  "display_name" VARCHAR(160) NOT NULL,
  "status" "connector_installation_status" NOT NULL DEFAULT 'DRAFT',
  "configuration" JSONB NOT NULL DEFAULT '{}',
  "encrypted_credentials" JSONB NOT NULL,
  "credential_metadata" JSONB NOT NULL DEFAULT '{}',
  "granted_capabilities" JSONB NOT NULL DEFAULT '[]',
  "last_health_status" "connector_health_status" NOT NULL DEFAULT 'UNKNOWN',
  "last_health_checked_at" TIMESTAMP(3),
  "last_error_code" VARCHAR(100),
  "last_error_message" VARCHAR(500),
  "credential_expires_at" TIMESTAMP(3),
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "connector_installations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "connector_installations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "connector_installations_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connector_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "connector_installations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "connector_installations_active_unique" ON "connector_installations"("organization_id", "connector_id") WHERE "deleted_at" IS NULL;
CREATE INDEX "connector_installations_organization_id_status_deleted_at_idx" ON "connector_installations"("organization_id", "status", "deleted_at");
CREATE INDEX "connector_installations_organization_id_connector_id_idx" ON "connector_installations"("organization_id", "connector_id");

CREATE TABLE "connector_executions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "connector_installation_id" UUID NOT NULL,
  "agent_execution_id" UUID,
  "tool_name" VARCHAR(180) NOT NULL,
  "actor_type" "connector_actor_type" NOT NULL,
  "actor_id" UUID,
  "request_metadata" JSONB NOT NULL DEFAULT '{}',
  "input" JSONB NOT NULL,
  "output" JSONB,
  "status" "connector_execution_status" NOT NULL DEFAULT 'RUNNING',
  "latency_ms" INTEGER,
  "external_status_code" INTEGER,
  "error_code" VARCHAR(100),
  "error_message" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "connector_executions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "connector_executions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "connector_executions_connector_installation_id_fkey" FOREIGN KEY ("connector_installation_id") REFERENCES "connector_installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "connector_executions_organization_id_created_at_idx" ON "connector_executions"("organization_id", "created_at");
CREATE INDEX "connector_executions_connector_installation_id_created_at_idx" ON "connector_executions"("connector_installation_id", "created_at");
CREATE INDEX "connector_executions_agent_execution_id_idx" ON "connector_executions"("agent_execution_id");

CREATE TABLE "connector_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "connector_installation_id" UUID NOT NULL,
  "event_type" VARCHAR(120) NOT NULL,
  "external_event_id" VARCHAR(255) NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "connector_event_status" NOT NULL DEFAULT 'RECEIVED',
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3),
  "error_code" VARCHAR(100),
  "error_message" VARCHAR(500),
  CONSTRAINT "connector_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "connector_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "connector_events_connector_installation_id_fkey" FOREIGN KEY ("connector_installation_id") REFERENCES "connector_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "connector_events_connector_installation_id_external_event_id_key" ON "connector_events"("connector_installation_id", "external_event_id");
CREATE INDEX "connector_events_organization_id_received_at_idx" ON "connector_events"("organization_id", "received_at");
CREATE INDEX "connector_events_connector_installation_id_status_idx" ON "connector_events"("connector_installation_id", "status");

CREATE TABLE "connector_audit_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "connector_installation_id" UUID,
  "user_id" UUID,
  "event" VARCHAR(120) NOT NULL,
  "request_id" VARCHAR(100) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "connector_audit_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "connector_audit_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "connector_audit_events_connector_installation_id_fkey" FOREIGN KEY ("connector_installation_id") REFERENCES "connector_installations"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "connector_audit_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "connector_audit_events_organization_id_created_at_idx" ON "connector_audit_events"("organization_id", "created_at");
CREATE INDEX "connector_audit_events_connector_installation_id_created_at_idx" ON "connector_audit_events"("connector_installation_id", "created_at");

CREATE TABLE "dummy_crm_leads" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "connector_installation_id" UUID NOT NULL,
  "first_name" VARCHAR(100),
  "last_name" VARCHAR(100),
  "phone" VARCHAR(40),
  "email" VARCHAR(320),
  "source" VARCHAR(100) NOT NULL,
  "interest" VARCHAR(255),
  "notes" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dummy_crm_leads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dummy_crm_leads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "dummy_crm_leads_connector_installation_id_fkey" FOREIGN KEY ("connector_installation_id") REFERENCES "connector_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "dummy_crm_leads_organization_id_created_at_idx" ON "dummy_crm_leads"("organization_id", "created_at");
CREATE INDEX "dummy_crm_leads_connector_installation_id_idx" ON "dummy_crm_leads"("connector_installation_id");
