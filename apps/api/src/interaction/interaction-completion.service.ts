/** Sprint 7.12 STEP 9/10/13 — the one place that decides "this interaction is over" and triggers
 * reference notification. No generic "conversation ended" signal exists in this codebase (confirmed by
 * inspection: ConversationStatus is only ACTIVE/ARCHIVED) — this service recognizes the two concrete
 * signals available today: an explicit closing phrase in the text turn, and a voice call ending for a
 * reason that isn't a failure. A WorkflowExecution reaching COMPLETED is a natural third trigger point
 * (WorkflowExecutionService.markCompleted) that is NOT wired in this sprint — see
 * docs/interaction-reference.md's documented limitation; this service's `complete()` method is already
 * the right shape for that hook to call later.
 */
import { Injectable, Logger, Inject } from "@nestjs/common";
import { QUEUE } from "../queue/queue.tokens";
import { InteractionService } from "./interaction.service";
import { InteractionMetricsService } from "./interaction-metrics.service";
import type { BackgroundQueue, QueuePublishInput } from "../queue/queue.types";

/** English-only for now (documented limitation, same precedent as Sprint 6.6's Hinglish routing
 * coverage) — a customer explicitly signaling "we're done here." Deliberately conservative: false
 * negatives (missing a real closing) are far less harmful than false positives (ending a case the
 * customer wasn't actually finished with). */
const CLOSING_PATTERN =
  /\b(that'?s?\s+(all|it)(\s+for\s+now)?|nothing\s+else|no,?\s+that'?s?\s+(all|it)|we'?re\s+all\s+done|all\s+done(,?\s+thanks)?|thanks?,?\s*(that'?s?\s+(all|it))?,?\s*bye|goodbye|bye\s*(for\s+now)?)\b/i;

@Injectable()
export class InteractionCompletionService {
  private readonly logger = new Logger(InteractionCompletionService.name);

  constructor(
    private readonly interactions: InteractionService,
    private readonly metrics: InteractionMetricsService,
    @Inject(QUEUE) private readonly queue: BackgroundQueue
  ) {}

  /** STEP 9 — a conservative, explicit-only signal: does this customer message read like a closing
   * remark? Never inferred from the AGENT's response (an agent saying "let me know if there's anything
   * else" must never itself end the interaction). */
  detectsClosing(userText: string): boolean {
    return CLOSING_PATTERN.test(userText.trim());
  }

  /** Marks the interaction COMPLETED (idempotent — STEP 31) and fires the notification orchestrator
   * exactly once, fire-and-forget, never blocking or throwing into the caller (STEP 13/43). */
  async complete(organizationId: string, interactionId: string, resolutionSummary?: string | null): Promise<void> {
    const { alreadyTerminal } = await this.interactions.complete(organizationId, interactionId, {
      ...(resolutionSummary !== undefined ? { resolutionSummary } : {})
    });
    if (alreadyTerminal) return;
    this.metrics.increment("interactions_completed_total");
    const payload: QueuePublishInput = {
      organizationId,
      category: "NOTIFICATION_JOBS",
      refType: "Interaction",
      refId: interactionId,
      dedupeKey: `notification-${interactionId}`,
      payload: { interactionId, organizationId }
    };
    this.queue.publish(payload).catch((error) => {
      this.logger.error({
        event: "NOTIFICATION_JOB_ENQUEUE_FAILED",
        organizationId,
        interactionId,
        error: error instanceof Error ? error.message : "unknown"
      });
    });
  }

  async fail(organizationId: string, interactionId: string, resolutionSummary?: string | null): Promise<void> {
    const { alreadyTerminal } = await this.interactions.fail(organizationId, interactionId, {
      ...(resolutionSummary !== undefined ? { resolutionSummary } : {})
    });
    if (alreadyTerminal) return;
    this.metrics.increment("interactions_failed_total");
  }
}
