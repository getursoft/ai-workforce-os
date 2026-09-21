/** Sprint 7.12 STEP 16 — a minimal structural interface + DI token for the WhatsApp outbound sender,
 * matching the exact RECEPTIONIST_RUNTIME/CHAT_DELEGATION_TRIGGER pattern already used in this codebase
 * (receptionist.types.ts, workforce/chat-delegation.token.ts) specifically to avoid a circular MODULE
 * dependency. `ChannelMessageProcessor` (channels/channel-message.processor.ts) is the real
 * implementation, bound to this token in channel.module.ts — this file has zero imports of its own, so
 * nothing that imports it can ever be part of a circular chain through it. Resolved lazily via ModuleRef
 * in interaction-notification.orchestrator.ts, not constructor DI, for the same reason.
 */
export interface WhatsAppSender {
  sendHumanMessage(
    organizationId: string,
    conversationId: string,
    body: string
  ): Promise<{ delivered: boolean; channelMessageId: string | null }>;
}

export const WHATSAPP_SENDER = Symbol("WHATSAPP_SENDER");
