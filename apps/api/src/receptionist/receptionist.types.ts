import type { AgentExecutionInput } from "../agents/agent.runtime";
import type { TraceContext } from "../observability/trace-context";
import type { ResponseChannel } from "../conversation/conversational-response-policy";

/** Sprint 6.4: kept as its own name for readability at every existing call site, but now a direct alias
 *  of the canonical `ResponseChannel` (conversational-response-policy.ts) rather than a second, independently
 *  maintained union — see `resolveConversationChannel`, the one place both the Receptionist and the direct
 *  (non-Receptionist) employee execution path derive "the channel" for a turn. */
export type ReceptionistChannel = ResponseChannel;
export type ReceptionistFrontDoorUnavailableReason =
  "RECEPTIONIST_NOT_INSTALLED" | "RECEPTIONIST_DISABLED" | "RECEPTIONIST_NOT_CONFIGURED";
export type ReceptionistRouteType =
  | "ROUTE"
  | "CLARIFY"
  | "CONTINUE_HANDOFF"
  | "MULTI_EMPLOYEE"
  | "RECEPTIONIST_RESPONSE"
  | "UNSUPPORTED";

export interface SafeAttachmentMetadata {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface SafeCustomerIdentity {
  id: string | null;
  type: string;
  displayName: string | null;
  locale: string | null;
  timezone: string | null;
}

export interface HandoffContext {
  [key: string]: unknown;
  customerRequest: string;
  customerIdentity: SafeCustomerIdentity;
  conversationSummary: string | null;
  attachments: SafeAttachmentMetadata[];
  extractedKnownFacts: Record<string, string | number | boolean>;
  requestedCapability: string | null;
  sourceChannel: ReceptionistChannel;
  locale: string | null;
  timezone: string | null;
}

/** Where the Receptionist's belief about the customer's name came from — surfaced only as an
 *  observability attribute, never the name itself (see the routing span in receptionist.service.ts). */
export type ReceptionistIdentitySource =
  | "AUTHENTICATED_PROFILE"
  | "RECEPTIONIST_CAPTURED"
  | "CHANNEL_IDENTITY"
  | "UNKNOWN";

/** Durable per-conversation intake state, persisted on the Receptionist's own `Conversation.metadata`
 *  (never on the specialist's conversation/entities — see the correction-pass spec's "Do NOT overload
 *  specialist workflow state unnecessarily"). Lets a bare name reply ("Krishna") be recognized as the
 *  answer to "may I know your name?" instead of being re-classified as a fresh routing request, and lets
 *  the original request resume once the name is known. */
export interface ReceptionistIntakeState {
  customerName: string | null;
  identityStatus: ReceptionistIdentitySource;
  pendingReceptionistInput: "CUSTOMER_NAME" | null;
  pendingOriginalRequest: string | null;
}

export interface ActiveReceptionistHandoff {
  id: string;
  targetEmployeeInstallationId: string;
  targetConversationId: string | null;
  routingIntent: string | null;
  routingCapability: string | null;
  routingConfidence: number;
  status: string;
}

export interface ReceptionistRouteInput {
  organizationId: string;
  receptionistInstallationId: string;
  conversationId: string;
  customerIdentity: SafeCustomerIdentity;
  message: string;
  attachmentMetadata: SafeAttachmentMetadata[];
  conversationSummary: string | null;
  currentHandoff: ActiveReceptionistHandoff | null;
  channel: ReceptionistChannel;
  llmRoutingEnabled: boolean;
  minimumRoutingConfidence: number;
  clarificationEnabled: boolean;
  /** Travel Booking Closure Pass — Phase 2: true when `currentHandoff`'s specialist currently has a
   *  structured pending question AND `message` reasonably satisfies it (see
   *  SpecialistPendingInputRegistry.isSatisfiedBy). When true, routing must return CONTINUE_HANDOFF
   *  immediately, before any domain-switch scoring runs — this is what stops a message like "share it
   *  here" from being stolen by an unrelated employee whose routing vocabulary happens to overlap a
   *  common English word ("it"). Always false when there's no active handoff or no resolver applies. */
  pendingInputSatisfied: boolean;
  /** Sprint 6.3 — Part 3: the active handoff's specialist's own most recent assistant reply (null if none
   *  yet, or no active handoff). Used to tell a genuine domain pivot ("forget the trip, check my salary")
   *  apart from an ordinary in-context follow-up that happens to share a word with another employee's
   *  routing vocabulary ("show me options above my budget", right after Travel itself asked for a budget)
   *  — see `contextEcho` in receptionist-routing.service.ts. Never used to grant ownership by itself; it
   *  only raises the bar for an implicit (non-explicit) switch away from the active specialist. */
  recentSpecialistMessage: string | null;
}

export interface ReceptionistRouteDecision {
  routeType: ReceptionistRouteType;
  primaryEmployeeInstallationId: string | null;
  secondaryEmployeeInstallationIds: string[];
  capability: string | null;
  intent: string | null;
  confidence: number;
  decisionSource: "DETERMINISTIC" | "LLM" | "ACTIVE_HANDOFF";
  reasonCode: string;
  clarificationQuestion: string | null;
  handoffMode: "DELEGATE_AND_RETURN" | "TRANSFER_SESSION" | "PARALLEL" | null;
  usage?: {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface ReceptionistRuntimeResult {
  conversationId: string;
  executionId: string;
  messageId: string;
  response: string;
  status: "COMPLETED" | "FAILED";
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCost: number | null;
  };
  sources: [];
  receptionist: {
    routeType: ReceptionistRouteType;
    decisionSource: ReceptionistRouteDecision["decisionSource"];
    confidence: number;
    reasonCode: string;
    handoff: {
      id: string;
      status: string;
      targetEmployeeInstallationId: string;
      targetDisplayName: string;
      displayMode: "TRANSPARENT_HANDOFF" | "RECEPTIONIST_PROXY";
    } | null;
  };
  /** Travel Booking Closure Pass — Phase 6: the specialist's own attachments (e.g. a booking confirmation
   *  PDF), preserved through the Receptionist wrapper — see receptionist.service.ts's `customerResponse`.
   *  Same top-level key AgentService.execute() already uses for a direct (non-handoff) response. */
  attachments?: Array<Record<string, unknown>>;
}

export interface ReceptionistRuntime {
  execute(
    input: AgentExecutionInput,
    traceContext?: TraceContext
  ): Promise<ReceptionistRuntimeResult>;
}

export const RECEPTIONIST_RUNTIME = Symbol("RECEPTIONIST_RUNTIME");
