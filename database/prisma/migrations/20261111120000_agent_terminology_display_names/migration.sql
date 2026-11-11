-- Agent terminology migration (display text only).
--
-- DATA-ONLY: no table, column, enum or constraint is created, renamed or dropped. Plugin slugs
-- ("travel-employee", ...), routing keys, memory scopes and every other persisted identifier are
-- intentionally unchanged (see docs/AGENT_TERMINOLOGY_MIGRATION_AUDIT.md, Option A).
--
-- Updates the human-readable name / displayName / description / routing displayName that were
-- snapshotted into each tenant's installed built-in plugin from the shipped plugin.json files.
-- A value is changed ONLY if it still equals the shipped legacy default, so any text a tenant
-- customised is left untouched. Fully idempotent: re-running updates zero rows.

DROP TABLE IF EXISTS "_agent_terminology_renames";
CREATE TEMP TABLE "_agent_terminology_renames" (
  "slug" TEXT PRIMARY KEY,
  "old_name" TEXT NOT NULL,
  "new_name" TEXT NOT NULL,
  "old_display" TEXT NOT NULL,
  "new_display" TEXT NOT NULL
);

INSERT INTO "_agent_terminology_renames" VALUES
  ('travel-employee',           'Travel Employee',           'Travel Agent',           'Travel Employee',           'Travel Agent'),
  ('hr-employee',               'HR Employee',               'HR Agent',               'HR Employee',               'HR Agent'),
  ('finance-employee',          'Finance Employee',          'Finance Agent',          'Finance Employee',          'Finance Agent'),
  ('it-support-employee',       'IT Support Employee',       'IT Support Agent',       'IT Support Employee',       'IT Support Agent'),
  ('sales-employee',            'Sales Employee',            'Sales Agent',            'Sales Employee',            'Sales Agent'),
  ('marketing-employee',        'Marketing Employee',        'Marketing Agent',        'Marketing Employee',        'Marketing Agent'),
  ('legal-employee',            'Legal Document Employee',   'Legal Document Agent',   'Legal Employee',            'Legal Agent'),
  ('customer-support-employee', 'Customer Support Employee', 'Customer Support Agent', 'Customer Support Employee', 'Customer Support Agent');

-- plugins: top-level columns
UPDATE "plugins" p SET "name" = r."new_name"
FROM "_agent_terminology_renames" r
WHERE p."slug" = r."slug" AND p."name" = r."old_name";

UPDATE "plugins" p SET "display_name" = r."new_display"
FROM "_agent_terminology_renames" r
WHERE p."slug" = r."slug" AND p."display_name" = r."old_display";

-- Only the shipped "AI <role> employee. ..." lead-in is rewritten; later sentences (which may refer
-- to human employees, e.g. the HR agent "answers employee questions") are preserved verbatim.
UPDATE "plugins" p SET "description" = regexp_replace(p."description", '^(AI [A-Za-z ]+?) employee\. ', '\1 agent. ')
FROM "_agent_terminology_renames" r
WHERE p."slug" = r."slug" AND p."description" ~ '^AI [A-Za-z ]+? employee\. ';

-- plugins.manifest (JSONB snapshot of the installed manifest)
UPDATE "plugins" p SET "manifest" = jsonb_set(p."manifest", '{name}', to_jsonb(r."new_name"))
FROM "_agent_terminology_renames" r
WHERE p."slug" = r."slug" AND p."manifest"->>'name' = r."old_name";

UPDATE "plugins" p SET "manifest" = jsonb_set(p."manifest", '{displayName}', to_jsonb(r."new_display"))
FROM "_agent_terminology_renames" r
WHERE p."slug" = r."slug" AND p."manifest"->>'displayName' = r."old_display";

UPDATE "plugins" p SET "manifest" = jsonb_set(
  p."manifest", '{description}',
  to_jsonb(regexp_replace(p."manifest"->>'description', '^(AI [A-Za-z ]+?) employee\. ', '\1 agent. '))
)
FROM "_agent_terminology_renames" r
WHERE p."slug" = r."slug" AND p."manifest"->>'description' ~ '^AI [A-Za-z ]+? employee\. ';

UPDATE "plugins" p SET "manifest" = jsonb_set(p."manifest", '{routing,displayName}', to_jsonb(r."new_display"))
FROM "_agent_terminology_renames" r
WHERE p."slug" = r."slug" AND p."manifest"#>>'{routing,displayName}' = r."old_display";

-- employee_routing_profiles: the name the AI Receptionist shows customers when it hands off
UPDATE "employee_routing_profiles" e SET "display_name" = r."new_display"
FROM "plugins" p
JOIN "_agent_terminology_renames" r ON r."slug" = p."slug"
WHERE e."plugin_installation_id" = p."id" AND e."display_name" = r."old_display";

DROP TABLE "_agent_terminology_renames";
