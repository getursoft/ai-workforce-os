import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import {
  AgentExecutionStatus,
  ConversationMessageRole,
  ConversationStatus,
  Prisma,
  ReceptionistHandoffStatus
} from "@prisma/client";
import { AgentService } from "../agents/agent.service";
import type { AgentExecutionInput } from "../agents/agent.runtime";
import {
  composeChannelResponse,
  resolveConversationChannel
} from "../conversation/conversational-response-policy";
import { classifyIdentityCandidate } from "../conversation/identity-capture";
import { classifyUserInput } from "../conversation/input-semantics";
import { CustomerIdentityService } from "../customer-identity/customer-identity.service";
import { InteractionService } from "../interaction/interaction.service";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { ObservabilityService } from "../observability/observability.service";
import type { TraceContext } from "../observability/trace-context";
import { WorkforceOrchestratorService } from "../workforce/workforce-orchestrator.service";
import { ReceptionistRoutingService } from "./receptionist-routing.service";
import { SpecialistPendingInputRegistry } from "./specialist-pending-input";
import type {
  ActiveReceptionistHandoff,
  HandoffContext,
  ReceptionistChannel,
  ReceptionistFrontDoorUnavailableReason,
  ReceptionistIdentitySource,
  ReceptionistIntakeState,
  ReceptionistRouteDecision,
  ReceptionistRuntime,
  ReceptionistRuntimeResult,
  SafeAttachmentMetadata,
  SafeCustomerIdentity
} from "./receptionist.types";
import { WorkforceDirectoryService } from "./workforce-directory.service";

interface ReceptionistSettings {
  enabled: boolean;
  displayName: string;
  defaultWebFrontDoor: boolean;
  defaultWhatsAppFrontDoor: boolean;
  handoffDisplayMode: "TRANSPARENT_HANDOFF" | "RECEPTIONIST_PROXY";
  llmRoutingEnabled: boolean;
  routingModel: string;
  minimumRoutingConfidence: number;
  clarificationEnabled: boolean;
  voiceEnabled: boolean;
  preferredLanguage: string;
  welcomeMessage: string;
  fallbackMessage: string;
}

const DEFAULT_SETTINGS: ReceptionistSettings = {
  enabled: true,
  displayName: "AI Receptionist",
  defaultWebFrontDoor: true,
  defaultWhatsAppFrontDoor: true,
  handoffDisplayMode: "TRANSPARENT_HANDOFF",
  llmRoutingEnabled: true,
  routingModel: "configured-provider-model",
  minimumRoutingConfidence: 0.85,
  clarificationEnabled: true,
  voiceEnabled: false,
  preferredLanguage: "auto",
  // Stored without a salutation — `greetingFor()` prepends a time-of-day "Good morning/afternoon/
  // evening" computed at render time, so a static string here can't go stale relative to the clock.
  welcomeMessage:
    "I'm Krevia, your AI Receptionist. May I know your name, and could you briefly tell me what you'd like to discuss today?",
  fallbackMessage:
    "I couldn't find an available specialist for that request. I can keep the request, retry, or help with something else."
};

/** "Good morning/afternoon/evening" for the given instant in the given IANA timezone — falls back to
 *  "Hello" for an invalid timezone rather than throwing, since a greeting salutation is never worth
 *  failing the whole turn over. */
function timeOfDaySalutation(date: Date, timeZone: string): string {
  try {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone }).format(date)
    );
    if (hour < 5 || hour >= 21) return "Good evening";
    if (hour < 12) return "Good morning";
    if (hour < 17) return "Good afternoon";
    return "Good evening";
  } catch {
    return "Hello";
  }
}

