-- CreateTable
CREATE TABLE "travel_employee_configurations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "persona" VARCHAR(2000) NOT NULL DEFAULT '',
    "welcome_message" VARCHAR(1000) NOT NULL DEFAULT 'Hi! I''m your AI travel assistant. Where would you like to travel to?',
    "business_hours_timezone" VARCHAR(64),
    "business_hours_start" VARCHAR(5),
    "business_hours_end" VARCHAR(5),
    "escalation_contact" VARCHAR(255) NOT NULL DEFAULT '',
    "brand_tone" VARCHAR(40) NOT NULL DEFAULT 'FRIENDLY',
    "default_currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "default_language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "travel_employee_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "travel_employee_configurations_plugin_installation_id_key" ON "travel_employee_configurations"("plugin_installation_id");

-- CreateIndex
CREATE INDEX "travel_employee_configurations_organization_id_idx" ON "travel_employee_configurations"("organization_id");

-- AddForeignKey
ALTER TABLE "travel_employee_configurations" ADD CONSTRAINT "travel_employee_configurations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_employee_configurations" ADD CONSTRAINT "travel_employee_configurations_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_employee_configurations" ADD CONSTRAINT "travel_employee_configurations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
