import { LegacyUserRole, PrismaClient } from "@prisma/client";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const prisma = new PrismaClient();

// argon2 is a dependency of the API package, not the root package the seed runs from — load it from
// the API's node_modules so the platform-owner password hash uses the same verifier as LoginHandler.
const requireFromApi = createRequire(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../apps/api/package.json")
);
const argon2 = requireFromApi("argon2") as typeof import("argon2");

export const PLATFORM_OWNER_EMAIL =
  process.env.PLATFORM_OWNER_EMAIL?.trim().toLowerCase() || "krpandey25646@gmail.com";
const PLATFORM_OWNER_PASSWORD =
  process.env.PLATFORM_OWNER_PASSWORD || "PlatformOwner@25646";
const PLATFORM_OWNER_FIRST_NAME = process.env.PLATFORM_OWNER_FIRST_NAME || "Krishna";
const PLATFORM_OWNER_LAST_NAME = process.env.PLATFORM_OWNER_LAST_NAME || "Pandey";

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
    "plugin.ai.manage",
    "plugin.email.manage",
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
    "connector.event.read",
    "knowledge.read",
    "knowledge.upload",
    "knowledge.delete",
    "knowledge.reindex",
    "knowledge.search",
    "knowledge.collection.manage",
    "channel.read",
    "channel.create",
    "channel.update",
    "channel.delete",
    "channel.test",
    "channel.message.read",
    "travel.config.read",
    "travel.config.update",
    "travel.conversation.reset",
    "travel.leads.read",
    "travel.leads.update",
    "usage.read",
    "billing.read",
    "billing.manage",
    "approval.read",
    "approval.create",
    "approval.decide",
    "approval.manage",
    "travel.booking.read",
    "travel.booking.manage",
    "travel.booking.approve.customer",
    "travel.cancellation.request",
    "travel.cancellation.approve",
    "hr.config.read",
    "hr.config.update",
    "hr.conversation.reset",
    "hr.tickets.read",
    "hr.tickets.update",
    "finance.config.read",
    "finance.config.update",
    "finance.conversation.reset",
    "finance.records.read",
    "finance.records.update",
    "it.config.read",
    "it.config.update",
    "it.conversation.reset",
    "it.tickets.read",
    "it.tickets.update",
    "sales.config.read",
    "sales.config.update",
    "sales.conversation.reset",
    "sales.leads.read",
    "sales.leads.update",
    "marketing.config.read",
    "marketing.config.update",
    "marketing.conversation.reset",
    "marketing.campaigns.read",
    "marketing.campaigns.update",
    "legal.config.read",
    "legal.config.update",
    "legal.conversation.reset",
    "legal.notices.read",
    "legal.notices.update",
    "support.config.read",
    "support.config.update",
    "support.conversation.reset",
    "support.tickets.read",
    "support.tickets.update",
    "hr.leave.submit",
    "hr.leave.approve",
    "workforce.read",
    "workforce.task.read",
    "workforce.task.manage",
    "workforce.collaboration.configure",
    "workforce.audit.read",
    "observability.read",
    "observability.trace.read",
    "observability.metrics.read",
    "observability.alert.read",
    "observability.alert.manage",
    "observability.operation.execute",
    "observability.platform.read",
    "scheduler.read",
    "scheduler.write",
    "scheduler.retry",
    "scheduler.template.read",
    "scheduler.template.write",
    "scheduler.worker.read"
  ],
  Admin: [
    "organization.manage",
    "TEAM_READ",
    "TEAM_CREATE",
    "TEAM_UPDATE",
    "TEAM_DELETE",
    "TEAM_MEMBER_ADD",
    "TEAM_MEMBER_REMOVE",
    "TEAM_MEMBER_UPDATE",
    "plugin.read",
    "plugin.email.manage",
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
    "connector.event.read",
    "knowledge.read",
    "knowledge.upload",
    "knowledge.delete",
    "knowledge.reindex",
    "knowledge.search",
    "knowledge.collection.manage",
    "channel.read",
    "channel.create",
    "channel.update",
    "channel.delete",
    "channel.test",
    "channel.message.read",
    "travel.config.read",
    "travel.config.update",
    "travel.conversation.reset",
    "travel.leads.read",
    "travel.leads.update",
    "travel.booking.read",
    "travel.booking.manage",
    "approval.read",
    "approval.decide",
    "travel.cancellation.approve",
    "hr.config.read",
    "hr.config.update",
    "hr.conversation.reset",
    "hr.tickets.read",
    "hr.tickets.update",
    "finance.config.read",
    "finance.config.update",
    "finance.conversation.reset",
    "finance.records.read",
    "finance.records.update",
    "it.config.read",
    "it.config.update",
    "it.conversation.reset",
    "it.tickets.read",
    "it.tickets.update",
    "sales.config.read",
    "sales.config.update",
    "sales.conversation.reset",
    "sales.leads.read",
    "sales.leads.update",
    "marketing.config.read",
    "marketing.config.update",
    "marketing.conversation.reset",
    "marketing.campaigns.read",
    "marketing.campaigns.update",
    "legal.config.read",
    "legal.config.update",
    "legal.conversation.reset",
    "legal.notices.read",
    "legal.notices.update",
    "support.config.read",
    "support.config.update",
    "support.conversation.reset",
    "support.tickets.read",
    "support.tickets.update",
    "hr.leave.approve",
    "workforce.read",
    "workforce.task.read",
    "workforce.task.manage",
    "workforce.collaboration.configure",
    "workforce.audit.read",
    "observability.read",
    "observability.trace.read",
    "observability.metrics.read",
    "observability.alert.read",
    "observability.alert.manage",
    "observability.operation.execute",
    "scheduler.read",
    "scheduler.write",
    "scheduler.retry",
    "scheduler.template.read",
    "scheduler.template.write",
    "scheduler.worker.read"
  ],
  Manager: [
    "TEAM_READ",
    "TEAM_CREATE",
    "TEAM_UPDATE",
    "TEAM_MEMBER_ADD",
    "TEAM_MEMBER_REMOVE",
    "TEAM_MEMBER_UPDATE",
    "plugin.read",
    "plugin.email.manage",
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
    "connector.event.read",
    "knowledge.read",
    "knowledge.search",
    "channel.read",
    "channel.test",
    "channel.message.read",
    "travel.config.read",
    "travel.conversation.reset",
    "travel.leads.read",
    "travel.booking.read",
    "approval.read",
    "approval.decide",
    "hr.config.read",
    "hr.conversation.reset",
    "hr.tickets.read",
    "finance.config.read",
    "finance.conversation.reset",
    "finance.records.read",
    "it.config.read",
    "it.conversation.reset",
    "it.tickets.read",
    "sales.config.read",
    "sales.conversation.reset",
    "sales.leads.read",
    "marketing.config.read",
    "marketing.conversation.reset",
    "marketing.campaigns.read",
    "legal.config.read",
    "legal.conversation.reset",
    "legal.notices.read",
    "support.config.read",
    "support.conversation.reset",
    "support.tickets.read",
    "hr.leave.submit",
    "hr.leave.approve",
    "workforce.read",
    "workforce.task.read",
    "observability.read",
    "observability.trace.read",
    "observability.metrics.read",
    "observability.alert.read",
    "scheduler.read",
    "scheduler.template.read",
    "scheduler.worker.read"
  ],
  Member: [
    "TEAM_READ",
    "plugin.read",
    "plugin.execute",
    "plugin.email.manage",
    "agents.run",
    "agents.conversations.read",
    "agents.memory.read",
    "agents.memory.write",
    "agents.tools.execute",
    "knowledge.read",
    "knowledge.search"
  ],
  Viewer: [
    "TEAM_READ",
    "plugin.read",
    "plugin.email.manage",
    "connector.read",
    "knowledge.read",
    "channel.read",
    "travel.config.read",
    "hr.config.read",
    "finance.config.read",
    "it.config.read",
    "sales.config.read",
    "marketing.config.read",
    "legal.config.read",
    "support.config.read",
    "scheduler.read"
  ]
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
  "plugin.ai.manage": "Configure AI model providers for employees",
  "plugin.email.manage": "Configure email delivery for employee notifications",
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
  "connector.event.read": "View connector inbound events",
  "knowledge.read": "View organization knowledge documents",
  "knowledge.upload": "Upload and index knowledge documents",
  "knowledge.delete": "Delete knowledge documents",
  "knowledge.reindex": "Re-index knowledge documents",
  "knowledge.search": "Search organization knowledge",
  "knowledge.collection.manage": "Create and manage AI Employee knowledge collections",
  "channel.read": "View messaging channel connections and configuration",
  "channel.create": "Create messaging channel connections",
  "channel.update": "Update messaging channel configuration and credentials",
  "channel.delete": "Archive messaging channel connections",
  "channel.test": "Test and enable or disable messaging channel connections",
  "channel.message.read": "View channel conversations and messages",
  "travel.config.read": "View Travel Employee configuration",
  "travel.config.update": "Update Travel Employee configuration",
  "travel.conversation.reset": "Reset a Travel Employee conversation",
  "travel.leads.read": "View travel leads captured by the AI Employee",
  "travel.leads.update": "Update travel lead status",
  "approval.read": "View approval requests",
  "approval.create": "Create approval requests",
  "approval.decide": "Approve or reject approval requests",
  "approval.manage": "Manage approval policies and configurations",
  "travel.booking.read": "View travel bookings and download tickets",
  "travel.booking.manage": "Record customer decisions, submit bookings to the provider, and deliver tickets",
  "travel.booking.approve.customer": "Request customer approval for travel bookings",
  "travel.cancellation.request": "Request travel cancellation",
  "travel.cancellation.approve": "Approve travel cancellation requests",
  "hr.config.read": "View HR Employee configuration",
  "hr.config.update": "Update HR Employee configuration",
  "hr.conversation.reset": "Reset an HR Employee conversation",
  "hr.tickets.read": "View HR tickets captured by the AI Employee",
  "hr.tickets.update": "Update HR ticket status",
  "finance.config.read": "View Finance Employee configuration",
  "finance.config.update": "Update Finance Employee configuration",
  "finance.conversation.reset": "Reset a Finance Employee conversation",
  "finance.records.read": "View finance records captured by the AI Employee",
  "finance.records.update": "Update finance record status",
  "it.config.read": "View IT Support Employee configuration",
  "it.config.update": "Update IT Support Employee configuration",
  "it.conversation.reset": "Reset an IT Support Employee conversation",
  "it.tickets.read": "View IT support tickets captured by the AI Employee",
  "it.tickets.update": "Update IT support ticket status",
  "sales.config.read": "View Sales Employee configuration",
  "sales.config.update": "Update Sales Employee configuration",
  "sales.conversation.reset": "Reset a Sales Employee conversation",
  "sales.leads.read": "View sales leads captured by the AI Employee",
  "sales.leads.update": "Update sales lead status",
  "marketing.config.read": "View Marketing Employee configuration",
  "marketing.config.update": "Update Marketing Employee configuration",
  "marketing.conversation.reset": "Reset a Marketing Employee conversation",
  "marketing.campaigns.read": "View marketing campaigns captured by the AI Employee",
  "marketing.campaigns.update": "Update marketing campaign status",
  "legal.config.read": "View Legal Employee configuration",
  "legal.config.update": "Update Legal Employee configuration",
  "legal.conversation.reset": "Reset a Legal Employee conversation",
  "legal.notices.read": "View legal notices tracked by the AI Employee",
  "legal.notices.update": "Update legal notice status",
  "support.config.read": "View Customer Support Employee configuration",
  "support.config.update": "Update Customer Support Employee configuration",
  "support.conversation.reset": "Reset a Customer Support Employee conversation",
  "support.tickets.read": "View customer support tickets captured by the AI Employee",
  "support.tickets.update": "Update customer support ticket status",
  "hr.leave.submit": "Submit and manage HR leave requests",
  "hr.leave.approve": "Approve or reject HR leave requests",
  "usage.read": "View AI-credit usage, token, and request metrics",
  "billing.read": "View billing plan and invoices",
  "billing.manage": "Purchase AI credit top-ups",
  "billing.payment_settings.manage": "Configure the payment gateway (Razorpay) credentials",
  "workforce.read": "View installed AI Employees and their collaboration profiles",
  "workforce.task.read": "View delegated tasks between AI Employees",
  "workforce.task.manage": "Trigger, cancel, and retry delegated tasks between AI Employees",
  "workforce.collaboration.configure": "Configure organization-wide AI Employee collaboration policy",
  "workforce.audit.read": "View audit events for AI Employee delegation",
  "observability.read": "View the observability overview (executions, success rate, running work)",
  "observability.trace.read": "View individual execution traces and their span trees",
  "observability.metrics.read": "View aggregated observability metrics and charts",
  "observability.alert.read": "View operational alerts",
  "observability.alert.manage": "Acknowledge and resolve operational alerts",
  "observability.operation.execute": "Perform safe operational actions (retry task, resume workflow) from observability",
  "observability.platform.read": "View cross-organization platform health (platform operators only)",
  "scheduler.read": "View scheduled jobs, executions, and the scheduler dashboard",
  "scheduler.write": "Create, update, pause, resume, and cancel scheduled jobs",
  "scheduler.retry": "Manually retry failed or dead-lettered scheduled executions",
  "scheduler.template.read": "View reusable job templates",
  "scheduler.template.write": "Instantiate and manage reusable job templates",
  "scheduler.worker.read": "View scheduler worker health and queue statistics"
};

