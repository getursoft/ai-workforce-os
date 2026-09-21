/** Sprint 7.12 STEP 23/24/25 — secure, tenant-scoped lookup by customer-facing reference id. A reference
 * id is an IDENTIFIER, never an authentication secret (STEP 29): every caller here already supplies its
 * own `organizationId` from an authenticated/tenant-scoped context (the admin API's JWT principal, or the
 * agent tool's ToolExecutionContext) — this service never accepts a bare reference id with no tenant
 * scope attached.
 */
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.tokens";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { InteractionMetricsService } from "./interaction-metrics.service";
import { normalizeReferenceId } from "./reference-id.generator";

export interface InteractionLookupResult {
  interactionId: string;
  referenceId: string;
  status: string;
  channel: string;
  startedAt: Date;
  completedAt: Date | null;
  entryAgentId: string | null;
  currentAgentId: string | null;
  conversationId: string | null;
  /** Reuses the existing ConversationSummary table when one exists for the linked conversation (STEP
   * 25: "reuse conversation/memory/history architecture... use safe summarization... not blindly replay
   * full transcript") — falls back to the Interaction's own resolutionSummary, then null. Never the raw
   * transcript. */
  summary: string | null;
}

@Injectable()
export class InteractionReferenceLookupService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly metrics: InteractionMetricsService
  ) {}

  async lookup(organizationId: string, rawReferenceId: string): Promise<InteractionLookupResult | null> {
    this.metrics.increment("reference_lookup_total");
    const prefixLength = this.config.string("INTERACTION_REFERENCE_PREFIX", "KRV").length;
    const normalized = normalizeReferenceId(rawReferenceId, prefixLength);
    const interaction = await this.prisma.interaction.findFirst({
      where: { organizationId, referenceId: normalized }
    });
    if (!interaction) {
      this.metrics.increment("reference_lookup_not_found_total");
      return null;
    }
    const summary = await this.resolveSummary(organizationId, interaction);
    return {
      interactionId: interaction.id,
      referenceId: interaction.referenceId,
      status: interaction.status,
      channel: interaction.channel,
      startedAt: interaction.startedAt,
      completedAt: interaction.completedAt,
      entryAgentId: interaction.entryAgentId,
      currentAgentId: interaction.currentAgentId,
      conversationId: interaction.conversationId,
      summary
    };
  }

  private async resolveSummary(
    organizationId: string,
    interaction: { conversationId: string | null; resolutionSummary: string | null }
  ): Promise<string | null> {
    if (interaction.conversationId) {
      const summary = await this.prisma.conversationSummary.findFirst({
        where: { organizationId, conversationId: interaction.conversationId }
      });
      if (summary) return summary.summary;
    }
    return interaction.resolutionSummary ?? null;
  }
}
