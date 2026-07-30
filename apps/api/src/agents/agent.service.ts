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
import {
  AgentExecutionStatus,
  AgentMemoryScope,
  AgentToolExecutionStatus,
  ConversationMessageRole,
  ConversationStatus,
  PluginStatus,
  Prisma,
  TravelLeadCrmSyncStatus
} from "@prisma/client";
import type { AiProvider } from "@ai-workforce-os/plugin-sdk";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
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
import { SkillRegistry } from "../skills/skill-registry";
import { SkillRuntimeService } from "../skills/skill-runtime.service";
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
import type { WorkflowDispatchOutcome, WorkflowDispatchSignals } from "../workflows/workflow-runtime.contracts";
import type { WorkflowSignal } from "../workflows/workflow-signal.contracts";

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
    @Optional() workflowCoordinator?: WorkflowCoordinator
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
    for (const handler of this.connectors.toolHandlers()) this.tools.register(handler);
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
      ...(dto.metadata ? { metadata: dto.metadata } : {})
    });
  }
  /**
   * Shared execution path for every caller (dashboard chat, channel adapters). The actor
   * determines conversation ownership and tool permissions; everything else is identical.
   */
  async execute(input: AgentExecutionInput) {
    const { organizationId } = input;
    const actorUserId = input.actor.type === "USER" ? input.actor.userId : null;
    const plugin = await this.prisma.plugin.findFirst({
      where: { id: input.agentId, organizationId, deletedAt: null }
    });
    if (!plugin) throw new NotFoundException("PLUGIN_INSTALLATION_NOT_FOUND");
    if (plugin.status !== PluginStatus.ACTIVE) throw new ConflictException("PLUGIN_DISABLED");
    const isTravelEmployee = plugin.slug === TRAVEL_EMPLOYEE_PLUGIN_SLUG;
    const travelConfig = isTravelEmployee
      ? await this.travelEmployeeConfig(organizationId, plugin.id)
      : null;
    let provider!: AiProvider;
    let settings!: ProviderSettings;
    if (!travelConfig)
      ({ provider, settings } = await this.pluginAi.resolveProvider(organizationId, plugin.id));
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
    let travelOrchestrator: TravelEmployeeLlmOrchestrator | null = null;
    let deterministicTravelProvider: TravelEmployeeProvider | null = null;
    const persistedTravelState = travelConfig
      ? await this.loadTravelState(organizationId, plugin.id, conversation.id)
      : null;
    // Cache parsed state once to avoid duplicate parsing in orchestrator setup and workfLow dispatch
    const parsedEntities = entitiesFromStoredState(persistedTravelState);
    const parsedMemory = memoryFromStoredState(persistedTravelState);
    if (travelConfig) {
      let resolvedReal: { provider: AiProvider; settings: ProviderSettings } | null = null;
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
          resolvedReal.provider, travelConfig,
          parsedEntities, parsedMemory,
          "PLATFORM_MANAGED"
        );
        provider = travelOrchestrator;
        settings = resolvedReal.settings;
      } else {
        deterministicTravelProvider = new TravelEmployeeProvider(
          travelConfig, parsedMemory, parsedEntities,
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
    const usingDeterministicTravel = Boolean(travelConfig) && !travelOrchestrator;
    const configuredModel = usingDeterministicTravel
      ? "travel-employee-v1"
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
    if (!input.text.trim() && historyRows.length === 0 && travelConfig) {
      const greetStarted = Date.now();
      const assistant = await this.prisma.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          organizationId,
          role: ConversationMessageRole.ASSISTANT,
          content: travelConfig.welcomeMessage,
          model: "greeting-v1",
          inputTokens: 0,
          outputTokens: estimateTokens(travelConfig.welcomeMessage)
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
          outputTokens: estimateTokens(travelConfig.welcomeMessage),
          totalTokens: estimateTokens(travelConfig.welcomeMessage)
        }
      });
      // Persist onboarding state immediately: the traveler's very next reply is answering "may I know your
      // name?" (COLLECT_NAME), not a trip-detail question — without this, a state read before the first
      // reply (e.g. the dashboard's context-aware placeholder) would see no stage at all.
      await this.memories.save(organizationId, actorUserId, {
        pluginInstallationId: plugin.id,
        conversationId: conversation.id,
        scope: AgentMemoryScope.CONVERSATION,
        key: TRAVEL_TRIP_STATE_MEMORY_KEY,
        value: entitiesToStoredState(EMPTY_TRAVEL_ENTITIES, "COLLECT_NAME") as unknown as Record<
          string,
          unknown
        >,
        searchableText: "COLLECT_NAME"
      });
      return {
        conversationId: conversation.id,
        executionId: execution.id,
        messageId: assistant.id,
        response: travelConfig.welcomeMessage,
        status: "COMPLETED" as const,
        model: "greeting-v1",
        usage: {
          inputTokens: 0,
          outputTokens: estimateTokens(travelConfig.welcomeMessage),
          totalTokens: estimateTokens(travelConfig.welcomeMessage),
          estimatedCost: null
        },
        sources: []
      };
    }
    await this.prisma.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        organizationId,
        role: ConversationMessageRole.USER,
        content: input.text
      }
    });
    const execution = await this.prisma.agentExecution.create({
      data: {
        organizationId,
        conversationId: conversation.id,
        pluginInstallationId: plugin.id,
        userId: actorUserId,
        status: AgentExecutionStatus.RUNNING,
        modelProvider: usingDeterministicTravel ? "travel-employee" : providerName(settings),
        model: configuredModel,
        requestId: input.requestId,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        startedAt: new Date()
      }
    });
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
          pluginInstallationId: plugin.id, query: "preference", limit: 10
        })
      ]);
      for (const name of toolNames) available.add(name);
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
          input.text,
          input.requestId,
          persistedTravelEntities,
          persistedTravelMemory,
          input.channelContact
        );
        if (workflowResponse) {
          failureStage = "persistence";
          const assistant = await this.prisma.conversationMessage.create({
            data: {
              conversationId: conversation.id,
              organizationId,
              role: ConversationMessageRole.ASSISTANT,
              content: workflowResponse.response,
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
            sources: []
          };
        }
      }

      // Domain/state turns are classified before retrieval. Knowledge search is not merely ignored for
      // these turns; it is never invoked, preventing travel slots/corrections from falling into RAG.
      const requestIntent = classifyRequestIntent(input.text, { isTravelEmployee });

      // Stage 8B: Authoritative input collection
      // When AUTHORITATIVE_INPUT_COLLECTION mode is enabled, Skill Runtime decides what happens next
      // instead of the legacy Travel Runtime.
      let authoritativeDecision = null as Awaited<ReturnType<typeof this.executeAuthoritativeInputCollection>> | null;
      let runtimeMode: PlanTripRuntimeMode = "SHADOW";

      if (isTravelEmployee && travelConfig && (requestIntent === "TRAVEL_PLANNING" || requestIntent === "SLOT_UPDATE" || requestIntent === "CORRECTION")) {
        runtimeMode = this.resolveRuntimeMode(organizationId, plugin.id);

        if (runtimeMode === "AUTHORITATIVE_INPUT_COLLECTION" && this.inputCollection) {
          const lastAssistantMessage = [...historyRows]
            .reverse()
            .find((message) => message.role === "ASSISTANT")?.content ?? null;

          authoritativeDecision = await this.executeAuthoritativeInputCollection(
            organizationId,
            plugin.id,
            conversation.id,
            input.requestId,
            lastAssistantMessage,
            persistedTravelEntities,
            persistedTravelMemory
          );

          if (authoritativeDecision && !TravelDecisionAdapter.shouldFallback(
            TravelDecisionAdapter.route(authoritativeDecision.decision)
          )) {
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
        ? arbitrateConversationTurn(input.text, turnContext)
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
        ? resolveTravelInput(input.text, turnContext)
        : null;
      const leadStatusAnswer =
        requestIntent === "LEAD_STATUS_QUERY"
          ? await this.buildLeadStatusAnswer(organizationId, plugin.id, conversation.id, input.text)
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
            ? await this.knowledge.search(organizationId, plugin.id, { query: input.text })
            : [];
      const knowledgePrompt = buildKnowledgeBlock(knowledgeSources);
      let request = this.prompt.build({
        pluginPrompt: plugin.description,
        memories: recentMemories.map((x) => `${x.key}: ${x.searchableText ?? "configured"}`),
        ...(knowledgePrompt ? { retrievedKnowledge: knowledgePrompt } : {}),
        history: historyRows.map(toModelMessage),
        message: input.text,
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
      const knowledgeAnswer = isKnowledgeEligible(requestIntent)
        ? knowledgeGroundedAnswer(knowledgeSources, input.text)
        : null;

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
        !TravelDecisionAdapter.shouldFallback(TravelDecisionAdapter.route(authoritativeDecision.decision))
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

            if (executionDecision.capability === "BOOKING" && executionDecision.executionStatus === "DEFERRED") {
              bookingWorkflowPendingText = route.explanation;
              // Stage 9C: BOOKING_HANDOFF — a typed workflow-start request from the capability decision
              // itself (never from parsing this text). Preserves any already-active workflow instead of
              // overwriting it (startBookingHandoff returns null on conflict), in which case the plain
              // explanation above remains the response, unchanged from Stage 9A/9B behavior.
              if (this.workflowCoordinator) {
                const bookingOutcome = await this.workflowCoordinator.startBookingHandoff(
                  { organizationId, pluginInstallationId: plugin.id, conversationId: conversation.id },
                  input.requestId,
                  {
                    originCity: persistedTravelEntities.originCity,
                    destinationCity: persistedTravelEntities.destinationCity,
                    travelDates: persistedTravelEntities.departureDate ?? persistedTravelEntities.travelMonth,
                    skillExecutionId: authoritativeDecision.loadedExecution?.id ?? null,
                    journeyId: persistedTravelMemory.journey?.id ?? null
                  }
                );
                if (bookingOutcome?.responseText) bookingWorkflowPendingText = bookingOutcome.responseText;
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
        responseProvider = usingDeterministicTravel ? "travel-employee" : providerName(settings);
      if (
        leadStatusAnswer !== null ||
        knowledgeAnswer !== null ||
        authoritativeQuestionText !== null ||
        bookingWorkflowPendingText !== null
      ) {
        finalText =
          leadStatusAnswer ?? knowledgeAnswer ?? authoritativeQuestionText ?? bookingWorkflowPendingText ?? "";
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
          query: input.text,
          requestIntent,
          promptLength: request.messages.map((m) => m.content).join("\n").length,
          promptTokens: estimateTokens(request.messages.map((m) => m.content).join(" ")),
          finalPromptPreview: request.messages.at(-1)?.content.slice(0, 500) ?? "",
          groundedFromKnowledge: knowledgeAnswer !== null,
          ...(knowledgeAnswer !== null ? { llmResponse: knowledgeAnswer } : {})
        });
      let travelToolRecoveryText: string | null = null;
      let travelToolCallsAttempted = 0;
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
        const response = await withTimeout(
          provider.complete({
            messages: request.messages,
            tools: request.tools.map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema
            })),
            maxOutputTokens: 1000
          }),
          settings.timeoutMs + 1_000,
          "MODEL_EXECUTION_TIMEOUT"
        );
        inputTokens += response.usage?.inputTokens ?? 0;
        outputTokens += response.usage?.outputTokens ?? 0;
        responseModel = response.model;
        responseProvider = response.provider;
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
            const isCrmLeadTool = call.name === "travel.create_lead" || call.name.endsWith("crm.create_lead");
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
      if (!finalText) throw new Error("AGENT_ITERATION_LIMIT_EXCEEDED");
      if (
        leadStatusAnswer === null &&
        knowledgeAnswer === null &&
        this.security.knowledge.retrievalDebugLogging
      )
        this.logger.log({
          event: "AGENT_PROMPT_DEBUG",
          organizationId,
          conversationId: conversation.id,
          query: input.text,
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
                { role: "user" as const, content: input.text },
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
                  { role: "user" as const, content: input.text },
                  { role: "assistant" as const, content: finalText }
                ],
                travelConfig.defaultCurrency
              );
              return deterministicTravelProvider
                ? entitiesToStoredState(
                    entitiesFromStoredState(derived as unknown as Record<string, unknown>),
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
          travelOrchestrator?.lastWorkflowSignal ?? deterministicTravelProvider?.lastWorkflowSignal ?? null;
        if (workflowSignalDraft && this.workflowCoordinator) {
          try {
            const freshEntities = entitiesFromStoredState(state as unknown as Record<string, unknown>);
            const freshMemory = memoryFromStoredState(state as unknown as Record<string, unknown>);
            const signal: WorkflowSignal = {
              signalType: workflowSignalDraft.signalType,
              workflowType: "TRIP_SUBMISSION",
              source: "BELOW_MINIMUM_BUDGET_FEASIBILITY",
              sourceTurnId: input.requestId,
              sourceSkillExecutionId: null,
              payload: { trigger: workflowSignalDraft.trigger },
              confidence: 1
            };
            const signalOutcome = await this.workflowCoordinator.dispatchSignal(
              { organizationId, pluginInstallationId: plugin.id, conversationId: conversation.id },
              signal,
              input.requestId,
              this.buildWorkflowDispatchSignals(freshEntities, freshMemory),
              input.text
            );
            if (signalOutcome)
              await this.reconcileLegacyStateAfterWorkflowLead(
                signalOutcome,
                organizationId,
                actorUserId,
                plugin.id,
                conversation.id,
                freshEntities,
                freshMemory
              );
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
      return {
        conversationId: conversation.id,
        executionId: execution.id,
        messageId: assistant.id,
        response: finalText,
        status: "COMPLETED" as const,
        model: responseModel,
        usage: { inputTokens, outputTokens, totalTokens, estimatedCost: null },
        sources: knowledgeSources.map(sourceMetadata)
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
      where: { organizationId, status: PluginStatus.ACTIVE, deletedAt: null },
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
  ): Promise<{ response: string; model: string } | null> {
    if (!this.workflowCoordinator) return null;

    const scope = { organizationId, pluginInstallationId, conversationId };
    const dispatchSignals = this.buildWorkflowDispatchSignals(persistedTravelEntities, persistedTravelMemory, channelContact);

    try {
      const outcome = await this.workflowCoordinator.dispatchTurn(scope, text, requestId, dispatchSignals);
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
      return { response: outcome.responseText ?? "", model: "workflow-runtime-v1" };
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
      journeyId: memory.journey?.id ?? null
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
        legacyPendingContactValue: memory.pendingContactValue ?? null
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
