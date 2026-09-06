import { Injectable } from "@nestjs/common";
import Ajv from "ajv";
import { PluginAiService } from "../plugins/plugin-ai.service";
import type { WorkforceDirectoryEntry } from "./workforce-directory.service";
import { WorkforceDirectoryService } from "./workforce-directory.service";
import type {
  ReceptionistRouteDecision,
  ReceptionistRouteInput,
  ReceptionistRouteType
} from "./receptionist.types";

const RETURN_PATTERNS = [
  /\b(?:go back|main menu|talk to (?:the )?receptionist|back to (?:the )?receptionist|i need something else)\b/i,
  /main kisi aur department se baat karna chahta hoon/i,
  /receptionist se baat/i
];
const GREETING = /^(?:hi|hello|hey|namaste|namaskar|good\s+(?:morning|afternoon|evening))[!.\s]*$/i;
const DIRECTORY_QUESTION =
  /\b(?:what can (?:you|krevia) (?:do|help)|who can help|available (?:team|employee|specialist)|which departments?)\b/i;
// Sprint 6.6 — Part 8: "aur"/"bhi" are the Hinglish equivalents of "and also"/"also" — same generic,
// employee-agnostic multi-intent marker, not new vocabulary in kind.
const MULTI_SIGNAL = /\b(?:and also|also|as well as|along with|and|aur|bhi)\b/i;
// Sprint 6.3 — Part 3: a customer explicitly abandoning the current topic ("forget the trip", "never
// mind that", "instead I need...") is a strong, generic (non-domain-specific) switch signal — but it has
// a perverse side effect on pure keyword scoring: naming the OLD topic in order to reject it ("forget the
// TRIP") makes the active specialist's own score go UP, not down, which can defeat the ordinary
// margin-based switch check below. This pattern exists purely to recognize that pivot phrasing itself,
// never any specific employee's vocabulary.
//
// Sprint 6.6 — Part 8: extended with Hinglish pivot phrasing ("trip rehne do", "travel chhodo", "ab
// finance help chahiye", "HR se baat karni hai", "HR pe chalo") — like the English patterns above, these
// only ever recognize the PIVOT LANGUAGE itself, never a specific employee's vocabulary; the actual
// destination employee is still decided entirely by ordinary scoring (`alternative!.score >= 5`) at the
// call site, so a loosely-matching Hinglish phrase can never by itself cause a false switch.
const PIVOT_SIGNAL =
  /\b(?:forget (?:it|that|this|about|the\s+\w+)|never\s?mind|nonetheless|instead[,]?\s+i\b|actually[,]?\s+i\s+(?:need|want)|not\s+(?:about|regarding)\s+(?:that|this|it)|\w+\s+rehne\s+do|chhodo|ab\s+\w+(?:\s+\w+)?\s+chahiye|se\s+baat\s+karni\s+hai|pe\s+chalo)\b/i;

interface LlmClassification {
  employeeCapability: string | null;
  secondaryCapabilities: string[];
  intent: string | null;
  confidence: number;
  reasonCode: string;
}

