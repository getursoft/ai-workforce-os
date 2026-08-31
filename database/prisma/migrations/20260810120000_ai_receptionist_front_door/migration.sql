-- AI Receptionist / Universal Workforce Front Door (additive)
CREATE TYPE "receptionist_handoff_status" AS ENUM (
  'ROUTING',
  'CLARIFYING',
  'HANDOFF_ACTIVE',
  'WAITING_SPECIALIST',
  'RETURNED_TO_RECEPTIONIST',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
);

CREATE TYPE "voice_session_status" AS ENUM ('RINGING', 'ACTIVE', 'ENDED', 'FAILED');

ALTER TABLE "employee_routing_profiles"
  ADD COLUMN "employee_key" VARCHAR(120),
  ADD COLUMN "capabilities" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "channel_eligibility" JSONB NOT NULL DEFAULT '["WEB","WHATSAPP","VOICE"]',
  ADD COLUMN "current_availability" VARCHAR(40) NOT NULL DEFAULT 'AVAILABLE';

CREATE TABLE "receptionist_handoffs" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "receptionist_installation_id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "customer_identity_id" UUID,
  "target_employee_installation_id" UUID NOT NULL,
  "target_conversation_id" UUID,
  "delegated_task_id" UUID,
  "status" "receptionist_handoff_status" NOT NULL DEFAULT 'ROUTING',
  "routing_intent" VARCHAR(120),
  "routing_capability" VARCHAR(120),
  "routing_confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "source_channel" VARCHAR(40) NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "parent_trace_id" VARCHAR(64),
  "metadata_json" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "receptionist_handoffs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "receptionist_handoffs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "receptionist_handoffs_organization_id_conversation_id_status_idx"
  ON "receptionist_handoffs"("organization_id", "conversation_id", "status");
CREATE INDEX "receptionist_handoffs_organization_id_customer_identity_id_status_idx"
  ON "receptionist_handoffs"("organization_id", "customer_identity_id", "status");
CREATE INDEX "receptionist_handoffs_organization_id_target_employee_installation_idx"
  ON "receptionist_handoffs"("organization_id", "target_employee_installation_id", "status");

CREATE TABLE "voice_sessions" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "channel_connection_id" UUID NOT NULL,
  "customer_identity_id" UUID,
  "receptionist_conversation_id" UUID NOT NULL,
  "active_handoff_id" UUID,
  "provider" VARCHAR(80) NOT NULL,
  "provider_call_id" VARCHAR(200) NOT NULL,
  "status" "voice_session_status" NOT NULL DEFAULT 'RINGING',
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMP(3),
  "speech_end_to_ack_ms" INTEGER,
  "routing_ms" INTEGER,
  "specialist_first_response_ms" INTEGER,
  "total_turn_ms" INTEGER,
  "metadata_json" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "voice_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "voice_sessions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "voice_sessions_organization_id_provider_provider_call_id_key"
  ON "voice_sessions"("organization_id", "provider", "provider_call_id");
CREATE INDEX "voice_sessions_organization_id_status_idx"
  ON "voice_sessions"("organization_id", "status");
CREATE INDEX "voice_sessions_organization_id_receptionist_conversation_id_idx"
  ON "voice_sessions"("organization_id", "receptionist_conversation_id");
