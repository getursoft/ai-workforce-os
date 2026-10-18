-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "recruitment_call_status" ADD VALUE 'CONTACT_VIEWED';
ALTER TYPE "recruitment_call_status" ADD VALUE 'CALL_ACTION_REQUESTED';
ALTER TYPE "recruitment_call_status" ADD VALUE 'CALL_LINK_OPENED';
ALTER TYPE "recruitment_call_status" ADD VALUE 'CALL_INITIATION_REQUESTED';
ALTER TYPE "recruitment_call_status" ADD VALUE 'CALL_PROVIDER_ACCEPTED';
ALTER TYPE "recruitment_call_status" ADD VALUE 'CALL_RINGING';
ALTER TYPE "recruitment_call_status" ADD VALUE 'CALL_CONNECTED';
ALTER TYPE "recruitment_call_status" ADD VALUE 'CALL_CANCELLED';

-- AlterTable
ALTER TABLE "recruitment_call_logs" ADD COLUMN     "failure_reason" VARCHAR(500),
ADD COLUMN     "platform" VARCHAR(16),
ADD COLUMN     "provider_call_id" VARCHAR(100);

