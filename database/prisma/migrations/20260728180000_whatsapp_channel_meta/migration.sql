-- WhatsApp Channel Integration: Meta Cloud API support
-- Extends channel enums and adds Meta-specific fields to channel_connections.

ALTER TYPE "channel_provider" ADD VALUE 'META_CLOUD_API';
ALTER TYPE "channel_connection_status" ADD VALUE 'CONNECTING';
ALTER TYPE "channel_connection_status" ADD VALUE 'CONNECTED';
ALTER TYPE "channel_connection_status" ADD VALUE 'DEGRADED';
ALTER TYPE "channel_connection_status" ADD VALUE 'FAILED';

ALTER TABLE "channel_connections"
  ADD COLUMN "whatsapp_business_account_id" varchar(100),
  ADD COLUMN "phone_number_id" varchar(100) UNIQUE,
  ADD COLUMN "display_phone_number" varchar(24),
  ADD COLUMN "assigned_agent_id" uuid,
  ADD COLUMN "onboarding_mode" varchar(24) DEFAULT 'MANUAL',
  ADD COLUMN "token_expires_at" timestamp(3) with time zone,
  ADD COLUMN "last_webhook_received_at" timestamp(3) with time zone;

CREATE INDEX "channel_connections_org_waba_idx" ON "channel_connections"("organization_id", "whatsapp_business_account_id");
