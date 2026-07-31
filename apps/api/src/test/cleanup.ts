import { PrismaService } from "../infrastructure/prisma/prisma.service";

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
  await prisma.userRole.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.organizationSetting.deleteMany();
  await prisma.customerProfile.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}