export async function seedRbac(client: PrismaClient = prisma): Promise<void> {
  // Bootstrap the platform owner's home organization + account FIRST so the role loop below also
  // seeds the "Owner" system role and userRole assignment for it.
  await seedPlatformOwner(client);
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
      const declaredPermissionIds = permissions
        .filter(({ key }) => (permissionKeys as readonly string[]).includes(key))
        .map(({ id }) => id);
      await client.rolePermission.createMany({
        data: declaredPermissionIds.map((permissionId) => ({ roleId: role.id, permissionId })),
        skipDuplicates: true
      });
      // System roles are fully owned by DEFAULT_PERMISSIONS: revoke any grant that is no longer
      // declared for this role so removing a key here also takes effect for already-seeded orgs.
      if (role.isSystem) {
        await client.rolePermission.deleteMany({
          where: { roleId: role.id, permissionId: { notIn: declaredPermissionIds } }
        });
      }
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
  // Seed subscription plan and org subscription for the first organisation
  const org = await client.organization.findFirst();
  if (org) {
    const plan = await client.subscriptionPlan.upsert({
      where: { code: "GROWTH" },
      update: {},
      create: { code: "GROWTH", name: "Growth", description: "Shared AI credit pool for growing teams", monthlyCreditAllowance: 500000, overageEnabled: true, overageRateMicrosPerCredit: 1000 }
    });
    const now = new Date();
    const cycleStart = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const cycleEnd = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999);
    await client.organisationSubscription.upsert({
      where: { organizationId: org.id },
      update: {},
      create: { organizationId: org.id, planId: plan.id, status: "ACTIVE", billingCycleStart: cycleStart, billingCycleEnd: cycleEnd }
    });
  }
  await seedPlatformOwner(client);
  await seedSubscription(client);
}

