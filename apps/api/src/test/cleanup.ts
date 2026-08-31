import argon2 from "argon2";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";

const PLATFORM_OWNER_EMAIL =
  process.env.PLATFORM_OWNER_EMAIL?.toLowerCase() || "krpandey25646@gmail.com";
const PLATFORM_OWNER_PASSWORD = process.env.PLATFORM_OWNER_PASSWORD || "PlatformOwner@25646";

/**
 * Idempotently bootstraps the platform owner account + home organization. Any spec that logs in as the
 * platform owner must call this first — `deleteAllOrganizationScopedRows` (used by other specs' cleanup)
 * wipes the whole shared test database, including this account, so its presence can never be assumed.
 */
export async function ensurePlatformOwner(prisma: PrismaService): Promise<void> {
  const organization = await prisma.organization.upsert({
    where: { slug: "ai-workforce-os-platform" },
    update: {},
    create: { name: "Krevia.ai Platform", slug: "ai-workforce-os-platform", status: "ACTIVE" }
  });
  const existing = await prisma.user.findUnique({
    where: { normalizedEmail: PLATFORM_OWNER_EMAIL }
  });
  if (existing) return;
  await prisma.user.create({
    data: {
      organizationId: organization.id,
      firstName: "Krishna",
      lastName: "Pandey",
      email: PLATFORM_OWNER_EMAIL,
      normalizedEmail: PLATFORM_OWNER_EMAIL,
      passwordHash: await argon2.hash(PLATFORM_OWNER_PASSWORD),
      role: "OWNER",
      status: "ACTIVE"
    }
  });
}

/**
 * Deletes every row that references an Organization so `organization.deleteMany()` can run without hitting
 * a RESTRICT FK. The approval engine and the AI-employee/attachment tables all carry `organizationId` and
 * are created at runtime during e2e/integration runs — omitting them from a cleanup leaves RESTRICT
 * foreign keys (e.g. `approval_audit_events_organization_id_fkey`) that make org deletion fail with
 * PrismaClientKnownRequestError. Kept in a shared helper so every spec cleans identically.
 */
export async function deleteAllOrganizationScopedRows(prisma: PrismaService): Promise<void> {
  // Skill executions reference conversations/agent-executions/plugins.
  await prisma.skillExecution.deleteMany();
  // Travel artifacts (deepest first to satisfy cascades).
  await prisma.travelCancellation.deleteMany();
  await prisma.travelBooking.deleteMany();
  await prisma.travelLead.deleteMany();
  await prisma.travelEmployeeConfiguration.deleteMany();
  // Domain-employee artifacts + config (reference conversations/plugins — delete before them).
  await prisma.hrTicket.deleteMany();
  await prisma.hrLeaveRequest.deleteMany();
  await prisma.hrEmployeeConfiguration.deleteMany();
  await prisma.financeRecord.deleteMany();
  await prisma.financeEmployeeConfiguration.deleteMany();
  await prisma.itSupportTicket.deleteMany();
  await prisma.itSupportEmployeeConfiguration.deleteMany();
  await prisma.salesLead.deleteMany();
  await prisma.salesEmployeeConfiguration.deleteMany();
  await prisma.marketingCampaign.deleteMany();
  await prisma.marketingEmployeeConfiguration.deleteMany();
  await prisma.legalNotice.deleteMany();
  await prisma.legalEmployeeConfiguration.deleteMany();
  await prisma.customerSupportTicket.deleteMany();
  await prisma.customerSupportEmployeeConfiguration.deleteMany();
  // Attachments (reference conversations + plugins + users).
  await prisma.conversationAttachment.deleteMany();
  // Approval chain: assignments/decisions/audit-events reference approval_requests, which reference
  // workflow_executions. Delete deepest first.
  await prisma.approvalAssignment.deleteMany();
  await prisma.approvalDecision.deleteMany();
  await prisma.approvalAuditEvent.deleteMany();
  await prisma.approvalRequest.deleteMany();
  await prisma.approvalPolicy.deleteMany();
  // Workflows reference conversations + plugins + agent-executions.
  await prisma.workflowExecution.deleteMany();
  // Agent runtime.
  await prisma.agentToolExecution.deleteMany();
  await prisma.agentExecution.deleteMany();
  await prisma.agentMemory.deleteMany();
  // Memory (Sprint 4.5) — audit events reference memory records; both reference organizations.
  await prisma.memoryAuditEvent.deleteMany();
  await prisma.memoryRecord.deleteMany();
  await prisma.conversationSummary.deleteMany();
  // Billing — credit purchase orders and payment gateway configs reference users with RESTRICT,
  // delete before users.
  await prisma.creditPurchaseOrder.deleteMany();
  await prisma.paymentGatewayConfiguration.deleteMany();
  // Receptionist voice/handoff state references organization-scoped channels/conversations logically.
  await prisma.voiceSession.deleteMany();
  await prisma.receptionistHandoff.deleteMany();
  // Conversation content + conversations.
  await prisma.channelMessage.deleteMany();
  await prisma.conversationMessage.deleteMany();
  await prisma.conversation.deleteMany();
  // Knowledge.
  await prisma.knowledgeChunk.deleteMany();
  await prisma.knowledgeDocument.deleteMany();
  await prisma.knowledgeCollection.deleteMany();
  // Channels + connectors.
  await prisma.channelConnection.deleteMany();
  await prisma.connectorEvent.deleteMany();
  await prisma.connectorExecution.deleteMany();
  await prisma.connectorAuditEvent.deleteMany();
  await prisma.connectorInstallation.deleteMany();
  await prisma.dummyCrmLead.deleteMany();
  await prisma.usageEvent.deleteMany();
  // Shared AI configuration — children before parents: assignments/org-defaults reference
  // profiles (Restrict/SetNull), profiles reference connections (Restrict), and connections
  // reference users via createdByUserId (Restrict), so this must run before user.deleteMany().
  await prisma.employeeAiProfileAssignment.deleteMany();
  await prisma.organizationAiDefaults.deleteMany();
  await prisma.aiModelProfile.deleteMany();
  await prisma.aiProviderConnection.deleteMany();
  // Plugins + config.
  await prisma.pluginAiConfiguration.deleteMany();
  await prisma.pluginConfiguration.deleteMany();
  await prisma.emailDeliveryConfiguration.deleteMany();
  await prisma.employeeRoutingProfile.deleteMany();
  await prisma.plugin.deleteMany();
  // Identity + RBAC.
  await prisma.serviceAccount.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.teamMember.deleteMany();
  await prisma.team.deleteMany();
  await prisma.invitation.deleteMany();
  await prisma.authenticationSession.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.organizationSetting.deleteMany();
  await prisma.customerProfile.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}