@Injectable()
export class ReceptionistService implements ReceptionistRuntime {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: ReceptionistRoutingService,
    private readonly directory: WorkforceDirectoryService,
    private readonly agents: AgentService,
    private readonly workforce: WorkforceOrchestratorService,
    private readonly customerIdentities: CustomerIdentityService,
    private readonly observability: ObservabilityService,
    private readonly pendingInputRegistry: SpecialistPendingInputRegistry,
    @Optional() private readonly interactions?: InteractionService
  ) {}

  async execute(
    input: AgentExecutionInput,
    traceContext?: TraceContext
  ): Promise<ReceptionistRuntimeResult> {
    const started = Date.now();
    const plugin = await this.requireReceptionist(input.organizationId, input.agentId);
    const settings = await this.settings(plugin.id);
    if (!settings.enabled) throw new Error("RECEPTIONIST_DISABLED");
    const conversation = await this.resolveConversation(input, plugin.id);
    if (conversation.status === ConversationStatus.ARCHIVED)
      throw new Error("CONVERSATION_ARCHIVED");
    const baseCustomerIdentity = await this.safeCustomerIdentity(
      input,
      conversation.customerProfileId
    );
    const channel = channelFor(input);

    // Sprint 7.12 STEP 3/6/7 — the Receptionist is the TRUE first-contact point for WhatsApp/voice/
    // web-via-receptionist (this method returns before AgentService.executeTraced's own conversation
    // resolution ever runs for these — see AgentService.executeTraced's own comment on this), so the
    // Interaction must be created/linked here, not there. A subsequent specialist handoff dispatch
    // reaches AgentService.executeTraced directly and finds this SAME Interaction via shared channel
    // identity — never a duplicate.
    if (this.interactions) {
      const voiceSessionId =
        typeof input.metadata?.voiceSessionId === "string" ? input.metadata.voiceSessionId : null;
      const interaction = await this.interactions.findOrCreate({
        organizationId: input.organizationId,
        channel: channel === "WEB" ? "WEB_CHAT" : channel,
        conversationId: conversation.id,
        voiceSessionId,
        channelConnectionId: input.actor.type === "CHANNEL" ? input.actor.channelConnectionId : null,
        externalUserId: input.actor.type === "CHANNEL" ? input.actor.externalUserId : null,
        entryAgentId: plugin.id
      });
      await this.interactions.setCurrentAgent(input.organizationId, interaction.id, plugin.id);
    }

    const historyCount = await this.prisma.conversationMessage.count({
      where: { organizationId: input.organizationId, conversationId: conversation.id }
    });
    if (!input.text.trim() && !input.attachmentIds?.length && historyCount === 0) {
      return this.greet(input, conversation.id, settings, started, traceContext);
    }

    const attachments = await this.attachments(
      input.organizationId,
      conversation.id,
      input.attachmentIds
    );
    await this.prisma.conversationMessage.create({
      data: {
        organizationId: input.organizationId,
        conversationId: conversation.id,
        role: ConversationMessageRole.USER,
        content: input.text.trim() || attachmentMessage(attachments)
      }
    });

    // Identity resolution (see resolveIdentity): checks the Receptionist's own captured name for this
    // conversation, then the authenticated dashboard user, then any existing channel/CustomerProfile
    // identity, before ever falling back to "ask once". Never invents a name from an email address.
    const intake = readIntakeState(conversation.metadata);
    let { customerIdentity, identitySource } = await this.resolveIdentity(
      input,
      conversation,
      baseCustomerIdentity,
      intake
    );

    // A pending "may I know your name?" answer is consumed here, BEFORE routing ever sees it — this is
    // what stops a bare "Krishna" reply from being misclassified as a fresh specialist-routing request.
    // The routing decision below is then made against the ORIGINAL request text, not the name reply, so
    // the customer never has to repeat themselves.
    let effectiveText = input.text;
    let justCapturedName = false;
    if (intake.pendingReceptionistInput === "CUSTOMER_NAME") {
      const capturedName = captureNameAnswer(input.text);
      if (capturedName) {
        justCapturedName = true;
        effectiveText = intake.pendingOriginalRequest ?? input.text;
        customerIdentity = { ...customerIdentity, displayName: capturedName };
        identitySource = "RECEPTIONIST_CAPTURED";
        await this.persistIntake(conversation.id, conversation.metadata, {
          customerName: capturedName,
          identityStatus: "RECEPTIONIST_CAPTURED",
          pendingReceptionistInput: null,
          pendingOriginalRequest: null,
          pendingClarificationCandidateIds: null
        });
      }
    }

    // Sprint 6.6 — Part 9 (root cause): a CLARIFY exchange used to discard the original ambiguous
    // message entirely — the next turn routed the customer's short disambiguating reply ("Travel") ALONE,
    // with no memory of what it was even answering. Mirrors the CUSTOMER_NAME resumption immediately
    // above: the original message survives in `pendingOriginalRequest` (no second store), and this turn's
    // reply is appended to it before routing ever runs — never routed in isolation. A bare disambiguating
    // reply, a domain pivot ("forget this, salary ka issue hai"), and a reply that merely confirms one of
    // the offered candidates are all handled by the SAME mechanism: ordinary routing scoring against the
    // combined text, not a special-cased lookup against `pendingClarificationCandidateIds` (which exists
    // only as an observability/future-use record of what was actually offered, per the plan's "no second
    // routing model").
    if (intake.pendingReceptionistInput === "CLARIFY_ROUTE") {
      effectiveText = intake.pendingOriginalRequest
        ? `${intake.pendingOriginalRequest} ${input.text}`.trim()
        : input.text;
      await this.persistIntake(conversation.id, conversation.metadata, {
        customerName: intake.customerName,
        identityStatus: intake.identityStatus,
        pendingReceptionistInput: null,
        pendingOriginalRequest: null,
        pendingClarificationCandidateIds: null
      });
    }

    // Sprint 6.5 — Part 4/6: UNPROMPTED identity capture. Nobody asked "what's your name?" this turn —
    // the customer just volunteered it ("Krishna", "I'm Krishna", "Krishna here"), and identity is a
    // conversation/customer-level concept, not something only Travel or only a prompted reply can
    // recognize (see identity-capture.ts's header comment). Delegates entirely to the same
    // `classifyIdentityCandidate` used by Travel — same stopword list, same HIGH/LOW confidence rules —
    // so a short command/domain phrase ("book it", "I need HR help") can never be captured as a name here
    // either. `classifyUserInput` is a second, independent guard: even if a candidate name somehow slipped
    // through (it shouldn't — the stopword list already excludes every case the sprint brief lists), an
    // ACTION/CORRECTION/FAREWELL classification of the same text blocks capture, converging this
    // deterministic path with the semantic vocabulary used elsewhere in this sprint.
    if (!justCapturedName && identitySource === "UNKNOWN") {
      const candidate = classifyIdentityCandidate(effectiveText);
      if (candidate) {
        const semantic = classifyUserInput(effectiveText, { hasPendingQuestion: false });
        if (semantic.semantic !== "ACTION" && semantic.semantic !== "CORRECTION" && semantic.semantic !== "FAREWELL") {
          justCapturedName = true;
          customerIdentity = { ...customerIdentity, displayName: candidate.name };
          identitySource = "RECEPTIONIST_CAPTURED";
          await this.persistIntake(conversation.id, conversation.metadata, {
            customerName: candidate.name,
            identityStatus: "RECEPTIONIST_CAPTURED",
            pendingReceptionistInput: null,
            pendingOriginalRequest: null,
            pendingClarificationCandidateIds: null
          });
          // A message that is JUST the identity ("Krishna", "I'm Krishna", "Krishna here") has nothing
          // left to route this turn — acknowledge and wait for the customer's actual request next turn.
          // A longer message ("I'm Krishna, I need HR help") is identity-plus-content: capture silently
          // and fall through to ordinary routing below, which now seeds the specialist with the name in
          // the very same turn.
          if (isIdentityOnlyMessage(effectiveText)) {
            return this.acknowledgeIdentityAndContinue(
              input,
              conversation.id,
              candidate.name,
              started,
              traceContext
            );
          }
        }
      }
    }

    const execution = await this.prisma.agentExecution.create({
      data: {
        organizationId: input.organizationId,
        conversationId: conversation.id,
        pluginInstallationId: plugin.id,
        userId: input.actor.type === "USER" ? input.actor.userId : null,
        status: AgentExecutionStatus.RUNNING,
        modelProvider: "receptionist-routing",
        model: "deterministic-profile-router-v1",
        requestId: input.requestId,
        traceId: traceContext?.sampled ? traceContext.traceId : null,
        startedAt: new Date(started),
        metadata: safeMetadata(input.metadata)
      }
    });
    if (traceContext)
      await this.observability.linkTrace(traceContext, {
        conversationId: conversation.id,
        agentExecutionId: execution.id
      });

    try {
      const current = await this.activeHandoff(input.organizationId, conversation.id);
      const summary = await this.prisma.conversationSummary.findFirst({
        where: { organizationId: input.organizationId, conversationId: conversation.id },
        select: { summary: true }
      });
      // Travel Booking Closure Pass — Phase 2: resolved once per turn, before routing, so a message that
      // plainly answers the active specialist's own pending question (e.g. "share it here" answering
      // Travel's ticket-delivery ask) is never exposed to domain-switch scoring at all — see
      // ReceptionistRoutingService.route's own use of this flag and SpecialistPendingInputRegistry's doc
      // comment for why this can't be a keyword hack.
      const pendingInputSatisfied = current
        ? await this.pendingInputRegistry.isSatisfiedBy(
            input.organizationId,
            current.targetEmployeeInstallationId,
            current.targetConversationId,
            effectiveText
          )
        : false;
      // Sprint 6.3 — Part 3: the active specialist's own last reply, used by routing to tell an ordinary
      // in-context follow-up ("options above my budget", echoing what Travel itself just asked) apart from
      // a genuine domain pivot that merely shares a word with another employee's routing vocabulary.
      const recentSpecialistMessage = current?.targetConversationId
        ? ((
            await this.prisma.conversationMessage.findFirst({
              where: {
                organizationId: input.organizationId,
                conversationId: current.targetConversationId,
                role: "ASSISTANT"
              },
              orderBy: { createdAt: "desc" },
              select: { content: true }
            })
          )?.content ?? null)
        : null;
      const decision = await this.observability.withSpan<ReceptionistRouteDecision>(
        traceContext,
        {
          name: "WORKFORCE_ROUTING",
          spanType: "EMPLOYEE_ROUTING",
          component: "ReceptionistRoutingService",
          organizationId: input.organizationId,
          conversationId: conversation.id,
          employeeInstallationId: plugin.id,
          inputSummary: {
            channel,
            attachmentCount: attachments.length,
            activeHandoff: Boolean(current)
          }
        },
        async (routingSpan) => {
          const result = await this.routing.route({
            organizationId: input.organizationId,
            receptionistInstallationId: plugin.id,
            conversationId: conversation.id,
            customerIdentity,
            message: effectiveText,
            attachmentMetadata: attachments,
            conversationSummary: summary?.summary ?? null,
            currentHandoff: current,
            channel,
            llmRoutingEnabled: settings.llmRoutingEnabled,
            minimumRoutingConfidence: settings.minimumRoutingConfidence,
            clarificationEnabled: settings.clarificationEnabled,
            pendingInputSatisfied,
            recentSpecialistMessage
          });
          const routingDecisionLabel =
            result.routeType === "CONTINUE_HANDOFF"
              ? "CONTINUE_HANDOFF"
              : current && (result.routeType === "ROUTE" || result.routeType === "MULTI_EMPLOYEE")
                ? "DOMAIN_SWITCH"
                : result.routeType === "CLARIFY"
                  ? "CLARIFICATION"
                  : result.routeType === "ROUTE" || result.routeType === "MULTI_EMPLOYEE"
                    ? "NEW_ROUTE"
                    : result.routeType;
          // Never put the customer's name itself here — identitySource records where it came from, not
          // the value, matching the platform's existing "no PII in trace attributes" policy.
          await this.observability.addAttribute(routingSpan, "decision", {
            routingDecision: routingDecisionLabel,
            routeType: result.routeType,
            activeEmployee: current?.targetEmployeeInstallationId ?? null,
            selectedCapability: result.capability,
            candidateCount: result.secondaryEmployeeInstallationIds.length + 1,
            confidence: result.confidence,
            domainSwitchConfidence: routingDecisionLabel === "DOMAIN_SWITCH" ? result.confidence : null,
            decisionSource: result.decisionSource,
            targetInstallation: result.primaryEmployeeInstallationId,
            secondaryCount: result.secondaryEmployeeInstallationIds.length,
            identitySource
          });
          return result;
        }
      );

      if (
        !justCapturedName &&
        identitySource === "UNKNOWN" &&
        (decision.routeType === "ROUTE" || decision.routeType === "MULTI_EMPLOYEE")
      ) {
        return this.deferForCustomerName({
          input,
          plugin,
          conversation,
          execution,
          started,
          pendingOriginalRequest: effectiveText
        });
      }

      // Downstream of this point, everything — the handoff title, the delegation contract's objective,
      // and above all the specialist's own `text` — must see the RESUMED original request, never the bare
      // name reply that answered "may I know your name?" (that reply already went into the conversation
      // transcript as its own USER message above; it must not also become the specialist's first turn).
      // Sprint 6.6: generalized from "only when a name was just captured" to "whenever effectiveText was
      // actually resumed/combined" — the CLARIFY_ROUTE resumption above rewrites `effectiveText` the same
      // way the CUSTOMER_NAME one does, and needs the same substitution here.
      const effectiveInput = effectiveText !== input.text ? { ...input, text: effectiveText } : input;
      const outcome = await this.applyDecision({
        input: effectiveInput,
        plugin,
        conversationId: conversation.id,
        conversationMetadata: conversation.metadata,
        customerProfileId: conversation.customerProfileId,
        customerIdentity,
        channel,
        settings,
        decision,
        current,
        attachments,
        summary: summary?.summary ?? null,
        ...(traceContext ? { traceContext } : {})
      });
      const routeUsage = decision.usage ?? {
        provider: "receptionist-routing",
        model: "deterministic-profile-router-v1",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      };
      await this.prisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          status: AgentExecutionStatus.COMPLETED,
          completedAt: new Date(),
          latencyMs: Date.now() - started,
          modelProvider: routeUsage.provider,
          model: routeUsage.model,
          inputTokens: routeUsage.inputTokens,
          outputTokens: routeUsage.outputTokens,
          totalTokens: routeUsage.totalTokens,
          metadata: {
            routeType: decision.routeType,
            routeCapability: decision.capability,
            routingConfidence: decision.confidence,
            routingSource: decision.decisionSource,
            handoffId: outcome.handoff?.id ?? null,
            channel,
            clarificationCount: decision.routeType === "CLARIFY" ? 1 : 0
          }
        }
      });
      // Travel Booking Closure Pass — Phase 6: the specialist's own attachments (e.g. a booking
      // confirmation PDF, see AgentService.execute) must survive the Receptionist wrapper's own
      // contentJson — a specialist response routed through Ask Krevia must preserve attachments, not only
      // flattened text. `outcome.attachments` is already scoped to just the current turn's specialist
      // result (see `customerResponse`), never accumulated across turns.
      const contentJson = {
        receptionist: {
          routeType: decision.routeType,
          decisionSource: decision.decisionSource,
          confidence: decision.confidence,
          reasonCode: decision.reasonCode,
          handoff: outcome.handoff
        },
        ...(outcome.attachments?.length ? { attachments: outcome.attachments } : {})
      };
      const message = await this.prisma.conversationMessage.create({
        data: {
          organizationId: input.organizationId,
          conversationId: conversation.id,
          role: ConversationMessageRole.ASSISTANT,
          content: outcome.response,
          contentJson: contentJson as unknown as Prisma.InputJsonValue,
          model: routeUsage.model,
          inputTokens: routeUsage.inputTokens,
          outputTokens: routeUsage.outputTokens
        }
      });
      return {
        conversationId: conversation.id,
        executionId: execution.id,
        messageId: message.id,
        response: outcome.response,
        status: "COMPLETED",
        model: routeUsage.model,
        usage: {
          inputTokens: routeUsage.inputTokens,
          outputTokens: routeUsage.outputTokens,
          totalTokens: routeUsage.totalTokens,
          estimatedCost: null
        },
        sources: [],
        receptionist: contentJson.receptionist,
        // Travel Booking Closure Pass — Phase 6: exposed at the SAME top-level key AgentService.execute()
        // already uses for a direct (non-handoff) chat response, so the dashboard's attachment renderer
        // needs no Receptionist-specific branch to find it.
        ...(outcome.attachments?.length ? { attachments: outcome.attachments } : {})
      };
    } catch (error) {
      await this.prisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          status: AgentExecutionStatus.FAILED,
          completedAt: new Date(),
          latencyMs: Date.now() - started,
          errorCode: safeCode(error),
          errorMessage: "Receptionist execution failed safely"
        }
      });
      throw error;
    }
  }

  async frontDoor(organizationId: string) {
    const plugins = await this.prisma.plugin.findMany({
      where: { organizationId, deletedAt: null },
      select: {
        id: true,
        slug: true,
        displayName: true,
        description: true,
        manifest: true,
        status: true
      },
      orderBy: { installedAt: "asc" }
    });
    const receptionists = plugins.filter((plugin) =>
      manifestCapabilities(plugin.manifest).includes("workforce.intake")
    );
    if (!receptionists.length) return unavailableFrontDoor("RECEPTIONIST_NOT_INSTALLED");

    const candidates = await Promise.all(
      receptionists.map(async (plugin) => ({ plugin, settings: await this.settings(plugin.id) }))
    );
    const selected = candidates.find(
      ({ plugin, settings }) =>
        plugin.status === "ACTIVE" && settings.enabled && settings.defaultWebFrontDoor
    );
    if (!selected) {
      const installed = candidates[0]!;
      const reason: ReceptionistFrontDoorUnavailableReason = candidates.some(
        ({ plugin, settings }) => plugin.status === "ACTIVE" && settings.enabled
      )
        ? "RECEPTIONIST_NOT_CONFIGURED"
        : "RECEPTIONIST_DISABLED";
      return unavailableFrontDoor(reason, {
        installationId: installed.plugin.id,
        employeeKey: installed.plugin.slug,
        displayName: installed.settings.displayName || installed.plugin.displayName,
        description: installed.plugin.description
      });
    }
    const { plugin: receptionist, settings } = selected;
    return {
      enabled: true,
      reasonCode: null,
      installationId: receptionist.id,
      pluginInstallationId: receptionist.id,
      employeeKey: receptionist.slug,
      displayName: settings.displayName || receptionist.displayName,
      description: receptionist.description,
      settings,
      workforce: await this.directory.list(organizationId)
    };
  }

  /** Prepends a time-of-day salutation (in the organization's configured timezone, defaulting to UTC)
   *  to a stored greeting template — the one thing a static DB string can't express on its own. */
  private async greetingFor(organizationId: string, baseMessage: string): Promise<string> {
    const setting = await this.prisma.organizationSetting.findUnique({
      where: { organizationId },
      select: { timezone: true }
    });
    const salutation = timeOfDaySalutation(new Date(), setting?.timezone ?? "UTC");
    return `${salutation}! ${baseMessage}`;
  }

  private async applyDecision(context: {
    input: AgentExecutionInput;
    plugin: { id: string; displayName: string };
    conversationId: string;
    conversationMetadata: unknown;
    customerProfileId: string | null;
    customerIdentity: SafeCustomerIdentity;
    channel: ReceptionistChannel;
    settings: ReceptionistSettings;
    decision: ReceptionistRouteDecision;
    current: ActiveReceptionistHandoff | null;
    attachments: SafeAttachmentMetadata[];
    summary: string | null;
    traceContext?: TraceContext;
  }): Promise<{
    response: string;
    handoff: ReceptionistRuntimeResult["receptionist"]["handoff"];
    /** Travel Booking Closure Pass — Phase 6: a specialist's own structured attachments (e.g. a booking
     *  confirmation PDF — see AgentService.execute's own `attachments` return field, whose shape varies by
     *  attachment type), preserved through the Receptionist wrapper — see `customerResponse`. Opaque here
     *  on purpose: the Receptionist never interprets attachment contents, only relays them unmodified.
     *  Absent for every non-handoff branch (greeting, clarify, directory, ...), which never carry one. */
    attachments?: Array<Record<string, unknown>>;
  }> {
    const { decision } = context;
    if (decision.reasonCode === "GREETING") {
      const response = await this.greetingFor(context.input.organizationId, context.settings.welcomeMessage);
      return { response, handoff: null };
    }
    if (decision.reasonCode === "RETURN_TO_RECEPTIONIST") {
      if (context.current)
        await this.finishHandoff(
          context.input.organizationId,
          context.current.id,
          ReceptionistHandoffStatus.RETURNED_TO_RECEPTIONIST
        );
      return {
        response: "You're back with me. What else can I help you with?",
        handoff: null
      };
    }
    if (decision.reasonCode === "WORKFORCE_DIRECTORY_REQUEST") {
      const available = (
        await this.directory.eligible(
          context.input.organizationId,
          context.channel,
          context.plugin.id
        )
      ).map((employee) => `${employee.displayName}: ${employee.description}`);
      return {
        response: available.length
          ? `I can connect you with:\n${available.map((line) => `• ${line}`).join("\n")}`
          : context.settings.fallbackMessage,
        handoff: null
      };
    }
    if (decision.routeType === "CLARIFY") {
      // Sprint 6.6 — Part 9: persist the ambiguous message (and which employees it might have meant) so
      // the customer's next, short disambiguating reply is interpreted TOGETHER with it, not routed alone
      // — mirrors the CUSTOMER_NAME deferral immediately below at the `deferForCustomerName` call site.
      // `context.input.text` is already the fully-resumed text by this point (a CLARIFY-of-a-CLARIFY
      // accumulates rather than losing the earlier context), and `secondaryEmployeeInstallationIds` is the
      // decision's own existing field, now populated for CLARIFY too (see receptionist-routing.service.ts).
      await this.persistIntake(context.conversationId, context.conversationMetadata, {
        customerName: context.customerIdentity.displayName,
        identityStatus:
          context.customerIdentity.displayName != null ? "RECEPTIONIST_CAPTURED" : "UNKNOWN",
        pendingReceptionistInput: "CLARIFY_ROUTE",
        pendingOriginalRequest: context.input.text,
        pendingClarificationCandidateIds: decision.secondaryEmployeeInstallationIds.length
          ? decision.secondaryEmployeeInstallationIds
          : null
      });
      return {
        response:
          decision.clarificationQuestion ??
          "Could you share a little more detail so I can connect you with the right specialist?",
        handoff: null
      };
    }
    if (decision.routeType === "UNSUPPORTED" || !decision.primaryEmployeeInstallationId) {
      return { response: context.settings.fallbackMessage, handoff: null };
    }
    if (decision.routeType === "CONTINUE_HANDOFF" && context.current) {
      return this.continueHandoff(context, context.current);
    }
    if (context.current) {
      await this.finishHandoff(
        context.input.organizationId,
        context.current.id,
        ReceptionistHandoffStatus.RETURNED_TO_RECEPTIONIST
      );
    }
    return decision.routeType === "MULTI_EMPLOYEE"
      ? this.startParallelHandoff(context)
      : this.startHandoff(context);
  }

  private async startHandoff(context: Parameters<ReceptionistService["applyDecision"]>[0]) {
    const targetId = context.decision.primaryEmployeeInstallationId;
    if (!targetId) throw new Error("HANDOFF_TARGET_MISSING");
    const target = await this.requireTarget(context.input.organizationId, targetId);
    const handoffContext = this.handoffContext(context);
    await this.workforce.planDelegation({
      organizationId: context.input.organizationId,
      sourceEmployeeInstallationId: context.plugin.id,
      targetEmployeeInstallationId: targetId,
      requestedByActorType: context.input.actor.type,
      requestedByActorId:
        context.input.actor.type === "USER"
          ? context.input.actor.userId
          : context.customerIdentity.id,
      contract: {
        taskType: delegationTaskType(context.decision.intent, "CUSTOMER_HANDOFF"),
        ...(context.decision.capability ? { targetCapability: context.decision.capability } : {}),
        objective: context.input.text.slice(0, 2000),
        input: handoffContext,
        constraints: { readOnly: false }
      }
    });
    const specialistConversation = await this.prisma.conversation.create({
      data: {
        organizationId: context.input.organizationId,
        pluginInstallationId: targetId,
        createdByUserId: context.input.actor.type === "USER" ? context.input.actor.userId : null,
        customerProfileId: context.customerProfileId,
        title: `Handoff: ${context.input.text}`.slice(0, 160),
        metadata: {
          receptionistConversationId: context.conversationId,
          receptionistInstallationId: context.plugin.id,
          sourceChannel: context.channel
        }
      }
    });
    const clonedAttachmentIds = await this.cloneAttachments(
      context.input.organizationId,
      context.conversationId,
      specialistConversation.id,
      targetId,
      context.input.attachmentIds
    );
    const row = await this.prisma.receptionistHandoff.create({
      data: {
        organizationId: context.input.organizationId,
        receptionistInstallationId: context.plugin.id,
        conversationId: context.conversationId,
        customerIdentityId: context.customerIdentity.id,
        targetEmployeeInstallationId: targetId,
        targetConversationId: specialistConversation.id,
        status: ReceptionistHandoffStatus.WAITING_SPECIALIST,
        routingIntent: context.decision.intent,
        routingCapability: context.decision.capability,
        routingConfidence: context.decision.confidence,
        sourceChannel: context.channel,
        parentTraceId: context.traceContext?.traceId ?? null,
        metadataJson: { handoffContext } as Prisma.InputJsonValue
      }
    });
    return this.observability.withSpan<
      Awaited<ReturnType<ReceptionistService["customerResponse"]>>
    >(
      context.traceContext,
      {
        name: "HANDOFF",
        spanType: "DELEGATION",
        component: "ReceptionistService",
        organizationId: context.input.organizationId,
        conversationId: context.conversationId,
        employeeInstallationId: targetId,
        inputSummary: {
          handoffId: row.id,
          capability: context.decision.capability,
          sourceChannel: context.channel
        }
      },
      async (handoffSpan) => {
        const specialistStartedAt = Date.now();
        try {
          const result = await this.agents.execute({
            ...context.input,
            agentId: targetId,
            conversationId: specialistConversation.id,
            metadata: {
              receptionistHandoffId: row.id,
              receptionistConversationId: context.conversationId,
              requestedCapability: context.decision.capability,
              ...(context.customerIdentity.displayName
                ? { receptionistCustomerName: context.customerIdentity.displayName }
                : {})
            },
            ...(clonedAttachmentIds.length ? { attachmentIds: clonedAttachmentIds } : {}),
            traceContext: handoffSpan
          });
          await this.prisma.receptionistHandoff.update({
            where: { id: row.id },
            data: {
              status: ReceptionistHandoffStatus.HANDOFF_ACTIVE,
              lastActivityAt: new Date(),
              metadataJson: {
                handoffContext,
                specialistExecutionId: result.executionId,
                specialistFirstResponseMs: Date.now() - specialistStartedAt
              } as Prisma.InputJsonValue
            }
          });
          return this.customerResponse(context, row.id, target, result.response, true, specialistAttachments(result));
        } catch {
          await this.finishHandoff(
            context.input.organizationId,
            row.id,
            ReceptionistHandoffStatus.FAILED
          );
          return {
            response: `${target.displayName} is temporarily unavailable. I can keep your request and retry, or help you with something else.`,
            handoff: this.handoffView(
              row.id,
              "FAILED",
              targetId,
              target.displayName,
              context.settings.handoffDisplayMode
            )
          };
        }
      }
    );
  }

  private async continueHandoff(
    context: Parameters<ReceptionistService["applyDecision"]>[0],
    handoff: ActiveReceptionistHandoff
  ) {
    if (!handoff.targetConversationId) throw new Error("HANDOFF_CONVERSATION_MISSING");
    const target = await this.requireTarget(
      context.input.organizationId,
      handoff.targetEmployeeInstallationId
    );
    const specialistConversation = await this.prisma.conversation.findFirst({
      where: {
        id: handoff.targetConversationId,
        organizationId: context.input.organizationId,
        pluginInstallationId: handoff.targetEmployeeInstallationId,
        status: "ACTIVE",
        deletedAt: null
      }
    });
    if (!specialistConversation) throw new Error("HANDOFF_CONVERSATION_NOT_FOUND");
    await this.workforce.planDelegation({
      organizationId: context.input.organizationId,
      sourceEmployeeInstallationId: context.plugin.id,
      targetEmployeeInstallationId: handoff.targetEmployeeInstallationId,
      requestedByActorType: context.input.actor.type,
      contract: {
        taskType: delegationTaskType(handoff.routingIntent, "CUSTOMER_HANDOFF_CONTINUATION"),
        ...(handoff.routingCapability ? { targetCapability: handoff.routingCapability } : {}),
        objective: context.input.text.slice(0, 2000),
        input: { handoffId: handoff.id, continuation: true }
      }
    });
    const clonedAttachmentIds = await this.cloneAttachments(
      context.input.organizationId,
      context.conversationId,
      specialistConversation.id,
      target.id,
      context.input.attachmentIds
    );
    return this.observability.withSpan<
      Awaited<ReturnType<ReceptionistService["customerResponse"]>>
    >(
      context.traceContext,
      {
        name: "HANDOFF_CONTINUATION",
        spanType: "DELEGATION",
        component: "ReceptionistService",
        organizationId: context.input.organizationId,
        conversationId: context.conversationId,
        employeeInstallationId: target.id,
        inputSummary: { handoffId: handoff.id, source: "ACTIVE_HANDOFF" }
      },
      async (handoffSpan) => {
        const result = await this.agents.execute({
          ...context.input,
          agentId: target.id,
          conversationId: specialistConversation.id,
          metadata: {
            receptionistHandoffId: handoff.id,
            continuation: true,
            ...(context.customerIdentity.displayName
              ? { receptionistCustomerName: context.customerIdentity.displayName }
              : {})
          },
          ...(clonedAttachmentIds.length ? { attachmentIds: clonedAttachmentIds } : {}),
          traceContext: handoffSpan
        });
        await this.prisma.receptionistHandoff.updateMany({
          where: { id: handoff.id, organizationId: context.input.organizationId },
          data: { status: ReceptionistHandoffStatus.HANDOFF_ACTIVE, lastActivityAt: new Date() }
        });
        return this.customerResponse(context, handoff.id, target, result.response, false, specialistAttachments(result));
      }
    );
  }

  private async startParallelHandoff(context: Parameters<ReceptionistService["applyDecision"]>[0]) {
    const primaryId = context.decision.primaryEmployeeInstallationId;
    if (!primaryId) throw new Error("PARALLEL_PRIMARY_HANDOFF_MISSING");
    const ids = unique([primaryId, ...context.decision.secondaryEmployeeInstallationIds]);
    const targets = await Promise.all(
      ids.map((id) => this.requireTarget(context.input.organizationId, id))
    );
    const handoffContext = this.handoffContext(context);
    const join = await this.workforce.delegateParallel({
      organizationId: context.input.organizationId,
      sourceEmployeeInstallationId: context.plugin.id,
      requests: targets.map((target, index) => ({
        targetEmployeeInstallationId: target.id,
        contract: {
          taskType:
            index === 0
              ? delegationTaskType(context.decision.intent, "CUSTOMER_HANDOFF")
              : "CUSTOMER_HANDOFF_CONTRIBUTION",
          ...(index === 0 && context.decision.capability
            ? { targetCapability: context.decision.capability }
            : {}),
          objective: context.input.text.slice(0, 2000),
          input: handoffContext,
          constraints: { readOnly: false }
        }
      })),
      joinPolicy: "BEST_EFFORT",
      requestedByActorType: context.input.actor.type,
      requestedByActorId:
        context.input.actor.type === "USER"
          ? context.input.actor.userId
          : context.customerIdentity.id,
      mode: "SYNCHRONOUS",
      traceContext: context.traceContext ?? null
    });
    const tasks = await this.prisma.employeeDelegatedTask.findMany({
      where: { organizationId: context.input.organizationId, correlationId: join.correlationId },
      orderBy: { createdAt: "asc" }
    });
    const primaryTask = tasks.find(
      (task) => task.targetEmployeeInstallationId === context.decision.primaryEmployeeInstallationId
    );
    if (!primaryTask) throw new Error("PARALLEL_PRIMARY_HANDOFF_MISSING");
    const row = await this.prisma.receptionistHandoff.create({
      data: {
        organizationId: context.input.organizationId,
        receptionistInstallationId: context.plugin.id,
        conversationId: context.conversationId,
        customerIdentityId: context.customerIdentity.id,
        targetEmployeeInstallationId: primaryTask.targetEmployeeInstallationId,
        targetConversationId: primaryTask.childConversationId,
        delegatedTaskId: primaryTask.id,
        status:
          primaryTask.status === "COMPLETED"
            ? ReceptionistHandoffStatus.HANDOFF_ACTIVE
            : ReceptionistHandoffStatus.FAILED,
        routingIntent: context.decision.intent,
        routingCapability: context.decision.capability,
        routingConfidence: context.decision.confidence,
        sourceChannel: context.channel,
        parentTraceId: context.traceContext?.traceId ?? null,
        metadataJson: {
          handoffContext,
          correlationId: join.correlationId,
          secondaryEmployeeInstallationIds: context.decision.secondaryEmployeeInstallationIds
        } as Prisma.InputJsonValue
      }
    });
    const contributions = await Promise.all(
      tasks.map(async (task) => ({
        target: targets.find((target) => target.id === task.targetEmployeeInstallationId),
        response: task.childConversationId
          ? await this.lastAssistantResponse(context.input.organizationId, task.childConversationId)
          : null
      }))
    );
    const combined = contributions
      .filter((item): item is { target: { id: string; displayName: string }; response: string } =>
        Boolean(item.target && item.response)
      )
      .map((item) => `${item.target.displayName}: ${item.response}`)
      .join("\n\n");
    const target = targets[0];
    if (!target) throw new Error("PARALLEL_PRIMARY_HANDOFF_MISSING");
    return {
      response:
        context.settings.handoffDisplayMode === "TRANSPARENT_HANDOFF"
          ? `I've coordinated ${targets.map((item) => item.displayName).join(" and ")} for this request.\n\n${combined || context.settings.fallbackMessage}`
          : combined || context.settings.fallbackMessage,
      handoff: this.handoffView(
        row.id,
        row.status,
        target.id,
        target.displayName,
        context.settings.handoffDisplayMode
      )
    };
  }

  private customerResponse(
    context: Parameters<ReceptionistService["applyDecision"]>[0],
    handoffId: string,
    target: { id: string; displayName: string },
    specialistResponse: string,
    isNewHandoff: boolean,
    attachments?: Array<Record<string, unknown>>
  ) {
    return {
      response:
        context.settings.handoffDisplayMode === "TRANSPARENT_HANDOFF"
          ? handoffPresentation(context.channel, target.displayName, specialistResponse, isNewHandoff)
          : specialistResponse,
      handoff: this.handoffView(
        handoffId,
        "HANDOFF_ACTIVE",
        target.id,
        target.displayName,
        context.settings.handoffDisplayMode
      ),
      ...(attachments?.length ? { attachments } : {})
    };
  }

  private handoffView(
    id: string,
    status: string,
    targetEmployeeInstallationId: string,
    targetDisplayName: string,
    displayMode: ReceptionistSettings["handoffDisplayMode"]
  ) {
    return { id, status, targetEmployeeInstallationId, targetDisplayName, displayMode };
  }

  private handoffContext(
    context: Parameters<ReceptionistService["applyDecision"]>[0]
  ): HandoffContext {
    return {
      customerRequest: context.input.text.slice(0, 12_000),
      customerIdentity: context.customerIdentity,
      conversationSummary: context.summary?.slice(0, 2000) ?? null,
      attachments: context.attachments,
      extractedKnownFacts: {},
      requestedCapability: context.decision.capability,
      sourceChannel: context.channel,
      locale: context.customerIdentity.locale,
      timezone: context.customerIdentity.timezone
    };
  }

  private async greet(
    input: AgentExecutionInput,
    conversationId: string,
    settings: ReceptionistSettings,
    started: number,
    traceContext?: TraceContext
  ): Promise<ReceptionistRuntimeResult> {
    const greeting = await this.greetingFor(input.organizationId, settings.welcomeMessage);
    const message = await this.prisma.conversationMessage.create({
      data: {
        organizationId: input.organizationId,
        conversationId,
        role: ConversationMessageRole.ASSISTANT,
        content: greeting,
        contentJson: {
          receptionist: {
            routeType: "RECEPTIONIST_RESPONSE",
            decisionSource: "DETERMINISTIC",
            confidence: 1,
            reasonCode: "GREETING",
            handoff: null
          }
        },
        model: "receptionist-greeting-v1",
        inputTokens: 0,
        outputTokens: 0
      }
    });
    const execution = await this.prisma.agentExecution.create({
      data: {
        organizationId: input.organizationId,
        conversationId,
        pluginInstallationId: input.agentId,
        userId: input.actor.type === "USER" ? input.actor.userId : null,
        status: AgentExecutionStatus.COMPLETED,
        modelProvider: "receptionist-greeting",
        model: "receptionist-greeting-v1",
        requestId: input.requestId,
        traceId: traceContext?.sampled ? traceContext.traceId : null,
        startedAt: new Date(started),
        completedAt: new Date(),
        latencyMs: Date.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      }
    });
    return {
      conversationId,
      executionId: execution.id,
      messageId: message.id,
      response: greeting,
      status: "COMPLETED",
      model: "receptionist-greeting-v1",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: null },
      sources: [],
      receptionist: {
        routeType: "RECEPTIONIST_RESPONSE",
        decisionSource: "DETERMINISTIC",
        confidence: 1,
        reasonCode: "GREETING",
        handoff: null
      }
    };
  }

  /** Sprint 6.5 — Part 4: the customer just volunteered their name UNPROMPTED and said nothing else this
   *  turn ("Krishna", "I'm Krishna", "Krishna here") — identity is already captured and persisted by the
   *  caller before this runs. Acknowledges it and waits for the customer's actual request next turn,
   *  exactly like `greet()` does for a first empty turn; no routing decision is made and no handoff is
   *  created for a message that carries no request. */
  private async acknowledgeIdentityAndContinue(
    input: AgentExecutionInput,
    conversationId: string,
    name: string,
    started: number,
    traceContext?: TraceContext
  ): Promise<ReceptionistRuntimeResult> {
    const response = `Nice to meet you, ${name}! How can I help you today?`;
    const contentJson = {
      receptionist: {
        routeType: "RECEPTIONIST_RESPONSE" as const,
        decisionSource: "DETERMINISTIC" as const,
        confidence: 1,
        reasonCode: "UNPROMPTED_IDENTITY_CAPTURED",
        handoff: null
      }
    };
    const message = await this.prisma.conversationMessage.create({
      data: {
        organizationId: input.organizationId,
        conversationId,
        role: ConversationMessageRole.ASSISTANT,
        content: response,
        contentJson,
        model: "receptionist-identity-v1",
        inputTokens: 0,
        outputTokens: 0
      }
    });
    const execution = await this.prisma.agentExecution.create({
      data: {
        organizationId: input.organizationId,
        conversationId,
        pluginInstallationId: input.agentId,
        userId: input.actor.type === "USER" ? input.actor.userId : null,
        status: AgentExecutionStatus.COMPLETED,
        modelProvider: "receptionist-identity",
        model: "receptionist-identity-v1",
        requestId: input.requestId,
        traceId: traceContext?.sampled ? traceContext.traceId : null,
        startedAt: new Date(started),
        completedAt: new Date(),
        latencyMs: Date.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        metadata: { routeType: "RECEPTIONIST_RESPONSE", reasonCode: "UNPROMPTED_IDENTITY_CAPTURED" }
      }
    });
    return {
      conversationId,
      executionId: execution.id,
      messageId: message.id,
      response,
      status: "COMPLETED",
      model: "receptionist-identity-v1",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: null },
      sources: [],
      receptionist: contentJson.receptionist
    };
  }

  /** Identity is unknown but this turn would otherwise start a brand-new specialist handoff — asks for
   *  the customer's name FIRST and stashes the original request rather than handing off immediately and
   *  letting the specialist ask (see the correction-pass spec's "Do NOT first hand off and then allow
   *  Travel to ask name"). One customer-facing message, same as every other turn; no handoff is created. */
  private async deferForCustomerName(context: {
    input: AgentExecutionInput;
    plugin: { id: string; displayName: string };
    conversation: { id: string; metadata: unknown };
    execution: { id: string };
    started: number;
    pendingOriginalRequest: string;
  }): Promise<ReceptionistRuntimeResult> {
    const { input, conversation, execution, started, pendingOriginalRequest } = context;
    await this.persistIntake(conversation.id, conversation.metadata, {
      customerName: null,
      identityStatus: "UNKNOWN",
      pendingReceptionistInput: "CUSTOMER_NAME",
      pendingOriginalRequest,
      pendingClarificationCandidateIds: null
    });
    const response = "Sure, I can help with that. Before I connect you, may I know your name?";
    const contentJson = {
      receptionist: {
        routeType: "RECEPTIONIST_RESPONSE" as const,
        decisionSource: "DETERMINISTIC" as const,
        confidence: 1,
        reasonCode: "COLLECT_CUSTOMER_NAME",
        handoff: null
      }
    };
    const message = await this.prisma.conversationMessage.create({
      data: {
        organizationId: input.organizationId,
        conversationId: conversation.id,
        role: ConversationMessageRole.ASSISTANT,
        content: response,
        contentJson,
        model: "receptionist-identity-v1",
        inputTokens: 0,
        outputTokens: 0
      }
    });
    await this.prisma.agentExecution.update({
      where: { id: execution.id },
      data: {
        status: AgentExecutionStatus.COMPLETED,
        completedAt: new Date(),
        latencyMs: Date.now() - started,
        modelProvider: "receptionist-identity",
        model: "receptionist-identity-v1",
        metadata: { routeType: "RECEPTIONIST_RESPONSE", reasonCode: "COLLECT_CUSTOMER_NAME" }
      }
    });
    return {
      conversationId: conversation.id,
      executionId: execution.id,
      messageId: message.id,
      response,
      status: "COMPLETED",
      model: "receptionist-identity-v1",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: null },
      sources: [],
      receptionist: contentJson.receptionist
    };
  }

  private async resolveConversation(input: AgentExecutionInput, pluginInstallationId: string) {
    if (input.conversationId) {
      const existing = await this.prisma.conversation.findFirst({
        where: {
          id: input.conversationId,
          organizationId: input.organizationId,
          pluginInstallationId,
          deletedAt: null
        }
      });
      if (!existing) throw new NotFoundException("CONVERSATION_NOT_FOUND");
      return existing;
    }
    const identity = this.customerIdentities.resolve(
      input.actor.type === "CHANNEL"
        ? { source: "CHANNEL_PHONE", phone: input.actor.externalUserId }
        : { source: "UNKNOWN" }
    );
    const profile = await this.customerIdentities.loadProfile(input.organizationId, identity);
    return this.prisma.conversation.create({
      data: {
        organizationId: input.organizationId,
        pluginInstallationId,
        createdByUserId: input.actor.type === "USER" ? input.actor.userId : null,
        customerProfileId: profile?.id ?? null,
        ...(input.actor.type === "CHANNEL"
          ? {
              channelConnectionId: input.actor.channelConnectionId,
              externalUserId: input.actor.externalUserId
            }
          : {}),
        title: title(input.text),
        metadata: safeMetadata(input.metadata)
      }
    });
  }

  private async safeCustomerIdentity(
    input: AgentExecutionInput,
    customerProfileId: string | null
  ): Promise<SafeCustomerIdentity> {
    const [profile, organization] = await Promise.all([
      customerProfileId
        ? this.prisma.customerProfile.findFirst({
            where: { id: customerProfileId, organizationId: input.organizationId, deletedAt: null }
          })
        : null,
      this.prisma.organizationSetting.findUnique({
        where: { organizationId: input.organizationId }
      })
    ]);
    return {
      id: profile?.id ?? null,
      type: profile?.identityType ?? (input.actor.type === "CHANNEL" ? "PHONE" : "ANONYMOUS"),
      displayName: profile?.displayName ?? null,
      locale: profile?.language ?? organization?.locale ?? null,
      timezone: organization?.timezone ?? null
    };
  }

  /** Identity source precedence: this conversation's own previously-captured name first (never re-ask
   *  within the same conversation), then any existing channel/CustomerProfile identity (e.g. a returning
   *  WhatsApp contact), and only "UNKNOWN" — meaning ask once — when neither resolves anything.
   *
   *  Deliberately does NOT read the dashboard USER actor's own account name: `input.actor.type === "USER"`
   *  is a staff member operating/testing the workforce, not the customer being served (the exact same
   *  distinction CustomerIdentityService already draws — see `safeCustomerIdentity`/`resolve()`, which
   *  never links a dashboard actor to a CustomerProfile either). AUTHENTICATED_PROFILE is reserved for a
   *  genuinely authenticated *customer* actor (e.g. a future logged-in customer portal), which no current
   *  `AgentActor` variant represents — never invented from a staff account or an email address. */
  private async resolveIdentity(
    _input: AgentExecutionInput,
    _conversation: { createdByUserId: string | null },
    baseCustomerIdentity: SafeCustomerIdentity,
    intake: ReceptionistIntakeState
  ): Promise<{ customerIdentity: SafeCustomerIdentity; identitySource: ReceptionistIdentitySource }> {
    if (intake.customerName) {
      return {
        customerIdentity: { ...baseCustomerIdentity, displayName: intake.customerName },
        identitySource: "RECEPTIONIST_CAPTURED"
      };
    }
    if (baseCustomerIdentity.displayName) {
      return { customerIdentity: baseCustomerIdentity, identitySource: "CHANNEL_IDENTITY" };
    }
    return { customerIdentity: baseCustomerIdentity, identitySource: "UNKNOWN" };
  }

  private async persistIntake(
    conversationId: string,
    currentMetadata: unknown,
    intake: ReceptionistIntakeState
  ): Promise<void> {
    const record =
      currentMetadata && typeof currentMetadata === "object" && !Array.isArray(currentMetadata)
        ? (currentMetadata as Record<string, unknown>)
        : {};
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        metadata: { ...record, receptionistIntake: intake } as unknown as Prisma.InputJsonValue
      }
    });
  }

  private async activeHandoff(
    organizationId: string,
    conversationId: string
  ): Promise<ActiveReceptionistHandoff | null> {
    return this.prisma.receptionistHandoff.findFirst({
      where: {
        organizationId,
        conversationId,
        status: { in: ["HANDOFF_ACTIVE", "WAITING_SPECIALIST"] }
      },
      orderBy: { lastActivityAt: "desc" },
      select: {
        id: true,
        targetEmployeeInstallationId: true,
        targetConversationId: true,
        routingIntent: true,
        routingCapability: true,
        routingConfidence: true,
        status: true
      }
    });
  }

  private async finishHandoff(
    organizationId: string,
    id: string,
    status: ReceptionistHandoffStatus
  ) {
    await this.prisma.receptionistHandoff.updateMany({
      where: { id, organizationId },
      data: { status, completedAt: new Date(), lastActivityAt: new Date() }
    });
  }

  private async attachments(
    organizationId: string,
    conversationId: string,
    ids?: string[]
  ): Promise<SafeAttachmentMetadata[]> {
    if (!ids?.length) return [];
    const rows = await this.prisma.conversationAttachment.findMany({
      where: { id: { in: ids }, organizationId, conversationId },
      select: { id: true, originalFilename: true, mimeType: true, sizeBytes: true }
    });
    if (rows.length !== new Set(ids).size) throw new Error("ATTACHMENT_NOT_FOUND");
    return rows.map((row) => ({
      id: row.id,
      filename: row.originalFilename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes
    }));
  }

  private async cloneAttachments(
    organizationId: string,
    sourceConversationId: string,
    targetConversationId: string,
    targetEmployeeInstallationId: string,
    ids?: string[]
  ): Promise<string[]> {
    if (!ids?.length) return [];
    const rows = await this.prisma.conversationAttachment.findMany({
      where: { id: { in: ids }, organizationId, conversationId: sourceConversationId }
    });
    if (rows.length !== new Set(ids).size) throw new Error("ATTACHMENT_NOT_FOUND");
    const created = await Promise.all(
      rows.map((row) =>
        this.prisma.conversationAttachment.create({
          data: {
            organizationId,
            pluginInstallationId: targetEmployeeInstallationId,
            conversationId: targetConversationId,
            createdByUserId: row.createdByUserId,
            originalFilename: row.originalFilename,
            mimeType: row.mimeType,
            sizeBytes: row.sizeBytes,
            storageKey: row.storageKey,
            objectStorageKey: row.objectStorageKey,
            extractedText: row.extractedText
          }
        })
      )
    );
    return created.map((row) => row.id);
  }

  private async lastAssistantResponse(organizationId: string, conversationId: string) {
    return (
      (
        await this.prisma.conversationMessage.findFirst({
          where: { organizationId, conversationId, role: "ASSISTANT" },
          orderBy: { createdAt: "desc" },
          select: { content: true }
        })
      )?.content ?? null
    );
  }

  private async requireReceptionist(organizationId: string, id: string) {
    const plugin = await this.prisma.plugin.findFirst({
      where: { id, organizationId, status: "ACTIVE", deletedAt: null },
      select: { id: true, displayName: true, manifest: true }
    });
    if (!plugin || !manifestCapabilities(plugin.manifest).includes("workforce.intake"))
      throw new NotFoundException("RECEPTIONIST_NOT_FOUND");
    return plugin;
  }

  private async requireTarget(organizationId: string, id: string) {
    const target = await this.prisma.plugin.findFirst({
      where: { id, organizationId, status: "ACTIVE", deletedAt: null },
      select: { id: true, displayName: true }
    });
    if (!target) throw new NotFoundException("WORKFORCE_TARGET_UNAVAILABLE");
    return target;
  }

  private async settings(pluginId: string): Promise<ReceptionistSettings> {
    const stored = await this.prisma.pluginConfiguration.findUnique({
      where: { pluginId },
      select: { config: true }
    });
    const config = record(stored?.config);
    return {
      ...DEFAULT_SETTINGS,
      ...Object.fromEntries(Object.entries(config).filter(([key]) => key in DEFAULT_SETTINGS))
    } as ReceptionistSettings;
  }
}

