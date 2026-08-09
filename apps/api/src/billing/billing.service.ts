import { Injectable } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";

export interface UsageSummary {
  plan: { code: string; name: string } | null;
  billingCycle: { start: string; end: string } | null;
  currency: string;
  monthlyAllowanceCredits: number;
  usedCredits: number;
  remainingCredits: number;
  usagePercentage: number;
  estimatedOverageAmountMinor: number;
  threshold: "NORMAL" | "INFORMATIONAL" | "WARNING" | "LIMIT_REACHED" | "OVERAGE";
  tokens: { input: number; output: number; cachedInput: number; reasoning: number; total: number };
  totalRequests: number;
}

export interface TrendPoint {
  date: string;
  creditsConsumed: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
}

export interface EmployeeTrend {
  employees: string[];
  requestPoints: Array<Record<string, string | number>>;
  points: Array<Record<string, string | number>>;
  tokenPoints: Array<Record<string, string | number>>;
  timeSavedPoints: Array<Record<string, string | number>>;
  assumedMinutesSavedPerExecution: number;
}

export interface UserUsage {
  userId: string;
  name: string;
  email: string;
  creditsConsumed: number;
  sharePercentage: number;
  inputTokens: number;
  outputTokens: number;
  executions: number;
}

export interface EmployeeUsage {
  pluginInstallationId: string;
  employeeName: string;
  creditsConsumed: number;
  sharePercentage: number;
  inputTokens: number;
  outputTokens: number;
  executions: number;
}

export interface CapabilityUsage {
  capability: string;
  displayName: string;
  creditsConsumed: number;
  sharePercentage: number;
}

export interface ModelUsage {
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  creditsConsumed: number;
  internalCostAmountMinor: number | null;
}

/** Illustrative estimate of manual handling time a completed AI execution replaces — there is no
 *  measured baseline, so this is a deliberately conservative, disclosed assumption, not a fact. */
const ASSUMED_MINUTES_SAVED_PER_EXECUTION = 8;

/** The one place tokens are converted to credits — shared by usage reporting (this file) and
 *  BillingEnforcementService so the number an org is billed on and the number that gates execution can
 *  never drift apart. */
export function tokensToCredits(totalTokens: number): number {
  return Math.ceil((totalTokens * 4) / 1000);
}

