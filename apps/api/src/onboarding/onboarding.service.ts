import { Injectable } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { EntitlementService } from "../entitlements/entitlement.service";

export interface OnboardingChecklistItem {
  key: string;
  label: string;
  complete: boolean;
}

export interface OnboardingChecklist {
  items: OnboardingChecklistItem[];
  completedCount: number;
  totalCount: number;
  percentComplete: number;
}

/**
 * Sprint 5.0 — Phase 12: a computed (never stored) onboarding checklist. Every check is a real read
 * against state that already exists — no new schema, no "activation" step to forget, and it can never
 * drift out of sync with reality the way a stored boolean flag could.
 */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService
  ) {}

  async checklist(organizationId: string): Promise<OnboardingChecklist> {
    const [employees, users, channels, knowledgeDocuments, subscription, executions, providerConfigured] = await Promise.all([
      this.entitlements.getUsage(organizationId, "MAX_EMPLOYEES"),
      this.entitlements.getUsage(organizationId, "MAX_USERS"),
      this.entitlements.getUsage(organizationId, "MAX_WHATSAPP_CHANNELS"),
      this.prisma.knowledgeDocument.count({ where: { organizationId } }),
      this.prisma.organisationSubscription.count({ where: { organizationId } }),
      this.prisma.agentExecution.count({ where: { organizationId, status: "COMPLETED" }, take: 1 }),
      this.prisma.pluginAiConfiguration.count({ where: { organizationId } })
    ]);

    const items: OnboardingChecklistItem[] = [
      { key: "EMPLOYEE_INSTALLED", label: "Install your first AI Employee", complete: employees > 0 },
      { key: "PROVIDER_CONFIGURED", label: "Configure an AI provider (or use the platform default)", complete: employees > 0 || providerConfigured > 0 },
      { key: "KNOWLEDGE_UPLOADED", label: "Upload knowledge for your employees to reference", complete: knowledgeDocuments > 0 },
      { key: "CHANNEL_CONNECTED", label: "Connect a channel (WhatsApp/Twilio)", complete: channels > 0 },
      { key: "TEAM_INVITED", label: "Invite your team", complete: users > 1 },
      { key: "EMPLOYEE_TESTED", label: "Test an employee in chat", complete: executions > 0 },
      { key: "BILLING_CONFIGURED", label: "Set up billing / choose a plan", complete: subscription > 0 }
    ];
    const completedCount = items.filter((i) => i.complete).length;
    return {
      items,
      completedCount,
      totalCount: items.length,
      percentComplete: Math.round((completedCount / items.length) * 100)
    };
  }
}
