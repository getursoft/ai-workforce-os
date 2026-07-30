-- Employee routing profiles and processing acknowledgement fields

ALTER TABLE "channel_connections"
  ADD COLUMN "processing_acknowledgement_enabled" boolean DEFAULT true,
  ADD COLUMN "processing_acknowledgement_message" varchar(500),
  ADD COLUMN "processing_acknowledgement_mode" varchar(32) DEFAULT 'ALWAYS_AFTER_ROUTING';

CREATE TABLE "employee_routing_profiles" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "organization_id" uuid NOT NULL,
    "plugin_installation_id" uuid NOT NULL,
    "display_name" varchar(160) NOT NULL,
    "employee_type" varchar(80),
    "summary" varchar(500),
    "supported_domains" jsonb DEFAULT '[]',
    "supported_intents" jsonb DEFAULT '[]',
    "example_queries" jsonb DEFAULT '[]',
    "excluded_intents" jsonb DEFAULT '[]',
    "routing_keywords" jsonb DEFAULT '[]',
    "enabled_for_channel_routing" boolean DEFAULT true,
    "routing_priority" integer DEFAULT 0,
    "created_at" timestamp(3) with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp(3) with time zone NOT NULL,
    CONSTRAINT "employee_routing_profiles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "employee_routing_profiles_plugin_unique" UNIQUE ("plugin_installation_id")
);

CREATE INDEX "employee_routing_profiles_org_enabled_idx" ON "employee_routing_profiles"("organization_id", "enabled_for_channel_routing");

ALTER TABLE "employee_routing_profiles"
    ADD CONSTRAINT "erp_organization_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "employee_routing_profiles"
    ADD CONSTRAINT "erp_plugin_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE;
