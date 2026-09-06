/** Sprint 7 — persists granular per-utterance transcript segments (partial + final) for call replay/QA.
 * This is additive observability data, NOT conversation truth: the actual receptionist/agent turn is
 * still persisted as a normal ConversationMessage via AgentService.execute() (same as WhatsApp text),
 * so there is exactly one source of truth for "what was said in the conversation." Raw audio is never
 * persisted here or anywhere else — only recognized/spoken text.
 */
import { Injectable } from "@nestjs/common";
import type { Prisma, VoiceTranscriptSpeaker } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";

const MAX_SEGMENT_TEXT_LENGTH = 4000;

@Injectable()
export class VoiceTranscriptService {
  constructor(private readonly prisma: PrismaService) {}

  async append(input: {
    organizationId: string;
    voiceSessionId: string;
    speaker: VoiceTranscriptSpeaker;
    text: string;
    isFinal: boolean;
    sequenceNumber: number;
    startedAt?: Date;
    endedAt?: Date;
    confidence?: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const text = input.text.trim().slice(0, MAX_SEGMENT_TEXT_LENGTH);
    if (!text) return;
    try {
      await this.prisma.voiceTranscriptSegment.create({
        data: {
          organizationId: input.organizationId,
          voiceSessionId: input.voiceSessionId,
          speaker: input.speaker,
          text,
          isFinal: input.isFinal,
          sequenceNumber: input.sequenceNumber,
          ...(input.startedAt ? { startedAt: input.startedAt } : {}),
          ...(input.endedAt ? { endedAt: input.endedAt } : {}),
          ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          metadataJson: (input.metadata ?? {}) as Prisma.InputJsonValue
        }
      });
    } catch (error) {
      // A duplicate sequenceNumber (P2002) means a retried/duplicate event already wrote this segment —
      // harmless no-op, matching the idempotency convention used across the channels module. Any other
      // error is swallowed too: transcript persistence is best-effort observability and must never take
      // down a live call.
      void error;
    }
  }

  async ordered(organizationId: string, voiceSessionId: string) {
    return this.prisma.voiceTranscriptSegment.findMany({
      where: { organizationId, voiceSessionId },
      orderBy: { sequenceNumber: "asc" }
    });
  }
}
