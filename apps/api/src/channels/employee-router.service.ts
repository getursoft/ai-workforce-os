import { Injectable } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { ChannelConnection } from "@prisma/client";
import type { EmployeeRoutingDecision, ConversationRoutingState } from "./employee-router.types";
import {
  DEFAULT_RECEPTIONIST_GREETING,
  DEFAULT_INTENT_QUESTION,
  DEFAULT_OUT_OF_SCOPE_MESSAGE,
  DEFAULT_AMBIGUOUS_MESSAGE,
  MAX_CLARIFICATION_ATTEMPTS,
  GREETING_PATTERNS
} from "./employee-router.types";

export interface EmployeeMetadata {
  id: string;
  slug: string;
  displayName: string;
  description: string;
}

const PROMPT_INJECTION_PATTERNS = [
  /\bignore\s+(all\s+)?(previous\s+)?instructions\b/i,
  /\breveal\s+(your\s+)?(system\s+)?prompt\b/i,
  /\bswitch\s+me\s+to\s+(employee|agent)\s+id\b/i,
  /\buse\s+employee\s+id\b/i,
  /\bact\s+as\s+(admin|administrator)\b/i,
  /\bdisclose\s+(access\s+)?token\b/i,
  /\bretrieve\s+(all\s+)?documents\b/i,
  /\bsearch\s+(all\s+)?organisation\s+documents\b/i,
  /\bcall\s+(the\s+)?admin\s+tool\b/i,
  /\bexecute\s+(an?\s+)?unauthorised\s+workflow\b/i,
  /\bbypass\s+routing\b/i,
  /\bshow\s+hidden\s+tools\b/i
];

@Injectable()
export class EmployeeRouterService {
  constructor(private readonly prisma: PrismaService) {}

  isGreeting(text: string): boolean {
    return GREETING_PATTERNS.some((p) => p.test(text.trim()));
  }

  isPromptInjection(text: string): boolean {
    return PROMPT_INJECTION_PATTERNS.some((p) => p.test(text));
  }

  sanitizeInput(text: string): string {
    return text.slice(0, 2000).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  }

  buildReceptionistGreeting(channel: ChannelConnection): string {
    return channel.receptionistGreeting ?? DEFAULT_RECEPTIONIST_GREETING;
  }

  buildIntentQuestion(channel: ChannelConnection): string {
    return channel.intentQuestion ?? DEFAULT_INTENT_QUESTION;
  }

  buildOutOfScopeMessage(channel: ChannelConnection): string {
    return channel.outOfScopeMessage ?? DEFAULT_OUT_OF_SCOPE_MESSAGE;
  }

  buildAmbiguousMessage(channel: ChannelConnection): string {
    return channel.ambiguousIntentMessage ?? DEFAULT_AMBIGUOUS_MESSAGE;
  }

  async getAvailableEmployees(organizationId: string, allowedIds: string[]): Promise<EmployeeMetadata[]> {
    if (allowedIds.length === 0) return [];
    const plugins = await this.prisma.plugin.findMany({
      where: { id: { in: allowedIds }, organizationId, status: "ACTIVE", deletedAt: null }
    });
    return plugins.map((p) => ({ id: p.id, slug: p.slug, displayName: p.displayName, description: p.description }));
  }

  async route(
    text: string,
    organizationId: string,
    channel: ChannelConnection,
    routingState: ConversationRoutingState | null
  ): Promise<{ decision: EmployeeRoutingDecision; responseText: string | null }> {
    const sanitized = this.sanitizeInput(text);

    if (this.isPromptInjection(sanitized)) {
      return {
        decision: { status: "NO_EMPLOYEE_AVAILABLE", confidence: 1, reasonCode: "PROMPT_INJECTION_DETECTED" },
        responseText: this.buildOutOfScopeMessage(channel)
      };
    }

    const allowedIds = (channel.allowedEmployeeIds as string[]) ?? [];
    const employees = await this.getAvailableEmployees(organizationId, allowedIds);

    if (employees.length === 0) {
      return {
        decision: { status: "NO_EMPLOYEE_AVAILABLE", confidence: 1, reasonCode: "NO_EMPLOYEES_CONFIGURED" },
        responseText: this.buildOutOfScopeMessage(channel)
      };
    }

    // Single employee: check if request is in-scope via keyword matching
    if (employees.length === 1) {
      const single = employees[0];
      if (!single) return { decision: { status: "NO_EMPLOYEE_AVAILABLE", confidence: 1, reasonCode: "UNEXPECTED_EMPTY" }, responseText: this.buildOutOfScopeMessage(channel) };
      return this.routeToSingleEmployee(sanitized, single, channel);
    }

    // Multiple employees: deterministic keyword-based routing
    return this.routeMultiEmployee(sanitized, employees, channel, routingState);
  }

  private routeToSingleEmployee(
    text: string,
    employee: EmployeeMetadata,
    channel: ChannelConnection
  ): { decision: EmployeeRoutingDecision; responseText: string | null } {
    const isInScope = this.isRequestInScope(text, employee);
    if (isInScope) {
      return {
        decision: {
          status: "ROUTED", employeeInstallationId: employee.id, confidence: 0.85,
          detectedIntent: employee.slug, reasonCode: "SINGLE_EMPLOYEE_IN_SCOPE"
        },
        responseText: null
      };
    }
    return {
      decision: {
        status: "OUT_OF_SCOPE", confidence: 0.9, candidateEmployeeIds: [employee.id],
        reasonCode: "OUT_OF_SCOPE_FOR_AVAILABLE_EMPLOYEE"
      },
      responseText: this.buildOutOfScopeMessage(channel)
    };
  }

