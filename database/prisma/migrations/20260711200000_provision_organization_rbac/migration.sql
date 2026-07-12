-- Provision system RBAC atomically for newly-created organizations and users.
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey"
  FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION provision_system_roles() RETURNS trigger AS $$
BEGIN
  INSERT INTO "roles" ("id", "organization_id", "name", "description", "is_system", "updated_at")
  SELECT gen_random_uuid(), NEW.id, role.name, role.description, true, CURRENT_TIMESTAMP
  FROM (VALUES ('Owner','Organization owner'),('Admin','Organization administrator'),
    ('Manager','Team manager'),('Member','Organization member'),('Viewer','Read-only member')) role(name,description)
  ON CONFLICT ("organization_id", "name") DO NOTHING;

  INSERT INTO "role_permissions" ("role_id", "permission_id")
  SELECT r.id, p.id FROM "roles" r CROSS JOIN "permissions" p
  WHERE r.organization_id = NEW.id AND
    (r.name IN ('Owner','Admin') OR
     (r.name='Manager' AND p.key IN ('users.read','roles.read','invitations.read','invitations.write')) OR
     (r.name='Member' AND p.key IN ('users.read','roles.read')) OR
     (r.name='Viewer' AND p.key='users.read'))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER organizations_provision_system_roles
AFTER INSERT ON "organizations" FOR EACH ROW EXECUTE FUNCTION provision_system_roles();

CREATE OR REPLACE FUNCTION assign_legacy_user_role() RETURNS trigger AS $$
BEGIN
  INSERT INTO "user_roles" ("user_id", "role_id")
  SELECT NEW.id, r.id FROM "roles" r
  WHERE r.organization_id = NEW.organization_id
    AND r.name = CASE NEW.role::text WHEN 'OWNER' THEN 'Owner' WHEN 'ADMIN' THEN 'Admin' ELSE 'Member' END
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_assign_legacy_role
AFTER INSERT ON "users" FOR EACH ROW EXECUTE FUNCTION assign_legacy_user_role();
