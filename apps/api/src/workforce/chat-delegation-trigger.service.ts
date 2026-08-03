import { Injectable, Logger } from "@nestjs/common";
import { EmployeeRegistry } from "./employee-registry";
import { EmployeeCollaborationRouter } from "./employee-collaboration-router";
import { WorkforceOrchestratorService } from "./workforce-orchestrator.service";
import type { TraceContext } from "../observability/trace-context";

export interface ChatDelegationResult {
  delegated: boolean;
  targetEmployeeInstallationId?: string;
  targetDisplayName?: string;
  contribution?: string;
  taskId?: string;
}

/**
 * Sprint 4.7 Phase 0: closes the one gap Sprint 4.6 disclosed — the normal chat pipeline never invoked
 * WorkforceOrchestratorService automatically. This is a structured, bounded trigger, not a free-form
 * classifier: it only fires when the user's OWN message text contains an explicit consult phrase
 * ("check X with <domain>", "ask <domain> ...", "have <domain> review/verify/confirm ...") AND
 * EmployeeCollaborationRouter — the same routing engine synchronous/async delegation already uses —
 * scores an installed, active employee above its normal confidence threshold for that domain. Nothing
 * here is a hardcoded employee name; the domain phrase is only ever matched against installed employees'
 * own declared aliases/routingDomains via the router's existing DOMAIN_KEYWORD_MATCH scoring.
 *
 * Loop safety: callers must only invoke this for actor.type "USER" or "CHANNEL" turns — never for the
 * "SYSTEM" actor a delegated task's own execution runs as (see WorkforceOrchestratorService.dispatch()).
 * A delegated child task's server-generated instructions are never re-scanned for a consult phrase.
 */
@Injectable()
export class ChatDelegationTriggerService {
  private readonly logger = new Logger(ChatDelegationTriggerService.name);

  private static readonly CONSULT_PATTERNS: RegExp[] = [
    /\b(?:check|verify|confirm)\b.{0,60}?\bwith\b\s+([A-Za-z][A-Za-z\s&/-]{1,40}?)(?:[.?!]|$)/i,
    /\bask\b\s+([A-Za-z][A-Za-z\s&/-]{1,40}?)\s+(?:what|if|whether|about|for|to)\b/i,
    /\bhave\b\s+([A-Za-z][A-Za-z\s&/-]{1,40}?)\s+(?:review|check|verify|confirm|look\s+at)\b/i
  ];

  constructor(
    private readonly registry: EmployeeRegistry,
    private readonly router: EmployeeCollaborationRouter,
    private readonly orchestrator: WorkforceOrchestratorService
  ) {}

  detectConsultPhrase(text: string): { domainHint: string } | null {
    for (const pattern of ChatDelegationTriggerService.CONSULT_PATTERNS) {
      const match = pattern.exec(text);
      if (match?.[1]) return { domainHint: match[1].trim() };
    }
    return null;
  }

  async maybeDelegate(input: {
    organizationId: string;
    primaryEmployeeInstallationId: string;
    conversationId: string;
    messageText: string;
    traceContext?: TraceContext | null;
  }): Promise<ChatDelegationResult> {
    const signal = this.detectConsultPhrase(input.messageText);
    if (!signal) return { delegated: false };

    const primary = await this.registry.getInstalled(input.organizationId, input.primaryEmployeeInstallationId);
    if (!primary) return { delegated: false };

    const contract = {
      // Deliberately NOT "GENERAL_QUERY" — every installed employee is auto-declared to support that
      // task type by default (see plugin.service.ts), which would make EmployeeCollaborationRouter's
      // TASK_TYPE_MATCH (0.95 confidence) fire for any installed employee regardless of domain, defeating
      // the whole point of routing this consult to the RIGHT specialist. A distinct task type forces the
      // router to fall through to its capability/domain-keyword scoring instead.
      taskType: "CONSULT_REQUEST",
      objective: input.messageText.slice(0, 2000),
      input: { consultTopic: signal.domainHint, requestedBy: primary.displayName }
    };

    const routing = await this.router.route(input.organizationId, input.primaryEmployeeInstallationId, contract);
    if (!routing.shouldDelegate || !routing.targetEmployeeInstallationId) return { delegated: false };

    try {
      const task = await this.orchestrator.delegate({
        organizationId: input.organizationId,
        sourceEmployeeInstallationId: input.primaryEmployeeInstallationId,
        targetEmployeeInstallationId: routing.targetEmployeeInstallationId,
        requestedByActorType: "EMPLOYEE",
        requestedByActorId: input.primaryEmployeeInstallationId,
        contract,
        mode: "SYNCHRONOUS",
        traceContext: input.traceContext ?? null
      });
      const target = await this.registry.getInstalled(input.organizationId, routing.targetEmployeeInstallationId);
      const contribution = task.status === "COMPLETED" ? task.resultSummary : null;
      return {
        delegated: true,
        targetEmployeeInstallationId: routing.targetEmployeeInstallationId,
        targetDisplayName: target?.displayName ?? "a specialist",
        ...(contribution ? { contribution } : {}),
        taskId: task.id
      };
    } catch (error) {
      // A failed internal consult must never break the primary employee's own reply to the customer.
      this.logger.warn({
        event: "ChatDelegationTriggerFailed",
        organizationId: input.organizationId,
        primaryEmployeeInstallationId: input.primaryEmployeeInstallationId,
        error: error instanceof Error ? error.message : String(error)
      });
      return { delegated: false };
    }
  }
}
