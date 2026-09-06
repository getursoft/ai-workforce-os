-- CreateEnum
CREATE TYPE "voice_transport" AS ENUM ('WHATSAPP', 'PSTN', 'WEBRTC', 'SIMULATOR');

-- CreateEnum
CREATE TYPE "voice_direction" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "voice_transcript_speaker" AS ENUM ('USER', 'AGENT', 'SYSTEM');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "voice_session_status" ADD VALUE 'CREATED';
ALTER TYPE "voice_session_status" ADD VALUE 'CONNECTING';
ALTER TYPE "voice_session_status" ADD VALUE 'INTERRUPTED';
ALTER TYPE "voice_session_status" ADD VALUE 'ENDING';

-- AlterTable
ALTER TABLE "channel_connections" ADD COLUMN     "voice_enabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "voice_sessions" ADD COLUMN     "answered_at" TIMESTAMP(3),
ADD COLUMN     "direction" "voice_direction" NOT NULL DEFAULT 'INBOUND',
ADD COLUMN     "external_caller_id" VARCHAR(64),
ADD COLUMN     "last_activity_at" TIMESTAMP(3),
ADD COLUMN     "provider_stream_id" VARCHAR(200),
ADD COLUMN     "termination_reason" VARCHAR(200),
ADD COLUMN     "transport" "voice_transport" NOT NULL DEFAULT 'SIMULATOR';

-- CreateTable
CREATE TABLE "voice_transcript_segments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "voice_session_id" UUID NOT NULL,
    "speaker" "voice_transcript_speaker" NOT NULL,
    "text" TEXT NOT NULL,
    "is_final" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "confidence" DOUBLE PRECISION,
    "sequence_number" INTEGER NOT NULL,
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_transcript_segments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "voice_transcript_segments_organization_id_voice_session_id__idx" ON "voice_transcript_segments"("organization_id", "voice_session_id", "sequence_number");

-- CreateIndex
CREATE UNIQUE INDEX "voice_transcript_segments_voice_session_id_sequence_number_key" ON "voice_transcript_segments"("voice_session_id", "sequence_number");

-- AddForeignKey
ALTER TABLE "voice_transcript_segments" ADD CONSTRAINT "voice_transcript_segments_voice_session_id_fkey" FOREIGN KEY ("voice_session_id") REFERENCES "voice_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
