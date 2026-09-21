/** Sprint 7.12 — the single, channel-agnostic entry point for interaction lifecycle. Chat/WhatsApp/voice
 * all call `findOrCreate()` — no per-channel duplicate implementation (rule #3/STEP 3 of the brief).
 *
 * `conversationId`/`voiceSessionId`/`channelConnectionId` on Interaction are loose references (see the
 * schema comment) — this service is the only place that resolves/links them, so callers never need their
 * own find-or-create logic.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import { Interaction, InteractionChannel, InteractionStatus, Prisma } from "@prisma/client";
import { APP_CONFIG, type AppConfig } from "../config/config.tokens";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { ReferenceIdGenerator } from "./reference-id.generator";

const MAX_REFERENCE_ID_ATTEMPTS = 5;
export const TERMINAL_INTERACTION_STATUSES: InteractionStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];
const TERMINAL_STATUSES = TERMINAL_INTERACTION_STATUSES;

export interface FindOrCreateInteractionInput {
  organizationId: string;
  channel: InteractionChannel;
  transport?: string | null;
  conversationId?: string | null;
  voiceSessionId?: string | null;
  channelConnectionId?: string | null;
  externalUserId?: string | null;
  phoneNumber?: string | null;
  email?: string | null;
  entryAgentId?: string | null;
  /** The Receptionist conversation a handoff dispatch originated from (`input.metadata.receptionistConversationId`
   * in agent.service.ts) — lets web-chat/dashboard handoffs (which have no `channelConnectionId`/`externalUserId`
   * to resolve a shared channel identity through) re-link to the Interaction the Receptionist already created,
   * instead of falling through to `create()` and minting a second reference for the same case. */
  linkedConversationId?: string | null;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

@Injectable()
export class InteractionService {
  private readonly logger = new Logger(InteractionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig
  ) {}

  private generator(): ReferenceIdGenerator {
    return new ReferenceIdGenerator({
      prefix: this.config.string("INTERACTION_REFERENCE_PREFIX", "KRV"),
      length: this.config.number("INTERACTION_REFERENCE_LENGTH", 6)
    });
  }

  /** Finds the Interaction this activity belongs to, or creates a fresh one — the ONLY way an
   * Interaction/reference is ever created in this codebase (STEP 3: even "Hi" creates one). Resolution
   * order: (1) an existing Interaction already linked to this exact conversation, (2) an existing one
   * already linked to this exact voice session, (3) the most recent non-terminal Interaction for the same
   * channel identity (phone/WhatsApp address) — covers "customer messages again a minute later, before
   * the Conversation row even existed yet" — otherwise (4) create new. Idempotent: safe to call on every
   * inbound turn of the same conversation/call. */
  async findOrCreate(input: FindOrCreateInteractionInput): Promise<Interaction> {
    if (input.conversationId) {
      const existing = await this.prisma.interaction.findFirst({
        where: { organizationId: input.organizationId, conversationId: input.conversationId }
      });
      if (existing) return this.touch(existing, input);
    }
    if (input.voiceSessionId) {
      const existing = await this.prisma.interaction.findFirst({
        where: { organizationId: input.organizationId, voiceSessionId: input.voiceSessionId }
      });
      if (existing) return this.touch(existing, input);
    }
    if (input.channelConnectionId && input.externalUserId) {
      const existing = await this.prisma.interaction.findFirst({
        where: {
          organizationId: input.organizationId,
          channelConnectionId: input.channelConnectionId,
          externalUserId: input.externalUserId,
          status: { notIn: TERMINAL_STATUSES }
        },
        orderBy: { createdAt: "desc" }
      });
      if (existing) return this.touch(existing, input);
    }
    if (input.linkedConversationId) {
      const existing = await this.prisma.interaction.findFirst({
        where: {
          organizationId: input.organizationId,
          conversationId: input.linkedConversationId,
          status: { notIn: TERMINAL_STATUSES }
        }
      });
      // A deliberate re-point, not the usual "permanent once known" rule `touch()` enforces: the case has
      // moved from the Receptionist's conversation to the specialist's, so the Interaction's conversationId
      // (its "currently active leg") should follow it, the same way `currentAgentId` already does.
      if (existing) return this.relinkConversation(existing, input);
    }
    return this.create(input);
  }

