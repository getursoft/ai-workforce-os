import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  RequestTimeoutException
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import {
  AgentExecutionStatus,
  AgentMemoryScope,
  AgentToolExecutionStatus,
  ConversationAiControlState,
  ConversationMessageActorType,
  ConversationMessageRole,
  ConversationStatus,
  PluginStatus,
  Prisma,
  TravelLeadCrmSyncStatus
} from "@prisma/client";
import type { AiProvider } from "@ai-workforce-os/plugin-sdk";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { BillingEnforcementService } from "../billing/billing-enforcement.service";
import { ObservabilityService } from "../observability/observability.service";
import type { TraceContext } from "../observability/trace-context";
import { TraceContextStore } from "../observability/trace-context.store";
import { summarizeText } from "../observability/observability-sanitizer";
import { RECEPTIONIST_RUNTIME, type ReceptionistRuntime } from "../receptionist/receptionist.types";
import {
  composeChannelResponse,
  resolveConversationChannel
} from "../conversation/conversational-response-policy";
import type { ChatDelegationTriggerService } from "../workforce/chat-delegation-trigger.service";
import { CHAT_DELEGATION_TRIGGER } from "../workforce/chat-delegation.token";
import { IdentityApplicationError } from "../identity/application/errors/identity.error";
import { AuthorizationService } from "../identity/application/services/authorization.service";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../identity/infrastructure/security/security-config";
import { AgentRunDto, PageDto, SaveMemoryDto, SearchMemoryDto, UpdateMemoryDto } from "./agent.dto";
import {
  PromptBuilder,
  ToolExecutor,
  ToolPermissionPolicy,
  ToolRegistry,
  estimateCost,
  redact,
  type AgentExecutionInput,
  type ModelMessage,
  type ToolExecutionContext,
  withTimeout
} from "./agent.runtime";
import { buildToolCatalog } from "./tool-catalog";
import { AiProviderError, type ProviderSettings } from "../plugins/plugin-ai.runtime";
import { PluginAiService } from "../plugins/plugin-ai.service";
import { ConnectorService } from "../connectors/connector.service";
import { KnowledgeSearchService } from "../knowledge/knowledge.search";
import type { KnowledgeSource } from "../knowledge/knowledge.types";
import { estimateTokens } from "../knowledge/knowledge.chunking";
import {
  buildKnowledgeAnswer,
  buildKnowledgeBlock,
  namesOtherEmployeeDomain,
  NO_KNOWLEDGE_MESSAGE
} from "../knowledge/knowledge.prompt";
import {
  DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
  TRAVEL_EMPLOYEE_PLUGIN_SLUG,
  TRAVEL_TRIP_STATE_MEMORY_KEY,
  TravelEmployeeLlmOrchestrator,
  TravelEmployeeProvider,
  arbitrateConversationTurn,
  buildSalesHandoffFallbackMessage,
  buildToolFailureRecoveryMessage,
  deriveTravelState,
  EMPTY_TRAVEL_ENTITIES,
  entitiesFromStoredState,
  entitiesToStoredState,
  generatePlaceholderFlights,
  generatePlaceholderHotels,
  memoryFromStoredState,
  resolveTravelInput,
  type TravelEmployeeRuntimeConfig
} from "../travel/travel.runtime";
import { classifyRequestIntent, isKnowledgeEligible } from "./request-classifier";
import { CustomerIdentityService } from "../customer-identity/customer-identity.service";
import type { CustomerIdentity } from "../customer-identity/customer-identity.types";
import { TravelLeadService } from "../travel/travel-lead.service";
import { TravelBookingService } from "../travel/booking/travel-booking.service";
import { formatMoney } from "../travel/currency.service";
import {
  EmployeeDomainLlmOrchestrator,
  EmployeeDomainProvider,
  employeeEntitiesFromStoredState,
  employeeEntitiesToStoredState,
  employeeMemoryFromStoredState,
  employeeScopeProfile,
  type EmployeeRuntimeConfig
} from "../employees/employee-runtime";
import {
  EMPLOYEE_DOMAIN_REGISTRY,
  findEmployeeDomain,
  type EmployeeDomainDescriptor
} from "../employees/employee-registry";
import { EmployeeArtifactService } from "../employees/employee-artifact.service";
import { ApiBackedEmployeeProvider } from "../employees/api-backed.provider";
import { SkillRegistry } from "../skills/skill-registry";
import { SkillRuntimeService } from "../skills/skill-runtime.service";
// Sprint 6.1 — the Universal Skills Platform. Distinct from the pre-existing, unrelated Travel-only
// conversational state machine imported just above (`SkillRegistry`/`SkillRuntimeService`, singular
// "Skill"): `SkillsRuntimeService`/`SkillRegistryService` (plural "Skills") is the versioned,
// billed, tenant-isolated marketplace runtime any employee can invoke. Do not conflate the two.
import { SkillsRuntimeService } from "../skills-platform/skill-runtime.service";
import { SkillRegistryService } from "../skills-platform/skill-registry.service";
import {
  SkillExecutionRevisionConflictError,
  SkillExecutionService
} from "../skills/skill-execution.service";
import {
  PLAN_TRIP_SKILL_ID,
  PLAN_TRIP_SKILL_VERSION,
  PlanTripSkillHandler,
  emptyPlanTripSkillState
} from "../skills/travel/plan-trip.skill";
import {
  adaptTravelEntitiesForPlanTripShadow,
  comparePlanTripShadow,
  failedPlanTripShadowComparison,
  mergeDeterministicTravelShadowEntities,
  normalizeExistingTravelDecision,
  withPlanTripShadowPersistence,
  type PlanTripShadowComparison
} from "../skills/travel/plan-trip-shadow-comparison";
import { PlanTripSkillExecutionMapper } from "../skills/travel/plan-trip-skill-execution.mapper";
import { InputCollectionService } from "../skills/travel/input-collection.service";
import { TravelDecisionAdapter } from "../skills/travel/travel-decision-adapter";
import {
  isAuthoritativeModeEnabled,
  resolvePlanTripRuntimeMode,
  type PlanTripRuntimeMode
} from "../skills/travel/skill-runtime-authoritative-config";
import { CapabilityExecutionAdapter } from "../skills/travel/capability-execution.adapter";
import { WorkflowCoordinator } from "../workflows/workflow-coordinator";
import type { ContactCaptureTripContext } from "../workflows/contact-capture/contact-capture.types";
import type { BookingHandoffTripContext } from "../workflows/booking-handoff/booking-handoff.types";
import type { TripSubmissionTripContext } from "../workflows/trip-submission/trip-submission.types";
import type {
  WorkflowDispatchOutcome,
  WorkflowDispatchSignals
} from "../workflows/workflow-runtime.contracts";
import type { WorkflowSignal } from "../workflows/workflow-signal.contracts";
import {
  MemoryService as PlatformMemoryService,
  MEMORY_PROMPT_RECENT_MESSAGES,
  MEMORY_SUMMARIZE_THRESHOLD
} from "../memory/memory.service";
import { formatMemoryContextBlock } from "../memory/memory.prompt";

@Injectable()
export class MemoryService {
  constructor(private readonly prisma: PrismaService) {}
  async save(organizationId: string, userId: string | null, input: SaveMemoryDto) {
    await this.assertScope(organizationId, userId, input);
    const conversationId =
      input.scope === AgentMemoryScope.CONVERSATION ? (input.conversationId ?? null) : null;
    const where = {
      organizationId,
      pluginInstallationId: input.pluginInstallationId,
      userId: input.scope === AgentMemoryScope.USER ? userId : null,
      conversationId,
      scope: input.scope,
      key: input.key,
      deletedAt: null
    };
    const existing = await this.prisma.agentMemory.findFirst({ where });
    const data = {
      value: input.value as Prisma.InputJsonValue,
      searchableText: input.searchableText ?? JSON.stringify(input.value).slice(0, 2000),
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      deletedAt: null
    };
    return existing
      ? this.prisma.agentMemory.update({ where: { id: existing.id }, data })
      : this.prisma.agentMemory.create({
          data: {
            organizationId,
            pluginInstallationId: input.pluginInstallationId,
            userId: input.scope === AgentMemoryScope.USER ? userId : null,
            conversationId,
            scope: input.scope,
            key: input.key,
            ...data
          }
        });
  }
  async search(organizationId: string, userId: string | null, input: SearchMemoryDto) {
    await this.assertPlugin(organizationId, input.pluginInstallationId);
    return this.prisma.agentMemory.findMany({
      where: {
        organizationId,
        pluginInstallationId: input.pluginInstallationId,
        deletedAt: null,
        AND: [
          {
            OR: [
              { userId },
              {
                userId: null,
                scope: { in: [AgentMemoryScope.PLUGIN, AgentMemoryScope.ORGANIZATION] }
              }
            ]
          },
          {
            OR: [
              { key: { contains: input.query, mode: "insensitive" } },
              { searchableText: { contains: input.query, mode: "insensitive" } }
            ]
          }
        ]
      },
      orderBy: { updatedAt: "desc" },
      take: input.limit
    });
  }
  async list(organizationId: string, userId: string, page: PageDto) {
    const where: Prisma.AgentMemoryWhereInput = {
      organizationId,
      deletedAt: null,
      OR: [{ userId }, { userId: null }]
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.agentMemory.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize
      }),
      this.prisma.agentMemory.count({ where })
    ]);
    return paged(items, total, page);
  }
  async update(organizationId: string, userId: string, id: string, dto: UpdateMemoryDto) {
    const memory = await this.prisma.agentMemory.findFirst({
      where: { id, organizationId, deletedAt: null, OR: [{ userId }, { userId: null }] }
    });
    if (!memory) throw new NotFoundException("MEMORY_NOT_FOUND");
    return this.prisma.agentMemory.update({
      where: { id },
      data: {
        value: dto.value as Prisma.InputJsonValue,
        ...(dto.searchableText !== undefined ? { searchableText: dto.searchableText } : {}),
        ...(dto.metadata !== undefined ? { metadata: dto.metadata as Prisma.InputJsonValue } : {})
      }
    });
  }
  async forget(organizationId: string, userId: string, id: string): Promise<void> {
    const memory = await this.prisma.agentMemory.findFirst({
      where: { id, organizationId, deletedAt: null, OR: [{ userId }, { userId: null }] }
    });
    if (!memory) throw new NotFoundException("MEMORY_NOT_FOUND");
    await this.prisma.agentMemory.update({ where: { id }, data: { deletedAt: new Date() } });
  }
  private async assertScope(organizationId: string, userId: string | null, input: SaveMemoryDto) {
    await this.assertPlugin(organizationId, input.pluginInstallationId);
    if (input.scope === AgentMemoryScope.CONVERSATION) {
      if (!input.conversationId) throw new ConflictException("MEMORY_SCOPE_INVALID");
      const count = await this.prisma.conversation.count({
        where: {
          id: input.conversationId,
          organizationId,
          pluginInstallationId: input.pluginInstallationId,
          deletedAt: null
        }
      });
      if (!count) throw new NotFoundException("CONVERSATION_NOT_FOUND");
    }
    if (input.scope === AgentMemoryScope.USER && !userId)
      throw new ForbiddenException("MEMORY_SCOPE_DENIED");
  }
  private async assertPlugin(organizationId: string, id: string) {
    if (!(await this.prisma.plugin.count({ where: { id, organizationId, deletedAt: null } })))
      throw new NotFoundException("PLUGIN_INSTALLATION_NOT_FOUND");
  }
}

/**
 * Baseline tool permissions granted to channel-originated executions (e.g. WhatsApp).
 * There is no dashboard user to resolve RBAC permissions for; authorization instead happens
 * upstream, when an admin with `channel.create`/`channel.update` binds the channel to an agent.
 */
const CHANNEL_ACTOR_PERMISSIONS = new Set([
  "agents.memory.read",
  "agents.memory.write",
  "agents.tools.execute"
]);

/** Placeholder settings used for logging/telemetry when the Travel Employee's deterministic engine runs. */
const TRAVEL_PROVIDER_SETTINGS: ProviderSettings = {
  providerType: "DETERMINISTIC",
  timeoutMs: 15000
};

/** Placeholder settings used for logging/telemetry when a domain employee's deterministic engine runs. */
const EMPLOYEE_PROVIDER_SETTINGS: ProviderSettings = {
  providerType: "DETERMINISTIC",
  timeoutMs: 15000
};

// Sprint 6.7 — Part 21: an explicit customer request to be connected to a human, checked before any
// employee dispatch runs (the same gate point as the human-takeover pause check below). English and
// Hinglish are matched with separate patterns so the acknowledgement can be returned in the same
// register the customer used, mirroring this file's/travel.runtime.ts's existing convention of literal
// phrase alternation rather than a generic combinator.
const HUMAN_ESCALATION_REQUEST_PATTERN_EN =
  /\b(?:speak|talk)\s+(?:to|with)\s+a\s+(?:person|human|representative|agent)\b|\bhuman\s+agent\b|\breal\s+person\b|\bconnect\s+me\s+(?:to|with)\s+a\s+(?:human|representative|agent)\b|\bi\s+want\s+a\s+human\b/i;
const HUMAN_ESCALATION_REQUEST_PATTERN_HI =
  /\bagent\s+se\s+baat\s+karni\s+hai\b|\bhuman\s+chahiye\b|\brepresentative\s+se\s+connect\s+karo\b|\bkisi\s+(?:insaan|vyakti)\s+se\s+baat\b|\bagent\s+se\s+baat\s+karo\b/i;
const HUMAN_HANDOFF_ACKNOWLEDGEMENT_EN = "Sure — I'll hand this over to a team member.";
const HUMAN_HANDOFF_ACKNOWLEDGEMENT_HI =
  "Bilkul — main ye conversation team member ko hand over kar raha hoon.";

// Travel Booking Closure Pass — Phase 7: natural ways a customer asks for an already-confirmed booking's
// document again, in the SAME conversation — "share the pdf", "send my pdf", "send the ticket", "show my
// ticket", "download my ticket", "where is my ticket?", "give me the booking confirmation", "share
// booking confirmation", "resend my ticket", "I need the PDF". Deliberately literal phrase alternation
// (matching this file's/travel.runtime.ts's existing RESEND_TICKET_PATTERN convention) rather than a
// generic verb+noun combinator — a loose "verb ... ticket" pattern would also match a genuinely NEW
// request like "I need a ticket to Bali next month", which must never be swallowed by this override (the
// downstream "does a real booking actually exist for this conversation" check is the real safety net, but
// a tight pattern avoids relying on that alone).
const POST_BOOKING_ARTIFACT_REQUEST_PATTERN =
  /\b(?:share|send)\s+(?:the|my)\s+pdf\b|\bi\s+need\s+(?:the|my)\s+pdf\b|\bshare\s+(?:the\s+)?booking\s+confirmation\b|\bgive\s+me\s+the\s+booking\s+confirmation\b|\bsend\s+(?:me\s+)?(?:the\s+)?ticket\b|\bshow\s+my\s+ticket\b|\bdownload\s+my\s+ticket\b|\bwhere'?s\s+my\s+ticket\b|\bwhere\s+is\s+my\s+ticket\b|\bresend\s+my\s+ticket\b/i;

// Sprint 6.3 — Part 6-9: natural follow-up QUESTIONS about an already-confirmed booking — "what was the
// hotel", "how much did it cost", "what is my PNR", "show my itinerary" — answered from the SAME
// completed TravelBooking row `POST_BOOKING_ARTIFACT_REQUEST_PATTERN` already looks up, never by asking
// Travel Runtime to re-derive them from its own (already-cleared) in-memory trip state. Each sub-pattern
// is checked independently so the handler below can answer the SPECIFIC fact asked for rather than
// dumping the whole booking every time.
const POST_BOOKING_HOTEL_QUESTION_PATTERN = /\b(?:what|which)\s+(?:was|is)?\s*(?:the\s+)?hotel\b/i;
const POST_BOOKING_TOTAL_QUESTION_PATTERN =
  /\b(?:what\s+(?:was|is)\s+(?:the\s+)?(?:total|price|cost)|how\s+much\s+did\s+it\s+cost|what\s+did\s+(?:it|the\s+(?:booking|trip))\s+cost)\b/i;