/**
 * Travel Booking Closure Pass — Phase 14/16/19: channel-aware handoff presentation. WEB already shows a
 * visual "Connected to {employee}" indicator (see the dashboard's active-employee chip, built in an
 * earlier correction pass) — repeating "I'll connect you with X." in the text AND prefixing every single
 * turn with "X: " is redundant there, and reads like a state-machine transcript rather than a
 * conversation. WHATSAPP/VOICE have no such visual indicator, so a brief spoken-style acknowledgement is
 * still worth keeping on the FIRST turn of a handoff — never repeated on every turn there either.
 *
 * Sprint 6.3 — Part 5/11: also the one place every specialist's response passes through on its way out of
 * the Receptionist, so it applies the shared channel-response policy here — `stripDebugWording` on every
 * channel (a safety net against any internal wording that slipped into a composed message), and
 * `toVoiceSafeText` specifically for VOICE (markdown/bullets -> plain speakable prose). Still never alters
 * the SUBSTANCE of `specialistResponse` — only its final presentation for the given channel.
 */
export function handoffPresentation(
  channel: ReceptionistChannel,
  targetDisplayName: string,
  specialistResponse: string,
  isNewHandoff: boolean
): string {
  const acknowledgement =
    isNewHandoff && channel !== "WEB" ? `${targetDisplayName} can help with that — I'll hand you over.\n\n` : "";
  const composed = composeChannelResponse(`${acknowledgement}${specialistResponse}`, channel);
  return composed.message;
}