  private async create(input: FindOrCreateInteractionInput): Promise<Interaction> {
    const generator = this.generator();
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_REFERENCE_ID_ATTEMPTS; attempt++) {
      const referenceId = generator.generate();
      try {
        const interaction = await this.prisma.interaction.create({
          data: {
            organizationId: input.organizationId,
            referenceId,
            channel: input.channel,
            transport: input.transport ?? null,
            conversationId: input.conversationId ?? null,
            voiceSessionId: input.voiceSessionId ?? null,
            channelConnectionId: input.channelConnectionId ?? null,
            externalUserId: input.externalUserId ?? null,
            phoneNumber: input.phoneNumber ?? null,
            email: input.email ?? null,
            entryAgentId: input.entryAgentId ?? null,
            currentAgentId: input.entryAgentId ?? null,
            status: "ACTIVE"
          }
        });
        this.logger.log({
          event: "INTERACTION_STARTED",
          organizationId: input.organizationId,
          interactionId: interaction.id,
          referenceId: interaction.referenceId,
          channel: input.channel
        });
        return interaction;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        lastError = error;
      }
    }
    throw new Error(`INTERACTION_REFERENCE_ID_EXHAUSTED: ${String(lastError)}`);
  }

  /** Backfills any newly-known link fields (conversationId once resolved, agent once routed) onto an
   * already-existing Interaction, and bumps lastActivityAt — never overwrites a field that's already set
   * with a different value (a resolved conversationId is permanent once known). */
  private async touch(existing: Interaction, input: FindOrCreateInteractionInput): Promise<Interaction> {
    const data: Prisma.InteractionUpdateInput = { lastActivityAt: new Date() };
    if (!existing.conversationId && input.conversationId) data.conversationId = input.conversationId;
    if (!existing.voiceSessionId && input.voiceSessionId) data.voiceSessionId = input.voiceSessionId;
    if (!existing.channelConnectionId && input.channelConnectionId)
      data.channelConnectionId = input.channelConnectionId;
    if (!existing.phoneNumber && input.phoneNumber) data.phoneNumber = input.phoneNumber;
    if (!existing.email && input.email) data.email = input.email;
    return this.prisma.interaction.update({ where: { id: existing.id }, data });
  }

  /** Moves an existing Interaction's conversationId onto the specialist conversation a handoff just
   * dispatched to — the one place `conversationId` is allowed to change after being set, since a handoff is
   * an explicit, known move of the same case to a new conversation (see `linkedConversationId` above). */
  private async relinkConversation(
    existing: Interaction,
    input: FindOrCreateInteractionInput
  ): Promise<Interaction> {
    const data: Prisma.InteractionUpdateInput = { lastActivityAt: new Date() };
    if (input.conversationId) data.conversationId = input.conversationId;
    if (!existing.channelConnectionId && input.channelConnectionId)
      data.channelConnectionId = input.channelConnectionId;
    if (!existing.phoneNumber && input.phoneNumber) data.phoneNumber = input.phoneNumber;
    if (!existing.email && input.email) data.email = input.email;
    return this.prisma.interaction.update({ where: { id: existing.id }, data });
  }

  async setCurrentAgent(organizationId: string, interactionId: string, agentId: string): Promise<void> {
    await this.prisma.interaction.updateMany({
      where: { id: interactionId, organizationId },
      data: { currentAgentId: agentId, lastActivityAt: new Date() }
    });
  }

  async get(organizationId: string, interactionId: string): Promise<Interaction | null> {
    return this.prisma.interaction.findFirst({ where: { id: interactionId, organizationId } });
  }

  async findByConversationId(organizationId: string, conversationId: string): Promise<Interaction | null> {
    return this.prisma.interaction.findFirst({ where: { organizationId, conversationId } });
  }

  async findByVoiceSessionId(organizationId: string, voiceSessionId: string): Promise<Interaction | null> {
    return this.prisma.interaction.findFirst({ where: { organizationId, voiceSessionId } });
  }

  /** Idempotent: completing an already-terminal Interaction is a harmless no-op that returns
   * `alreadyTerminal: true` so callers (e.g. the notification trigger) never re-fire side effects for a
   * duplicate completion signal (STEP 31). */
  async complete(
    organizationId: string,
    interactionId: string,
    input: { resolutionSummary?: string | null } = {}
  ): Promise<{ interaction: Interaction; alreadyTerminal: boolean }> {
    return this.transitionToTerminal(organizationId, interactionId, "COMPLETED", input.resolutionSummary);
  }

  async fail(
    organizationId: string,
    interactionId: string,
    input: { resolutionSummary?: string | null } = {}
  ): Promise<{ interaction: Interaction; alreadyTerminal: boolean }> {
    return this.transitionToTerminal(organizationId, interactionId, "FAILED", input.resolutionSummary);
  }

  private async transitionToTerminal(
    organizationId: string,
    interactionId: string,
    status: "COMPLETED" | "FAILED",
    resolutionSummary?: string | null
  ): Promise<{ interaction: Interaction; alreadyTerminal: boolean }> {
    const existing = await this.prisma.interaction.findFirst({ where: { id: interactionId, organizationId } });
    if (!existing) throw new Error("INTERACTION_NOT_FOUND");
    if (TERMINAL_STATUSES.includes(existing.status)) return { interaction: existing, alreadyTerminal: true };
    const interaction = await this.prisma.interaction.update({
      where: { id: interactionId },
      data: {
        status,
        completedAt: new Date(),
        ...(resolutionSummary ? { resolutionSummary } : {})
      }
    });
    this.logger.log({
      event: status === "COMPLETED" ? "INTERACTION_COMPLETED" : "INTERACTION_FAILED",
      organizationId,
      interactionId,
      referenceId: interaction.referenceId
    });
    return { interaction, alreadyTerminal: false };
  }

  /** STEP 10/31 double-send guard: atomically claims the "communicate the reference now" slot for this
   * interaction. Returns true only for the ONE caller that wins the race (conditional update on
   * `referenceCommunicatedAt IS NULL`) — every other/later caller (a retried turn, a duplicate completion
   * signal) gets false and must not repeat the reference. */
  async claimReferenceCommunication(organizationId: string, interactionId: string): Promise<boolean> {
    const result = await this.prisma.interaction.updateMany({
      where: { id: interactionId, organizationId, referenceCommunicatedAt: null },
      data: { referenceCommunicatedAt: new Date() }
    });
    return result.count > 0;
  }
}
