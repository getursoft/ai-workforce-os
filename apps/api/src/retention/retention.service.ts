import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { AppConfig } from "../config/app-config";
import { APP_CONFIG } from "../config/config.tokens";
import { ObservabilityRetentionService } from "../observability/observability-retention.service";

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly observabilityRetention: ObservabilityRetentionService
  ) {}

  onModuleInit(): void {
    if (this.config.boolean("RETENTION_ENABLED", true)) {
      this.timer = setInterval(() => void this.runOnce(), 60 * 60 * 1000);
      this.timer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    try {
      await this.observabilityRetention.runOnce();
      await this.cleanupInteractions();
      await this.cleanupVoice();
      await this.cleanupNotifications();
      await this.cleanupAgentExecutions();
      await this.cleanupWorkflowExecutions();
      this.logger.log({ event: "RETENTION_RUN_COMPLETED" });
    } catch (error) {
      this.logger.error({ event: "RETENTION_RUN_FAILED", error: String(error) });
    }
  }

  private async cleanupInteractions(): Promise<void> {
    const days = this.config.number("INTERACTION_RETENTION_DAYS", 90);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await this.prisma.interaction.deleteMany({
      where: { status: { in: ["COMPLETED", "FAILED", "CANCELLED"] }, updatedAt: { lt: cutoff } }
    });
    if (result.count > 0) this.logger.log({ event: "INTERACTION_RETENTION_CLEANUP", count: result.count });
  }

  private async cleanupVoice(): Promise<void> {
    const transcriptDays = this.config.number("VOICE_TRANSCRIPT_RETENTION_DAYS", 90);
    const eventDays = this.config.number("VOICE_EVENT_RETENTION_DAYS", 90);
    const transcriptCutoff = new Date(Date.now() - transcriptDays * 24 * 60 * 60 * 1000);
    const eventCutoff = new Date(Date.now() - eventDays * 24 * 60 * 60 * 1000);

    const transcriptResult = await this.prisma.voiceTranscriptSegment.deleteMany({
      where: { createdAt: { lt: transcriptCutoff } }
    });
    const eventResult = await this.prisma.voiceSession.deleteMany({
      where: { status: "ENDED", endedAt: { lt: eventCutoff } }
    });
    if (transcriptResult.count > 0) this.logger.log({ event: "VOICE_TRANSCRIPT_RETENTION_CLEANUP", count: transcriptResult.count });
    if (eventResult.count > 0) this.logger.log({ event: "VOICE_SESSION_RETENTION_CLEANUP", count: eventResult.count });
  }

  private async cleanupNotifications(): Promise<void> {
    const days = this.config.number("NOTIFICATION_RETENTION_DAYS", 90);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await this.prisma.interactionNotification.deleteMany({
      where: { status: { in: ["SENT", "DELIVERED", "FAILED", "SKIPPED"] }, createdAt: { lt: cutoff } }
    });
    if (result.count > 0) this.logger.log({ event: "NOTIFICATION_RETENTION_CLEANUP", count: result.count });
  }

  private async cleanupAgentExecutions(): Promise<void> {
    const days = this.config.number("EXECUTION_RETENTION_DAYS", 90);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await this.prisma.agentExecution.deleteMany({
      where: { status: { in: ["COMPLETED", "FAILED"] }, completedAt: { lt: cutoff } }
    });
    if (result.count > 0) this.logger.log({ event: "AGENT_EXECUTION_RETENTION_CLEANUP", count: result.count });
  }

  private async cleanupWorkflowExecutions(): Promise<void> {
    const days = this.config.number("EXECUTION_RETENTION_DAYS", 90);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await this.prisma.workflowExecution.deleteMany({
      where: { status: { in: ["COMPLETED", "FAILED", "CANCELLED"] }, completedAt: { lt: cutoff } }
    });
    if (result.count > 0) this.logger.log({ event: "WORKFLOW_RETENTION_CLEANUP", count: result.count });
  }
}
