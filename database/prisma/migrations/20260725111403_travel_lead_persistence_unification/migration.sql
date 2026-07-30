-- CreateEnum
CREATE TYPE "travel_lead_crm_sync_status" AS ENUM ('PENDING', 'SYNCED', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "travel_leads"
  ADD COLUMN "journey_id" VARCHAR(64),
  ADD COLUMN "email" VARCHAR(160),
  ADD COLUMN "trip_purpose" VARCHAR(120),
  ADD COLUMN "display_currency" VARCHAR(8),
  ADD COLUMN "consent_given_at" TIMESTAMP(3),
  ADD COLUMN "idempotency_key" VARCHAR(300),
  ADD COLUMN "crm_sync_status" "travel_lead_crm_sync_status" NOT NULL DEFAULT 'PENDING';

-- CreateIndex
CREATE UNIQUE INDEX "travel_leads_idempotency_key_key" ON "travel_leads"("idempotency_key");
