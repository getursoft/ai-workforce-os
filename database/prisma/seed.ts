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
    "api_keys.revoke",
    "plugin.read",
    "plugin.install",
    "plugin.update",
    "plugin.delete",
    "plugin.execute",
    "agents.run",
    "agents.conversations.read",
    "agents.executions.read",
    "agents.memory.read",
    "agents.memory.write",
    "agents.tools.execute",
    "connector.read",
    "connector.install",
    "connector.update",
    "connector.configure",
    "connector.authenticate",
    "connector.enable",
    "connector.disable",
    "connector.test",
    "connector.health",
    "connector.disconnect",
    "connector.remove",
    "connector.audit.read",
    "connector.execution.read",
    "connector.event.read"
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
    "api_keys.revoke",
    "plugin.read",
    "plugin.install",
    "plugin.update",
    "plugin.delete",
    "plugin.execute",
    "agents.run",
    "agents.conversations.read",
    "agents.executions.read",
    "agents.memory.read",
    "agents.memory.write",
    "agents.tools.execute",
    "connector.read",
    "connector.install",
    "connector.update",
    "connector.configure",
    "connector.authenticate",
    "connector.enable",
    "connector.disable",
    "connector.test",
    "connector.health",
    "connector.disconnect",
    "connector.remove",
    "connector.audit.read",
    "connector.execution.read",
    "connector.event.read"
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
    "api_keys.read",
    "plugin.read",
    "plugin.install",
    "plugin.update",
    "plugin.execute",
    "agents.run",
    "agents.conversations.read",
    "agents.executions.read",
    "agents.memory.read",
    "agents.memory.write",
    "agents.tools.execute",
    "connector.read",
    "connector.test",
    "connector.health",
    "connector.execution.read",
    "connector.event.read"
  ],
  Member: [
    "users.read",
    "roles.read",
    "TEAM_READ",
    "plugin.read",
    "plugin.execute",
    "agents.run",
    "agents.conversations.read",
    "agents.memory.read",
    "agents.memory.write",
    "agents.tools.execute"
  ],
  Viewer: ["users.read", "TEAM_READ", "plugin.read", "connector.read"]
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
  "api_keys.revoke": "Revoke API keys",
  "plugin.read": "View installed plugins",
  "plugin.install": "Install plugins",
  "plugin.update": "Update plugin state and configuration",
  "plugin.delete": "Remove plugins",
  "plugin.execute": "Execute plugin tools",
  "agents.run": "Run enabled AI employees",
  "agents.conversations.read": "View agent conversations",
  "agents.executions.read": "View agent execution history",
  "agents.memory.read": "Read scoped agent memory",
  "agents.memory.write": "Manage scoped agent memory",
  "agents.tools.execute": "Execute approved agent tools",
  "connector.read": "View connector catalogue and installations",
  "connector.install": "Install organization connectors",
  "connector.update": "Update connector metadata",
  "connector.configure": "Configure connectors and capability grants",
  "connector.authenticate": "Manage connector credentials and authentication",
  "connector.enable": "Enable connectors",
  "connector.disable": "Disable connectors",
  "connector.test": "Test connector connections",
  "connector.health": "Check connector health",
  "connector.disconnect": "Disconnect connectors",
  "connector.remove": "Archive connector installations",
  "connector.audit.read": "View connector audit history",
  "connector.execution.read": "View connector executions",
  "connector.event.read": "View connector inbound events"
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
