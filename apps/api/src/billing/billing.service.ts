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
    const totalCredits = groups.reduce((s, g) => s + Math.ceil(((g._sum.totalTokens ?? 0) * 4) / 1000), 0);
    return groups.map((g) => {
      const cap = g.modelProvider?.toUpperCase() === "DETERMINISTIC" ? "TOOL_EXECUTION" : "CHAT_GENERATION";
      const credits = Math.ceil(((g._sum.totalTokens ?? 0) * 4) / 1000);
      return {
        capability: cap, displayName: CAPABILITY_LABELS[cap] ?? cap,
        creditsConsumed: credits,
        sharePercentage: totalCredits > 0 ? Math.round((credits / totalCredits) * 10000) / 100 : 0
      };
    });
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
