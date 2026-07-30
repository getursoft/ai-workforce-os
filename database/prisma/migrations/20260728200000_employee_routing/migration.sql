-- Employee routing: multi-employee intent-based routing for WhatsApp channels

ALTER TABLE "channel_connections"
  ADD COLUMN "routing_mode" varchar(24) DEFAULT 'FIXED',
  ADD COLUMN "default_employee_id" uuid,
  ADD COLUMN "allowed_employee_ids" jsonb DEFAULT '[]',
  ADD COLUMN "receptionist_greeting" varchar(500),
  ADD COLUMN "intent_question" varchar(500),
  ADD COLUMN "out_of_scope_message" varchar(500),
  ADD COLUMN "ambiguous_intent_message" varchar(500);
