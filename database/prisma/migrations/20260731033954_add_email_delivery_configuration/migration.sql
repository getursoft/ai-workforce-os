-- CreateTable
CREATE TABLE "email_delivery_configurations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "configuration" JSONB NOT NULL,
    "encrypted_secrets" JSONB NOT NULL,
    "encryption_version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_delivery_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_delivery_configurations_plugin_installation_id_key" ON "email_delivery_configurations"("plugin_installation_id");

-- CreateIndex
CREATE INDEX "email_delivery_configurations_organization_id_plugin_instal_idx" ON "email_delivery_configurations"("organization_id", "plugin_installation_id");

-- AddForeignKey
ALTER TABLE "email_delivery_configurations" ADD CONSTRAINT "email_delivery_configurations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_delivery_configurations" ADD CONSTRAINT "email_delivery_configurations_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_delivery_configurations" ADD CONSTRAINT "email_delivery_configurations_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
