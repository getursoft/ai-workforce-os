-- Sprint 2.2: normalized organization RBAC, soft deletion, and invitations.
ALTER TYPE "user_role" RENAME TO "legacy_user_role";
ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMP(3);

CREATE TABLE "roles" ("id" UUID NOT NULL, "organization_id" UUID NOT NULL, "name" VARCHAR(80) NOT NULL, "description" VARCHAR(255), "is_system" BOOLEAN NOT NULL DEFAULT false, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL, CONSTRAINT "roles_pkey" PRIMARY KEY ("id"));
CREATE TABLE "permissions" ("id" UUID NOT NULL, "key" VARCHAR(100) NOT NULL, "description" VARCHAR(255), CONSTRAINT "permissions_pkey" PRIMARY KEY ("id"));
CREATE TABLE "role_permissions" ("role_id" UUID NOT NULL, "permission_id" UUID NOT NULL, CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id"));
CREATE TABLE "user_roles" ("user_id" UUID NOT NULL, "role_id" UUID NOT NULL, "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id"));
CREATE TABLE "invitations" ("id" UUID NOT NULL, "organization_id" UUID NOT NULL, "email" VARCHAR(320) NOT NULL, "normalized_email" VARCHAR(320) NOT NULL, "token_hash" CHAR(64) NOT NULL, "role_ids" JSONB NOT NULL, "invited_by_id" UUID NOT NULL, "expires_at" TIMESTAMP(3) NOT NULL, "accepted_at" TIMESTAMP(3), "revoked_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL, CONSTRAINT "invitations_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "roles_organization_id_name_key" ON "roles"("organization_id","name");
CREATE INDEX "roles_organization_id_idx" ON "roles"("organization_id");
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");
CREATE INDEX "invitations_organization_id_normalized_email_idx" ON "invitations"("organization_id","normalized_email");
CREATE INDEX "invitations_expires_at_idx" ON "invitations"("expires_at");
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "permissions" ("id","key","description") VALUES
(gen_random_uuid(),'users.read','View organization users'),(gen_random_uuid(),'users.write','Create and update users'),(gen_random_uuid(),'users.delete','Deactivate users'),
(gen_random_uuid(),'roles.read','View roles and permissions'),(gen_random_uuid(),'roles.write','Manage custom roles'),(gen_random_uuid(),'invitations.read','View invitations'),(gen_random_uuid(),'invitations.write','Manage invitations'),(gen_random_uuid(),'organization.manage','Manage organization settings');
INSERT INTO "roles" ("id","organization_id","name","description","is_system","updated_at") SELECT gen_random_uuid(),o.id,n.name,n.description,true,CURRENT_TIMESTAMP FROM "organizations" o CROSS JOIN (VALUES ('Owner','Organization owner'),('Admin','Organization administrator'),('Manager','Team manager'),('Member','Organization member'),('Viewer','Read-only member')) n(name,description);
INSERT INTO "role_permissions" ("role_id","permission_id") SELECT r.id,p.id FROM "roles" r CROSS JOIN "permissions" p WHERE r.name IN ('Owner','Admin') OR (r.name='Manager' AND p.key IN ('users.read','roles.read','invitations.read','invitations.write')) OR (r.name='Member' AND p.key IN ('users.read','roles.read')) OR (r.name='Viewer' AND p.key IN ('users.read'));
INSERT INTO "user_roles" ("user_id","role_id") SELECT u.id,r.id FROM "users" u JOIN "roles" r ON r.organization_id=u.organization_id AND r.name=CASE u.role::text WHEN 'OWNER' THEN 'Owner' WHEN 'ADMIN' THEN 'Admin' ELSE 'Member' END;