/**
 * Bootstraps the single universal platform-owner account (SecurityConfig.platformOwnerEmail).
 * The account lives in a dedicated "AI Workforce OS Platform" home organization with legacy OWNER
 * role; seedRbac's role loop (which runs after this) assigns the Owner system role + permissions.
 * Idempotent: on re-seed it never duplicates the owner or resets an existing password.
 */
export async function seedPlatformOwner(client: PrismaClient = prisma): Promise<void> {
  const slug = "ai-workforce-os-platform";
  const organization = await client.organization.upsert({
    where: { slug },
    update: {},
    create: {
      name: "AI Workforce OS Platform",
      slug,
      status: "ACTIVE"
    }
  });
  const normalized = PLATFORM_OWNER_EMAIL;
  const existing = await client.user.findUnique({ where: { normalizedEmail: normalized } });
  if (existing) return;
  await client.user.create({
    data: {
      organizationId: organization.id,
      firstName: PLATFORM_OWNER_FIRST_NAME,
      lastName: PLATFORM_OWNER_LAST_NAME,
      email: normalized,
      normalizedEmail: normalized,
      passwordHash: await argon2.hash(PLATFORM_OWNER_PASSWORD),
      role: LegacyUserRole.OWNER,
      status: "ACTIVE"
    }
  });
}

async function seedSubscription(client: PrismaClient = prisma): Promise<void> {
  const org = await client.organization.findFirst();
  if (org) {
    const plan = await client.subscriptionPlan.upsert({
      where: { code: "GROWTH" },
      update: {},
      create: { code: "GROWTH", name: "Growth", description: "Shared AI credit pool for growing teams", monthlyCreditAllowance: 500000, overageEnabled: true, overageRateMicrosPerCredit: 1000 }
    });
    const now = new Date();
    const cycleStart = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const cycleEnd = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999);
    await client.organisationSubscription.upsert({
      where: { organizationId: org.id },
      update: {},
      create: { organizationId: org.id, planId: plan.id, status: "ACTIVE", billingCycleStart: cycleStart, billingCycleEnd: cycleEnd }
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedRbac().finally(() => prisma.$disconnect());
}
