-- CreateTable
CREATE TABLE "conversation_attachments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "created_by_user_id" UUID,
    "original_filename" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(160) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" VARCHAR(500) NOT NULL,
    "extracted_text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_attachments_organization_id_conversation_id_created_at_idx" ON "conversation_attachments"("organization_id", "conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "conversation_attachments" ADD CONSTRAINT "conversation_attachments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_attachments" ADD CONSTRAINT "conversation_attachments_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_attachments" ADD CONSTRAINT "conversation_attachments_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_attachments" ADD CONSTRAINT "conversation_attachments_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
