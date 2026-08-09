-- Sprint 6.1: RBAC — skill.* permissions for system roles.
-- Inserts permission rows (idempotent), updates the provisioning trigger so newly created orgs
-- receive them, and reconciles existing organizations' system roles (same pattern as
-- 20260731230000_rbac_trigger_least_privilege).
INSERT INTO "permissions" ("id", "key", "description")
SELECT gen_random_uuid(), key, description FROM (VALUES
  ('skill.execute', 'Execute installed skills on behalf of AI employees'),
  ('skill.install', 'Install skills from the skill marketplace'),
  ('skill.update', 'Update, enable, disable, or roll back skill installations'),
  ('skill.uninstall', 'Uninstall skills from the organization'),
  ('skill.configure', 'Configure skill settings for the organization'),
  ('skill.marketplace.read', 'Browse the skill marketplace and installation state'),
  ('skill.execution.read', 'View skill execution history and usage'),
  ('skill.health.read', 'Check installed skill health'),
  ('skill.grant.manage', 'Grant or revoke skills to installed AI employees')
) AS skill(key, description)
ON CONFLICT ("key") DO NOTHING;

CREATE OR REPLACE FUNCTION provision_system_roles() RETURNS trigger AS $$
BEGIN
  INSERT INTO "roles" ("id", "organization_id", "name", "description", "is_system", "updated_at")
  SELECT gen_random_uuid(), NEW.id, role.name, role.description, true, CURRENT_TIMESTAMP
  FROM (VALUES ('Owner','Organization owner'),('Admin','Organization administrator'),
    ('Manager','Team manager'),('Member','Organization member'),('Viewer','Read-only member')) role(name,description)
  ON CONFLICT ("organization_id", "name") DO NOTHING;

  INSERT INTO "role_permissions" ("role_id", "permission_id")
  SELECT r.id, p.id FROM "roles" r CROSS JOIN "permissions" p
  WHERE r.organization_id = NEW.id AND (
    r.name = 'Owner'
    OR (r.name = 'Admin' AND p.key IN ('users.read','users.write','users.delete','roles.read','roles.write','invitations.read','invitations.write','organization.manage','TEAM_READ','TEAM_CREATE','TEAM_UPDATE','TEAM_DELETE','TEAM_MEMBER_ADD','TEAM_MEMBER_REMOVE','TEAM_MEMBER_UPDATE','service_accounts.read','service_accounts.create','service_accounts.update','service_accounts.delete','service_accounts.roles.manage','api_keys.read','api_keys.create','api_keys.rotate','api_keys.revoke','plugin.read','plugin.install','plugin.update','plugin.delete','plugin.email.manage','plugin.execute','agents.run','agents.conversations.read','agents.executions.read','agents.memory.read','agents.memory.write','agents.tools.execute','connector.read','connector.install','connector.update','connector.configure','connector.authenticate','connector.enable','connector.disable','connector.test','connector.health','connector.disconnect','connector.remove','connector.audit.read','connector.execution.read','connector.event.read','knowledge.read','knowledge.upload','knowledge.delete','knowledge.reindex','knowledge.search','knowledge.collection.manage','channel.read','channel.create','channel.update','channel.delete','channel.test','channel.message.read','travel.config.read','travel.config.update','travel.conversation.reset','travel.leads.read','travel.leads.update','travel.booking.read','travel.booking.manage','approval.read','approval.decide','travel.cancellation.approve','hr.config.read','hr.config.update','hr.conversation.reset','hr.tickets.read','hr.tickets.update','finance.config.read','finance.config.update','finance.conversation.reset','finance.records.read','finance.records.update','it.config.read','it.config.update','it.conversation.reset','it.tickets.read','it.tickets.update','sales.config.read','sales.config.update','sales.conversation.reset','sales.leads.read','sales.leads.update','marketing.config.read','marketing.config.update','marketing.conversation.reset','marketing.campaigns.read','marketing.campaigns.update','legal.config.read','legal.config.update','legal.conversation.reset','legal.notices.read','legal.notices.update','support.config.read','support.config.update','support.conversation.reset','support.tickets.read','support.tickets.update','hr.leave.approve','workforce.read','workforce.task.read','workforce.task.manage','workforce.collaboration.configure','workforce.audit.read','observability.read','observability.trace.read','observability.metrics.read','observability.alert.read','observability.alert.manage','observability.operation.execute','observability.platform.read','scheduler.read','scheduler.write','scheduler.retry','scheduler.template.read','scheduler.template.write','scheduler.worker.read','skill.execute','skill.install','skill.update','skill.uninstall','skill.configure','skill.marketplace.read','skill.execution.read','skill.health.read','skill.grant.manage'))
    OR (r.name = 'Manager' AND p.key IN ('users.read','roles.read','invitations.read','invitations.write','TEAM_READ','TEAM_CREATE','TEAM_UPDATE','TEAM_MEMBER_ADD','TEAM_MEMBER_REMOVE','TEAM_MEMBER_UPDATE','service_accounts.read','api_keys.read','plugin.read','plugin.install','plugin.update','plugin.email.manage','plugin.execute','agents.run','agents.conversations.read','agents.executions.read','agents.memory.read','agents.memory.write','agents.tools.execute','connector.read','connector.test','connector.health','connector.execution.read','connector.event.read','knowledge.read','knowledge.search','channel.read','channel.test','channel.message.read','travel.config.read','travel.conversation.reset','travel.leads.read','travel.booking.read','approval.read','approval.decide','hr.config.read','hr.conversation.reset','hr.tickets.read','finance.config.read','finance.conversation.reset','finance.records.read','it.config.read','it.conversation.reset','it.tickets.read','sales.config.read','sales.conversation.reset','sales.leads.read','marketing.config.read','marketing.conversation.reset','marketing.campaigns.read','legal.config.read','legal.conversation.reset','legal.notices.read','support.config.read','support.conversation.reset','support.tickets.read','hr.leave.submit','hr.leave.approve','skill.execute','skill.marketplace.read','skill.execution.read','skill.health.read','skill.grant.manage'))
    OR (r.name = 'Member' AND p.key IN ('TEAM_READ','plugin.email.manage','agents.run','agents.conversations.read','agents.memory.read','agents.memory.write','agents.tools.execute','knowledge.read','knowledge.search','skill.execute','skill.marketplace.read','skill.execution.read'))
    OR (r.name = 'Viewer' AND p.key IN ('TEAM_READ','plugin.email.manage','connector.read','knowledge.read','channel.read','travel.config.read','hr.config.read','finance.config.read','it.config.read','sales.config.read','marketing.config.read','legal.config.read','support.config.read','skill.marketplace.read'))
  )
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Reconcile EXISTING organizations: refresh the Admin/Manager/Member/Viewer system roles with the
-- skill.* grants (Owner already receives every permission via the trigger above).
DO $$
BEGIN
  INSERT INTO "role_permissions" ("role_id", "permission_id")
  SELECT r.id, p.id FROM "roles" r CROSS JOIN "permissions" p
  WHERE r.is_system = true AND r.name IN ('Admin','Manager','Member','Viewer') AND (
    (r.name = 'Admin' AND p.key IN ('skill.execute','skill.install','skill.update','skill.uninstall','skill.configure','skill.marketplace.read','skill.execution.read','skill.health.read','skill.grant.manage'))
    OR (r.name = 'Manager' AND p.key IN ('skill.execute','skill.marketplace.read','skill.execution.read','skill.health.read','skill.grant.manage'))
    OR (r.name = 'Member' AND p.key IN ('skill.execute','skill.marketplace.read','skill.execution.read'))
    OR (r.name = 'Viewer' AND p.key = 'skill.marketplace.read')
  )
  ON CONFLICT DO NOTHING;
END $$;
