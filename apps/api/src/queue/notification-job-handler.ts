import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InteractionNotificationOrchestrator } from "../interaction/interaction-notification.orchestrator";
import { QueueHandlerRegistry } from "./queue-worker";
import type { QueueMessageView } from "./queue.types";

@Injectable()
export class NotificationJobHandler implements OnModuleInit {
  private readonly logger = new Logger(NotificationJobHandler.name);

  constructor(
    private readonly orchestrator: InteractionNotificationOrchestrator,
    private readonly registry: QueueHandlerRegistry
  ) {}

  onModuleInit(): void {
    this.registry.register("NOTIFICATION_JOBS" as any, this.handle.bind(this));
  }

  async handle(message: QueueMessageView): Promise<boolean> {
    const { interactionId, organizationId } = this.parsePayload(message);
    if (!interactionId || !organizationId) {
      this.logger.warn({ event: "NOTIFICATION_JOB_INVALID_PAYLOAD", messageId: message.id });
      return true;
    }
    try {
      await this.orchestrator.notifyReferenceIssued(organizationId, interactionId);
      this.logger.log({ event: "NOTIFICATION_JOB_PROCESSED", messageId: message.id, interactionId });
      return true;
    } catch (error) {
      this.logger.error({
        event: "NOTIFICATION_JOB_FAILED",
        messageId: message.id,
        interactionId,
        error: error instanceof Error ? error.message : "unknown"
      });
      return false;
    }
  }

  private parsePayload(message: QueueMessageView): { interactionId?: string; organizationId?: string } {
    const payload = message.payload as Record<string, unknown>;
    return {
      interactionId: (payload.interactionId as string) ?? null,
      organizationId: (payload.organizationId as string) ?? null
    };
  }
}