const CAPABILITY_LABELS: Record<string, string> = {
  CHAT_GENERATION: "Chat Generation",
  KNOWLEDGE_RAG: "Knowledge / RAG",
  TOOL_EXECUTION: "Tool Execution",
  EMBEDDINGS: "Embeddings",
  VOICE: "Voice",
  WORKFLOW: "Workflow",
  CHANNEL: "Channel"
};

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(organizationId: string, startOverride?: Date, endOverride?: Date): Promise<UsageSummary> {
    const sub = await this.prisma.organisationSubscription.findUnique({
      where: { organizationId }, include: { plan: true }
    });
    const plan = sub?.plan ?? null;
    const allowance = sub?.monthlyCreditAllowanceOverride ?? plan?.monthlyCreditAllowance ?? 0;
    const cycleStart = sub?.billingCycleStart ?? new Date(0);
    const cycleEnd = sub?.billingCycleEnd ?? new Date(0);
    const now = new Date();
    const start = startOverride ?? cycleStart;
    const end = endOverride ?? (sub ? cycleEnd : new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));

    const agg = await this.prisma.agentExecution.aggregate({
      where: { organizationId, status: "COMPLETED", createdAt: { gte: start, lte: end } },
      _sum: { inputTokens: true, outputTokens: true, totalTokens: true },
      _count: { id: true }
    });
    const usedCredits = Math.ceil(((agg._sum.totalTokens ?? 0) * 4) / 1000);
    const remaining = Math.max(0, allowance - usedCredits);
    const pct = allowance > 0 ? Math.round((usedCredits / allowance) * 10000) / 100 : 0;
    const threshold = pct >= 100 ? "OVERAGE" : pct >= 85 ? "WARNING" : pct >= 70 ? "INFORMATIONAL" : "NORMAL";
    const estOverage = pct >= 100 && sub?.overageEnabledOverride !== false && plan?.overageEnabled
      ? ((usedCredits - allowance) * (plan.overageRateMicrosPerCredit ?? 0)) / 1000
      : 0;
    return {
      plan: plan ? { code: plan.code, name: plan.name } : null,
      billingCycle: sub ? { start: start.toISOString(), end: end.toISOString() } : null,
      currency: "INR",
      monthlyAllowanceCredits: allowance,
      usedCredits, remainingCredits: remaining, usagePercentage: pct,
      estimatedOverageAmountMinor: Math.round(estOverage), threshold,
      tokens: {
        input: agg._sum.inputTokens ?? 0,
        output: agg._sum.outputTokens ?? 0,
        cachedInput: 0, reasoning: 0,
        total: agg._sum.totalTokens ?? 0
      },
      totalRequests: agg._count.id
    };
  }

  async byEmployee(organizationId: string, start: Date, end: Date): Promise<EmployeeUsage[]> {
    const groups = await this.prisma.agentExecution.groupBy({
      by: ["pluginInstallationId"], where: { organizationId, status: "COMPLETED", createdAt: { gte: start, lte: end } },
      _sum: { inputTokens: true, outputTokens: true, totalTokens: true },
      _count: { id: true }, orderBy: { _sum: { totalTokens: "desc" } }
    });
    const ids = groups.map((g) => g.pluginInstallationId);
    const plugins = ids.length ? await this.prisma.plugin.findMany({
      where: { id: { in: ids } }, select: { id: true, displayName: true }
    }) : [];
    const pluginMap = new Map(plugins.map((p) => [p.id, p.displayName]));
    const totalCredits = groups.reduce((s, g) => s + Math.ceil(((g._sum.totalTokens ?? 0) * 4) / 1000), 0);
    return groups.map((g) => {
      const credits = Math.ceil(((g._sum.totalTokens ?? 0) * 4) / 1000);
      return {
        pluginInstallationId: g.pluginInstallationId,
        employeeName: pluginMap.get(g.pluginInstallationId) ?? "Removed Employee",
        creditsConsumed: credits,
        sharePercentage: totalCredits > 0 ? Math.round((credits / totalCredits) * 10000) / 100 : 0,
        inputTokens: g._sum.inputTokens ?? 0,
        outputTokens: g._sum.outputTokens ?? 0,
        executions: g._count.id
      };
    });
  }

  async byCapability(organizationId: string, start: Date, end: Date): Promise<CapabilityUsage[]> {
    const groups = await this.prisma.agentExecution.groupBy({
      by: ["modelProvider"], where: { organizationId, status: "COMPLETED", createdAt: { gte: start, lte: end } },
      _sum: { totalTokens: true }, orderBy: { _sum: { totalTokens: "desc" } }
    });
    // Multiple raw modelProvider values (different providers/models, or the same provider recorded with
    // different casing across executions) can map to the SAME coarse capability bucket below — merge by
    // that bucket before returning, or the same "Chat Generation" label appears as several separate rows
    // with different percentages (a real bug: 97%/1.8%/1% "Chat Generation" rows that should have been one).
    const byCapability = new Map<string, number>();
    for (const g of groups) {
      const cap = g.modelProvider?.toUpperCase() === "DETERMINISTIC" ? "TOOL_EXECUTION" : "CHAT_GENERATION";
      byCapability.set(cap, (byCapability.get(cap) ?? 0) + (g._sum.totalTokens ?? 0));
    }
    const totalCredits = [...byCapability.values()].reduce((s, tokens) => s + Math.ceil((tokens * 4) / 1000), 0);
    return [...byCapability.entries()]
      .map(([cap, tokens]) => {
        const credits = Math.ceil((tokens * 4) / 1000);
        return {
          capability: cap, displayName: CAPABILITY_LABELS[cap] ?? cap,
          creditsConsumed: credits,
          sharePercentage: totalCredits > 0 ? Math.round((credits / totalCredits) * 10000) / 100 : 0
        };
      })
      .sort((a, b) => b.creditsConsumed - a.creditsConsumed);
  }

  async byModel(organizationId: string, start: Date, end: Date): Promise<ModelUsage[]> {
    const groups = await this.prisma.agentExecution.groupBy({
      by: ["modelProvider", "model"],
      where: { organizationId, status: "COMPLETED", createdAt: { gte: start, lte: end }, modelProvider: { not: null } },
      _sum: { inputTokens: true, outputTokens: true, totalTokens: true },
      orderBy: { _sum: { totalTokens: "desc" } }
    });
    return groups.map((g) => ({
      provider: g.modelProvider ?? "unknown", model: g.model ?? "unknown",
      inputTokens: g._sum.inputTokens ?? 0, cachedInputTokens: 0,
      outputTokens: g._sum.outputTokens ?? 0, reasoningTokens: 0,
      totalTokens: g._sum.totalTokens ?? 0,
      creditsConsumed: Math.ceil(((g._sum.totalTokens ?? 0) * 4) / 1000),
      internalCostAmountMinor: null
    }));
  }

  async trend(organizationId: string, start: Date, end: Date): Promise<TrendPoint[]> {
    const rows = await this.prisma.agentExecution.findMany({
      where: { organizationId, status: "COMPLETED", createdAt: { gte: start, lte: end } },
      select: { createdAt: true, inputTokens: true, outputTokens: true, totalTokens: true },
      orderBy: { createdAt: "asc" }
    });
    const daily = new Map<string, { credits: number; input: number; output: number; total: number; requests: number }>();
    for (const r of rows) {
      const day = r.createdAt.toISOString().slice(0, 10);
      const entry = daily.get(day) ?? { credits: 0, input: 0, output: 0, total: 0, requests: 0 };
      entry.credits += Math.ceil(((r.totalTokens ?? 0) * 4) / 1000);
      entry.input += r.inputTokens ?? 0;
      entry.output += r.outputTokens ?? 0;
      entry.total += r.totalTokens ?? 0;
      entry.requests += 1;
      daily.set(day, entry);
    }
    const points: TrendPoint[] = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 10);
      const entry = daily.get(key);
      points.push({
        date: key,
        creditsConsumed: entry?.credits ?? 0,
        inputTokens: entry?.input ?? 0,
        outputTokens: entry?.output ?? 0,
        totalTokens: entry?.total ?? 0,
        requests: entry?.requests ?? 0
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return points;
  }

  /** Same daily buckets as `trend`, split per AI Employee — one series per employee for a multi-line chart. */
  async trendByEmployee(organizationId: string, start: Date, end: Date): Promise<EmployeeTrend> {
    const rows = await this.prisma.agentExecution.findMany({
      where: { organizationId, status: "COMPLETED", createdAt: { gte: start, lte: end } },
      select: { createdAt: true, totalTokens: true, pluginInstallationId: true },
      orderBy: { createdAt: "asc" }
    });
    const pluginIds = [...new Set(rows.map((r) => r.pluginInstallationId))];
    const plugins = pluginIds.length
      ? await this.prisma.plugin.findMany({
          where: { id: { in: pluginIds } },
          select: { id: true, displayName: true }
        })
      : [];
    const nameById = new Map(plugins.map((p) => [p.id, p.displayName]));
    const employees = [...new Set(plugins.map((p) => p.displayName))].sort();

    const dailyCredits = new Map<string, Map<string, number>>();
    const dailyTokens = new Map<string, Map<string, number>>();
    const dailyExecutionCounts = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const day = r.createdAt.toISOString().slice(0, 10);
      const name = nameById.get(r.pluginInstallationId) ?? "Removed Employee";
      const tokens = r.totalTokens ?? 0;
      const credits = Math.ceil((tokens * 4) / 1000);
      const creditTotals = dailyCredits.get(day) ?? new Map<string, number>();
      creditTotals.set(name, (creditTotals.get(name) ?? 0) + credits);
      dailyCredits.set(day, creditTotals);
      const tokenTotals = dailyTokens.get(day) ?? new Map<string, number>();
      tokenTotals.set(name, (tokenTotals.get(name) ?? 0) + tokens);
      dailyTokens.set(day, tokenTotals);
      const executionTotals = dailyExecutionCounts.get(day) ?? new Map<string, number>();
      executionTotals.set(name, (executionTotals.get(name) ?? 0) + 1);
      dailyExecutionCounts.set(day, executionTotals);
    }
    const dailyHoursSaved = new Map<string, Map<string, number>>();
    for (const [day, executionTotals] of dailyExecutionCounts) {
      const hoursByEmployee = new Map<string, number>();
      for (const [name, count] of executionTotals) {
        hoursByEmployee.set(name, Math.round(((count * ASSUMED_MINUTES_SAVED_PER_EXECUTION) / 60) * 100) / 100);
      }
      dailyHoursSaved.set(day, hoursByEmployee);
    }

    const buildSeries = (daily: Map<string, Map<string, number>>): Array<Record<string, string | number>> => {
      const points: Array<Record<string, string | number>> = [];
      const cursor = new Date(start);
      while (cursor <= end) {
        const key = cursor.toISOString().slice(0, 10);
        const dayTotals = daily.get(key);
        const point: Record<string, string | number> = { date: key };
        for (const name of employees) point[name] = dayTotals?.get(name) ?? 0;
        points.push(point);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      return points;
    };

    return {
      employees,
      requestPoints: buildSeries(dailyExecutionCounts),
      points: buildSeries(dailyCredits),
      tokenPoints: buildSeries(dailyTokens),
      timeSavedPoints: buildSeries(dailyHoursSaved),
      assumedMinutesSavedPerExecution: ASSUMED_MINUTES_SAVED_PER_EXECUTION
    };
  }

  async byUser(organizationId: string, start: Date, end: Date): Promise<UserUsage[]> {
    const groups = await this.prisma.agentExecution.groupBy({
      by: ["userId"],
      where: { organizationId, status: "COMPLETED", createdAt: { gte: start, lte: end } },
      _sum: { inputTokens: true, outputTokens: true, totalTokens: true },
      _count: { id: true },
      orderBy: { _sum: { totalTokens: "desc" } }
    });
    const userIds = groups.map((g) => g.userId).filter(Boolean) as string[];
    const users = userIds.length ? await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, firstName: true, lastName: true, email: true }
    }) : [];
    const userMap = new Map(users.map((u) => [u.id, u]));
    const totalCredits = groups.reduce((s, g) => s + Math.ceil(((g._sum.totalTokens ?? 0) * 4) / 1000), 0);
    return groups.map((g) => {
      const user = g.userId ? userMap.get(g.userId) : null;
      const credits = Math.ceil(((g._sum.totalTokens ?? 0) * 4) / 1000);
      return {
        userId: g.userId ?? "system",
        name: user ? `${user.firstName} ${user.lastName ?? ""}`.trim() : "System",
        email: user?.email ?? "system",
        creditsConsumed: credits,
        sharePercentage: totalCredits > 0 ? Math.round((credits / totalCredits) * 10000) / 100 : 0,
        inputTokens: g._sum.inputTokens ?? 0,
        outputTokens: g._sum.outputTokens ?? 0,
        executions: g._count.id
      };
    });
  }

  billingPeriod(sub?: { billingCycleStart: Date; billingCycleEnd: Date }): { start: Date; end: Date } {
    if (sub) return { start: sub.billingCycleStart, end: sub.billingCycleEnd };
    const now = new Date();
    return { start: new Date(now.getUTCFullYear(), now.getUTCMonth(), 1), end: new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999) };
  }
}