const POST_BOOKING_PNR_QUESTION_PATTERN = /\b(?:what'?s|what\s+(?:is|was))\s+my\s+pnr\b/i;
const POST_BOOKING_SUMMARY_QUESTION_PATTERN =
  /\b(?:what\s+(?:was|is)\s+my\s+booking|show\s+my\s+itinerary|what'?s\s+my\s+itinerary|what\s+(?:is|was)\s+my\s+itinerary)\b/i;
const POST_BOOKING_QA_PATTERN = new RegExp(
  [
    POST_BOOKING_HOTEL_QUESTION_PATTERN.source,
    POST_BOOKING_TOTAL_QUESTION_PATTERN.source,
    POST_BOOKING_PNR_QUESTION_PATTERN.source,
    POST_BOOKING_SUMMARY_QUESTION_PATTERN.source
  ].join("|"),
  "i"
);

/** Answers a natural follow-up question against an already-confirmed booking's own stored data — never
 *  invents a fact the booking doesn't have, and only ever reads (never re-derives via Travel Runtime,
 *  which no longer has this trip's state once a booking is confirmed). Returns null when `text` isn't one
 *  of the recognized post-booking questions (the caller only invokes this after `POST_BOOKING_QA_PATTERN`
 *  already matched, so this should always resolve, but stays defensive). */
function answerPostBookingQuestion(
  text: string,
  booking: {
    destinationCity: string | null;
    originCity: string | null;
    providerPnr: string | null;
    providerBookingRef: string | null;
    quotedAmount: unknown;
    quotedCurrency: string | null;
    hotelDetailsJson: unknown;
    flightDetailsJson: unknown;
  }
): string | null {
  const hotel = (booking.hotelDetailsJson ?? {}) as Record<string, unknown>;
  const hotelName = typeof hotel.hotelName === "string" ? hotel.hotelName : null;
  const flight = (booking.flightDetailsJson ?? {}) as { segments?: Array<Record<string, unknown>> };
  const airline = typeof flight.segments?.[0]?.airline === "string" ? (flight.segments[0].airline as string) : null;
  const total =
    booking.quotedAmount !== null && booking.quotedAmount !== undefined && booking.quotedCurrency
      ? formatMoney(Number(booking.quotedAmount), booking.quotedCurrency)
      : null;

  if (POST_BOOKING_HOTEL_QUESTION_PATTERN.test(text)) {
    return hotelName
      ? `You stayed at ${hotelName}${typeof hotel.area === "string" ? ` in ${hotel.area}` : ""}.`
      : "I don't have a hotel on file for this booking — it may have been a flight-only trip.";
  }
  if (POST_BOOKING_TOTAL_QUESTION_PATTERN.test(text)) {
    return total
      ? `The total was ${total}.`
      : "I don't have a total on file for this booking.";
  }
  if (POST_BOOKING_PNR_QUESTION_PATTERN.test(text)) {
    return booking.providerPnr
      ? `Your PNR is ${booking.providerPnr}.`
      : "I don't have a PNR on file for this booking yet.";
  }
  if (POST_BOOKING_SUMMARY_QUESTION_PATTERN.test(text)) {
    const route =
      booking.originCity && booking.destinationCity
        ? `${booking.originCity} to ${booking.destinationCity}`
        : (booking.destinationCity ?? "your trip");
    const parts = [`Here's your booking: ${route}.`];
    if (airline) parts.push(`Flight with ${airline}.`);
    if (hotelName) parts.push(`Hotel: ${hotelName}.`);
    if (total) parts.push(`Total: ${total}.`);
    if (booking.providerPnr) parts.push(`PNR: ${booking.providerPnr}.`);
    return parts.join(" ");
  }
  return null;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly tools = new ToolRegistry();
  private readonly executor: ToolExecutor;
  private readonly prompt = new PromptBuilder();
  private readonly skillRuntime: SkillRuntimeService;
  private readonly skillExecutions: SkillExecutionService | null;
  private readonly inputCollection: InputCollectionService | null;
  private readonly capabilityExecution: CapabilityExecutionAdapter;
  private readonly workflowCoordinator: WorkflowCoordinator | null;
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly memories: MemoryService,
    private readonly pluginAi: PluginAiService,
    private readonly connectors: ConnectorService,
    private readonly knowledge: KnowledgeSearchService,
    private readonly customerIdentity: CustomerIdentityService,
    private readonly travelLeadService: TravelLeadService,
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig,
    @Optional() skillRuntime?: SkillRuntimeService,
    @Optional() skillExecutions?: SkillExecutionService,
    @Optional() inputCollection?: InputCollectionService,
    @Optional() capabilityExecution?: CapabilityExecutionAdapter,
    @Optional() workflowCoordinator?: WorkflowCoordinator,
    @Optional() private readonly travelBookingService?: TravelBookingService,
    @Optional() private readonly employeeArtifacts?: EmployeeArtifactService,
    @Optional() private readonly platformMemory?: PlatformMemoryService,
    @Optional() private readonly observability?: ObservabilityService,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() private readonly traceContextStore?: TraceContextStore,
    @Optional() private readonly billingEnforcement?: BillingEnforcementService,
    @Optional() private readonly skillsRuntime?: SkillsRuntimeService,
    @Optional() private readonly skillRegistry?: SkillRegistryService
  ) {
    this.skillRuntime = skillRuntime ?? createDefaultSkillRuntime();
    // Nest always injects the durable mirror service. Keeping it nullable preserves the
    // lightweight construction convention used by isolated AgentService unit tests.
    this.skillExecutions = skillExecutions ?? null;
    this.inputCollection = inputCollection ?? null;
    this.capabilityExecution = capabilityExecution ?? new CapabilityExecutionAdapter();
    this.workflowCoordinator = workflowCoordinator ?? null;
    this.executor = new ToolExecutor(this.tools, new ToolPermissionPolicy());
    this.registerTools();
    this.registerTravelTools();
    this.registerEmployeeTools();
    this.registerSkillTools();
    for (const handler of this.connectors.toolHandlers()) this.tools.register(handler);
  }

  /** Sprint 4.7: safe tracing wrapper — when ObservabilityService isn't injected (unit tests constructing
   *  AgentService directly with a short arg list) this just runs the callback, unchanged. */
  private async traced<T>(
    context: TraceContext | null | undefined,
    metadata: Parameters<ObservabilityService["withSpan"]>[1],
    callback: (span: TraceContext | undefined) => Promise<T>
  ): Promise<T> {
    if (!this.observability) return callback(context ?? undefined);
    return this.observability.withSpan(context, metadata, callback);
  }

  /** Resolved lazily via ModuleRef (not constructor DI) specifically to avoid a circular module
   *  dependency: WorkforceModule already imports AgentModule for AgentService/WorkflowExecutionService,
   *  so AgentModule cannot also import WorkforceModule for this. `{ strict: false }` searches the whole
   *  application container, which is fine here since resolution only ever happens after bootstrap. */
  private getChatDelegationTrigger(): ChatDelegationTriggerService | null {
    if (!this.moduleRef) return null;
    try {
      return this.moduleRef.get<unknown, ChatDelegationTriggerService>(CHAT_DELEGATION_TRIGGER, {
        strict: false
      });
    } catch {
      return null;
    }
  }

  private getReceptionistRuntime(): ReceptionistRuntime | null {
    if (!this.moduleRef) return null;
    try {
      return this.moduleRef.get<unknown, ReceptionistRuntime>(RECEPTIONIST_RUNTIME, {
        strict: false
      });
    } catch {
      return null;
    }
  }

  async run(organizationId: string, userId: string, requestId: string, dto: AgentRunDto) {
    return this.execute({
      organizationId,
      agentId: dto.pluginInstallationId,
      ...(dto.conversationId ? { conversationId: dto.conversationId } : {}),
      actor: { type: "USER", userId },
      text: dto.message ?? "",
      source: { type: "DASHBOARD" },
      requestId,
      ...(dto.metadata ? { metadata: dto.metadata } : {}),
      ...(dto.attachmentIds ? { attachmentIds: dto.attachmentIds } : {}),
      ...(dto.channel ? { requestedChannel: dto.channel } : {})
    });
  }
  /**
   * Shared execution path for every caller (dashboard chat, channel adapters). The actor
   * determines conversation ownership and tool permissions; everything else is identical.
   */
  async execute(input: AgentExecutionInput) {
    const result = await this.traced(
      input.traceContext,
      {
        name: "AGENT_EXECUTION",
        spanType: "AGENT_EXECUTION",
        component: "AgentService",
        organizationId: input.organizationId,
        actorType: input.actor.type,
        actorId:
          input.actor.type === "USER"
            ? input.actor.userId
            : input.actor.type === "CHANNEL"
              ? input.actor.externalUserId
              : null,
        conversationId: input.conversationId ?? null,
        inputSummary: {
          agentId: input.agentId,
          source: input.source.type,
          message: summarizeText(input.text)
        },
        traceMetadata: { agentId: input.agentId, source: input.source.type }
      },
      async (span) => this.executeTraced(input, span)
    );
    return this.applyChannelPolicy(input, result);
  }

  /** Sprint 6.4 — Part 1/6: the pipeline trace found that only Receptionist-routed turns ever ran through
   *  `conversational-response-policy` (via `handoffPresentation`) — a direct employee execution (a
   *  dashboard chat pointed straight at, say, the Travel Employee's own installation, bypassing
   *  Receptionist entirely) returned its raw response untouched. This is the one place both paths'
   *  final response passes through before leaving AgentService, so the policy now applies consistently
   *  everywhere (Part 6) without scattering `composeChannelResponse` calls across `executeTraced`'s many
   *  internal return points (Part 18). A Receptionist-routed result (identified by its own `receptionist`
   *  field — see `ReceptionistRuntimeResult`) is left alone: it was already shaped for the correct channel
   *  inside `ReceptionistService`, and `composeChannelResponse` on already-clean text is a no-op, but
   *  skipping it keeps this one, single point where each execution path's response is shaped an actual
   *  single point per path rather than a redundant second pass. */
  private applyChannelPolicy<T extends { response: string }>(
    input: AgentExecutionInput,
    result: T
  ): T {
    if ("receptionist" in result) return result;
    const channel = resolveConversationChannel({
      sourceType: input.source.type,
      requestedChannel: input.requestedChannel
    });
    const shaped = composeChannelResponse(result.response, channel);
    if (shaped.message === result.response) return result;
    return { ...result, response: shaped.message };
  }

  private async executeTraced(input: AgentExecutionInput, span: TraceContext | undefined) {
    const { organizationId } = input;
    // Sprint 5.0 Phase 10: the single gate for billable AI execution. Runs before any provider/tool work,
    // never on login/billing/notification paths (they never call AgentService.execute).
    if (this.billingEnforcement)
      await this.billingEnforcement.assertExecutionAllowed(organizationId);
    const actorUserId = input.actor.type === "USER" ? input.actor.userId : null;
    const plugin = await this.prisma.plugin.findFirst({
      where: { id: input.agentId, organizationId, deletedAt: null }
    });
    if (!plugin) throw new NotFoundException("PLUGIN_INSTALLATION_NOT_FOUND");
    if (plugin.status !== PluginStatus.ACTIVE) throw new ConflictException("PLUGIN_DISABLED");
    const pluginCapabilities = Array.isArray(
      (plugin.manifest as { capabilities?: unknown })?.capabilities
    )
      ? (plugin.manifest as { capabilities: unknown[] }).capabilities.filter(
          (capability): capability is string => typeof capability === "string"
        )
      : [];
    if (pluginCapabilities.includes("workforce.intake")) {
      const receptionist = this.getReceptionistRuntime();
      if (!receptionist) throw new ConflictException("RECEPTIONIST_RUNTIME_UNAVAILABLE");
      return this.traced(
        span,
        {
          name: "RECEPTIONIST_EXECUTION",
          spanType: "AGENT_EXECUTION",
          component: "ReceptionistService",
          organizationId,
          conversationId: input.conversationId ?? null,
          employeeInstallationId: plugin.id,
          inputSummary: { channel: input.source.type }
        },
        async (receptionistSpan) => receptionist.execute(input, receptionistSpan)
      );
    }
    const isTravelEmployee = plugin.slug === TRAVEL_EMPLOYEE_PLUGIN_SLUG;
    const isLegalEmployee = plugin.slug === "legal-employee";
    const employeeDomain = findEmployeeDomain(plugin.slug);
    const employeeConfig = employeeDomain
      ? await this.employeeConfig(organizationId, plugin.id, employeeDomain)
      : null;
    const travelConfig = isTravelEmployee
      ? await this.travelEmployeeConfig(organizationId, plugin.id)
      : null;
    let provider!: AiProvider;
    let settings!: ProviderSettings;
    // Additive observability/billing metadata from AiConfigurationResolverService (via
    // PluginAiService.resolveProvider) — attached to the execution span below when known. Populated
    // whenever a turn is actually served by a resolver-backed provider (generic plugin providers,
    // Travel's LLM orchestrator, employee-domain LLM orchestrators). Stays null when the turn is
    // served by an engine that never consults the resolver at all (Travel/employee-domain
    // deterministic engines, ApiBackedEmployeeProvider) — reporting resolution metadata there would
    // misattribute the turn to a config path that wasn't actually used.
    let aiResolutionSource: string | null = null;
    let aiProviderConnectionId: string | null = null;
    let aiModelProfileId: string | null = null;
    if (!travelConfig && !employeeConfig) {
      const resolvedProvider = await this.pluginAi.resolveProvider(organizationId, plugin.id);
      provider = resolvedProvider.provider;
      settings = resolvedProvider.settings;
      aiResolutionSource = resolvedProvider.resolutionSource ?? null;
      aiProviderConnectionId = resolvedProvider.providerConnectionId ?? null;
      aiModelProfileId = resolvedProvider.modelProfileId ?? null;
    }
    // carries a durable phone identity; a dashboard USER actor is a staff member testing/operating the
    // employee, not the customer being served, so it always resolves ANONYMOUS. A brand-new conversation
    // for an ANONYMOUS identity NEVER links to a prior customer's profile — that's the isolation guarantee.
    const customerIdentity: CustomerIdentity = this.customerIdentity.resolve(
      input.actor.type === "CHANNEL"
        ? { source: "CHANNEL_PHONE", phone: input.actor.externalUserId }
        : { source: "UNKNOWN" }
    );
    const existingCustomerProfile = input.conversationId
      ? null
      : await this.customerIdentity.loadProfile(organizationId, customerIdentity);
    const conversation = input.conversationId
      ? await this.prisma.conversation.findFirst({
          where: {
            id: input.conversationId,
            organizationId,
            pluginInstallationId: plugin.id,
            deletedAt: null
          }
        })
      : await this.prisma.conversation.create({
          data: {
            organizationId,
            pluginInstallationId: plugin.id,
            createdByUserId: actorUserId,
            customerProfileId: existingCustomerProfile?.id ?? null,
            ...(input.actor.type === "CHANNEL"
              ? {
                  channelConnectionId: input.actor.channelConnectionId,
                  externalUserId: input.actor.externalUserId
                }
              : {}),
            title: title(input.text),
            metadata: (input.metadata ?? {}) as Prisma.InputJsonValue
          }
        });
    if (!conversation) throw new NotFoundException("CONVERSATION_NOT_FOUND");
    if (conversation.status === ConversationStatus.ARCHIVED)
      throw new ConflictException("CONVERSATION_ARCHIVED");
    if (span) await this.observability?.linkTrace(span, { conversationId: conversation.id });
    let travelOrchestrator: TravelEmployeeLlmOrchestrator | null = null;
    let deterministicTravelProvider: TravelEmployeeProvider | null = null;
    const persistedTravelState = travelConfig
      ? await this.loadTravelState(organizationId, plugin.id, conversation.id)
      : null;
    // Cache parsed state once to avoid duplicate parsing in orchestrator setup and workfLow dispatch
    const parsedEntities = entitiesFromStoredState(persistedTravelState);
    const parsedMemory = memoryFromStoredState(persistedTravelState);
    let employeeOrchestrator: EmployeeDomainLlmOrchestrator | null = null;
    let deterministicEmployeeProvider: EmployeeDomainProvider | null = null;
    const persistedEmployeeState =
      employeeConfig && employeeDomain
        ? await this.loadEmployeeState(organizationId, plugin.id, conversation.id, employeeDomain)
        : null;
    const parsedEmployeeEntities = employeeEntitiesFromStoredState(
      persistedEmployeeState,
      employeeDomain?.spec.fields ?? []
    );
    const parsedEmployeeMemory = employeeMemoryFromStoredState(persistedEmployeeState);
    // Receptionist handoff correction pass: a brand-new specialist conversation (no persisted state yet)
    // that arrived via ReceptionistService.startHandoff/continueHandoff carries the customer's
    // already-captured name in `input.metadata.receptionistCustomerName`. Seeding it here means the
    // specialist's own COLLECT_NAME gate (`!entities.customerName`) never fires for a handoff turn — no
    // prompt change, no duplicated name-collection logic, just the same entity field direct chat already
    // uses. Direct chat never sets this metadata key, so its own name-collection is untouched.
    const receptionistCustomerName =
      typeof input.metadata?.receptionistCustomerName === "string"
        ? input.metadata.receptionistCustomerName.trim()
        : null;
    if (receptionistCustomerName) {
      if (!persistedTravelState && !parsedEntities.customerName)
        parsedEntities.customerName = receptionistCustomerName;
      if (!persistedEmployeeState && !parsedEmployeeEntities.customerName)
        parsedEmployeeEntities.customerName = receptionistCustomerName;
    }
    if (travelConfig) {
      let resolvedReal:
        | ({ provider: AiProvider; settings: ProviderSettings } & Partial<{
            resolutionSource: string | null;
            providerConnectionId: string | null;
            modelProfileId: string | null;
          }>)
        | null = null;
      try {
        resolvedReal = await this.pluginAi.resolveProvider(organizationId, plugin.id);
      } catch (error) {
        if (
          !(error instanceof BadRequestException) ||
          error.message !== "AI_PROVIDER_NOT_CONFIGURED"
        )
          throw error;
      }
      if (resolvedReal && resolvedReal.settings.providerType !== "DETERMINISTIC") {
        travelOrchestrator = new TravelEmployeeLlmOrchestrator(
          resolvedReal.provider,
          travelConfig,
          parsedEntities,
          parsedMemory,
          "PLATFORM_MANAGED"
        );
        provider = travelOrchestrator;
        settings = resolvedReal.settings;
        aiResolutionSource = resolvedReal.resolutionSource ?? null;
        aiProviderConnectionId = resolvedReal.providerConnectionId ?? null;
        aiModelProfileId = resolvedReal.modelProfileId ?? null;
      } else {
        deterministicTravelProvider = new TravelEmployeeProvider(
          travelConfig,
          parsedMemory,
          parsedEntities,
          "PLATFORM_MANAGED"
        );
        provider = deterministicTravelProvider;
        settings = TRAVEL_PROVIDER_SETTINGS;
      }
      // Diagnostic: which Travel Employee engine actually handles this turn — the dashboard/channel
      // caller cannot tell from the response alone, and several past "the fix isn't active" reports
      // turned out to be this selection resolving to a different engine than expected.
      this.logger.log({
        event: "TRAVEL_ENGINE_SELECTED",
        conversationId: conversation.id,
        runtime: travelOrchestrator ? "llm_orchestrator" : "deterministic_provider",
        configuredProviderType: resolvedReal?.settings.providerType ?? null
      });
    }
    if (employeeConfig && employeeDomain) {
      let resolvedReal:
        | ({ provider: AiProvider; settings: ProviderSettings } & Partial<{
            resolutionSource: string | null;
            providerConnectionId: string | null;
            modelProfileId: string | null;
          }>)
        | null = null;
      // Real-API flow: when the employee's "use real API" toggle is ON, forward every turn to the
      // configured backend API instead of the built-in deterministic/dummy flow. The admin supplies the
      // endpoint + key in the employee's configuration.
      if (employeeConfig.apiEnabled === true) {
        provider = new ApiBackedEmployeeProvider(employeeDomain.spec, {
          enabled: true,
          endpoint: employeeConfig.apiEndpoint ?? null,
          apiKey: employeeConfig.apiKey ?? null
        });
        settings = EMPLOYEE_PROVIDER_SETTINGS;
        this.logger.log({
          event: "EMPLOYEE_API_FLOW_SELECTED",
          conversationId: conversation.id,
          employee: employeeDomain.slug,
          endpointConfigured: Boolean(employeeConfig.apiEndpoint)
        });
      } else {
        try {
          resolvedReal = await this.pluginAi.resolveProvider(organizationId, plugin.id);
        } catch (error) {
          if (
            !(error instanceof BadRequestException) ||
            error.message !== "AI_PROVIDER_NOT_CONFIGURED"
          )
            throw error;
        }
        if (resolvedReal && resolvedReal.settings.providerType !== "DETERMINISTIC") {
          employeeOrchestrator = new EmployeeDomainLlmOrchestrator(
            resolvedReal.provider,
            employeeDomain.spec,
            employeeConfig,
            parsedEmployeeEntities,
            parsedEmployeeMemory
          );
          provider = employeeOrchestrator;
          settings = resolvedReal.settings;
          aiResolutionSource = resolvedReal.resolutionSource ?? null;
          aiProviderConnectionId = resolvedReal.providerConnectionId ?? null;
          aiModelProfileId = resolvedReal.modelProfileId ?? null;
        } else {
          deterministicEmployeeProvider = new EmployeeDomainProvider(
            employeeDomain.spec,
            employeeConfig,
            parsedEmployeeMemory,
            parsedEmployeeEntities
          );
          provider = deterministicEmployeeProvider;
          settings = EMPLOYEE_PROVIDER_SETTINGS;
        }
      }
      this.logger.log({
        event: "EMPLOYEE_ENGINE_SELECTED",
        conversationId: conversation.id,
        employee: employeeDomain.slug,
        runtime:
          employeeConfig.apiEnabled === true
            ? "api_flow"
            : employeeOrchestrator
              ? "llm_orchestrator"
              : "deterministic_provider",
        configuredProviderType:
          employeeConfig.apiEnabled === true ? null : (resolvedReal?.settings.providerType ?? null)
      });
    }
    const usingDeterministicTravel = Boolean(travelConfig) && !travelOrchestrator;
    const usingDeterministicEmployee = Boolean(employeeConfig) && !employeeOrchestrator;
    const configuredModel = usingDeterministicTravel
      ? "travel-employee-v1"
      : usingDeterministicEmployee && employeeDomain
        ? employeeDomain.spec.modelName
        : providerModel(settings);
    const historyRows = await this.prisma.conversationMessage.findMany({
      where: { conversationId: conversation.id, organizationId },
      orderBy: { createdAt: "asc" },
      take: 30
    });
    // Proactive greeting: an empty message on a brand-new conversation (no prior turns yet) is the
    // dashboard/channel opening the Travel Employee's page before the traveler has said anything — render
    // the configured welcome message immediately and deterministically, with no LLM/tool round trip and
    // no synthetic USER turn recorded (nothing was actually said this turn). This is what lets the
    // conversation start automatically instead of sitting blank until the first user message.
    const greetingConfig =
      travelConfig ?? (employeeConfig && employeeDomain ? employeeConfig : null);
    const greetingMemoryKey = travelConfig
      ? TRAVEL_TRIP_STATE_MEMORY_KEY
      : (employeeDomain?.memoryKey ?? null);
    const hasAttachments = Boolean(input.attachmentIds?.length);
    if (
      !input.text.trim() &&
      !hasAttachments &&
      historyRows.length === 0 &&
      greetingConfig &&
      greetingMemoryKey
    ) {
      const greetStarted = Date.now();
      const assistant = await this.prisma.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          organizationId,
          role: ConversationMessageRole.ASSISTANT,
          content: greetingConfig.welcomeMessage,
          model: "greeting-v1",
          inputTokens: 0,
          outputTokens: estimateTokens(greetingConfig.welcomeMessage)
        }
      });
      const execution = await this.prisma.agentExecution.create({
        data: {
          organizationId,
          conversationId: conversation.id,
          pluginInstallationId: plugin.id,
          userId: actorUserId,
          status: AgentExecutionStatus.COMPLETED,
          modelProvider: "greeting",
          model: "greeting-v1",
          requestId: input.requestId,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
          startedAt: new Date(greetStarted),
          completedAt: new Date(),
          latencyMs: Date.now() - greetStarted,
          inputTokens: 0,
          outputTokens: estimateTokens(greetingConfig.welcomeMessage),
          totalTokens: estimateTokens(greetingConfig.welcomeMessage)
        }
      });
      // Persist onboarding state immediately: the very next reply is answering "may I know your name?"
      // (COLLECT_NAME), not a domain-detail question — without this, a state read before the first reply
      // (e.g. the dashboard's context-aware placeholder) would see no stage at all.
      const greetingState = travelConfig
        ? (entitiesToStoredState(EMPTY_TRAVEL_ENTITIES, "COLLECT_NAME") as unknown as Record<
            string,
            unknown
          >)
        : employeeEntitiesToStoredState(
            { customerName: null },
            "COLLECT_NAME",
            employeeMemoryFromStoredState(null)
          );
      await this.memories.save(organizationId, actorUserId, {
        pluginInstallationId: plugin.id,
        conversationId: conversation.id,
        scope: AgentMemoryScope.CONVERSATION,
        key: greetingMemoryKey,
        value: greetingState,
        searchableText: "COLLECT_NAME"
      });
      return {
        conversationId: conversation.id,
        executionId: execution.id,
        messageId: assistant.id,
        response: greetingConfig.welcomeMessage,
        status: "COMPLETED" as const,
        model: "greeting-v1",
        usage: {
          inputTokens: 0,
          outputTokens: estimateTokens(greetingConfig.welcomeMessage),
          totalTokens: estimateTokens(greetingConfig.welcomeMessage),
          estimatedCost: null
        },
        sources: []
      };
    }
    // File attachments (PDF/DOCX/TXT/JPG/PNG) uploaded to this conversation are read and prepended to the
    // user's message so every AI Employee can answer from the file's contents. Empty on conversations with
    // no attachments, so the greeting bypass above (and normal text) is unaffected.
    const attachmentContext = await this.loadAttachmentContext(
      organizationId,
      conversation.id,
      input.attachmentIds
    );
    const effectiveText = attachmentContext
      ? `${attachmentContext}\n\n${input.text.trim()}`
      : input.text.trim();
    await this.prisma.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        organizationId,
        role: ConversationMessageRole.USER,
        actorType: ConversationMessageActorType.USER,
        content: effectiveText
      }
    });

    // Sprint 6.7 — human takeover gate. Placed immediately after the USER message is durably stored (so a
    // human operator always sees every message, even one that arrives mid-takeover) and BEFORE any
    // workflow dispatch, classification, or provider call — no downstream Receptionist/Travel/employee
    // logic ever sees a turn while a human owns the conversation. Two cases:
    //   (a) already HUMAN_ACTIVE from a prior turn — store-and-stop, no AI-authored reply at all (an
    //       empty `response` signals the channel adapter to send nothing rather than a blank message).
    //   (b) still AI_ACTIVE but this exact message is an explicit request to speak to a person — flip to
    //       HUMAN_ACTIVE and return the one natural acknowledgement, in the same register (English/
    //       Hinglish) the customer used. Reuses the existing per-conversation state field rather than a
    //       second escalation mechanism; workflow-level pauses continue to use the pre-existing
    //       WAITING_FOR_APPROVAL mechanism unchanged.
    if (conversation.aiControlState === ConversationAiControlState.HUMAN_ACTIVE) {
      return {
        conversationId: conversation.id,
        executionId: null,
        messageId: null,
        response: "",
        status: "COMPLETED" as const,
        aiPaused: true as const,
        model: null,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: null },
        sources: []
      };
    }
    const escalationMatch = HUMAN_ESCALATION_REQUEST_PATTERN_HI.test(effectiveText)
      ? "HI"
      : HUMAN_ESCALATION_REQUEST_PATTERN_EN.test(effectiveText)
        ? "EN"
        : null;
    if (escalationMatch) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          aiControlState: ConversationAiControlState.HUMAN_ACTIVE,
          aiPausedReason: "ESCALATION_REQUEST",
          takenOverAt: new Date()
        }
      });
      const acknowledgement =
        escalationMatch === "HI" ? HUMAN_HANDOFF_ACKNOWLEDGEMENT_HI : HUMAN_HANDOFF_ACKNOWLEDGEMENT_EN;
      const handoffMessage = await this.prisma.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          organizationId,
          role: ConversationMessageRole.ASSISTANT,
          actorType: ConversationMessageActorType.AI,
          content: acknowledgement
        }
      });
      return {
        conversationId: conversation.id,
        executionId: null,
        messageId: handoffMessage.id,
        response: acknowledgement,
        status: "COMPLETED" as const,
        model: "human-handoff-v1",
        usage: {
          inputTokens: 0,
          outputTokens: estimateTokens(acknowledgement),
          totalTokens: estimateTokens(acknowledgement),
          estimatedCost: null
        },
        sources: []
      };
    }

    // Sprint 4.5: capture durable memories from the user's message + trigger conversation summarization.
    // Fire-and-forget — memory capture must never affect the response or fail the turn.
    void this.captureTurnMemories(
      organizationId,
      actorUserId,
      plugin.id,
      conversation.id,
      input.text
    );
    const execution = await this.prisma.agentExecution.create({
      data: {
        organizationId,
        conversationId: conversation.id,
        pluginInstallationId: plugin.id,
        userId: actorUserId,
        status: AgentExecutionStatus.RUNNING,
        modelProvider: usingDeterministicTravel
          ? "travel-employee"
          : usingDeterministicEmployee && employeeDomain
            ? employeeDomain.spec.providerName
            : providerName(settings),
        model: configuredModel,
        requestId: input.requestId,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        startedAt: new Date(),
        traceId: span?.sampled ? span.traceId : null
      }
    });
    if (span) await this.observability?.linkTrace(span, { agentExecutionId: execution.id });
    const started = Date.now();
    let failureStage: "prompt" | "provider_call" | "response_parse" | "tool_loop" | "persistence" =
      "prompt";
    try {
      const permissions =
        input.actor.type === "USER"
          ? new Set(
              await this.authorization.getEffectivePermissions(input.actor.userId, organizationId)
            )
          : CHANNEL_ACTOR_PERMISSIONS;
      const grants = new Set(
        Array.isArray(plugin.grantedPermissions)
          ? plugin.grantedPermissions.filter((x): x is string => typeof x === "string")
          : []
      );
      const available = new Set<string>(["platform.demo.echo"]);
      if (grants.has("MEMORY")) {
        available.add("platform.memory.save");
        available.add("platform.memory.search");
      }
      if (grants.has("TOOLS")) {
        const declaredTools = Array.isArray((plugin.manifest as { tools?: unknown })?.tools)
          ? ((plugin.manifest as { tools?: Array<{ name?: unknown }> }).tools ?? [])
          : [];
        for (const tool of declaredTools)
          if (typeof tool.name === "string" && this.tools.has(tool.name)) available.add(tool.name);
      }
      const [toolNames, recentMemories] = await Promise.all([
        this.connectors.availableToolNames(organizationId, grants),
        this.memories.search(organizationId, actorUserId, {
          pluginInstallationId: plugin.id,
          query: "preference",
          limit: 10
        })
      ]);
      for (const name of toolNames) available.add(name);
      // Sprint 6.1 — Phase 12: expose only skills this specific employee installation is actually
      // granted and enabled for (SkillsRuntimeService.skillsForEmployee already filters on
      // installation/grant/enabled state). Discovery failures must never block a turn.
      if (this.skillsRuntime) {
        try {
          const grantedSkills = await this.skillsRuntime.skillsForEmployee(
            organizationId,
            plugin.id
          );
          for (const skill of grantedSkills) available.add(`skill.${skill.skillKey}`);
        } catch {
          // capability discovery is best-effort; the turn proceeds without skill tools this time
        }
      }
      const persistedTravelMemory = parsedMemory;
      const persistedTravelEntities = parsedEntities;

      // Stage 9B: Pending Workflow Runtime — mandatory priority. An active, WAITING_FOR_INPUT workflow
      // (or a fresh callback/lead trigger) must be handled here, before intent classification, RAG,
      // live-search routing, or Skill Runtime capability selection ever run for this turn. This is what
      // fixes the real UAT defect: a phone-number reply to "may I have your mobile number?" must never
      // reach classification/the legacy Travel Runtime dispatch, where it could be misrouted.
      if (isTravelEmployee && travelConfig) {
        const workflowResponse = await this.dispatchPendingWorkflowTurn(
          organizationId,
          actorUserId,
          plugin.id,
          conversation.id,
          effectiveText,
          input.requestId,
          persistedTravelEntities,
          persistedTravelMemory,
          input.channelContact
        );
        if (workflowResponse) {
          failureStage = "persistence";
          // A BOOKING_HANDOFF workflow completing with a real, ticketed booking (see WorkflowDispatchOutcome.
          // bookingId — only ever set once TravelBookingService.confirmApprovalAndBook actually produced a
          // PNR) attaches the ticket PDF as a structured chat attachment, mirroring ConversationMessage's
          // existing contentJson precedent (used today for TOOL-role sources) rather than a plain-text link,
          // since the download route requires an Authorization header a raw chat link could never carry.
          const attachments = workflowResponse.bookingId
            ? [
                {
                  type: "PDF_TICKET" as const,
                  bookingId: workflowResponse.bookingId,
                  url: `/travel/bookings/${workflowResponse.bookingId}/ticket.pdf`,
                  filename: `ticket-${workflowResponse.bookingId.slice(0, 8)}.pdf`
                }
              ]
            : null;
          const assistant = await this.prisma.conversationMessage.create({
            data: {
              conversationId: conversation.id,
              organizationId,
              role: ConversationMessageRole.ASSISTANT,
              content: workflowResponse.response,
              ...(attachments
                ? { contentJson: { attachments } as unknown as Prisma.InputJsonValue }
                : {}),
              model: workflowResponse.model,
              inputTokens: 0,
              outputTokens: estimateTokens(workflowResponse.response)
            }
          });
          await this.prisma.agentExecution.update({
            where: { id: execution.id },
            data: {
              status: AgentExecutionStatus.COMPLETED,
              completedAt: new Date(),
              latencyMs: Date.now() - started,
              inputTokens: 0,
              outputTokens: estimateTokens(workflowResponse.response),
              totalTokens: estimateTokens(workflowResponse.response),
              metadata: (input.metadata ?? {}) as Prisma.InputJsonValue
            }
          });
          await this.prisma.conversation.update({
            where: { id: conversation.id },
            data: { updatedAt: new Date() }
          });
          return {
            conversationId: conversation.id,
            executionId: execution.id,
            messageId: assistant.id,
            response: workflowResponse.response,
            status: "COMPLETED" as const,
            model: workflowResponse.model,
            usage: {
              inputTokens: 0,
              outputTokens: estimateTokens(workflowResponse.response),
              totalTokens: estimateTokens(workflowResponse.response),
              estimatedCost: null
            },
            sources: [],
            ...(attachments ? { attachments } : {})
          };
        }
      }

      // Domain/state turns are classified before retrieval. Knowledge search is not merely ignored for
      // these turns; it is never invoked, preventing travel slots/corrections from falling into RAG.
      const requestIntent = classifyRequestIntent(effectiveText, {
        isTravelEmployee,
        isEmployeeDomain: Boolean(employeeConfig)
      });

      // Stage 8B: Authoritative input collection
      // When AUTHORITATIVE_INPUT_COLLECTION mode is enabled, Skill Runtime decides what happens next
      // instead of the legacy Travel Runtime.
      let authoritativeDecision = null as Awaited<
        ReturnType<typeof this.executeAuthoritativeInputCollection>
      > | null;
      let runtimeMode: PlanTripRuntimeMode = "SHADOW";

      if (
        isTravelEmployee &&
        travelConfig &&
        (requestIntent === "TRAVEL_PLANNING" ||
          requestIntent === "SLOT_UPDATE" ||
          requestIntent === "CORRECTION")
      ) {
        runtimeMode = this.resolveRuntimeMode(organizationId, plugin.id);

        if (runtimeMode === "AUTHORITATIVE_INPUT_COLLECTION" && this.inputCollection) {
          const lastAssistantMessage =
            [...historyRows].reverse().find((message) => message.role === "ASSISTANT")?.content ??
            null;

          authoritativeDecision = await this.executeAuthoritativeInputCollection(
            organizationId,
            plugin.id,
            conversation.id,
            input.requestId,
            lastAssistantMessage,
            persistedTravelEntities,
            persistedTravelMemory
          );

          if (
            authoritativeDecision &&
            !TravelDecisionAdapter.shouldFallback(
              TravelDecisionAdapter.route(authoritativeDecision.decision)
            )
          ) {
            this.logger.log({
              event: "AUTHORITATIVE_INPUT_DECISION_GENERATED",
              conversationId: conversation.id,
              decision: authoritativeDecision.decision.decision,
              pendingInput: authoritativeDecision.decision.pendingInput
            });
          }
        }
      }

      const turnContext = {
        pendingInputAction: persistedTravelMemory.pendingInputAction ?? null,
        pendingContactValue: persistedTravelMemory.pendingContactValue ?? null,
        tripState: persistedTravelEntities,
        lastAssistantQuestion:
          [...historyRows].reverse().find((message) => message.role === "ASSISTANT")?.content ??
          null,
        conversationClosed: persistedTravelMemory.conversationClosed ?? false,
        currentLeadState:
          persistedTravelMemory.completionStage === "CAPTURED"
            ? ("CREATED" as const)
            : persistedTravelMemory.completionStage === "AWAITING_CONTACT"
              ? ("PENDING" as const)
              : ("NONE" as const)
      };
      const travelTurnDecision = isTravelEmployee
        ? arbitrateConversationTurn(effectiveText, turnContext)
        : null;
      if (travelTurnDecision)
        this.logger.log({
          event: "TRAVEL_TURN_ARBITRATED",
          conversationId: conversation.id,
          intent: travelTurnDecision.intent,
          source: travelTurnDecision.source,
          answersPendingAction: travelTurnDecision.answersPendingAction,
          supersedesPendingAction: travelTurnDecision.supersedesPendingAction,
          preservePendingAction: travelTurnDecision.preservePendingAction,
          pendingInputAction: turnContext.pendingInputAction,
          blockedStalePlanning:
            travelTurnDecision.intent === "PROVIDE_CONTACT" ||
            travelTurnDecision.intent === "CONFIRM_STANDALONE_CONTACT_USE"
        });
      const resolvedTravelInput = isTravelEmployee
        ? resolveTravelInput(effectiveText, turnContext)
        : null;
      const leadStatusAnswer =
        requestIntent === "LEAD_STATUS_QUERY"
          ? await this.buildLeadStatusAnswer(
              organizationId,
              plugin.id,
              conversation.id,
              effectiveText
            )
          : null;
      // employeeId === plugin.id: retrieval is always scoped to this specific AI Employee's own
      // collections (see KnowledgeSearchService.search) — it can structurally never return another
      // employee's chunks, even for two employees in the same organization.
      const knowledgeSources =
        resolvedTravelInput?.kind === "PENDING_CONTACT" ||
        resolvedTravelInput?.kind === "PENDING_CONTACT_NON_CONTACT" ||
        resolvedTravelInput?.kind === "PENDING_CONTACT_PAUSED" ||
        resolvedTravelInput?.kind === "INVALID_CONTACT_ATTEMPT" ||
        resolvedTravelInput?.kind === "STANDALONE_CONTACT" ||
        resolvedTravelInput?.kind === "STANDALONE_CONTACT_CONFIRMED" ||
        resolvedTravelInput?.kind === "STANDALONE_CONTACT_DECLINED"
          ? []
          : isKnowledgeEligible(requestIntent)
            ? await this.traced(
                span,
                {
                  name: "KNOWLEDGE_SEARCH",
                  spanType: "KNOWLEDGE_SEARCH",
                  component: "KnowledgeSearchService",
                  employeeInstallationId: plugin.id,
                  inputSummary: { requestIntent }
                },
                async (knowledgeSpan) => {
                  const { sources, metrics } = await this.knowledge.searchWithMetrics(
                    organizationId,
                    plugin.id,
                    { query: effectiveText }
                  );
                  // Phase 9: explicit RAG-routing visibility — proves/disproves "this intent should not
                  // have reached knowledge search" from the trace alone, without opening document content.
                  // Phase 6: full retrieval-quality breakdown — never includes chunk content, only counts/
                  // scores/timings, so this is safe to persist even at full sampling.
                  if (knowledgeSpan) {
                    await this.observability?.addAttribute(
                      knowledgeSpan,
                      "resultCount",
                      sources.length
                    );
                    await this.observability?.addAttribute(knowledgeSpan, "retrieval", metrics);
                  }
                  return sources;
                }
              )
            : [];
      if (span)
        await this.observability?.addAttribute(span, "routing", {
          requestIntent,
          knowledgeSearchInvoked: isKnowledgeEligible(requestIntent)
        });
      const knowledgePrompt = buildKnowledgeBlock(knowledgeSources);
      // Sprint 4.5: platform memory context (Organization -> Employee -> User -> Conversation Summary)
      // is recalled for this exact turn and injected ahead of the legacy tool-saved memories. The whole
      // memory block is placed before retrieved knowledge by PromptBuilder (see agent.runtime.ts), so
      // memory is never buried behind RAG. When a conversation summary exists, the prompt history uses
      // only the last N raw messages (token-explosion guard) instead of the oldest messages.
      const memoryContext = await this.traced(
        span,
        {
          name: "MEMORY_RECALL",
          spanType: "MEMORY_RECALL",
          component: "MemoryService",
          employeeInstallationId: plugin.id,
          inputSummary: {
            requestedScopes: ["ORGANIZATION", "EMPLOYEE", "USER", "CONVERSATION_SUMMARY"]
          }
        },
        (memorySpan) =>
          this.recallMemoryContext(
            organizationId,
            actorUserId,
            plugin.id,
            conversation.id,
            memorySpan
          )
      );
      const memoryBlock = memoryContext ? formatMemoryContextBlock(memoryContext) : "";
      const promptHistory = memoryContext?.conversationSummary
        ? (
            await this.prisma.conversationMessage.findMany({
              where: { conversationId: conversation.id, organizationId },
              orderBy: { createdAt: "desc" },
              take: MEMORY_PROMPT_RECENT_MESSAGES
            })
          ).reverse()
        : historyRows;
      let request = this.prompt.build({
        pluginPrompt: plugin.description,
        memories: [
          ...(memoryBlock ? [memoryBlock] : []),
          ...recentMemories.map((x) => `${x.key}: ${x.searchableText ?? "configured"}`)
        ],
        ...(knowledgePrompt ? { retrievedKnowledge: knowledgePrompt } : {}),
        history: promptHistory.map(toModelMessage),
        message: effectiveText,
        tools: this.tools.definitions(available)
      });
      // Every turn where retrieval already answers the question (or unambiguously should have, but
      // came up empty for this employee) is rendered through the deterministic Answer/Supporting
      // policy/Source/Confidence template instead of a free-form model call — see
      // knowledgeGroundedAnswer below and "GROUNDING"/"ANSWER FORMAT" in docs/enterprise-knowledge.md.
      // This guarantees the required format and precedence over pretrained knowledge regardless of
      // which AI provider (deterministic or real LLM) is configured for the employee.
      //
      // The bypass only ever runs for a message classified as a knowledge question (see "Request
      // routing" in docs/enterprise-knowledge.md) — computed from the message text alone, never from
      // whether `knowledgeSources` came back non-empty. Without this gate, an action request like "i
      // want to travel delhi to mumbai on 10 dec 26" could incidentally retrieve some low-relevance
      // policy chunk and get hijacked into the grounded "not found" fallback instead of the real
      // trip-planning workflow below.
      const isOtherEmployeeDomainQuestion = namesOtherEmployeeDomain(effectiveText);
      const knowledgeEligible = isKnowledgeEligible(requestIntent);
      const groundedKnowledgeAnswer = knowledgeEligible
        ? knowledgeGroundedAnswer(knowledgeSources, effectiveText)
        : null;
      // LLM public-knowledge fallback: if the knowledge search had no confident answer — and the question
      // is genuinely within THIS employee's domain (not another employee's, which should be routed) — ask
      // the employee's real LLM provider to answer from public knowledge (legal statutes, regulations,
      // common procedures). This keeps the employee useful beyond the uploaded knowledge base. Only fires
      // for a message actually classified as a knowledge question, so an ordinary chat/task turn never
      // triggers an extra LLM call.
      let knowledgeAnswer = groundedKnowledgeAnswer;
      const noGroundedAnswer =
        groundedKnowledgeAnswer === null || groundedKnowledgeAnswer === NO_KNOWLEDGE_MESSAGE;
      // Only the shared-engine domain employees (HR, Finance, IT, Sales, Marketing, Legal, Customer Support)
      // use the LLM public-knowledge fallback. Travel has its own orchestrator that already answers
      // knowledge/general questions through its LLM; running the fallback there would double-call the
      // provider and change the response model.
      if (
        employeeConfig &&
        knowledgeEligible &&
        noGroundedAnswer &&
        !isOtherEmployeeDomainQuestion
      ) {
        const persona = employeeConfig.persona;
        const fallback = await this.answerFromLlmFallback(
          organizationId,
          plugin.id,
          conversation.id,
          plugin,
          effectiveText,
          persona
        );
        if (fallback) knowledgeAnswer = fallback;
      }

      // Stage 8B: Handle authoritative input collection decision
      // If the Skill Runtime decided to ask a question, return it directly without Travel Runtime
      let authoritativeQuestionText: string | null = null;
      // Stage 9A: Capability Execution Adapter — translates a capability-ready InputDecision into a typed
      // ExecutionDecision. Only BOOKING_WORKFLOW_PENDING changes the response here: there is no existing
      // booking execution to preserve, so surfacing the route's own typed handoff explanation is the entire
      // correct behavior. ITINERARY/ESTIMATE/LIVE_SEARCH are recorded for diagnostics only — Travel Runtime
      // remains the sole executor for those (unchanged), so today's responses stay backward compatible.
      let bookingWorkflowPendingText: string | null = null;
      if (
        authoritativeDecision &&
        !TravelDecisionAdapter.shouldFallback(
          TravelDecisionAdapter.route(authoritativeDecision.decision)
        )
      ) {
        const route = TravelDecisionAdapter.route(authoritativeDecision.decision);

        if (TravelDecisionAdapter.requiresQuestion(route) && this.inputCollection) {
          // Get the natural language question for the pending input
          const question = this.inputCollection.getQuestionForPendingInput(
            authoritativeDecision.decision.pendingInput,
            persistedTravelMemory.responseLanguage
          );
          authoritativeQuestionText = question.full;

          this.logger.log({
            event: "AUTHORITATIVE_QUESTION_SELECTED",
            conversationId: conversation.id,
            pendingInput: authoritativeDecision.decision.pendingInput,
            question: authoritativeQuestionText.slice(0, 200)
          });
        } else if (
          travelConfig &&
          (TravelDecisionAdapter.requiresCapabilityExecution(route) ||
            TravelDecisionAdapter.isDeferredAction(route))
        ) {
          // The adapter is designed to never throw (see CapabilityExecutionAdapter.execute), but this
          // turn must degrade to the legacy Travel Runtime path — never fail the request — even if it
          // does. No retry: a caught failure here falls through exactly once, same as a FAILED decision.
          try {
            const executionDecision = this.capabilityExecution.execute(route, {
              entities: persistedTravelEntities,
              config: travelConfig,
              displayCurrency: travelConfig.defaultCurrency
            });

            this.logger.log({
              event: "CAPABILITY_EXECUTION_DECIDED",
              conversationId: conversation.id,
              capability: executionDecision.capability,
              executionStatus: executionDecision.executionStatus,
              executionType: executionDecision.executionType,
              executionTarget: executionDecision.executionTarget
            });

            if (
              executionDecision.capability === "BOOKING" &&
              (executionDecision.executionStatus === "DEFERRED" ||
                executionDecision.executionStatus === "EXECUTABLE")
            ) {
              bookingWorkflowPendingText = route.explanation;
              // Stage 9C: BOOKING_HANDOFF — a typed workflow-start request from the capability decision
              // itself (never from parsing this text). Preserves any already-active workflow instead of
              // overwriting it (startBookingHandoff returns null on conflict), in which case the plain
              // explanation above remains the response, unchanged from Stage 9A/9B behavior.
              if (this.workflowCoordinator) {
                const bookingOutcome = await this.workflowCoordinator.startBookingHandoff(
                  {
                    organizationId,
                    pluginInstallationId: plugin.id,
                    conversationId: conversation.id
                  },
                  input.requestId,
                  {
                    originCity: persistedTravelEntities.originCity,
                    destinationCity: persistedTravelEntities.destinationCity,
                    travelDates:
                      persistedTravelEntities.departureDate ?? persistedTravelEntities.travelMonth,
                    skillExecutionId: authoritativeDecision.loadedExecution?.id ?? null,
                    journeyId: persistedTravelMemory.journey?.id ?? null
                  }
                );
                if (bookingOutcome?.responseText)
                  bookingWorkflowPendingText = bookingOutcome.responseText;
              }
            }
          } catch (error) {
            this.logger.error({
              event: "CAPABILITY_EXECUTION_ADAPTER_THREW",
              conversationId: conversation.id,
              action: route.action,
              error: error instanceof Error ? error.message : "unknown"
            });
          }
        }
      }

      let inputTokens = 0,
        outputTokens = 0,
        finalText = "",
        responseModel = configuredModel,
        responseProvider = usingDeterministicTravel
          ? "travel-employee"
          : usingDeterministicEmployee && employeeDomain
            ? employeeDomain.spec.providerName
            : providerName(settings);
      // Travel Booking Closure Pass — Phase 4-6: set only when a booking completes synchronously within
      // the Stage 9E workflow-signal dispatch below. Declared at this outer scope (unlike the block's own
      // local `bookingAttachments`, which only reached the DB `.update()` call) so the FUNCTION'S RETURN
      // VALUE also carries it — without this, only a later re-read of the persisted message would ever see
      // the attachment; the immediate API response a client actually renders from would not.
      let bookingCompletionAttachments: Array<Record<string, unknown>> | null = null;
      if (
        leadStatusAnswer !== null ||
        knowledgeAnswer !== null ||
        authoritativeQuestionText !== null ||
        bookingWorkflowPendingText !== null
      ) {
        finalText =
          leadStatusAnswer ??
          knowledgeAnswer ??
          authoritativeQuestionText ??
          bookingWorkflowPendingText ??
          "";
        responseModel =
          leadStatusAnswer !== null
            ? "travel-lead-status-v1"
            : knowledgeAnswer !== null
              ? "knowledge-grounded-v1"
              : authoritativeQuestionText !== null
                ? "skill-input-collection-v1"
                : "capability-execution-v1";
        responseProvider =
          leadStatusAnswer !== null
            ? "travel-lead-status"
            : knowledgeAnswer !== null
              ? "knowledge-grounded"
              : authoritativeQuestionText !== null
                ? "skill-runtime"
                : "capability-execution";
        inputTokens = estimateTokens(request.messages.map((m) => m.content).join(" "));
        outputTokens = estimateTokens(finalText);
      }
      if (this.security.knowledge.retrievalDebugLogging)
        this.logger.log({
          event: "AGENT_PROMPT_DEBUG",
          organizationId,
          conversationId: conversation.id,
          query: effectiveText,
          requestIntent,
          promptLength: request.messages.map((m) => m.content).join("\n").length,
          promptTokens: estimateTokens(request.messages.map((m) => m.content).join(" ")),
          finalPromptPreview: request.messages.at(-1)?.content.slice(0, 500) ?? "",
          groundedFromKnowledge: knowledgeAnswer !== null,
          ...(knowledgeAnswer !== null ? { llmResponse: knowledgeAnswer } : {})
        });
      let travelToolRecoveryText: string | null = null;
      let travelToolCallsAttempted = 0;
      // Sprint 4.7A Phase 1: per-provider-call timing breakdown, accumulated across every iteration of the
      // tool-calling loop and attached once to the PROVIDER_CALL span (a single addAttribute write instead
      // of one per iteration keeps this out of the hot path — see Phase 13). serializeMs/fetchMs/parseMs are
      // real, measured durations; statusCode/networkConnectMs/providerQueueMs/firstTokenMs/cachedInputTokens/
      // reasoningTokens are left null with an explicit key (never fabricated) because the AiProvider
      // abstraction (packages/plugin-sdk) has no HTTP status, no raw socket hook, and no streaming/prompt-
      // caching support to measure them from.
      const providerCallTimings: Array<Record<string, unknown>> = [];
      await this.traced(
        span,
        {
          name: "PROVIDER_CALL",
          spanType: "PROVIDER_CALL",
          component: "AiProvider",
          employeeInstallationId: plugin.id,
          inputSummary: { providerType: settings.providerType, model: configuredModel }
        },
        async (providerSpan) => {
          for (
            let iteration = 0;
            leadStatusAnswer === null &&
            knowledgeAnswer === null &&
            authoritativeQuestionText === null &&
            bookingWorkflowPendingText === null &&
            iteration < 4;
            iteration++
          ) {
            failureStage = "provider_call";
            const outgoingRequest = {
              messages: request.messages,
              tools: request.tools.map(({ name, description, inputSchema }) => ({
                name,
                description,
                inputSchema
              })),
              maxOutputTokens: 1000
            };
            const serializeStartedAt = Date.now();
            const serializedByteLength = Buffer.byteLength(JSON.stringify(outgoingRequest), "utf8");
            const serializeMs = Date.now() - serializeStartedAt;
            const fetchStartedAt = Date.now();
            let response: Awaited<ReturnType<typeof provider.complete>>;
            // No retry-on-failure wraps provider.complete() today (withTimeout makes a single attempt), so this
            // is always 0 — a real, honest fact rather than a placeholder for retry logic that doesn't exist.
            const retryCount = 0;
            let timedOut = false;
            try {
              response = await withTimeout(
                provider.complete(outgoingRequest),
                settings.timeoutMs + 1_000,
                "MODEL_EXECUTION_TIMEOUT"
              );
            } catch (providerError) {
              timedOut =
                providerError instanceof Error &&
                providerError.message === "MODEL_EXECUTION_TIMEOUT";
              providerCallTimings.push({
                iteration,
                provider: responseProvider,
                model: configuredModel,
                serializeMs,
                requestBytes: serializedByteLength,
                fetchMs: Date.now() - fetchStartedAt,
                parseMs: null,
                totalMs: Date.now() - serializeStartedAt,
                statusCode: null,
                retryCount,
                timeout: timedOut,
                failed: true
              });
              throw providerError;
            }
            const fetchMs = Date.now() - fetchStartedAt;
            const parseStartedAt = Date.now();
            inputTokens += response.usage?.inputTokens ?? 0;
            outputTokens += response.usage?.outputTokens ?? 0;
            responseModel = response.model;
            responseProvider = response.provider;
            const parseMs = Date.now() - parseStartedAt;
            providerCallTimings.push({
              iteration,
              provider: response.provider,
              model: response.model,
              serializeMs,
              requestBytes: serializedByteLength,
              networkConnectMs: null,
              providerQueueMs: null,
              firstTokenMs: null,
              fetchMs,
              parseMs,
              totalMs: serializeMs + fetchMs + parseMs,
              statusCode: null,
              inputTokens: response.usage?.inputTokens ?? 0,
              cachedInputTokens: null,
              outputTokens: response.usage?.outputTokens ?? 0,
              reasoningTokens: null,
              toolCalls: response.toolCalls.length,
              retryCount,
              timeout: timedOut,
              failed: false
            });
            if (travelOrchestrator) {
              const diagnostics = travelOrchestrator.lastDiagnostics;
              this.logger.log({
                event: "TRAVEL_ORCHESTRATOR_TURN",
                organizationId,
                conversationId: conversation.id,
                executionId: execution.id,
                iteration,
                ...diagnostics
              });
            }
            if (!response.toolCalls.length) {
              finalText = response.content;
              break;
            }
            failureStage = "tool_loop";
            if (response.toolCalls.length > 5) throw new Error("AGENT_TOOL_LIMIT_EXCEEDED");
            for (const call of response.toolCalls) {
              if (travelConfig) travelToolCallsAttempted += 1;
              const handler = this.tools.get(call.name);
              const row = await this.prisma.agentToolExecution.create({
                data: {
                  organizationId,
                  executionId: execution.id,
                  toolName: call.name,
                  toolVersion: handler.definition.version,
                  status: AgentToolExecutionStatus.RUNNING,
                  input: redact(
                    call.arguments,
                    handler.definition.sensitiveInputPaths
                  ) as Prisma.InputJsonValue,
                  startedAt: new Date()
                }
              });
              const toolStarted = Date.now();
              // Sprint 4.7A Phase 2: one TOOL_CALL span per tool invocation, nested under the PROVIDER_CALL
              // span. Uses explicit startSpan/completeSpan/failSpan (not the `traced()` exception-based helper)
              // because this loop intentionally swallows some tool errors into a recoverable in-conversation
              // fallback rather than rethrowing — the span must still be marked FAILED in that case, which a
              // throw/catch-driven helper would miss.
              const [connectorName, ...capabilityParts] = call.name.split(".");
              const toolSpan =
                providerSpan && this.observability
                  ? await this.observability.startSpan(providerSpan, {
                      name: `TOOL_CALL:${call.name}`,
                      spanType: "TOOL_CALL",
                      component: "ToolExecutor",
                      employeeInstallationId: plugin.id,
                      inputSummary: {
                        tool: call.name,
                        connector: connectorName,
                        capability: capabilityParts.join(".") || call.name
                      }
                    })
                  : undefined;
              try {
                const output = await this.executor.execute(
                  call.name,
                  call.arguments,
                  {
                    organizationId,
                    userId: actorUserId,
                    pluginInstallationId: plugin.id,
                    conversationId: conversation.id
                  },
                  available,
                  permissions
                );
                await this.prisma.agentToolExecution.update({
                  where: { id: row.id },
                  data: {
                    status: AgentToolExecutionStatus.COMPLETED,
                    output: redact(
                      output,
                      handler.definition.sensitiveOutputPaths
                    ) as Prisma.InputJsonValue,
                    completedAt: new Date(),
                    latencyMs: Date.now() - toolStarted
                  }
                });
                if (toolSpan)
                  await this.observability?.completeSpan(toolSpan, toolStarted, {
                    attributes: {
                      tool: call.name,
                      connector: connectorName,
                      capability: capabilityParts.join(".") || call.name,
                      status: "COMPLETED",
                      retryCount: 0,
                      approvalRequired: handler.definition.requiredPermissions.some((permission) =>
                        /approv/i.test(permission)
                      )
                    }
                  });
                const content = JSON.stringify(output).slice(0, 12_000);
                await this.prisma.conversationMessage.create({
                  data: {
                    conversationId: conversation.id,
                    organizationId,
                    toolExecutionId: row.id,
                    role: ConversationMessageRole.TOOL,
                    content,
                    contentJson: redact(output) as Prisma.InputJsonValue
                  }
                });
                request = {
                  ...request,
                  messages: [
                    ...request.messages,
                    { role: "assistant", content: "", toolCallId: call.id },
                    { role: "tool", content, toolCallId: call.id }
                  ]
                };
              } catch (error) {
                const code = safeCode(error);
                if (toolSpan && this.observability) {
                  await this.observability.failSpan(
                    toolSpan,
                    {
                      name: `TOOL_CALL:${call.name}`,
                      spanType: "TOOL_CALL",
                      component: "ToolExecutor",
                      employeeInstallationId: plugin.id
                    },
                    toolStarted,
                    error
                  );
                  await this.observability.addAttribute(toolSpan, "tool", {
                    tool: call.name,
                    connector: connectorName,
                    capability: capabilityParts.join(".") || call.name,
                    retryCount: 0,
                    approvalRequired: handler.definition.requiredPermissions.some((permission) =>
                      /approv/i.test(permission)
                    ),
                    safeErrorCode: code
                  });
                }
                await this.prisma.agentToolExecution.update({
                  where: { id: row.id },
                  data: {
                    status:
                      code === "TOOL_NOT_PERMITTED"
                        ? AgentToolExecutionStatus.DENIED
                        : code === "TOOL_TIMEOUT"
                          ? AgentToolExecutionStatus.TIMED_OUT
                          : AgentToolExecutionStatus.FAILED,
                    errorCode: code,
                    errorMessage: "Tool execution failed",
                    completedAt: new Date(),
                    latencyMs: Date.now() - toolStarted
                  }
                });
                // Travel tool failures (e.g. a flaky flight/hotel search) get a recoverable, in-conversation
                // reply instead of surfacing as a hard agent failure — the traveler's captured trip details
                // are preserved (persisted below as usual) so they never have to repeat themselves. A failed
                // CRM-lead save during the BELOW_MINIMUM sales handoff is a genuine technical failure too, but
                // gets its own honest fallback that never promises a callback (only a real save may promise one).
                const isCrmLeadTool =
                  call.name === "travel.create_lead" || call.name.endsWith("crm.create_lead");
                const isSearchTool =
                  call.name === "travel.search_flights" || call.name === "travel.search_hotels";
                // A failed live search is fed BACK into the orchestrator (as a `role: tool` error marker) rather
                // than short-circuited here with a flat, dead-end message — this is what lets the orchestrator
                // persist provider-failure memory and answer with indicative recommendations instead (see
                // `continueAfterTool`'s `output.error === true` handling). Only when the LLM orchestrator is
                // actually in use: the deterministic fallback provider has no equivalent handling, so it keeps
                // the original flat recovery message.
                if (travelConfig && travelOrchestrator && isSearchTool) {
                  this.logger.error({
                    event: "TRAVEL_TOOL_EXECUTION_RECOVERED",
                    executionId: execution.id,
                    failedTool: call.name,
                    errorCategory: code,
                    context: "search",
                    validationDetails:
                      error instanceof Error ? error.message.slice(0, 500) : "unknown error"
                  });
                  const errorPayload = { error: true, errorCode: code, toolName: call.name };
                  const content = JSON.stringify(errorPayload).slice(0, 2000);
                  await this.prisma.conversationMessage.create({
                    data: {
                      conversationId: conversation.id,
                      organizationId,
                      toolExecutionId: row.id,
                      role: ConversationMessageRole.TOOL,
                      content,
                      contentJson: errorPayload as Prisma.InputJsonValue
                    }
                  });
                  request = {
                    ...request,
                    messages: [
                      ...request.messages,
                      { role: "assistant", content: "", toolCallId: call.id },
                      { role: "tool", content, toolCallId: call.id }
                    ]
                  };
                  continue;
                }
                if (travelConfig && (call.name.startsWith("travel.") || isCrmLeadTool)) {
                  this.logger.error({
                    event: "TRAVEL_TOOL_EXECUTION_RECOVERED",
                    executionId: execution.id,
                    failedTool: call.name,
                    errorCategory: code,
                    context: isCrmLeadTool ? "sales_handoff" : "search",
                    validationDetails:
                      error instanceof Error ? error.message.slice(0, 500) : "unknown error"
                  });
                  const language = travelOrchestrator?.responseLanguage ?? "ENGLISH";
                  travelToolRecoveryText = isCrmLeadTool
                    ? buildSalesHandoffFallbackMessage(language)
                    : buildToolFailureRecoveryMessage(language);
                  break;
                }
                throw error;
              }
            }
            if (travelToolRecoveryText) {
              finalText = travelToolRecoveryText;
              break;
            }
          }
          if (providerSpan && providerCallTimings.length)
            await this.observability?.addAttribute(
              providerSpan,
              "providerCalls",
              providerCallTimings
            );
        }
      );
      if (!finalText) throw new Error("AGENT_ITERATION_LIMIT_EXCEEDED");

      // Sprint 4.7 Phase 0: only ever evaluated for a genuine customer/dashboard-user message, never for
      // the SYSTEM actor a delegated task's own execution runs as — that gate is what keeps this from ever
      // re-triggering delegation off a server-generated internal task-handoff instruction (loop safety).
      const chatDelegation =
        input.actor.type === "USER" || input.actor.type === "CHANNEL"
          ? this.getChatDelegationTrigger()
          : null;
      if (chatDelegation) {
        const consult = await chatDelegation.maybeDelegate({
          organizationId,
          primaryEmployeeInstallationId: plugin.id,
          conversationId: conversation.id,
          messageText: input.text,
          traceContext: span ?? null
        });
        if (consult.delegated && consult.contribution) {
          finalText = `${finalText}\n\n(I checked with ${consult.targetDisplayName}: ${consult.contribution})`;
        }
      }

      if (
        leadStatusAnswer === null &&
        knowledgeAnswer === null &&
        this.security.knowledge.retrievalDebugLogging
      )
        this.logger.log({
          event: "AGENT_PROMPT_DEBUG",
          organizationId,
          conversationId: conversation.id,
          query: effectiveText,
          groundedFromKnowledge: false,
          llmResponse: finalText.slice(0, 2000)
        });
      failureStage = "persistence";
      const assistant = await this.prisma.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          organizationId,
          role: ConversationMessageRole.ASSISTANT,
          content: finalText,
          model: responseModel,
          inputTokens,
          outputTokens
        }
      });
      const totalTokens = inputTokens + outputTokens;
      // Phase 4 mirror mode: the legacy Travel runtime above remains authoritative. Its already-produced
      // structured entities are merged into a durable SkillExecution only after the response is fixed;
      // mirror loading, validation, optimistic updates, or failures cannot affect routing, RAG, tools,
      // the assistant response, or AgentMemory["travel.trip_state"].
      let skillShadow: PlanTripShadowComparison | null = null;
      if (travelConfig) {
        const deterministicDerivedState = travelOrchestrator
          ? null
          : deriveTravelState(
              [
                ...historyRows.map(toModelMessage),
                { role: "user" as const, content: effectiveText },
                { role: "assistant" as const, content: finalText }
              ],
              travelConfig.defaultCurrency
            );
        const shadowEntities = travelOrchestrator
          ? travelOrchestrator.lastEntities
          : mergeDeterministicTravelShadowEntities(
              persistedTravelEntities,
              entitiesFromStoredState(
                deterministicDerivedState as unknown as Record<string, unknown>
              )
            );
        const adapter = adaptTravelEntitiesForPlanTripShadow(shadowEntities, {
          deterministicTranscriptDerived: Boolean(deterministicDerivedState)
        });
        const existingDecision = normalizeExistingTravelDecision({
          requestIntent,
          stage: travelOrchestrator?.lastStage ?? deterministicDerivedState?.stage ?? null,
          workflowPhase: travelOrchestrator?.lastWorkflowPhase ?? null,
          toolCallsAttempted: travelToolCallsAttempted,
          entities: shadowEntities
        });
        const scope = {
          organizationId,
          pluginInstallationId: plugin.id,
          conversationId: conversation.id,
          skillId: PLAN_TRIP_SKILL_ID
        };
        const applicable = existingDecision.category !== "NOT_APPLICABLE";
        let activeExecution = null as Awaited<
          ReturnType<SkillExecutionService["findActiveExecution"]>
        >;
        let currentSkillState = emptyPlanTripSkillState();
        let persistenceWarning: "SKILL_PERSISTENCE_FAILED" | "SKILL_REVISION_CONFLICT" | null =
          null;
        const skillExecutions = this.skillExecutions;
        if (applicable && skillExecutions) {
          try {
            activeExecution = await skillExecutions.findActiveExecution(scope);
            if (activeExecution) {
              if (activeExecution.skillVersion !== PLAN_TRIP_SKILL_VERSION)
                throw new Error("SKILL_EXECUTION_VERSION_MISMATCH");
              currentSkillState = PlanTripSkillExecutionMapper.fromJson(activeExecution.state);
            }
          } catch (error) {
            persistenceWarning =
              error instanceof SkillExecutionRevisionConflictError
                ? "SKILL_REVISION_CONFLICT"
                : "SKILL_PERSISTENCE_FAILED";
            activeExecution = null;
            currentSkillState = emptyPlanTripSkillState();
          }
        }
        try {
          let evaluation = this.skillRuntime.evaluate(
            PLAN_TRIP_SKILL_ID,
            PLAN_TRIP_SKILL_VERSION,
            {
              organizationId,
              pluginInstallationId: plugin.id,
              conversationId: conversation.id,
              requestId: input.requestId,
              currentState: currentSkillState
            },
            adapter.input
          );
          skillShadow = comparePlanTripShadow({
            existing: existingDecision,
            shadowAction: evaluation.decision.action,
            shadowMissingField: evaluation.decision.state.pendingInput,
            shadowCapabilities: evaluation.decision.capabilities,
            fieldCompleteness: adapter.fieldCompleteness,
            adapterWarnings: adapter.warnings
          });
          if (applicable && skillExecutions && !persistenceWarning) {
            try {
              let mutation = activeExecution
                ? await skillExecutions.updateExecutionState({
                    organizationId,
                    id: activeExecution.id,
                    expectedRevision: activeExecution.revision,
                    state: evaluation.decision.state,
                    pendingInput: evaluation.decision.state.pendingInput,
                    latestAgentExecutionId: execution.id,
                    turnId: input.requestId
                  })
                : await skillExecutions.createExecution({
                    scope,
                    skillVersion: PLAN_TRIP_SKILL_VERSION,
                    schemaVersion: evaluation.decision.state.schemaVersion,
                    state: evaluation.decision.state,
                    pendingInput: evaluation.decision.state.pendingInput,
                    agentExecutionId: execution.id,
                    turnId: input.requestId
                  });
              // A concurrent first turn may win the unique active-key race. Apply this distinct turn to
              // the winner with its revision; an identical turn is already reported as an idempotent replay.
              if (!activeExecution && !mutation.applied && !mutation.idempotentReplay) {
                const winnerState = PlanTripSkillExecutionMapper.fromJson(mutation.execution.state);
                evaluation = this.skillRuntime.evaluate(
                  PLAN_TRIP_SKILL_ID,
                  PLAN_TRIP_SKILL_VERSION,
                  {
                    organizationId,
                    pluginInstallationId: plugin.id,
                    conversationId: conversation.id,
                    requestId: input.requestId,
                    currentState: winnerState
                  },
                  adapter.input
                );
                mutation = await skillExecutions.updateExecutionState({
                  organizationId,
                  id: mutation.execution.id,
                  expectedRevision: mutation.execution.revision,
                  state: evaluation.decision.state,
                  pendingInput: evaluation.decision.state.pendingInput,
                  latestAgentExecutionId: execution.id,
                  turnId: input.requestId
                });
                skillShadow = comparePlanTripShadow({
                  existing: existingDecision,
                  shadowAction: evaluation.decision.action,
                  shadowMissingField: evaluation.decision.state.pendingInput,
                  shadowCapabilities: evaluation.decision.capabilities,
                  fieldCompleteness: adapter.fieldCompleteness,
                  adapterWarnings: adapter.warnings
                });
              }
              skillShadow = withPlanTripShadowPersistence(skillShadow, {
                executionId: mutation.execution.id,
                status: mutation.execution.status,
                revision: mutation.execution.revision,
                applied: mutation.applied,
                idempotentReplay: mutation.idempotentReplay,
                warning: null
              });
            } catch (error) {
              persistenceWarning =
                error instanceof SkillExecutionRevisionConflictError
                  ? "SKILL_REVISION_CONFLICT"
                  : "SKILL_PERSISTENCE_FAILED";
            }
          }
        } catch {
          skillShadow = failedPlanTripShadowComparison({
            existing: existingDecision,
            fieldCompleteness: adapter.fieldCompleteness,
            adapterWarnings: adapter.warnings
          });
        }
        if (skillShadow && persistenceWarning)
          skillShadow = withPlanTripShadowPersistence(skillShadow, {
            executionId: activeExecution?.id ?? null,
            status: activeExecution?.status ?? null,
            revision: activeExecution?.revision ?? null,
            applied: false,
            idempotentReplay: false,
            warning: persistenceWarning
          });
        this.logger.debug({
          event: "SKILL_SHADOW_COMPARISON",
          organizationId,
          executionId: execution.id,
          skillId: skillShadow.skillId,
          skillVersion: skillShadow.skillVersion,
          agreement: skillShadow.agreement,
          existingDecision: skillShadow.existingDecision,
          shadowDecision: skillShadow.shadowDecision,
          reasonCodes: skillShadow.reasonCodes
        });
      }
      await this.prisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          status: AgentExecutionStatus.COMPLETED,
          completedAt: new Date(),
          latencyMs: Date.now() - started,
          inputTokens,
          outputTokens,
          totalTokens,
          estimatedCost: estimateCost(
            responseProvider,
            responseModel,
            inputTokens,
            outputTokens,
            {}
          ),
          metadata: {
            ...((input.metadata ?? {}) as Record<string, unknown>),
            retrieval: knowledgeSources.map(sourceMetadata),
            ...(skillShadow ? { skillShadow } : {})
          } as unknown as Prisma.InputJsonValue
        }
      });
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() }
      });
      if (travelConfig) {
        const state = travelOrchestrator
          ? entitiesToStoredState(
              travelOrchestrator.lastEntities,
              travelOrchestrator.lastStage,
              travelOrchestrator.lastMemory
            )
          : (() => {
              const derived = deriveTravelState(
                [
                  ...historyRows.map(toModelMessage),
                  { role: "user" as const, content: effectiveText },
                  { role: "assistant" as const, content: finalText }
                ],
                travelConfig.defaultCurrency
              );
              return deterministicTravelProvider
                ? entitiesToStoredState(
                    // deriveTravelState's own TravelState/TravelSlots shape has no originCity/tripType/
                    // preferences field at all — reconstructing entities from it (as before) silently
                    // dropped those fields every turn. The provider's own `lastEntities` is the complete,
                    // correctly-merged trip state for this turn; `derived` is kept only for its `.stage`
                    // computation, which TravelEmployeeProvider has no equivalent of.
                    deterministicTravelProvider.lastEntities,
                    derived.stage,
                    deterministicTravelProvider.lastMemory
                  )
                : derived;
            })();
        await this.memories.save(organizationId, actorUserId, {
          pluginInstallationId: plugin.id,
          conversationId: conversation.id,
          scope: AgentMemoryScope.CONVERSATION,
          key: TRAVEL_TRIP_STATE_MEMORY_KEY,
          value: state as unknown as Record<string, unknown>,
          searchableText:
            `${state.stage} ${(state as { destination?: unknown }).destination ?? ""}`.trim()
        });
        // Stage 9E: Travel Runtime's own BELOW_MINIMUM budget-feasibility business result emits a typed
        // signal (never a private pendingInputAction transition, in PLATFORM_MANAGED mode) instead of
        // starting the workflow itself — this turn's already-computed response text is unaffected either
        // way; only which mechanism owns the NEXT turn's contact reply changes. Silent: any outcome text
        // is discarded, since the response for THIS turn was already assembled above.
        const workflowSignalDraft =
          travelOrchestrator?.lastWorkflowSignal ??
          deterministicTravelProvider?.lastWorkflowSignal ??
          null;
        if (workflowSignalDraft && this.workflowCoordinator) {
          try {
            const freshEntities = entitiesFromStoredState(
              state as unknown as Record<string, unknown>
            );
            const freshMemory = memoryFromStoredState(state as unknown as Record<string, unknown>);

            const isBookingSignal = workflowSignalDraft.signalType === "START_BOOKING_HANDOFF";
            const dispatchSignalsBundle = this.buildWorkflowDispatchSignals(
              freshEntities,
              freshMemory
            );
            // bookingHandoffSignalProvider (workflow-signal-registry.ts) reads `signal.payload.tripContext`
            // as a full BookingHandoffTripContext — Travel Runtime's own `pendingWorkflowSignal.payload` is
            // only ever a flat `{selectedOption}` draft (it has no access to the rich entities/memory this
            // service already derived above), so it must be merged into the full tripContext here, never
            // passed through as-is (that previously left `tripContext` undefined and threw at dispatch time).
            const signal: WorkflowSignal = {
              signalType: workflowSignalDraft.signalType,
              workflowType: isBookingSignal ? "BOOKING_HANDOFF" : "TRIP_SUBMISSION",
              source: isBookingSignal
                ? "BOOKING_READY_CAPABILITY"
                : "BELOW_MINIMUM_BUDGET_FEASIBILITY",
              sourceTurnId: input.requestId,
              sourceSkillExecutionId: null,
              payload: isBookingSignal
                ? {
                    tripContext: {
                      ...dispatchSignalsBundle.bookingHandoffTripContext,
                      selectedOption:
                        (
                          workflowSignalDraft.payload as {
                            selectedOption?: Record<string, unknown> | null;
                            passengerDetails?: Record<string, unknown>[] | null;
                          } | null
                        )?.selectedOption ?? null,
                      passengerDetails:
                        (
                          workflowSignalDraft.payload as {
                            selectedOption?: Record<string, unknown> | null;
                            passengerDetails?: Record<string, unknown>[] | null;
                          } | null
                        )?.passengerDetails ?? null,
                      customerEmail:
                        (workflowSignalDraft.payload as { customerEmail?: string | null } | null)
                          ?.customerEmail ?? null,
                      customerPhone:
                        (workflowSignalDraft.payload as { customerPhone?: string | null } | null)
                          ?.customerPhone ?? null
                    }
                  }
                : (workflowSignalDraft.payload ?? { trigger: workflowSignalDraft.trigger }),
              confidence: 1
            };
            const signalOutcome = await this.workflowCoordinator.dispatchSignal(
              { organizationId, pluginInstallationId: plugin.id, conversationId: conversation.id },
              signal,
              input.requestId,
              dispatchSignalsBundle,
              effectiveText
            );
            if (signalOutcome && !isBookingSignal)
              await this.reconcileLegacyStateAfterWorkflowLead(
                signalOutcome,
                organizationId,
                actorUserId,
                plugin.id,
                conversation.id,
                freshEntities,
                freshMemory
              );
            if (isBookingSignal) {
              this.logger.log({
                event: "BOOKING_HANDOFF_SIGNAL_DISPATCHED",
                conversationId: conversation.id,
                trigger: workflowSignalDraft.trigger
              });
            }
            // Customer-confirmation bookings (see TravelBookingService.requestCustomerApproval) and a
            // TRIP_SUBMISSION lead whose triggering text already contained a contact value (see
            // TripSubmissionWorkflowService.start's "immediate contact" shortcut — reachable for
            // BELOW_MINIMUM_BUDGET since the Travel Booking Closure Pass, previously only for
            // CONFIRM_SUBMISSION/STANDALONE_CONTACT) can both complete synchronously within this same
            // dispatchSignal call — so their outcome text is NOT stale by the time it comes back and must
            // replace the generic placeholder ("waiting for approval" / "may I have your mobile number")
            // Travel Runtime already produced, both in the response returned for this turn and in the
            // already-persisted assistant message (a page reload must show the same real outcome).
            if (signalOutcome?.decision === "COMPLETE" && signalOutcome.responseText) {
              finalText = signalOutcome.responseText;
              outputTokens = estimateTokens(finalText);
              // Fix (Travel Booking UAT correction pass): a booking that starts AND completes
              // synchronously within this same signal dispatch (a customer-confirmation booking — see
              // BookingHandoffWorkflowService.start's own doc comment) never goes through
              // `dispatchPendingWorkflowTurn`'s own attachment-building block below, since that block only
              // runs for RESUMING an already-`WAITING_FOR_INPUT` workflow. Without this, the PDF ticket
              // was generated and persisted but never actually attached to the chat message that reports
              // the booking as confirmed — mirrors `dispatchPendingWorkflowTurn`'s attachment shape exactly.
              // Never applicable to a TRIP_SUBMISSION completion (bookingId stays undefined there).
              const bookingAttachments = signalOutcome.bookingId
                ? [
                    {
                      type: "PDF_TICKET" as const,
                      bookingId: signalOutcome.bookingId,
                      url: `/travel/bookings/${signalOutcome.bookingId}/ticket.pdf`,
                      filename: `ticket-${signalOutcome.bookingId.slice(0, 8)}.pdf`
                    }
                  ]
                : null;
              bookingCompletionAttachments = bookingAttachments;
              await this.prisma.conversationMessage.update({
                where: { id: assistant.id },
                data: {
                  content: finalText,
                  outputTokens,
                  ...(bookingAttachments
                    ? { contentJson: { attachments: bookingAttachments } as unknown as Prisma.InputJsonValue }
                    : {})
                }
              });
            }
          } catch (error) {
            this.logger.error({
              event: "TRAVEL_WORKFLOW_SIGNAL_DISPATCH_FAILED",
              conversationId: conversation.id,
              error: error instanceof Error ? error.message : "unknown"
            });
          }
        }
        // Stage 9F: workflow trigger re-evaluation — a budget correction (possibly reaching Travel
        // Runtime because an active workflow DEFERred the turn, see WorkflowResumeDecision.DEFER) may
        // resolve a previously BELOW_MINIMUM budget. The stale BELOW_MINIMUM-triggered TRIP_SUBMISSION
        // workflow (if any) must not keep demanding contact for a condition that no longer holds — see
        // WorkflowCoordinator.reevaluateBelowMinimumTrigger. Only evaluated when Travel Runtime actually
        // recomputed feasibility this turn (the LLM-orchestrator path exposes this diagnostic; the
        // deterministic provider does not today — a disclosed scope limit, see ARCHITECTURE.md).
        if (this.workflowCoordinator && travelOrchestrator?.lastDiagnostics?.feasibility) {
          try {
            await this.workflowCoordinator.reevaluateBelowMinimumTrigger(
              { organizationId, pluginInstallationId: plugin.id, conversationId: conversation.id },
              travelOrchestrator.lastDiagnostics.feasibility.classification === "BELOW_MINIMUM"
            );
          } catch (error) {
            this.logger.error({
              event: "TRIP_SUBMISSION_TRIGGER_REEVALUATION_FAILED",
              conversationId: conversation.id,
              error: error instanceof Error ? error.message : "unknown"
            });
          }
        }
        // Once a name is captured for a known (non-anonymous) customer identity, persist it onto their
        // durable profile so their *next* conversation (a fresh interaction, e.g. after this one is
        // archived/reset) can recognize them without re-asking — never onto this conversation's own
        // state, and never for an ANONYMOUS identity, which has no durable profile to attach to.
        const capturedName = (state as { customerName?: string | null }).customerName;
        if (capturedName) {
          const profile = await this.customerIdentity.rememberName(
            organizationId,
            customerIdentity,
            capturedName
          );
          if (profile && conversation.customerProfileId !== profile.id)
            await this.prisma.conversation.update({
              where: { id: conversation.id },
              data: { customerProfileId: profile.id }
            });
        }
      }
      // Persist the domain employee's conversation state under its own memory key (mirrors the travel
      // persistence contract above, but for the shared employee engine). The orchestrator exposes the
      // complete merged entities + stage; the deterministic provider's stage is derived from entities.
      if (employeeConfig && employeeDomain) {
        const employeeState = employeeOrchestrator
          ? employeeEntitiesToStoredState(
              employeeOrchestrator.lastEntities,
              employeeOrchestrator.lastStage,
              employeeOrchestrator.lastMemory
            )
          : deterministicEmployeeProvider
            ? employeeEntitiesToStoredState(
                deterministicEmployeeProvider.lastEntities,
                "COLLECT_NAME",
                deterministicEmployeeProvider.lastMemory
              )
            : null;
        if (employeeState) {
          await this.memories.save(organizationId, actorUserId, {
            pluginInstallationId: plugin.id,
            conversationId: conversation.id,
            scope: AgentMemoryScope.CONVERSATION,
            key: employeeDomain.memoryKey,
            value: employeeState,
            searchableText: `${employeeState.stage} ${employeeState.customerName ?? ""}`.trim()
          });
          const employeeName = employeeState.customerName;
          if (typeof employeeName === "string" && employeeName) {
            const profile = await this.customerIdentity.rememberName(
              organizationId,
              customerIdentity,
              employeeName
            );
            if (profile && conversation.customerProfileId !== profile.id)
              await this.prisma.conversation.update({
                where: { id: conversation.id },
                data: { customerProfileId: profile.id }
              });
          }
        }
      }
      // Legal Employee — "generate/download a PDF": when the user asked for a downloadable PDF of the
      // drafted legal document, persist the final response text as a LegalDocument and attach the download
      // URL so the chat renders a Download button (same pattern as the Travel ticket PDF attachment).
      let legalPdfAttachments: Array<{
        type: "PDF_DOCUMENT";
        documentId: string;
        url: string;
        filename: string;
      }> | null = null;
      if (
        isLegalEmployee &&
        finalText &&
        /pdf|download|downloadable|format as (a )?pdf|as a file|save (this|as) (a )?file/i.test(
          effectiveText
        )
      ) {
        try {
          const legalTitle = legalDocumentTitle(effectiveText, finalText);
          const row = await this.prisma.legalDocument.create({
            data: {
              organizationId,
              pluginInstallationId: plugin.id,
              conversationId: conversation.id,
              createdByUserId: actorUserId,
              title: legalTitle,
              content: finalText
            }
          });
          legalPdfAttachments = [
            {
              type: "PDF_DOCUMENT",
              documentId: row.id,
              url: `/api/v1/legal-employee/documents/${row.id}/pdf`,
              filename: `${legalTitle}.pdf`
            }
          ];
          await this.prisma.conversationMessage.update({
            where: { id: assistant.id },
            data: {
              contentJson: { attachments: legalPdfAttachments } as unknown as Prisma.InputJsonValue
            }
          });
        } catch (error) {
          this.logger.warn({
            event: "LEGAL_PDF_GENERATION_FAILED",
            conversationId: conversation.id,
            error: error instanceof Error ? error.message : "unknown"
          });
        }
      }
      // Travel Booking Closure Pass — Phase 7-9: post-booking artifact retrieval ("share the pdf", "send
      // my ticket", "where is my ticket?", ...). Deliberately a POST-PROCESSING override — like
      // `legalPdfAttachments` above — rather than a new Travel Runtime pendingAction/tool: Travel Runtime
      // has no Prisma access and no reliable way to know "is there already a real, confirmed booking for
      // THIS conversation" from its own in-memory entities alone (that state resets after confirmation).
      // Only ever overrides `finalText` when a REAL, already-confirmed TravelBooking is found for this
      // EXACT conversation — never fabricates one, never creates a second booking, and naturally supersedes
      // whatever Travel Runtime's own dispatch chain guessed (e.g. its "please share your email" resend-ticket
      // ask, or — the exact reported defect — a recommendation restart) once a genuine match exists.
      // Sprint 6.3 — Part 6-9: a plain follow-up QUESTION ("what was the hotel", "how much did it cost",
      // "what is my PNR", "show my itinerary") is checked alongside the PDF/artifact-retrieval phrases
      // below — both need the SAME "does a real completed booking exist for this conversation" lookup, so
      // they share it rather than querying twice or building a second classifier.
      const isPostBookingArtifactRequest = isTravelEmployee && POST_BOOKING_ARTIFACT_REQUEST_PATTERN.test(effectiveText);
      const isPostBookingQuestion = isTravelEmployee && !isPostBookingArtifactRequest && POST_BOOKING_QA_PATTERN.test(effectiveText);
      if (isPostBookingArtifactRequest || isPostBookingQuestion) {
        try {
          const existingBooking = await this.prisma.travelBooking.findFirst({
            where: {
              organizationId,
              conversationId: conversation.id,
              status: { in: ["BOOKED", "TICKETS_DELIVERED"] }
            },
            orderBy: { createdAt: "desc" }
          });
          if (existingBooking) {
            if (isPostBookingArtifactRequest) {
              finalText = `Of course — I've attached your booking confirmation again. Krevia booking reference: ${existingBooking.providerBookingRef ?? "unavailable"}${existingBooking.providerPnr ? `, simulated PNR: ${existingBooking.providerPnr}` : ""}.`;
              outputTokens = estimateTokens(finalText);
              bookingCompletionAttachments = [
                {
                  type: "PDF_TICKET" as const,
                  bookingId: existingBooking.id,
                  url: `/travel/bookings/${existingBooking.id}/ticket.pdf`,
                  filename: `ticket-${existingBooking.id.slice(0, 8)}.pdf`
                }
              ];
              await this.prisma.conversationMessage.update({
                where: { id: assistant.id },
                data: {
                  content: finalText,
                  outputTokens,
                  contentJson: { attachments: bookingCompletionAttachments } as unknown as Prisma.InputJsonValue
                }
              });
            } else {
              // A plain question about the completed booking — answer in text only, never re-attach the
              // PDF (the customer didn't ask for the document again, just a fact from it).
              const answer = answerPostBookingQuestion(effectiveText, existingBooking);
              if (answer) {
                finalText = answer;
                outputTokens = estimateTokens(finalText);
                await this.prisma.conversationMessage.update({
                  where: { id: assistant.id },
                  data: { content: finalText, outputTokens }
                });
              }
            }
          }
        } catch (error) {
          this.logger.warn({
            event: "POST_BOOKING_ARTIFACT_RETRIEVAL_FAILED",
            conversationId: conversation.id,
            error: error instanceof Error ? error.message : "unknown"
          });
        }
      }
      // Cross-employee routing handoff: the provider detected a CONFIRMED "yes, route it" reply to a prior
      // out-of-scope offer (see RoutingHandoffSignal / detectRoutingConfirmation) and returned a placeholder
      // "Connecting you to X…" response. This is the one place with Prisma access to actually do it: create
      // a fresh conversation under the target employee, run a full turn on it seeded with the ORIGINAL
      // out-of-scope message (never the "yes" itself), and rewrite this turn's already-persisted response
      // with a link to it — or a graceful "not installed" message if the target was never set up for this
      // org. Mirrors the booking-confirmation `finalText` rewrite pattern above (Stage 9E).
      const routingHandoffSignal =
        travelOrchestrator?.lastRoutingHandoffSignal ??
        deterministicTravelProvider?.lastRoutingHandoffSignal ??
        employeeOrchestrator?.lastRoutingHandoffSignal ??
        deterministicEmployeeProvider?.lastRoutingHandoffSignal ??
        null;
      let routingLinkAttachments: Array<{
        type: "CONVERSATION_LINK";
        employeeInstallationId: string;
        conversationId: string;
        label: string;
      }> | null = null;
      if (routingHandoffSignal) {
        try {
          const targetPlugin = await this.prisma.plugin.findFirst({
            where: {
              organizationId,
              slug: routingHandoffSignal.targetSlug,
              status: PluginStatus.ACTIVE,
              deletedAt: null
            }
          });
          const targetName =
            employeeScopeProfile(routingHandoffSignal.targetSlug)?.displayName ??
            routingHandoffSignal.targetSlug;
          if (!targetPlugin) {
            finalText = `I wanted to route this to ${targetName}, but it isn't set up for your organization yet. I can still try to help here, or ask an admin to install it.`;
          } else {
            const routedConversation = await this.prisma.conversation.create({
              data: {
                organizationId,
                pluginInstallationId: targetPlugin.id,
                createdByUserId: actorUserId,
                title: `Routed: ${routingHandoffSignal.originalText}`.slice(0, 160),
                metadata: {
                  routedFromConversationId: conversation.id,
                  routedFromPluginInstallationId: plugin.id
                } as Prisma.InputJsonValue
              }
            });
            await this.execute({
              organizationId,
              agentId: targetPlugin.id,
              actor: input.actor,
              source: input.source,
              text: routingHandoffSignal.originalText,
              requestId: `${input.requestId}:route`,
              conversationId: routedConversation.id
            });
            finalText = `I've started a new conversation with ${targetName} for you.`;
            routingLinkAttachments = [
              {
                type: "CONVERSATION_LINK",
                employeeInstallationId: targetPlugin.id,
                conversationId: routedConversation.id,
                label: `Continue in ${targetName}`
              }
            ];
          }
          outputTokens = estimateTokens(finalText);
          await this.prisma.conversationMessage.update({
            where: { id: assistant.id },
            data: {
              content: finalText,
              outputTokens,
              ...(routingLinkAttachments
                ? { contentJson: { attachments: routingLinkAttachments } as unknown as Prisma.InputJsonValue }
                : {})
            }
          });
        } catch (error) {
          this.logger.error({
            event: "ROUTING_HANDOFF_FAILED",
            conversationId: conversation.id,
            targetSlug: routingHandoffSignal.targetSlug,
            error: error instanceof Error ? error.message : "unknown"
          });
        }
      }
      if (span)
        await this.observability?.addAttribute(span, "execution", {
          employeeInstallationId: plugin.id,
          providerType: settings.providerType,
          model: responseModel,
          inputTokens,
          outputTokens,
          totalTokens,
          toolCount: travelToolCallsAttempted,
          status: "COMPLETED",
          ...(aiResolutionSource ? { aiResolutionSource } : {}),
          ...(aiProviderConnectionId ? { aiProviderConnectionId } : {}),
          ...(aiModelProfileId ? { aiModelProfileId } : {})
        });
      return {
        conversationId: conversation.id,
        executionId: execution.id,
        messageId: assistant.id,
        response: finalText,
        status: "COMPLETED" as const,
        model: responseModel,
        usage: { inputTokens, outputTokens, totalTokens, estimatedCost: null },
        // When the final answer explicitly says nothing was found (see NO_KNOWLEDGE_MESSAGE — e.g. the
        // Travel Employee asked an HR question, or nothing retrieved cleared the confidence gate), the
        // raw retrieval that was rejected must never still be exposed as "sources" — a UI rendering
        // citation chips alongside "I could not find this" would contradict the answer it's citing.
        sources: finalText === NO_KNOWLEDGE_MESSAGE ? [] : knowledgeSources.map(sourceMetadata),
        // Travel Booking Closure Pass — Phase 4-6: `bookingCompletionAttachments` checked first — a
        // synchronous booking completion is mutually exclusive with the legal/routing-link attachment
        // paths (different employees, different turns), but ordering it first keeps this resilient to
        // that ever changing.
        ...(bookingCompletionAttachments
          ? { attachments: bookingCompletionAttachments }
          : legalPdfAttachments
            ? { attachments: legalPdfAttachments }
            : routingLinkAttachments
              ? { attachments: routingLinkAttachments }
              : {})
      };
    } catch (error) {
      const stage = error instanceof AiProviderError ? error.stage : failureStage;
      this.logger.error({
        event: "AGENT_EXECUTION_FAILED",
        executionId: execution.id,
        providerType: settings.providerType,
        model: configuredModel,
        stage,
        code: safeCode(error),
        ...(error instanceof AiProviderError && error.upstreamStatus
          ? { upstreamStatus: error.upstreamStatus }
          : {})
      });
      try {
        await this.prisma.agentExecution.update({
          where: { id: execution.id },
          data: {
            status: safeCode(error).includes("TIMEOUT")
              ? AgentExecutionStatus.TIMED_OUT
              : AgentExecutionStatus.FAILED,
            completedAt: new Date(),
            latencyMs: Date.now() - started,
            errorCode: safeCode(error),
            errorMessage: "Agent execution failed"
          }
        });
      } catch {
        this.logger.error({
          event: "AGENT_EXECUTION_FAILURE_PERSIST_FAILED",
          executionId: execution.id,
          providerType: settings.providerType,
          model: configuredModel,
          stage: "persistence"
        });
      }
      if (error instanceof AiProviderError)
        throw new IdentityApplicationError(error.code, providerExecutionMessage(error.code));
      if (safeCode(error).includes("TIMEOUT")) throw new RequestTimeoutException(safeCode(error));
      if (safeCode(error) === "TOOL_NOT_PERMITTED")
        throw new ForbiddenException("TOOL_NOT_PERMITTED");
      throw new IdentityApplicationError(
        "AGENT_EXECUTION_FAILED",
        "The agent execution could not be completed safely."
      );
    }
  }
  async employees(organizationId: string) {
    const items = await this.prisma.plugin.findMany({
      // List every installed employee (ACTIVE or not) so the dashboard always reflects what was installed —
      // a plugin installed without "Enable after installation" is still visible (disabled), not silently
      // missing from the AI Employees page. `runtimeReady` marks whether it can currently run.
      where: { organizationId, deletedAt: null },
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        slug: true,
        displayName: true,
        description: true,
        version: true,
        status: true,
        lastHealthStatus: true,
        grantedPermissions: true
      }
    });
    return items.map((item) => ({
      ...item,
      runtimeReady:
        item.status === PluginStatus.ACTIVE &&
        Array.isArray(item.grantedPermissions) &&
        item.grantedPermissions.includes("MEMORY")
    }));
  }
  /** The dashboard's "Tools" page catalog — every reusable tool/capability across all AI employees, sourced
   *  from the live ToolRegistry (see registerTools()) so it can never drift from what's actually callable. */
  toolCatalog() {
    return buildToolCatalog(this.tools.definitions());
  }
  async conversations(organizationId: string, page: PageDto) {
    const where: Prisma.ConversationWhereInput = {
      organizationId,
      deletedAt: null,
      ...(page.pluginInstallationId ? { pluginInstallationId: page.pluginInstallationId } : {}),
      ...(page.status ? { status: page.status } : {}),
      ...(page.search ? { title: { contains: page.search, mode: "insensitive" } } : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.conversation.findMany({
        where,
        include: {
          pluginInstallation: { select: { displayName: true } },
          createdBy: { select: { firstName: true, lastName: true } },
          _count: { select: { messages: true } }
        },
        orderBy: { updatedAt: "desc" },
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize
      }),
      this.prisma.conversation.count({ where })
    ]);
    return paged(items, total, page);
  }
  async conversation(organizationId: string, id: string) {
    const value = await this.prisma.conversation.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: {
        pluginInstallation: { select: { displayName: true } },
        createdBy: { select: { firstName: true, lastName: true } },
        _count: { select: { messages: true } }
      }
    });
    if (!value) throw new NotFoundException("CONVERSATION_NOT_FOUND");
    return value;
  }
  async messages(organizationId: string, id: string) {
    await this.conversation(organizationId, id);
    return this.prisma.conversationMessage.findMany({
      where: { conversationId: id, organizationId },
      orderBy: { createdAt: "asc" }
    });
  }
  async archive(organizationId: string, id: string, status: ConversationStatus) {
    await this.conversation(organizationId, id);
    return this.prisma.conversation.update({ where: { id }, data: { status } });
  }
  async executions(organizationId: string, page: PageDto) {
    const where = { organizationId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.agentExecution.findMany({
        where,
        include: {
          pluginInstallation: { select: { displayName: true } },
          user: { select: { firstName: true, lastName: true } },
          _count: { select: { toolExecutions: true } }
        },
        orderBy: { createdAt: "desc" },
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize
      }),
      this.prisma.agentExecution.count({ where })
    ]);
    return paged(items, total, page);
  }
  async execution(organizationId: string, id: string) {
    const value = await this.prisma.agentExecution.findFirst({
      where: { id, organizationId },
      include: {
        pluginInstallation: { select: { displayName: true } },
        user: { select: { firstName: true, lastName: true } },
        toolExecutions: { orderBy: { createdAt: "asc" } }
      }
    });
    if (!value) throw new NotFoundException("EXECUTION_NOT_FOUND");
    return value;
  }
  /**
   * Sprint 4.5: fire-and-forget platform-memory capture after a user turn. Runs the deterministic
   * extraction rules on the user's message (storing e.g. "preferred.airline") and triggers automatic
   * conversation summarization when enough new turns have accumulated. Never throws to the caller.
   */
  private async captureTurnMemories(
    organizationId: string,
    actorUserId: string | null,
    pluginInstallationId: string,
    conversationId: string,
    text: string
  ): Promise<void> {
    if (!this.platformMemory || !text.trim()) return;
    try {
      await this.platformMemory.extractAndRemember({
        organizationId,
        actorId: actorUserId,
        employeeId: pluginInstallationId,
        conversationId,
        userId: actorUserId,
        text
      });
    } catch (error) {
      this.logger.warn({
        event: "MEMORY_EXTRACTION_FAILED",
        conversationId,
        error: error instanceof Error ? error.message : "unknown"
      });
    }
    try {
      await this.platformMemory.maybeSummarizeConversation(
        organizationId,
        conversationId,
        MEMORY_SUMMARIZE_THRESHOLD
      );
    } catch (error) {
      this.logger.warn({
        event: "MEMORY_SUMMARIZATION_FAILED",
        conversationId,
        error: error instanceof Error ? error.message : "unknown"
      });
    }
  }

  /** Sprint 4.5: retrieves the platform memory context (Org -> Employee -> User -> Conversation Summary). */
  private async recallMemoryContext(
    organizationId: string,
    actorUserId: string | null,
    employeeId: string,
    conversationId: string,
    memorySpan?: TraceContext
  ) {
    if (!this.platformMemory) return null;
    try {
      // Sprint 4.7A Phase 5: candidateCount/filteredCount/selectedCount/expiredCount/securityFiltered are
      // real counts from parallel COUNT queries (see MemoryService.recallWithMetrics) — never the memory
      // values themselves, which never reach a span attribute.
      const { context, metrics } = await this.platformMemory.recallWithMetrics(organizationId, {
        userId: actorUserId,
        employeeId,
        conversationId
      });
      if (memorySpan) await this.observability?.addAttribute(memorySpan, "recall", metrics);
      return context;
    } catch (error) {
      this.logger.warn({
        event: "MEMORY_RECALL_FAILED",
        conversationId,
        error: error instanceof Error ? error.message : "unknown"
      });
      return null;
    }
  }

  private registerTools() {
    this.tools.register({
      definition: {
        name: "platform.memory.save",
        version: "1.0.0",
        description: "Save a scoped preference",
        requiredPermissions: ["agents.memory.write"],
        timeoutMs: 3000,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["key", "value", "scope"],
          properties: {
            key: { type: "string", minLength: 1, maxLength: 160 },
            value: {
              anyOf: [
                { type: "string" },
                { type: "number" },
                { type: "boolean" },
                { type: "object" }
              ]
            },
            scope: { enum: ["USER", "CONVERSATION", "PLUGIN"] }
          }
        }
      },
      execute: async (input, context) => {
        const value =
          typeof input.value === "object" && input.value !== null
            ? (input.value as Record<string, unknown>)
            : { value: input.value };
        const memory = await this.memories.save(context.organizationId, context.userId, {
          pluginInstallationId: context.pluginInstallationId,
          conversationId: context.conversationId,
          scope: input.scope as AgentMemoryScope,
          key: String(input.key),
          value,
          searchableText: String(input.value)
        });
        return { memoryId: memory.id, saved: true };
      }
    });
    this.tools.register({
      definition: {
        name: "platform.memory.search",
        version: "1.0.0",
        description: "Search scoped memories",
        requiredPermissions: ["agents.memory.read"],
        timeoutMs: 3000,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string", minLength: 1 },
            limit: { type: "integer", minimum: 1, maximum: 20 }
          }
        }
      },
      execute: async (input, context) =>
        (
          await this.memories.search(context.organizationId, context.userId, {
            pluginInstallationId: context.pluginInstallationId,
            query: String(input.query),
            limit: Number(input.limit ?? 10)
          })
        ).map((x) => ({ key: x.key, value: x.value }))
    });
    this.tools.register({
      definition: {
        name: "platform.demo.echo",
        version: "1.0.0",
        description: "Deterministic local echo",
        requiredPermissions: ["agents.tools.execute"],
        timeoutMs: 1000,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["message"],
          properties: { message: { type: "string", maxLength: 1000 } }
        }
      },
      execute: async (input) => ({ echo: input.message })
    });
  }

  /**
   * Sprint 6.1 — Phase 12 Tool Registry integration. Registers one generic `skill.<key>` tool per
   * built-in adapter known to the process-local SkillRegistryService — the same registry/executor
   * every other tool goes through, not a second tool-call mechanism. Registration happens once for
   * every built-in skill key (this registry is process-wide, shared across organizations, exactly
   * like the connector-contributed tools registered just below); per-turn availability is what
   * actually restricts which employee may call which skill (see the `available` set built from
   * SkillsRuntimeService.skillsForEmployee in execute()). Even if a tool name were somehow reachable
   * without being in `available`, SkillsRuntimeService.execute() independently re-verifies
   * installation, employee grant and tenant scope — an LLM can never invoke an uninstalled skill
   * merely by naming it.
   */
  private registerSkillTools() {
    const skillsRuntime = this.skillsRuntime;
    if (!skillsRuntime || !this.skillRegistry) return;
    for (const adapter of this.skillRegistry.all()) {
      const manifest = adapter.manifest;
      const toolName = `skill.${manifest.key}`;
      if (this.tools.has(toolName)) continue;
      this.tools.register({
        definition: {
          name: toolName,
          version: manifest.version,
          description: manifest.description.slice(0, 500),
          inputSchema: manifest.inputSchema,
          requiredPermissions: ["skill.execute"],
          timeoutMs: manifest.timeoutMs
        },
        execute: async (input, context: ToolExecutionContext) => {
          const result = await skillsRuntime.execute({
            skillKey: manifest.key,
            organizationId: context.organizationId,
            pluginInstallationId: context.pluginInstallationId,
            conversationId: context.conversationId,
            ...(context.userId ? { userId: context.userId } : {}),
            input
          });
          return result.data;
        }
      });
    }
  }

  /**
   * Stage 9B: Pending Workflow Runtime — Contact Capture.
   *
   * Returns a response when (and only when) this turn was handled by the Contact Capture workflow:
   * either resuming an active WAITING_FOR_INPUT workflow, or starting a new one because this turn
   * selected a callback/lead option. Returns null when the workflow runtime is unavailable or this turn
   * has nothing to do with it — the caller then proceeds with the normal classification/RAG/Skill
   * Runtime path exactly as before Stage 9B. Never throws: any failure here is caught, logged without
   * exposing contact data, and treated as "not handled" so the caller falls back to the safe generic
   * legacy path exactly once.
   */
  private async dispatchPendingWorkflowTurn(
    organizationId: string,
    actorUserId: string | null,
    pluginInstallationId: string,
    conversationId: string,
    text: string,
    requestId: string,
    persistedTravelEntities: ReturnType<typeof entitiesFromStoredState>,
    persistedTravelMemory: ReturnType<typeof memoryFromStoredState>,
    channelContact?: { senderPhoneNumber: string }
  ): Promise<{ response: string; model: string; bookingId?: string | null } | null> {
    if (!this.workflowCoordinator) return null;

    const scope = { organizationId, pluginInstallationId, conversationId };
    const dispatchSignals = this.buildWorkflowDispatchSignals(
      persistedTravelEntities,
      persistedTravelMemory,
      channelContact
    );

    try {
      const outcome = await this.workflowCoordinator.dispatchTurn(
        scope,
        text,
        requestId,
        dispatchSignals
      );
      if (!outcome.handled) return null;

      await this.reconcileLegacyStateAfterWorkflowLead(
        outcome,
        organizationId,
        actorUserId,
        pluginInstallationId,
        conversationId,
        persistedTravelEntities,
        persistedTravelMemory
      );
      this.logger.log({
        event: "PENDING_WORKFLOW_TURN_DISPATCHED",
        conversationId,
        workflowType: outcome.workflowType,
        decision: outcome.decision
      });
      return {
        response: outcome.responseText ?? "",
        model: "workflow-runtime-v1",
        bookingId: outcome.bookingId ?? null
      };
    } catch (error) {
      this.logger.error({
        event: "PENDING_WORKFLOW_TURN_FAILED",
        conversationId,
        error: error instanceof Error ? error.message : "unknown"
      });
      return null;
    }
  }

  /**
   * Stage 9E: builds the one `WorkflowDispatchSignals` bundle both `dispatchPendingWorkflowTurn` (the
   * pre-Travel-Runtime resume/free-text-start pass) and the post-Travel-Runtime BELOW_MINIMUM signal check
   * share — never duplicated business-field derivation between the two call sites.
   */
  private buildWorkflowDispatchSignals(
    entities: ReturnType<typeof entitiesFromStoredState>,
    memory: ReturnType<typeof memoryFromStoredState>,
    channelContact?: { senderPhoneNumber: string }
  ): WorkflowDispatchSignals {
    const passengers =
      entities.totalTravellers !== null
        ? String(entities.totalTravellers)
        : entities.adults !== null
          ? String(entities.adults)
          : null;
    const contactCaptureTripContext: ContactCaptureTripContext = {
      originCity: entities.originCity,
      destinationCity: entities.destinationCity,
      travelDates: entities.departureDate ?? entities.travelMonth,
      passengers,
      tripPurpose: entities.tripPurpose,
      budgetAmount: entities.budget,
      budgetCurrency: entities.budgetCurrency,
      displayCurrency: entities.budgetCurrency,
      journeyId: memory.journey?.id ?? null,
      customerName: entities.customerName
    };
    if (channelContact?.senderPhoneNumber) {
      contactCaptureTripContext.verifiedPhoneNumber = channelContact.senderPhoneNumber;
    }
    const bookingHandoffTripContext: BookingHandoffTripContext = {
      originCity: entities.originCity,
      destinationCity: entities.destinationCity,
      travelDates: entities.departureDate ?? entities.travelMonth,
      skillExecutionId: null,
      journeyId: memory.journey?.id ?? null,
      travellerCount: entities.adults ?? entities.totalTravellers ?? null,
      vegetarianPreference: entities.preferences.some((preference) =>
        preference.toUpperCase().includes("VEGETARIAN")
      )
    };
    const tripSubmissionTripContext: TripSubmissionTripContext = {
      entities,
      responseLanguage: memory.responseLanguage,
      travelDates: entities.departureDate ?? entities.travelMonth,
      passengers,
      tripPurpose: entities.tripPurpose,
      budgetAmount: entities.budget,
      budgetCurrency: entities.budgetCurrency,
      displayCurrency: entities.budgetCurrency,
      journeyId: memory.journey?.id ?? null,
      customerName: entities.customerName
    };
    return {
      contactCapture: {
        providerFailure: memory.providerFailure ?? null,
        completionStage: memory.completionStage ?? null
      },
      contactCaptureTripContext,
      bookingHandoffTripContext,
      tripSubmission: {
        legacyPendingInputAction: memory.pendingInputAction ?? null,
        legacyCompletionStage: memory.completionStage ?? null,
        itineraryPresented: memory.lastGeneratedItinerary !== null,
        hasActiveTripContext: entities.destinationCity !== null,
        tripState: entities,
        legacyPendingContactValue: memory.pendingContactValue ?? null,
        legacyPendingAction: memory.pendingAction ?? null
      },
      tripSubmissionTripContext
    };
  }

  /**
   * Stage 9D/9E: TRIP_SUBMISSION (whether started from free text, resumed, or started from Travel Runtime's
   * own BELOW_MINIMUM signal) creates the internal lead directly rather than through the tool-execution
   * pipeline — this bumps the legacy `travel.trip_state` memory (`/state` endpoint truthfulness) and
   * best-effort CRM-syncs the lead exactly once, regardless of which entry point captured it.
   */
  private async reconcileLegacyStateAfterWorkflowLead(
    outcome: Pick<WorkflowDispatchOutcome, "workflowType" | "leadCreated">,
    organizationId: string,
    actorUserId: string | null,
    pluginInstallationId: string,
    conversationId: string,
    persistedTravelEntities: ReturnType<typeof entitiesFromStoredState>,
    persistedTravelMemory: ReturnType<typeof memoryFromStoredState>
  ): Promise<void> {
    if (!outcome.leadCreated) return;
    this.syncLeadToCrmBestEffort(outcome.leadCreated, {
      organizationId,
      userId: null,
      pluginInstallationId,
      conversationId
    });
    // TRIP_SUBMISSION replaces the legacy confirm-and-submit flow, which used to bump the conversation's
    // own persisted `stage` to BOOKING_CONFIRMED as part of the same turn (see `deriveTravelState`) — the
    // `/travel-employee/.../state` endpoint (exposed for future CRM integration) still needs to reflect
    // that a request was submitted, even though the workflow's own state lives separately in
    // WorkflowExecution, not in this legacy memory blob.
    if (outcome.workflowType === "TRIP_SUBMISSION") {
      const updatedState = entitiesToStoredState(persistedTravelEntities, "BOOKING_CONFIRMED", {
        ...persistedTravelMemory,
        // Keep the legacy completion signal consistent regardless of which mechanism captured the lead —
        // this is also what prevents a later repeated/international-format phone number, or a second
        // BELOW_MINIMUM-budget turn, from starting a second TRIP_SUBMISSION (see
        // TripSubmissionWorkflowService.shouldStart).
        completionStage: "CAPTURED",
        capturedLeadReference: outcome.leadCreated.reference
      });
      await this.memories.save(organizationId, actorUserId, {
        pluginInstallationId,
        conversationId,
        scope: AgentMemoryScope.CONVERSATION,
        key: TRAVEL_TRIP_STATE_MEMORY_KEY,
        value: updatedState,
        searchableText: `BOOKING_CONFIRMED ${persistedTravelEntities.destinationCity ?? ""}`.trim()
      });
    }
  }

  /**
   * Resolve the runtime mode for this Travel Employee execution.
   * Defaults to SHADOW mode for safety.
   */
  private resolveRuntimeMode(
    organizationId: string,
    pluginInstallationId: string
  ): PlanTripRuntimeMode {
    // Resolve mode: check feature flag and tenant configuration
    const mode = resolvePlanTripRuntimeMode(organizationId, pluginInstallationId);

    // Default to SHADOW for safety; only run authoritative if explicitly enabled
    return isAuthoritativeModeEnabled(mode) ? "AUTHORITATIVE_INPUT_COLLECTION" : "SHADOW";
  }

  /**
   * Execute authoritative input collection when enabled.
   *
   * This is the Stage 8B integration point. When AUTHORITATIVE_INPUT_COLLECTION mode
   * is active, this processes the input and returns an InputDecision that controls
   * routing. On any error, returns null to trigger legacy fallback.
   */
  private async executeAuthoritativeInputCollection(
    organizationId: string,
    pluginInstallationId: string,
    conversationId: string,
    requestId: string,
    lastAssistantMessage: string | null,
    persistedTravelEntities: ReturnType<typeof entitiesFromStoredState>,
    persistedTravelMemory: ReturnType<typeof memoryFromStoredState>
  ) {
    // Bail out if the service isn't available
    if (!this.inputCollection) {
      this.logger.warn({
        event: "INPUT_COLLECTION_SERVICE_UNAVAILABLE",
        conversationId
      });
      return null;
    }

    try {
      // Create the current skill state from persisted Travel entities
      const currentState = PlanTripSkillExecutionMapper.fromTravelEntities(persistedTravelEntities);

      // Generate the authoritative input decision
      const result = await this.inputCollection.collectInput({
        organizationId,
        pluginInstallationId,
        conversationId,
        requestId,
        currentState,
        lastAssistantMessage,
        conversationLanguage: persistedTravelMemory.responseLanguage
      });

      return result;
    } catch (error) {
      this.logger.error({
        event: "AUTHORITATIVE_INPUT_COLLECTION_FAILED",
        conversationId,
        error: error instanceof Error ? error.message : "unknown error"
      });
      return null;
    }
  }

  private async travelEmployeeConfig(
    organizationId: string,
    pluginInstallationId: string
  ): Promise<TravelEmployeeRuntimeConfig> {
    const row = await this.prisma.travelEmployeeConfiguration.findFirst({
      where: { organizationId, pluginInstallationId }
    });
    if (!row) return DEFAULT_TRAVEL_EMPLOYEE_CONFIG;
    return {
      persona: row.persona || DEFAULT_TRAVEL_EMPLOYEE_CONFIG.persona,
      welcomeMessage: row.welcomeMessage || DEFAULT_TRAVEL_EMPLOYEE_CONFIG.welcomeMessage,
      escalationContact: row.escalationContact || DEFAULT_TRAVEL_EMPLOYEE_CONFIG.escalationContact,
      brandTone: row.brandTone || DEFAULT_TRAVEL_EMPLOYEE_CONFIG.brandTone,
      defaultCurrency: row.defaultCurrency || DEFAULT_TRAVEL_EMPLOYEE_CONFIG.defaultCurrency,
      defaultLanguage: row.defaultLanguage || DEFAULT_TRAVEL_EMPLOYEE_CONFIG.defaultLanguage,
      businessHoursStart: row.businessHoursStart,
      businessHoursEnd: row.businessHoursEnd,
      businessHoursTimezone: row.businessHoursTimezone
    };
  }
  private async employeeConfig(
    organizationId: string,
    pluginInstallationId: string,
    domain: EmployeeDomainDescriptor
  ): Promise<
    EmployeeRuntimeConfig & {
      apiEnabled?: boolean;
      apiEndpoint?: string | null;
      apiKey?: string | null;
      defaultCountry?: string;
    }
  > {
    const delegate = domain.configModel(this.prisma);
    const row = await delegate.findFirst({ where: { organizationId, pluginInstallationId } });
    const defaults = domain.defaults;
    if (!row) return defaults;
    return {
      persona: (row.persona as string | null) || defaults.persona,
      welcomeMessage: (row.welcomeMessage as string | null) || defaults.welcomeMessage,
      escalationContact: (row.escalationContact as string | null) || defaults.escalationContact,
      brandTone: (row.brandTone as string | null) || defaults.brandTone,
      defaultCurrency: (row.defaultCurrency as string | null) || defaults.defaultCurrency,
      defaultLanguage: (row.defaultLanguage as string | null) || defaults.defaultLanguage,
      businessHoursStart: (row.businessHoursStart as string | null) ?? null,
      businessHoursEnd: (row.businessHoursEnd as string | null) ?? null,
      businessHoursTimezone: (row.businessHoursTimezone as string | null) ?? null,
      apiEnabled: row.apiEnabled === true,
      apiEndpoint: (row.apiEndpoint as string | null) ?? null,
      apiKey: (row.apiKey as string | null) ?? null,
      defaultCountry: (row.defaultCountry as string | null) ?? defaults.defaultCountry ?? "India"
    };
  }
  private async loadEmployeeState(
    organizationId: string,
    pluginInstallationId: string,
    conversationId: string,
    domain: EmployeeDomainDescriptor
  ): Promise<Record<string, unknown> | null> {
    const memory = await this.prisma.agentMemory.findFirst({
      where: {
        organizationId,
        pluginInstallationId,
        conversationId,
        scope: AgentMemoryScope.CONVERSATION,
        key: domain.memoryKey,
        deletedAt: null
      }
    });
    return (memory?.value as Record<string, unknown> | undefined) ?? null;
  }
  /** Loads the extracted text of the given conversation attachments (if any) and builds a context block
   *  that is prepended to the user's message so the AI Employee can read the file contents. Attachments are
   *  tenant-scoped to the conversation — never trusted across conversations. */
  private async loadAttachmentContext(
    organizationId: string,
    conversationId: string,
    attachmentIds: string[] | undefined
  ): Promise<string | null> {
    if (!attachmentIds || attachmentIds.length === 0) return null;
    const rows = await this.prisma.conversationAttachment.findMany({
      where: { id: { in: attachmentIds }, organizationId, conversationId }
    });
    if (rows.length === 0) return null;
    return rows
      .map((row) => `[Attachment: ${row.originalFilename} (${row.mimeType})]\n${row.extractedText}`)
      .join("\n\n");
  }
  private async loadTravelState(
    organizationId: string,
    pluginInstallationId: string,
    conversationId: string
  ): Promise<Record<string, unknown> | null> {
    const memory = await this.prisma.agentMemory.findFirst({
      where: {
        organizationId,
        pluginInstallationId,
        conversationId,
        scope: AgentMemoryScope.CONVERSATION,
        key: TRAVEL_TRIP_STATE_MEMORY_KEY,
        deletedAt: null
      }
    });
    return (memory?.value as Record<string, unknown> | undefined) ?? null;
  }

  /**
   * LLM public-knowledge fallback: when a knowledge question has no confident answer in the employee's
   * uploaded knowledge (or none at all), and the employee has a real LLM provider configured, ask that
   * LLM to answer from its own public/general knowledge. This is what lets the Legal Employee (and every
   * other employee) answer public-domain questions — legal statutes, regulations, common procedures —
   * instead of only ever replying "I could not find this information in the uploaded knowledge." Returns
   * null when no real LLM provider is configured, so a deterministic-only employee keeps the old behavior.
   */
  private async answerFromLlmFallback(
    organizationId: string,
    pluginInstallationId: string,
    conversationId: string,
    plugin: { displayName: string; description: string },
    message: string,
    persona: string | null
  ): Promise<string | null> {
    let resolvedReal: { provider: AiProvider; settings: ProviderSettings } | null = null;
    try {
      resolvedReal = await this.pluginAi.resolveProvider(organizationId, pluginInstallationId);
    } catch (error) {
      if (!(error instanceof BadRequestException) || error.message !== "AI_PROVIDER_NOT_CONFIGURED")
        throw error;
    }
    if (!resolvedReal || resolvedReal.settings.providerType === "DETERMINISTIC") return null;
    try {
      const system = [
        persona || `You are the ${plugin.displayName}.`,
        "The organization's uploaded knowledge does not contain an answer to the user's question.",
        "Answer from your own general/public knowledge, clearly and helpfully.",
        "If the topic is genuinely outside any publicly available knowledge, say so honestly.",
        "Never invent specific organization policies, private facts, or figures that are not publicly verifiable."
      ].join(" ");
      const result = await withTimeout(
        resolvedReal.provider.complete({
          messages: [
            { role: "system", content: system },
            { role: "user", content: message }
          ],
          temperature: 0.3,
          maxOutputTokens: 700
        }),
        resolvedReal.settings.timeoutMs + 1_000,
        "MODEL_EXECUTION_TIMEOUT"
      );
      const content = result.content?.trim();
      return content ? content : null;
    } catch (error) {
      this.logger.warn({
        event: "KNOWLEDGE_LLM_FALLBACK_FAILED",
        conversationId,
        error: error instanceof Error ? error.message : "unknown"
      });
      return null;
    }
  }

  private async buildLeadStatusAnswer(
    organizationId: string,
    pluginInstallationId: string,
    conversationId: string,
    message: string
  ): Promise<string> {
    const state = await this.loadTravelState(organizationId, pluginInstallationId, conversationId);
    const journey =
      state?.journey && typeof state.journey === "object"
        ? (state.journey as { id?: unknown })
        : null;
    const lead = await this.travelLeadService.findCurrentLead({
      organizationId,
      pluginInstallationId,
      conversationId,
      journeyId: typeof journey?.id === "string" ? journey.id : null
    });
    if (lead) {
      const summary: string[] = [
        "Yes, your travel enquiry has been captured successfully.",
        "",
        `Reference: ${lead.reference}`
      ];
      if (lead.departureCity && lead.destination)
        summary.push(`Route: ${lead.departureCity} → ${lead.destination}`);
      if (lead.passengers) summary.push(`Travellers: ${lead.passengers}`);
      if (lead.travelDates) summary.push(`Travel date: ${lead.travelDates}`);
      summary.push("", "Our team can use this reference to follow up on your request.");
      return summary.join("\n");
    }

    const referenceQuery = /\breference|enquiry\s*id\b/i.test(message);
    const origin = typeof state?.originCity === "string" ? state.originCity : null;
    const destination =
      typeof state?.destinationCity === "string"
        ? state.destinationCity
        : typeof state?.destination === "string"
          ? state.destination
          : null;
    const month = typeof state?.travelMonth === "string" ? state.travelMonth : null;
    const adults = typeof state?.adults === "number" ? state.adults : null;
    const details: string[] = [];
    if (origin && destination) details.push(`• ${origin} → ${destination}`);
    if (month) details.push(`• ${month}`);
    if (adults !== null) details.push(`• ${adults} adult${adults === 1 ? "" : "s"}`);
    const heading = referenceQuery
      ? "No enquiry reference has been generated yet because the lead has not been submitted."
      : "Not yet. Your trip details are noted, but no travel enquiry has been submitted yet.";
    return [
      heading,
      ...(details.length ? ["", ...details] : []),
      "",
      "To create it, please share a mobile number or email address and confirm that I may use it for travel follow-up."
    ].join("\n");
  }
  private registerTravelTools() {
    const preferenceProperties = {
      origin: { type: ["string", "null"] },
      departureDate: { type: ["string", "null"] },
      returnDate: { type: ["string", "null"] },
      nights: { type: ["integer", "null"], minimum: 1, maximum: 60 },
      children: { type: ["integer", "null"], minimum: 0, maximum: 20 },
      infants: { type: ["integer", "null"], minimum: 0, maximum: 20 },
      hotelStars: { type: ["integer", "null"], minimum: 1, maximum: 5 },
      budget: { type: ["number", "null"], minimum: 0 },
      currency: { type: ["string", "null"], maxLength: 3 },
      cabinClass: { type: ["string", "null"], maxLength: 40 },
      preferences: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 20 }
    } as const;
    this.tools.register({
      definition: {
        name: "travel.search_flights",
        version: "1.0.0",
        description: "Search placeholder flight options for a destination",
        requiredPermissions: ["agents.tools.execute"],
        timeoutMs: 3000,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["destination"],
          properties: {
            destination: { type: "string", minLength: 1, maxLength: 160 },
            travelMonth: { type: ["string", "null"] },
            durationDays: { type: ["integer", "null"], minimum: 1, maximum: 60 },
            passengers: { type: ["integer", "null"], minimum: 1, maximum: 20 },
            adults: { type: ["integer", "null"], minimum: 1, maximum: 20 },
            ...preferenceProperties
          }
        }
      },
      execute: async (input) =>
        generatePlaceholderFlights({
          destination:
            typeof input.destination === "string" ? input.destination : "your destination",
          travelMonth: typeof input.travelMonth === "string" ? input.travelMonth : null,
          passengers:
            typeof input.adults === "number"
              ? input.adults
              : typeof input.passengers === "number"
                ? input.passengers
                : null
        })
    });
    this.tools.register({
      definition: {
        name: "travel.search_hotels",
        version: "1.0.0",
        description: "Search placeholder hotel options for a destination",
        requiredPermissions: ["agents.tools.execute"],
        timeoutMs: 3000,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["destination"],
          properties: {
            destination: { type: "string", minLength: 1, maxLength: 160 },
            travelMonth: { type: ["string", "null"] },
            ...preferenceProperties
          }
        }
      },
      execute: async (input) =>
        generatePlaceholderHotels({
          destination:
            typeof input.destination === "string" ? input.destination : "your destination",
          travelMonth: typeof input.travelMonth === "string" ? input.travelMonth : null,
          hotelStars: typeof input.hotelStars === "number" ? input.hotelStars : null
        })
    });
    this.tools.register({
      definition: {
        name: "travel.escalate",
        version: "1.0.0",
        description: "Escalate the conversation to a human team member",
        requiredPermissions: ["agents.tools.execute"],
        timeoutMs: 3000,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { reason: { type: "string", maxLength: 500 } }
        }
      },
      execute: async (input, context) => {
        const config = await this.travelEmployeeConfig(
          context.organizationId,
          context.pluginInstallationId
        );
        return {
          escalated: true,
          contact: config.escalationContact,
          reason: typeof input.reason === "string" ? input.reason : null
        };
      }
    });
    // Conversation Completion & Lead Capture: the always-on, connector-independent capture path (see
    // apps/api/src/conversation/conversation-completion.ts and TravelLead in schema.prisma) — distinct
    // from the optional CRM-connector-backed crm.create_lead tool, which stays org-configured.
    this.tools.register({
      definition: {
        name: "travel.create_lead",
        version: "1.0.0",
        description:
          "Persist a travel lead after the traveler has consented and given a phone number",
        requiredPermissions: ["agents.tools.execute"],
        timeoutMs: 3000,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["phoneNumber", "conversationSummary"],
          properties: {
            reference: { type: ["string", "null"], maxLength: 20 },
            journeyId: { type: ["string", "null"], maxLength: 64 },
            customerName: { type: ["string", "null"], maxLength: 160 },
            phoneNumber: { type: "string", minLength: 1, maxLength: 24 },
            email: { type: ["string", "null"], maxLength: 160 },
            departureCity: { type: ["string", "null"], maxLength: 160 },
            destination: { type: ["string", "null"], maxLength: 160 },
            travelDates: { type: ["string", "null"], maxLength: 160 },
            passengers: { type: ["string", "null"], maxLength: 80 },
            tripPurpose: { type: ["string", "null"], maxLength: 120 },
            budgetAmount: { type: ["number", "null"] },
            budgetCurrency: { type: ["string", "null"], maxLength: 8 },
            displayCurrency: { type: ["string", "null"], maxLength: 8 },
            conversationSummary: { type: "string", minLength: 1, maxLength: 2000 }
          }
        },
        sensitiveInputPaths: ["phoneNumber", "email"]
      },
      // Single, always-on internal persistence path for every lead-capture entry point (the LLM
      // orchestrator, the deterministic no-LLM fallback, below-minimum handoff, callback/submit-enquiry,
      // escalation) — see `TravelLeadService.createInternalLead`. CRM availability never determines
      // whether this succeeds: the internal row is always created (or idempotently reused) FIRST, and the
      // best-effort CRM mirror only ever runs afterward, never blocking or rolling this back.
      execute: async (input, context) => {
        const lead = await this.travelLeadService.createInternalLead({
          organizationId: context.organizationId,
          pluginInstallationId: context.pluginInstallationId,
          conversationId: context.conversationId,
          journeyId: typeof input.journeyId === "string" ? input.journeyId : null,
          customerName: typeof input.customerName === "string" ? input.customerName : null,
          phoneNumber: String(input.phoneNumber),
          email: typeof input.email === "string" ? input.email : null,
          departureCity: typeof input.departureCity === "string" ? input.departureCity : null,
          destination: typeof input.destination === "string" ? input.destination : null,
          travelDates: typeof input.travelDates === "string" ? input.travelDates : null,
          passengers: typeof input.passengers === "string" ? input.passengers : null,
          tripPurpose: typeof input.tripPurpose === "string" ? input.tripPurpose : null,
          budgetAmount: typeof input.budgetAmount === "number" ? input.budgetAmount : null,
          budgetCurrency: typeof input.budgetCurrency === "string" ? input.budgetCurrency : null,
          displayCurrency: typeof input.displayCurrency === "string" ? input.displayCurrency : null,
          conversationSummary: String(input.conversationSummary),
          reference: typeof input.reference === "string" ? input.reference : null
        });
        this.syncLeadToCrmBestEffort(lead, context);
        return { leadId: lead.id, reference: lead.reference };
      }
    });
    // Always-on "resend my ticket" path — a returning customer, possibly in a brand-new conversation,
    // identifying an already-ticketed booking by the email they booked with (and, optionally, the travel
    // date to disambiguate multiple bookings on the same email). See TravelBookingService.
    // findBookingForResend/resendTicket and DeliveryRecorderService.recordTicketDelivery for the actual
    // lookup/regenerate-and-resend logic — this tool is a thin, honest pass-through: `found` is only ever
    // true when a real booking matched, and the per-channel status is only ever what actually happened.
    this.tools.register({
      definition: {
        name: "travel.resend_ticket",
        version: "1.0.0",
        description:
          "Look up an already-ticketed booking by email (and optionally travel date) and resend the ticket by email/WhatsApp",
        requiredPermissions: ["agents.tools.execute"],
        timeoutMs: 15000,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["email"],
          properties: {
            email: { type: "string", minLength: 3, maxLength: 320 },
            travelDate: { type: ["string", "null"], maxLength: 32 },
            customerName: { type: ["string", "null"], maxLength: 160 }
          }
        },
        sensitiveInputPaths: ["email"]
      },
      execute: async (input, context) => {
        if (!this.travelBookingService) return { resendResult: true, found: false };
        const booking = await this.travelBookingService.findBookingForResend(
          context.organizationId,
          {
            email: String(input.email),
            travelDate: typeof input.travelDate === "string" ? input.travelDate : null
          }
        );
        if (!booking) return { resendResult: true, found: false };
        const delivery = await this.travelBookingService.resendTicket(
          booking.id,
          context.organizationId
        );
        return {
          resendResult: true,
          found: true,
          pnr: booking.providerPnr,
          emailStatus: delivery.email?.status ?? null,
          whatsappStatus: delivery.whatsapp?.status ?? null
        };
      }
    });
  }

  /**
   * Registers the two tools every non-Travel domain employee exposes: `{slug}.create_{artifact}` (the
   * always-on internal persistence path, mirroring `travel.create_lead`) and `{slug}.escalate`. Both are
   * thin pass-throughs into the shared employee engine + artifact service — honest facts only: `reference`
   * is only set when a real artifact row was created, and `escalated` only ever reflects an actual lookup.
   */
  private registerEmployeeTools() {
    for (const domain of EMPLOYEE_DOMAIN_REGISTRY) {
      this.tools.register({
        definition: {
          name: domain.artifactToolName,
          version: "1.0.0",
          description: `Persist a ${domain.artifactNoun} after the requester consents and shares a contact number`,
          requiredPermissions: ["agents.tools.execute"],
          timeoutMs: 3000,
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["phoneNumber", "conversationSummary"],
            properties: {
              reference: { type: ["string", "null"], maxLength: 20 },
              customerName: { type: ["string", "null"], maxLength: 160 },
              phoneNumber: { type: "string", minLength: 1, maxLength: 24 },
              email: { type: ["string", "null"], maxLength: 160 },
              conversationSummary: { type: "string", minLength: 1, maxLength: 2000 },
              ...Object.fromEntries(
                domain.artifactFieldKeys.map((key) => [
                  key,
                  { type: ["string", "null"], maxLength: 500 }
                ])
              )
            }
          },
          sensitiveInputPaths: ["phoneNumber", "email"]
        },
        execute: async (input, context) => {
          if (!this.employeeArtifacts) return { artifactId: null, reference: null };
          const delegate = domain.artifactDelegate(this.prisma);
          const artifact = await this.employeeArtifacts.createInternal(
            delegate,
            domain.nameField,
            domain.referencePrefix,
            {
              organizationId: context.organizationId,
              pluginInstallationId: context.pluginInstallationId,
              conversationId: context.conversationId,
              customerName: typeof input.customerName === "string" ? input.customerName : null,
              phoneNumber: String(input.phoneNumber),
              email: typeof input.email === "string" ? input.email : null,
              conversationSummary: String(input.conversationSummary),
              reference: typeof input.reference === "string" ? input.reference : null,
              fields: domain.mapFields(input)
            }
          );
          return { artifactId: artifact.id, reference: artifact.reference };
        }
      });
      this.tools.register({
        definition: {
          name: domain.escalateToolName,
          version: "1.0.0",
          description: `Escalate the conversation to a human ${domain.artifactNoun} team member`,
          requiredPermissions: ["agents.tools.execute"],
          timeoutMs: 3000,
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: { reason: { type: "string", maxLength: 500 } }
          }
        },
        execute: async (input, context) => {
          const config = await this.employeeConfig(
            context.organizationId,
            context.pluginInstallationId,
            domain
          );
          return {
            escalated: true,
            contact: config.escalationContact,
            reason: typeof input.reason === "string" ? input.reason : null
          };
        }
      });
    }
    // Legal Employee — "generate a PDF" capability: persists the drafted legal document and returns a
    // download URL so the chat can offer a downloadable, well-formatted PDF of the notice/reply.
    this.tools.register({
      definition: {
        name: "legal.create_pdf",
        version: "1.0.0",
        description:
          "Generate a downloadable, well-formatted PDF of a drafted legal document (notice, reply, case summary)",
        requiredPermissions: ["agents.tools.execute"],
        timeoutMs: 8000,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["title", "content"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 255 },
            content: { type: "string", minLength: 1 },
            conversationId: { type: "string", minLength: 1, maxLength: 64 }
          }
        }
      },
      execute: async (input, context) => {
        const title = String(input.title).slice(0, 255);
        const content = String(input.content);
        const row = await this.prisma.legalDocument.create({
          data: {
            organizationId: context.organizationId,
            pluginInstallationId: context.pluginInstallationId,
            conversationId: context.conversationId,
            createdByUserId: context.userId ?? null,
            title,
            content
          }
        });
        return {
          documentId: row.id,
          downloadUrl: `/api/v1/legal-employee/documents/${row.id}/pdf`,
          title
        };
      }
    });
  }

  /**
   * Optional, best-effort, fire-and-forget mirror of a just-captured {@link TravelLead} into an external
   * CRM connector, if one happens to be installed for this organization — never awaited by the caller, and
   * any failure (no connector configured, connector error, whatever) is swallowed here. The `TravelLead`
   * row is always the source of truth regardless of whether this succeeds; the conversation itself never
   * depends on, waits for, or even knows the outcome of this sync.
   */
  private syncLeadToCrmBestEffort(
    lead: {
      id: string;
      reference: string;
      customerName: string | null;
      phoneNumber: string;
      destination: string | null;
      conversationSummary: string;
    },
    context: ToolExecutionContext
  ): void {
    void (async () => {
      try {
        const plugin = await this.prisma.plugin.findUnique({
          where: { id: context.pluginInstallationId }
        });
        const grants = new Set(
          Array.isArray(plugin?.grantedPermissions)
            ? plugin.grantedPermissions.filter((x): x is string => typeof x === "string")
            : []
        );
        const crmToolName = (
          await this.connectors.availableToolNames(context.organizationId, grants)
        ).find((name) => name.endsWith("crm.create_lead"));
        if (!crmToolName) {
          await this.travelLeadService.markCrmSyncStatus(lead.id, TravelLeadCrmSyncStatus.SKIPPED);
          return;
        }
        const [firstName, ...rest] = lead.customerName?.split(" ").filter(Boolean) ?? [];
        const lastName = rest.join(" ");
        // Sprint 4.7A Phase 2: this fire-and-forget sync runs detached from any awaited caller, but it is
        // still invoked synchronously from within the request's own AsyncLocalStorage continuation (see
        // TraceContextStore), so the ambient span is still available here without a parameter to thread it.
        const ambientContext = this.traceContextStore?.get();
        const [crmConnector, ...crmCapabilityParts] = crmToolName.split(".");
        const crmToolSpan =
          ambientContext && this.observability
            ? await this.observability.startSpan(ambientContext, {
                name: `TOOL_CALL:${crmToolName}`,
                spanType: "TOOL_CALL",
                component: "ToolExecutor",
                inputSummary: {
                  tool: crmToolName,
                  connector: crmConnector,
                  capability: crmCapabilityParts.join(".") || crmToolName
                }
              })
            : undefined;
        const crmToolStarted = Date.now();
        try {
          await this.executor.execute(
            crmToolName,
            {
              ...(firstName ? { firstName } : {}),
              ...(lastName ? { lastName } : {}),
              phone: lead.phoneNumber,
              source: "TravelEmployee",
              interest: lead.destination ? `${lead.destination} trip` : "Travel enquiry",
              notes: lead.conversationSummary,
              metadata: { travelLeadId: lead.id, travelLeadReference: lead.reference }
            },
            context,
            new Set([crmToolName]),
            new Set(["agents.tools.execute"])
          );
          if (crmToolSpan)
            await this.observability?.completeSpan(crmToolSpan, crmToolStarted, {
              attributes: {
                tool: crmToolName,
                connector: crmConnector,
                capability: crmCapabilityParts.join(".") || crmToolName,
                status: "COMPLETED",
                retryCount: 0,
                approvalRequired: false
              }
            });
        } catch (toolError) {
          if (crmToolSpan && this.observability)
            await this.observability.failSpan(
              crmToolSpan,
              {
                name: `TOOL_CALL:${crmToolName}`,
                spanType: "TOOL_CALL",
                component: "ToolExecutor"
              },
              crmToolStarted,
              toolError
            );
          throw toolError;
        }
        await this.travelLeadService.markCrmSyncStatus(lead.id, TravelLeadCrmSyncStatus.SYNCED);
      } catch (error) {
        // Best-effort only — see the doc comment above. Logged (never surfaced to the customer) so a
        // misconfigured or failing connector is still visible to operators.
        this.logger.warn({
          event: "TRAVEL_LEAD_CRM_SYNC_FAILED",
          leadId: lead.id,
          error: String(error)
        });
        await this.travelLeadService.markCrmSyncStatus(lead.id, TravelLeadCrmSyncStatus.FAILED);
      }
    })();
  }
}