function unavailableFrontDoor(
  reasonCode: ReceptionistFrontDoorUnavailableReason,
  receptionist?: {
    installationId: string;
    employeeKey: string;
    displayName: string;
    description: string;
  }
) {
  return {
    enabled: false as const,
    reasonCode,
    installationId: receptionist?.installationId ?? null,
    pluginInstallationId: receptionist?.installationId ?? null,
    employeeKey: receptionist?.employeeKey ?? null,
    displayName: receptionist?.displayName ?? "AI Receptionist",
    description: receptionist?.description ?? "Organization workforce front door",
    settings: null,
    workforce: []
  };
}

function manifestCapabilities(value: unknown): string[] {
  return Array.isArray(record(value).capabilities)
    ? (record(value).capabilities as unknown[]).filter(
        (item): item is string => typeof item === "string"
      )
    : [];
}

const INTAKE_IDENTITY_STATUSES: ReadonlySet<string> = new Set([
  "AUTHENTICATED_PROFILE",
  "RECEPTIONIST_CAPTURED",
  "CHANNEL_IDENTITY",
  "UNKNOWN"
]);

function readIntakeState(metadata: unknown): ReceptionistIntakeState {
  const stored = record(metadata).receptionistIntake;
  const raw = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  return {
    customerName: typeof raw.customerName === "string" ? raw.customerName : null,
    identityStatus: (typeof raw.identityStatus === "string" && INTAKE_IDENTITY_STATUSES.has(raw.identityStatus)
      ? raw.identityStatus
      : "UNKNOWN") as ReceptionistIdentitySource,
    pendingReceptionistInput:
      raw.pendingReceptionistInput === "CUSTOMER_NAME"
        ? "CUSTOMER_NAME"
        : raw.pendingReceptionistInput === "CLARIFY_ROUTE"
          ? "CLARIFY_ROUTE"
          : null,
    pendingOriginalRequest: typeof raw.pendingOriginalRequest === "string" ? raw.pendingOriginalRequest : null,
    pendingClarificationCandidateIds: Array.isArray(raw.pendingClarificationCandidateIds)
      ? raw.pendingClarificationCandidateIds.filter((id): id is string => typeof id === "string")
      : null
  };
}

