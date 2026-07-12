CREATE TYPE "team_status" AS ENUM ('ACTIVE','INACTIVE','ARCHIVED');
CREATE TYPE "team_member_role" AS ENUM ('MANAGER','LEAD','MEMBER');
CREATE TABLE "teams" ("id" UUID NOT NULL DEFAULT gen_random_uuid(),"organization_id" UUID NOT NULL,"name" VARCHAR(120) NOT NULL,"slug" VARCHAR(140) NOT NULL,"description" VARCHAR(500),"manager_id" UUID,"parent_team_id" UUID,"status" "team_status" NOT NULL DEFAULT 'ACTIVE',"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updated_at" TIMESTAMP(3) NOT NULL,"deleted_at" TIMESTAMP(3),CONSTRAINT "teams_pkey" PRIMARY KEY ("id"));
CREATE TABLE "team_members" ("team_id" UUID NOT NULL,"user_id" UUID NOT NULL,"role" "team_member_role" NOT NULL DEFAULT 'MEMBER',"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updated_at" TIMESTAMP(3) NOT NULL,CONSTRAINT "team_members_pkey" PRIMARY KEY ("team_id","user_id"));
CREATE UNIQUE INDEX "teams_organization_id_slug_key" ON "teams"("organization_id","slug");
CREATE INDEX "teams_organization_id_status_deleted_at_idx" ON "teams"("organization_id","status","deleted_at");
CREATE INDEX "teams_manager_id_idx" ON "teams"("manager_id"); CREATE INDEX "teams_parent_team_id_idx" ON "teams"("parent_team_id"); CREATE INDEX "team_members_user_id_idx" ON "team_members"("user_id");
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "teams" ADD CONSTRAINT "teams_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "teams" ADD CONSTRAINT "teams_parent_team_id_fkey" FOREIGN KEY ("parent_team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
INSERT INTO "permissions"("id","key","description") VALUES
(gen_random_uuid(),'TEAM_READ','View teams'),(gen_random_uuid(),'TEAM_CREATE','Create teams'),(gen_random_uuid(),'TEAM_UPDATE','Update teams'),(gen_random_uuid(),'TEAM_DELETE','Archive teams'),(gen_random_uuid(),'TEAM_MEMBER_ADD','Add team members'),(gen_random_uuid(),'TEAM_MEMBER_REMOVE','Remove team members'),(gen_random_uuid(),'TEAM_MEMBER_UPDATE','Update team members') ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions"("role_id","permission_id") SELECT r.id,p.id FROM "roles" r CROSS JOIN "permissions" p WHERE (r.name IN ('Owner','Admin')) OR (r.name='Manager' AND p.key IN ('TEAM_READ','TEAM_CREATE','TEAM_UPDATE','TEAM_MEMBER_ADD','TEAM_MEMBER_REMOVE','TEAM_MEMBER_UPDATE')) OR (r.name IN ('Member','Viewer') AND p.key='TEAM_READ') ON CONFLICT DO NOTHING;
