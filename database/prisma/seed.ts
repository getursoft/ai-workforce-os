import { LegacyUserRole, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const DEFAULT_PERMISSIONS = {
  Owner: [
    "users.read",
    "users.write",
    "users.delete",
    "roles.read",
    "roles.write",
    "invitations.read",
    "invitations.write",
    "organization.manage",
    "TEAM_READ",
    "TEAM_CREATE",
    "TEAM_UPDATE",
    "TEAM_DELETE",
    "TEAM_MEMBER_ADD",
    "TEAM_MEMBER_REMOVE",
    "TEAM_MEMBER_UPDATE",
    "service_accounts.read",
    "service_accounts.create",
    "service_accounts.update",
    "service_accounts.delete",
    "service_accounts.roles.manage",
    "api_keys.read",
    "api_keys.create",
    "api_keys.rotate",
    "api_keys.revoke"
  ],
  Admin: [
    "users.read",
    "users.write",
    "users.delete",
    "roles.read",
    "roles.write",
    "invitations.read",
    "invitations.write",
    "organization.manage",
    "TEAM_READ",
    "TEAM_CREATE",
    "TEAM_UPDATE",
    "TEAM_DELETE",
    "TEAM_MEMBER_ADD",
    "TEAM_MEMBER_REMOVE",
    "TEAM_MEMBER_UPDATE",
    "service_accounts.read",
    "service_accounts.create",
    "service_accounts.update",
    "service_accounts.delete",
    "service_accounts.roles.manage",
    "api_keys.read",
    "api_keys.create",
    "api_keys.rotate",
    "api_keys.revoke"
  ],
  Manager: [
    "users.read",
    "roles.read",
    "invitations.read",
    "invitations.write",
    "TEAM_READ",
    "TEAM_CREATE",
    "TEAM_UPDATE",
    "TEAM_MEMBER_ADD",
    "TEAM_MEMBER_REMOVE",
    "TEAM_MEMBER_UPDATE",
    "service_accounts.read",
    "api_keys.read"
  ],
  Member: ["users.read", "roles.read", "TEAM_READ"],
  Viewer: ["users.read", "TEAM_READ"]
} as const;

const descriptions: Record<string, string> = {
  "users.read": "View organization users",
  "users.write": "Create and update users",
  "users.delete": "Deactivate users",
  "roles.read": "View roles and permissions",
  "roles.write": "Manage custom roles",
  "invitations.read": "View invitations",
  "invitations.write": "Manage invitations",
  "organization.manage": "Manage organization settings",
  TEAM_READ: "View teams",
  TEAM_CREATE: "Create teams",
  TEAM_UPDATE: "Update teams",
  TEAM_DELETE: "Archive teams",
  TEAM_MEMBER_ADD: "Add team members",
  TEAM_MEMBER_REMOVE: "Remove team members",
  TEAM_MEMBER_UPDATE: "Update team members",
  "service_accounts.read": "View service accounts",
  "service_accounts.create": "Create service accounts",
  "service_accounts.update": "Update service accounts",
  "service_accounts.delete": "Archive service accounts",
  "service_accounts.roles.manage": "Manage service account roles",
  "api_keys.read": "View API key metadata",
  "api_keys.create": "Create API keys",
  "api_keys.rotate": "Rotate API keys",
  "api_keys.revoke": "Revoke API keys"
};

export async function seedRbac(client: PrismaClient = prisma): Promise<void> {
  for (const [key, description] of Object.entries(descriptions)) {
    await client.permission.upsert({
      where: { key },
      create: { key, description },
      update: { description }
    });
  }
  const permissions = await client.permission.findMany();
  const organizations = await client.organization.findMany({ select: { id: true } });
  for (const organization of organizations) {
    for (const [name, permissionKeys] of Object.entries(DEFAULT_PERMISSIONS)) {
      const role = await client.role.upsert({
        where: { organizationId_name: { organizationId: organization.id, name } },
        create: {
          organizationId: organization.id,
          name,
          description: `${name} system role`,
          isSystem: true
        },
        update: { isSystem: true }
      });
      await client.rolePermission.createMany({
        data: permissions
          .filter(({ key }) => (permissionKeys as readonly string[]).includes(key))
          .map(({ id }) => ({ roleId: role.id, permissionId: id })),
        skipDuplicates: true
      });
    }
    const users = await client.user.findMany({
      where: { organizationId: organization.id, userRoles: { none: {} } },
      select: { id: true, role: true }
    });
    const roles = await client.role.findMany({
      where: { organizationId: organization.id, isSystem: true },
      select: { id: true, name: true }
    });
    await client.userRole.createMany({
      data: users.flatMap((user) => {
        const name =
          user.role === LegacyUserRole.OWNER
            ? "Owner"
            : user.role === LegacyUserRole.ADMIN
              ? "Admin"
              : "Member";
        const role = roles.find((item) => item.name === name);
        return role ? [{ userId: user.id, roleId: role.id }] : [];
      }),
      skipDuplicates: true
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedRbac().finally(() => prisma.$disconnect());
}