function toModelMessage(row: { role: ConversationMessageRole; content: string }): ModelMessage {
  return { role: row.role.toLowerCase() as ModelMessage["role"], content: row.content };
}
function title(message: string) {
  return message.trim().replace(/\s+/g, " ").slice(0, 80) || "New conversation";
}
function safeCode(error: unknown) {
  return error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : "AGENT_EXECUTION_FAILED";
}
function providerName(settings: ProviderSettings): string {
  if (settings.providerType === "OPENAI_COMPATIBLE") return "openai-compatible";
  if (settings.providerType === "AZURE_OPENAI") return "azure-openai";
  return "deterministic";
}
function providerModel(settings: ProviderSettings): string {
  if (settings.providerType === "AZURE_OPENAI") return settings.deploymentName ?? "unconfigured";
  if (settings.providerType === "OPENAI_COMPATIBLE") return settings.model ?? "unconfigured";
  return "travel-test-v1";
}
function providerExecutionMessage(code: AiProviderError["code"]): string {
  const messages: Record<AiProviderError["code"], string> = {
    AI_PROVIDER_AUTHENTICATION_FAILED: "The AI provider rejected the configured credentials.",
    AI_PROVIDER_MODEL_NOT_FOUND: "The configured AI model or deployment was not found.",
    AI_PROVIDER_QUOTA_EXCEEDED: "The AI provider quota has been exceeded.",
    AI_PROVIDER_UNAVAILABLE: "The AI provider is currently unavailable.",
    AI_PROVIDER_TEST_FAILED: "The AI provider request failed.",
    AI_PROVIDER_RESPONSE_INVALID: "The AI provider returned an invalid response."
  };
  return messages[code];
}
/**
 * Decides whether this turn should be answered entirely from retrieved knowledge (see "GROUNDING" in
 * docs/enterprise-knowledge.md) rather than handed to the employee's normal conversational/task flow.
 * Returns the rendered answer, or null to proceed with the employee's normal behavior unchanged. Only
 * ever called when `classifyRequestIntent` (see `request-classifier.ts`) has already classified this
 * turn as KNOWLEDGE_QUERY — see `isKnowledgeEligible` and the call site in `execute()` — so a
 * TRAVEL_PLANNING/TASK_EXECUTION/SLOT_UPDATE/CORRECTION/CONFIRMATION turn can never be answered (or
 * blocked) by this at all, regardless of what knowledge search returned.
 *
 * - Qualifying sources exist -> always render the deterministic Answer/Supporting policy/Source/
 *   Confidence template from them (never blended with a free-form model reply). This is intentionally
 *   unconditional: employee-scoped retrieval (see KnowledgeSearchService.search) already guarantees
 *   these sources belong to this employee, so any qualifying hit is authoritative.
 * - No sources, but the turn explicitly names another employee's domain (leave policy, payroll,
 *   invoicing, ...) -> the explicit "not available" message, so e.g. a Travel Employee asked an HR
 *   question never silently drifts into unrelated conversation or a task flow that was never meant to
 *   answer it (see "KNOWLEDGE FILTERING" / UAT: Travel Employee asked leave policy).
 * - Otherwise -> null; this employee's existing behavior (trip planning, tool use, free chat,
 *   general-knowledge questions its configured provider can answer) applies unchanged.
 */
