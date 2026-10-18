-- CreateEnum
CREATE TYPE "recruitment_chat_verification_status" AS ENUM ('PENDING_CONTACT', 'PENDING_OTP', 'VERIFIED');

-- CreateTable
CREATE TABLE "recruitment_chat_identity_verifications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "status" "recruitment_chat_verification_status" NOT NULL DEFAULT 'PENDING_CONTACT',
    "contact_method" VARCHAR(10),
    "contact_value" VARCHAR(160),
    "otp_hash" VARCHAR(128),
    "otp_expires_at" TIMESTAMP(3),
    "otp_attempts" INTEGER NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_chat_identity_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_chat_identity_verif_organization_id_user_id_p_key" ON "recruitment_chat_identity_verifications"("organization_id", "user_id", "plugin_installation_id");

-- AddForeignKey
ALTER TABLE "recruitment_chat_identity_verifications" ADD CONSTRAINT "recruitment_chat_identity_verifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_chat_identity_verifications" ADD CONSTRAINT "recruitment_chat_identity_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_chat_identity_verifications" ADD CONSTRAINT "recruitment_chat_identity_verifications_revoked_by_user_i_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