  private routeMultiEmployee(
    text: string,
    employees: EmployeeMetadata[],
    channel: ChannelConnection,
    routingState: ConversationRoutingState | null
  ): { decision: EmployeeRoutingDecision; responseText: string | null } {
    const matches: Array<{ employee: EmployeeMetadata; score: number }> = [];

    for (const emp of employees) {
      const score = this.computeKeywordMatch(text, emp);
      if (score > 0) matches.push({ employee: emp, score });
    }

    matches.sort((a, b) => b.score - a.score);

    if (matches.length === 0) {
      return {
        decision: {
          status: "OUT_OF_SCOPE", confidence: 0.8, candidateEmployeeIds: employees.map((e) => e.id),
          reasonCode: "NO_KEYWORD_MATCH"
        },
        responseText: this.buildOutOfScopeMessage(channel)
      };
    }

    if (matches.length === 1) {
      const m = matches[0];
      if (!m) return { decision: { status: "AMBIGUOUS", confidence: 0, reasonCode: "UNEXPECTED_EMPTY" }, responseText: this.buildAmbiguousMessage(channel) };
      return {
        decision: {
          status: "ROUTED", employeeInstallationId: m.employee.id,
          confidence: m.score >= 3 ? 0.85 : 0.6,
          detectedIntent: m.employee.slug, reasonCode: "KEYWORD_MATCH"
        },
        responseText: null
      };
    }

    // Multiple matches — check for clarification limits
    const clarificationCount = routingState?.clarificationCount ?? 0;
    if (clarificationCount >= MAX_CLARIFICATION_ATTEMPTS) {
      return {
        decision: {
          status: "AMBIGUOUS", confidence: Math.max(...matches.map((m) => m.score)) / 5,
          candidateEmployeeIds: matches.map((m) => m.employee.id),
          reasonCode: "MAX_CLARIFICATION_EXCEEDED"
        },
        responseText: this.buildAmbiguousMessage(channel)
      };
    }

    // Ask clarification
    const names = matches.map((m) => m.employee.displayName);
    const question = names.length === 2
      ? `Is your question related to ${names[0]} or ${names[1]}?`
      : `Is your question related to ${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}?`;

    const topMatch = matches[0];
    if (!topMatch) return { decision: { status: "AMBIGUOUS", confidence: 0, reasonCode: "UNEXPECTED_EMPTY" }, responseText: this.buildAmbiguousMessage(channel) };
    return {
      decision: {
        status: "AMBIGUOUS", confidence: topMatch.score / 5,
        candidateEmployeeIds: matches.map((m) => m.employee.id),
        reasonCode: "MULTIPLE_MATCHES"
      },
      responseText: question
    };
  }

  private isRequestInScope(text: string, employee: EmployeeMetadata): boolean {
    const slug = employee.slug.toLowerCase();
    const desc = (employee.description ?? "").toLowerCase();
    const textLower = text.toLowerCase();

    const domainKeywords = this.extractDomainKeywords(slug, desc);
    return domainKeywords.some((kw) => textLower.includes(kw));
  }

  private computeKeywordMatch(text: string, employee: EmployeeMetadata): number {
    const textLower = text.toLowerCase();
    const slug = employee.slug.toLowerCase();
    const desc = (employee.description ?? "").toLowerCase();
    const display = employee.displayName.toLowerCase();

    let score = 0;
    const allKeywords = [slug, display, ...desc.split(/\s+/).filter((w) => w.length > 3)];

    for (const kw of allKeywords) {
      if (textLower.includes(kw)) score += kw.length > 5 ? 2 : 1;
    }

    const domainKeywords = this.extractDomainKeywords(slug, desc);
    for (const dk of domainKeywords) {
      if (textLower.includes(dk)) score += 3;
    }

    return score;
  }

  private extractDomainKeywords(slug: string, description: string): string[] {
    const combined = `${slug} ${description}`.toLowerCase();
    const keywords: string[] = [];
    if (/travel|trip|flight|hotel|holiday|booking|vacation|tour/i.test(combined)) {
      keywords.push("travel", "trip", "flight", "hotel", "holiday", "booking", "vacation", "tour", "plan");
    }
    if (/it\s*support|vpn|computer|laptop|password|network|software|hardware|tech/i.test(combined)) {
      keywords.push("vpn", "computer", "laptop", "password", "network", "software", "it support", "tech support");
    }
    if (/hr|human\s*resource|policy|leave|maternity|paternity|hiring|payroll|benefit/i.test(combined)) {
      keywords.push("hr", "human resource", "leave", "maternity", "paternity", "policy", "payroll", "benefit", "hiring");
    }
    if (/sales|sell|purchase|product|pricing|quote|order|invoice/i.test(combined)) {
      keywords.push("sales", "sell", "purchase", "product", "pricing", "quote", "order");
    }
    if (/support|customer\s*service|helpdesk|ticket|complaint|issue/i.test(combined)) {
      keywords.push("support", "customer service", "helpdesk", "ticket", "complaint");
    }
    return [...new Set(keywords)];
  }
}