@Injectable()
export class ReceptionistRouteDecisionValidator {
  private readonly validate = new Ajv({ allErrors: true, strict: true }).compile({
    type: "object",
    additionalProperties: false,
    required: [
      "routeType",
      "primaryEmployeeInstallationId",
      "secondaryEmployeeInstallationIds",
      "capability",
      "intent",
      "confidence",
      "decisionSource",
      "reasonCode",
      "clarificationQuestion",
      "handoffMode"
    ],
    properties: {
      routeType: {
        enum: [
          "ROUTE",
          "CLARIFY",
          "CONTINUE_HANDOFF",
          "MULTI_EMPLOYEE",
          "RECEPTIONIST_RESPONSE",
          "UNSUPPORTED"
        ]
      },
      primaryEmployeeInstallationId: { type: ["string", "null"] },
      secondaryEmployeeInstallationIds: { type: "array", items: { type: "string" } },
      capability: { type: ["string", "null"] },
      intent: { type: ["string", "null"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      decisionSource: { enum: ["DETERMINISTIC", "LLM", "ACTIVE_HANDOFF"] },
      reasonCode: { type: "string", minLength: 1, maxLength: 120 },
      clarificationQuestion: { type: ["string", "null"] },
      handoffMode: { enum: ["DELEGATE_AND_RETURN", "TRANSFER_SESSION", "PARALLEL", null] },
      usage: {
        type: "object",
        additionalProperties: false,
        required: ["provider", "model", "inputTokens", "outputTokens", "totalTokens"],
        properties: {
          provider: { type: "string" },
          model: { type: "string" },
          inputTokens: { type: "integer", minimum: 0 },
          outputTokens: { type: "integer", minimum: 0 },
          totalTokens: { type: "integer", minimum: 0 }
        }
      }
    }
  });

  assert(decision: ReceptionistRouteDecision): ReceptionistRouteDecision {
    if (!this.validate(decision)) throw new Error("RECEPTIONIST_ROUTE_DECISION_INVALID");
    return decision;
  }
}

@Injectable()
export class ReceptionistRoutingService {
  constructor(
    private readonly directory: WorkforceDirectoryService,
    private readonly pluginAi: PluginAiService,
    private readonly decisions: ReceptionistRouteDecisionValidator
  ) {}

  async route(input: ReceptionistRouteInput): Promise<ReceptionistRouteDecision> {
    const employees = await this.directory.eligible(
      input.organizationId,
      input.channel,
      input.receptionistInstallationId
    );
    const message = sanitize(input.message);

    if (GREETING.test(message)) {
      return this.valid(decision("RECEPTIONIST_RESPONSE", "DETERMINISTIC", 1, "GREETING"));
    }
    if (RETURN_PATTERNS.some((pattern) => pattern.test(message))) {
      return this.valid(
        decision("RECEPTIONIST_RESPONSE", "ACTIVE_HANDOFF", 1, "RETURN_TO_RECEPTIONIST")
      );
    }
    if (DIRECTORY_QUESTION.test(message)) {
      return this.valid(
        decision("RECEPTIONIST_RESPONSE", "DETERMINISTIC", 1, "WORKFORCE_DIRECTORY_REQUEST")
      );
    }
    // Travel Booking Closure Pass — Phase 2: pending-input ownership takes priority over domain-switch
    // scoring entirely — computed by the caller (see SpecialistPendingInputRegistry.isSatisfiedBy) BEFORE
    // this call, since it needs a DB read the routing service itself has no reason to perform on every
    // turn. Checked ahead of the scoring-based active-handoff-precedence block below (never reached for
    // this turn) so a coincidental vocabulary collision — e.g. "share it here" containing "it", which is
    // also IT Support's own domain keyword — can never hijack a turn that is plainly answering the active
    // specialist's own structured question.
    if (input.currentHandoff && input.pendingInputSatisfied) {
      return this.valid({
        ...decision("CONTINUE_HANDOFF", "ACTIVE_HANDOFF", 1, "PENDING_INPUT_OWNERSHIP"),
        primaryEmployeeInstallationId: input.currentHandoff.targetEmployeeInstallationId,
        capability: input.currentHandoff.routingCapability,
        intent: input.currentHandoff.routingIntent,
        handoffMode: "TRANSFER_SESSION"
      });
    }
    if (employees.length === 0) {
      return this.valid(decision("UNSUPPORTED", "DETERMINISTIC", 1, "NO_ELIGIBLE_EMPLOYEE"));
    }

    const scored = scoreEmployees(message, employees);
    let scoredForDecision = scored;
    if (input.currentHandoff) {
      const currentScore =
        scored.find(
          ({ employee }) =>
            employee.pluginInstallationId === input.currentHandoff?.targetEmployeeInstallationId
        )?.score ?? 0;
      const alternative = scored.find(
        ({ employee }) =>
          employee.pluginInstallationId !== input.currentHandoff?.targetEmployeeInstallationId
      );
      // Fix (Travel Booking Closure Pass — Phase 2 revision): the stricter threshold introduced by an
      // earlier correction pass (score >= 8 AND a +6 margin) was a blunt guard against exactly the kind of
      // coincidental single-keyword collision that `pendingInputSatisfied` above now prevents
      // structurally and specifically (e.g. "share it here" vs. IT Support's own "it" domain keyword,
      // "yes above my budget" vs. Finance's "budget" alias — both now resolved via
      // SpecialistPendingInputRegistry BEFORE this code ever runs, whenever Travel actually has a matching
      // structured pending question). That blunt threshold had a real cost: it also blocked genuine,
      // unambiguous single-signal domain switches with no pending-input contract in play at all (e.g.
      // "help with my invoice" mid-Travel-handoff, score 6, correctly meant for Finance). Restored to the
      // original, more permissive formula — safe now that the specific collisions it was guarding against
      // have a dedicated, targeted fix instead of a global scoring penalty.
      const explicitMultiIntentSwitch = Boolean(alternative) && alternative!.score >= 5 && MULTI_SIGNAL.test(message);
      // Fix (Sprint 6.3 — Part 3): a bare single-keyword match ("budget", "invoice", "it") scores
      // identically whether it's a genuine new request OR an ordinary in-context follow-up to something
      // the ACTIVE specialist itself just said ("...your approximate budget?" -> "options above my
      // budget?") — score/margin alone can't tell these apart, since both shapes are a single weight-6
      // keyword hit with currentScore 0. `contextEcho` re-scores the specialist's own last reply against
      // the SAME alternative employee: if that employee's vocabulary ALSO matches what the specialist
      // itself just said, the word is almost certainly explained by the ongoing conversation, not a pivot
      // — so an implicit (score-only) switch is refused and the turn stays with the active specialist.
      // Never applies to `explicitMultiIntentSwitch` (a real domain switch stays a real domain switch),
      // and never applies when the specialist hasn't spoken yet (no recent message to echo against).
      const contextEcho =
        Boolean(alternative) && input.recentSpecialistMessage
          ? (scoreEmployees(input.recentSpecialistMessage, employees).find(
              ({ employee }) => employee.pluginInstallationId === alternative!.employee.pluginInstallationId
            )?.score ?? 0) > 0
          : false;
      const dominantImplicitSwitch =
        Boolean(alternative) &&
        alternative!.score >= 5 &&
        (currentScore === 0 || alternative!.score >= currentScore + 3) &&
        !contextEcho;
      // An explicit pivot phrase bypasses the margin check entirely (mirrors `explicitMultiIntentSwitch`)
      // — naming the abandoned topic to reject it ("forget the TRIP") should never count against the
      // switch just because it inflates the current specialist's own keyword score. Still requires
      // `!contextEcho`: a pivot phrase doesn't override the case where the alternative's own vocabulary
      // was actually just echoing the active specialist's own words.
      const explicitPivotSwitch =
        Boolean(alternative) && alternative!.score >= 5 && PIVOT_SIGNAL.test(message) && !contextEcho;
      const clearSwitch = explicitMultiIntentSwitch || dominantImplicitSwitch || explicitPivotSwitch;
      if (!clearSwitch) {
        return this.valid({
          ...decision("CONTINUE_HANDOFF", "ACTIVE_HANDOFF", 1, "ACTIVE_HANDOFF_PRECEDENCE"),
          primaryEmployeeInstallationId: input.currentHandoff.targetEmployeeInstallationId,
          capability: input.currentHandoff.routingCapability,
          intent: input.currentHandoff.routingIntent,
          handoffMode: "TRANSFER_SESSION"
        });
      }
      // An explicit pivot ("forget the trip") names the abandoned topic specifically to reject it, which
      // otherwise leaves the OLD specialist's own score inflated (e.g. "trip" itself matching Travel) and
      // competing with the genuine new target in the decision below — excluding it here is what actually
      // lets the switch land cleanly instead of only avoiding CONTINUE_HANDOFF and then landing on CLARIFY.
      if (explicitPivotSwitch && !explicitMultiIntentSwitch && !dominantImplicitSwitch) {
        scoredForDecision = scored.filter(
          ({ employee }) => employee.pluginInstallationId !== input.currentHandoff?.targetEmployeeInstallationId
        );
      }
    }

    const deterministic = deterministicDecision(scoredForDecision, message, input.minimumRoutingConfidence);
    if (deterministic.routeType === "ROUTE" || deterministic.routeType === "MULTI_EMPLOYEE") {
      return this.valid(deterministic);
    }

    let routingUsage: ReceptionistRouteDecision["usage"];
    if (input.llmRoutingEnabled) {
      const llm = await this.classifyWithLlm(input, employees).catch(() => null);
      if (llm) {
        routingUsage = llm.usage;
        const resolved = resolveLlmDecision(llm, employees, input.minimumRoutingConfidence);
        if (resolved) return this.valid({ ...resolved, usage: llm.usage });
      }
    }

    if (!input.clarificationEnabled) {
      return this.valid({
        ...decision("UNSUPPORTED", "DETERMINISTIC", 0, "LOW_CONFIDENCE"),
        ...(routingUsage ? { usage: routingUsage } : {})
      });
    }
    const candidates = scoredForDecision.filter(({ score }) => score > 0).slice(0, 2);
    return this.valid({
      ...decision("CLARIFY", "DETERMINISTIC", deterministic.confidence, deterministic.reasonCode),
      clarificationQuestion: clarification(candidates.map(({ employee }) => employee.displayName)),
      // Sprint 6.6 — Part 9: reuses the decision's own existing `secondaryEmployeeInstallationIds` field
      // (left empty for CLARIFY until now) to carry which employees the clarification question actually
      // offered — the Receptionist persists this so the next turn's short disambiguating reply can be
      // interpreted against the original message, not routed alone. Not a new field on the decision type.
      secondaryEmployeeInstallationIds: candidates.map(({ employee }) => employee.pluginInstallationId),
      ...(routingUsage ? { usage: routingUsage } : {})
    });
  }

  private async classifyWithLlm(
    input: ReceptionistRouteInput,
    employees: WorkforceDirectoryEntry[]
  ): Promise<LlmClassification & { usage: NonNullable<ReceptionistRouteDecision["usage"]> }> {
    const { provider } = await this.pluginAi.resolveProvider(
      input.organizationId,
      input.receptionistInstallationId,
      "ROUTING"
    );
    const profiles = employees.map((employee) => ({
      capabilities: employee.capabilities,
      intents: employee.supportedIntents,
      domains: employee.domains,
      aliases: employee.routingAliases,
      examples: employee.examples,
      negativeCapabilities: employee.negativeCapabilities,
      channelEligibility: employee.channelEligibility
    }));
    const result = await provider.complete({
      messages: [
        {
          role: "system",
          content:
            "Classify workforce intake. Return JSON only with employeeCapability, secondaryCapabilities, intent, confidence, reasonCode. Select only a supplied capability. Never return an employee id. Ask no questions and include no prose."
        },
        {
          role: "user",
          content: JSON.stringify({
            message: input.message.slice(0, 2000),
            conversationSummary: input.conversationSummary?.slice(0, 1000) ?? null,
            attachments: input.attachmentMetadata,
            channel: input.channel,
            currentHandoff: input.currentHandoff
              ? {
                  capability: input.currentHandoff.routingCapability,
                  intent: input.currentHandoff.routingIntent
                }
              : null,
            profiles
          })
        }
      ],
      temperature: 0,
      maxOutputTokens: 220
    });
    const parsed = parseLlmClassification(result.content);
    return {
      ...parsed,
      usage: {
        provider: result.provider,
        model: result.model,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        totalTokens:
          result.usage?.totalTokens ??
          (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0)
      }
    };
  }

  private valid(value: ReceptionistRouteDecision): ReceptionistRouteDecision {
    return this.decisions.assert(value);
  }
}

function deterministicDecision(
  scored: Array<{
    employee: WorkforceDirectoryEntry;
    score: number;
    capability: string | null;
    intent: string | null;
  }>,
  message: string,
  threshold: number
): ReceptionistRouteDecision {
  const first = scored[0];
  const second = scored[1];
  if (!first || first.score === 0)
    return decision("CLARIFY", "DETERMINISTIC", 0, "NO_PROFILE_MATCH");
  const confidence = confidenceFor(first.score, second?.score ?? 0);
  const distinctSecond = second && second.score >= 5 && second.score >= first.score - 2;
  if (distinctSecond && MULTI_SIGNAL.test(message)) {
    return {
      ...decision("MULTI_EMPLOYEE", "DETERMINISTIC", confidence, "MULTI_PROFILE_MATCH"),
      primaryEmployeeInstallationId: first.employee.pluginInstallationId,
      secondaryEmployeeInstallationIds: [second.employee.pluginInstallationId],
      capability: first.capability,
      intent: first.intent,
      handoffMode: "PARALLEL"
    };
  }
  if (distinctSecond || confidence < threshold) {
    return decision("CLARIFY", "DETERMINISTIC", confidence, "AMBIGUOUS_PROFILE_MATCH");
  }
  return {
    ...decision("ROUTE", "DETERMINISTIC", confidence, "PROFILE_SIGNAL_MATCH"),
    primaryEmployeeInstallationId: first.employee.pluginInstallationId,
    capability: first.capability,
    intent: first.intent,
    handoffMode: "TRANSFER_SESSION"
  };
}

function scoreEmployees(message: string, employees: WorkforceDirectoryEntry[]) {
  const text = normalize(message);
  return employees
    .map((employee) => {
      const signals: Array<{
        value: string;
        weight: number;
        capability?: string;
        intent?: string;
      }> = [
        ...employee.domains.map((value) => ({ value, weight: 6 })),
        ...employee.routingAliases.map((value) => ({ value, weight: 6 })),
        ...employee.capabilities.map((value) => ({
          value: readable(value),
          weight: 5,
          capability: value
        })),
        ...employee.skillCapabilities.map((value) => ({
          value: readable(value),
          weight: 5,
          capability: value
        })),
        ...employee.supportedIntents.map((value) => ({
          value: readable(value),
          weight: 4,
          intent: value
        })),
        ...employee.examples.map((value) => ({ value, weight: 2 }))
      ];
      let score = 0;
      let capability: string | null = employee.capabilities[0] ?? null;
      let intent: string | null = employee.supportedIntents[0] ?? null;
      for (const signal of signals) {
        if (!matches(text, signal.value)) continue;
        // Action + domain scoring: a specific multi-word phrase ("invoice payment", "review this
        // contract", "customer lead") encodes both the domain noun and the requested action, so it
        // out-weighs a generic single word ("help", "payment") that any number of employees could
        // plausibly share. Profile-driven, not hardcoded — any employee's own routing metadata gets
        // this boost purely from how specific its own declared phrases are.
        score += signal.weight * phraseSpecificity(signal.value);
        if (signal.capability) capability = signal.capability;
        if (signal.intent) intent = signal.intent;
      }
      for (const negative of employee.negativeCapabilities) {
        const readableNegative = readable(negative);
        if (matches(text, readableNegative))
          score = Math.max(0, score - 5 * phraseSpecificity(readableNegative));
      }
      return { employee, score, capability, intent };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.employee.routingPriority - left.employee.routingPriority ||
        left.employee.pluginInstallationId.localeCompare(right.employee.pluginInstallationId)
    );
}

function resolveLlmDecision(
  classification: LlmClassification,
  employees: WorkforceDirectoryEntry[],
  threshold: number
): ReceptionistRouteDecision | null {
  if (!classification.employeeCapability || classification.confidence < 0.6) return null;
  const primary = resolveCapability(classification.employeeCapability, employees);
  if (!primary) return null;
  const secondary = unique(
    classification.secondaryCapabilities
      .map((capability) => resolveCapability(capability, employees)?.pluginInstallationId ?? null)
      .filter((id): id is string => Boolean(id) && id !== primary.pluginInstallationId)
  );
  if (classification.confidence < threshold) return null;
  const routeType: ReceptionistRouteType = secondary.length ? "MULTI_EMPLOYEE" : "ROUTE";
  return {
    ...decision(routeType, "LLM", classification.confidence, classification.reasonCode),
    primaryEmployeeInstallationId: primary.pluginInstallationId,
    secondaryEmployeeInstallationIds: secondary,
    capability: classification.employeeCapability,
    intent: classification.intent,
    handoffMode: secondary.length ? "PARALLEL" : "TRANSFER_SESSION"
  };
}

function resolveCapability(capability: string, employees: WorkforceDirectoryEntry[]) {
  const wanted = normalize(capability);
  return employees.find((employee) =>
    [...employee.capabilities, ...employee.skillCapabilities, ...employee.supportedActions].some(
      (candidate) => normalize(candidate) === wanted
    )
  );
}

function parseLlmClassification(content: string): LlmClassification {
  const raw = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (
    !(value.employeeCapability === null || typeof value.employeeCapability === "string") ||
    !(value.intent === null || typeof value.intent === "string") ||
    typeof value.confidence !== "number" ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    typeof value.reasonCode !== "string"
  )
    throw new Error("RECEPTIONIST_LLM_OUTPUT_INVALID");
  return {
    employeeCapability: value.employeeCapability,
    secondaryCapabilities: Array.isArray(value.secondaryCapabilities)
      ? value.secondaryCapabilities.filter((item): item is string => typeof item === "string")
      : [],
    intent: value.intent,
    confidence: value.confidence,
    reasonCode: value.reasonCode.slice(0, 120)
  };
}

function decision(
  routeType: ReceptionistRouteType,
  source: ReceptionistRouteDecision["decisionSource"],
  confidence: number,
  reasonCode: string
): ReceptionistRouteDecision {
  return {
    routeType,
    primaryEmployeeInstallationId: null,
    secondaryEmployeeInstallationIds: [],
    capability: null,
    intent: null,
    confidence,
    decisionSource: source,
    reasonCode,
    clarificationQuestion: null,
    handoffMode: null
  };
}

function confidenceFor(first: number, second: number): number {
  if (first <= 0) return 0;
  if (second === 0 && first >= 5) return 0.92;
  const margin = Math.max(0, first - second);
  return Math.min(0.95, Math.max(0.5, 0.58 + margin * 0.06));
}

function clarification(names: string[]): string {
  if (names.length >= 2) return `Sure. Is this about ${names[0]}, or ${names[1]}?`;
  if (names[0])
    return `Could you share a little more detail so I can confirm whether ${names[0]} is the right specialist?`;
  return "Could you share a little more detail about what you need so I can connect you with the right specialist?";
}

function matches(text: string, signal: string): boolean {
  const normalized = normalize(signal);
  if (!normalized || normalized.length < 2) return false;
  if (` ${text} `.includes(` ${normalized} `)) return true;
  const words = new Set(text.split(" "));
  const meaningful = normalized.split(" ").filter((word) => word.length >= 4);
  return meaningful.length >= 2 && meaningful.every((word) => words.has(word));
}

/** Word count of a signal phrase, capped at 3x so a long example sentence can't dominate purely by
 *  length. A single generic word ("help", "payment") stays at the base weight; a 2-3 word phrase that
 *  names both a domain noun and an action ("invoice payment", "review this contract", "customer lead")
 *  scores proportionally higher — this is what lets deterministic scoring favor "contract review" over
 *  a bare "employment" match without any employee-specific if/else. */
function phraseSpecificity(value: string): number {
  const words = value.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(Math.max(words, 1), 3);
}

function readable(value: string): string {
  return value.replace(/[._-]+/g, " ");
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitize(value: string): string {
  return value.slice(0, 12_000).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