/** The customer's reply to "may I know your name?" — permissive by design (this is a direct answer to a
 *  question the Receptionist itself just asked, unlike Travel/employee-domain's `extractCustomerName`
 *  heuristics which must guess from an un-prompted transcript). Strips a common self-intro prefix
 *  ("my name is X" -> "X") and only rejects an empty or implausibly long reply. */
function captureNameAnswer(text: string): string | null {
  const trimmed = text
    .trim()
    .replace(/^(?:my name is|i'm|i am|this is|it's|its)\s+/i, "")
    .trim();
  if (!trimmed || trimmed.length > 80) return null;
  return trimmed;
}

/** Sprint 6.5 — Part 4: does this message carry ONLY identity information ("Krishna", "I'm Krishna",
 *  "Krishna here", "Call me Krishna", "Hi, mera naam Krishna hai.") with nothing left to route, or is it
 *  identity-plus-content ("I'm Krishna, I need HR help")? A plain word-count check rather than precise
 *  phrase-stripping: every identity-only example in the sprint brief is five words or fewer, and every
 *  identity-plus-content example is a separate turn from the identity itself, so this cheap heuristic
 *  never has to distinguish the two within a single long message. */
function isIdentityOnlyMessage(text: string): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length <= 6;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Travel Booking Closure Pass — Phase 6: `AgentService.execute()`'s return type is inferred as a large
 * union across its many `return {...}` sites — only a handful (e.g. the booking-completion path) declare
 * an `attachments` field, so TypeScript won't let plain property access narrow it. A type assertion here
 * is safe: every call site already treats the specialist's result as an untyped record for `.response`
 * access (no attachment shape is asserted or trusted beyond "is this an array" — `customerResponse` only
 * relays it opaquely, never interprets it).
 */