function knowledgeGroundedAnswer(sources: KnowledgeSource[], text: string): string | null {
  if (sources.length) return buildKnowledgeAnswer(sources, text);
  if (namesOtherEmployeeDomain(text)) return NO_KNOWLEDGE_MESSAGE;
  return null;
}

/** Derives a concise, filename-safe title for a generated legal PDF from the user's request or the first
 *  heading line of the drafted content. */
function legalDocumentTitle(requestText: string, content: string): string {
  const fromHeading = content.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
  const fromRequest = requestText.match(/notice|reply|draft|case|verdict|petition|summary/i)?.[0];
  const base =
    fromHeading ??
    (fromRequest
      ? `${fromRequest.charAt(0).toUpperCase()}${fromRequest.slice(1)}`
      : "Legal Document");
  return sanitizeLegalTitle(base);
}

function sanitizeLegalTitle(value: string): string {
  return (
    value
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 80) || "Legal-Document"
  );
}
function sourceMetadata(source: KnowledgeSource) {
  return {
    documentId: source.documentId,
    collectionId: source.collectionId,
    title: source.title,
    pageNumber: source.pageNumber,
    heading: source.heading,
    sectionTitle: source.sectionTitle,
    isTable: source.isTable,
    chunkIndex: source.chunkIndex,
    score: Number(source.score.toFixed(4))
  };
}
function paged<T>(items: T[], total: number, page: PageDto) {
  return {
    items,
    pagination: {
      page: page.page,
      pageSize: page.pageSize,
      total,
      pages: Math.ceil(total / page.pageSize)
    }
  };
}

function createDefaultSkillRuntime(): SkillRuntimeService {
  const registry = new SkillRegistry();
  registry.register(new PlanTripSkillHandler());
  return new SkillRuntimeService(registry);
}