function specialistAttachments(result: unknown): Array<Record<string, unknown>> | undefined {
  const attachments = (result as { attachments?: unknown } | null)?.attachments;
  return Array.isArray(attachments) ? (attachments as Array<Record<string, unknown>>) : undefined;
}

function safeMetadata(value: unknown): Prisma.InputJsonValue {
  const metadata = record(value);
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([key]) => !/(secret|token|credential|prompt|memory|document)/i.test(key))
      .slice(0, 20)
  ) as Prisma.InputJsonValue;
}

function channelFor(input: AgentExecutionInput): ReceptionistChannel {
  return resolveConversationChannel({
    sourceType: input.source.type,
    requestedChannel: input.requestedChannel
  });
}

function title(text: string): string {
  const value = text.trim();
  return value ? value.slice(0, 160) : "AI Receptionist";
}

function attachmentMessage(attachments: SafeAttachmentMetadata[]): string {
  return attachments.length
    ? `Attached: ${attachments.map((item) => item.filename).join(", ")}`
    : "Customer request";
}

/** Routing-profile intent labels are customer/admin-facing metadata and may contain spaces (for
 * example, "Trip Planning"). Workforce delegation contracts intentionally accept only stable
 * identifier characters, so normalize the label at this integration boundary. */
function delegationTaskType(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
    .slice(0, 80);
  return normalized || fallback;
}

function safeCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "RECEPTIONIST_EXECUTION_FAILED";
  return /^[A-Z0-9_]+$/.test(value) ? value : "RECEPTIONIST_EXECUTION_FAILED";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
