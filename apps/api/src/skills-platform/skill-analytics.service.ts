import { Injectable } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { SkillRegistryService } from "./skill-registry.service";

export interface SkillAnalyticsFilters {
  from?: Date;
  to?: Date;
  skillKey?: string;
  pluginInstallationId?: string;
}

export interface SkillAnalyticsRow {
  skillKey: string;
  name: string;
  category: string;
  executions: number;
  completedExecutions: number;
  failedExecutions: number;
  successRate: number;
  failureRate: number;
  avgLatencyMs: number;
  creditsConsumed: number;
  totalTokens: number;
  employeesUsing: number;
  installed: boolean;
}

export interface SkillAnalyticsReport {
  scope: { organizationId: string; from: string | null; to: string | null };
  totals: {
    executions: number;
    creditsConsumed: number;
    totalTokens: number;
    successRate: number;
    failureRate: number;
    avgLatencyMs: number;
    employeesUsing: number;
    /** Always 1 in a tenant-isolated API — an organization can only ever see its own usage, never
     *  cross-tenant aggregate counts. Included so the response shape matches the requested metric
     *  set explicitly rather than silently omitting it. */
    organizationsUsing: 1;
  };
  perSkill: SkillAnalyticsRow[];
  topSkills: SkillAnalyticsRow[];
  leastUsed: SkillAnalyticsRow[];
  /** Proxy for "most installed" within a single tenant: the skill granted to the most employees. A
   *  per-organization API cannot report cross-tenant install counts (that would break tenant
   *  isolation), so this is the closest tenant-safe equivalent. */
  mostGranted: SkillAnalyticsRow[];
  mostFailed: SkillAnalyticsRow[];
  slowestSkills: SkillAnalyticsRow[];
}

/**
 * Sprint 6.1B Feature 4 — Skill Analytics. Reads exclusively from SkillRun/SkillInstallation/
 * EmployeeSkillGrant — the same billing/execution rows SkillsRuntimeService already writes — so
 * these numbers can never drift from what was actually billed and traced. No separate analytics
 * ledger, no duplicate aggregation pipeline.
 */
@Injectable()
export class SkillAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SkillRegistryService
  ) {}

  async getAnalytics(organizationId: string, filters: SkillAnalyticsFilters): Promise<SkillAnalyticsReport> {
    const where = {
      organizationId,
      ...(filters.skillKey ? { skillKey: filters.skillKey } : {}),
      ...(filters.pluginInstallationId ? { pluginInstallationId: filters.pluginInstallationId } : {}),
      ...(filters.from || filters.to
        ? { createdAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
        : {})
    };

    const runs = await this.prisma.skillRun.findMany({
      where,
      select: {
        skillKey: true,
        status: true,
        durationMs: true,
        creditsConsumed: true,
        totalTokens: true,
        pluginInstallationId: true
      }
    });

    const installations = await this.prisma.skillInstallation.findMany({
      where: { organizationId, deletedAt: null },
      select: { skillVersion: { select: { skill: { select: { key: true, name: true, category: true } } } } }
    });
    const installedByKey = new Map(installations.map((row) => [row.skillVersion.skill.key, row.skillVersion.skill]));

    const grants = await this.prisma.employeeSkillGrant.findMany({
      where: { organizationId, enabled: true },
      select: { pluginInstallationId: true, skillInstallation: { select: { skillVersion: { select: { skill: { select: { key: true } } } } } } }
    });
    const employeesByKey = new Map<string, Set<string>>();
    for (const grant of grants) {
      const key = grant.skillInstallation.skillVersion.skill.key;
      const set = employeesByKey.get(key) ?? new Set<string>();
      set.add(grant.pluginInstallationId);
      employeesByKey.set(key, set);
    }

    const skillKeys = new Set<string>([
      ...this.registry.keys(),
      ...installedByKey.keys(),
      ...runs.map((run) => run.skillKey)
    ]);

    const perSkill: SkillAnalyticsRow[] = [...skillKeys].map((skillKey) => {
      const skillRuns = runs.filter((run) => run.skillKey === skillKey);
      const completed = skillRuns.filter((run) => run.status === "COMPLETED");
      const failed = skillRuns.filter((run) => run.status === "FAILED");
      const manifest = this.registry.manifest(skillKey);
      const catalogEntry = installedByKey.get(skillKey);
      const totalDuration = skillRuns.reduce((sum, run) => sum + run.durationMs, 0);
      return {
        skillKey,
        name: catalogEntry?.name ?? manifest?.name ?? skillKey,
        category: catalogEntry?.category ?? manifest?.category ?? "unknown",
        executions: skillRuns.length,
        completedExecutions: completed.length,
        failedExecutions: failed.length,
        successRate: skillRuns.length > 0 ? round(completed.length / skillRuns.length) : 0,
        failureRate: skillRuns.length > 0 ? round(failed.length / skillRuns.length) : 0,
        avgLatencyMs: skillRuns.length > 0 ? Math.round(totalDuration / skillRuns.length) : 0,
        creditsConsumed: skillRuns.reduce((sum, run) => sum + run.creditsConsumed, 0),
        totalTokens: skillRuns.reduce((sum, run) => sum + run.totalTokens, 0),
        employeesUsing: employeesByKey.get(skillKey)?.size ?? 0,
        installed: installedByKey.has(skillKey)
      };
    });

    const totalExecutions = runs.length;
    const totalCompleted = runs.filter((run) => run.status === "COMPLETED").length;
    const totalFailed = runs.filter((run) => run.status === "FAILED").length;
    const totalDuration = runs.reduce((sum, run) => sum + run.durationMs, 0);
    const uniqueEmployees = new Set(runs.map((run) => run.pluginInstallationId).filter((id): id is string => Boolean(id)));

    return {
      scope: { organizationId, from: filters.from?.toISOString() ?? null, to: filters.to?.toISOString() ?? null },
      totals: {
        executions: totalExecutions,
        creditsConsumed: runs.reduce((sum, run) => sum + run.creditsConsumed, 0),
        totalTokens: runs.reduce((sum, run) => sum + run.totalTokens, 0),
        successRate: totalExecutions > 0 ? round(totalCompleted / totalExecutions) : 0,
        failureRate: totalExecutions > 0 ? round(totalFailed / totalExecutions) : 0,
        avgLatencyMs: totalExecutions > 0 ? Math.round(totalDuration / totalExecutions) : 0,
        employeesUsing: uniqueEmployees.size,
        organizationsUsing: 1
      },
      perSkill: perSkill.sort((a, b) => b.executions - a.executions),
      topSkills: [...perSkill].sort((a, b) => b.executions - a.executions).slice(0, 5),
      leastUsed: [...perSkill].sort((a, b) => a.executions - b.executions).slice(0, 5),
      mostGranted: [...perSkill].sort((a, b) => b.employeesUsing - a.employeesUsing).slice(0, 5),
      mostFailed: [...perSkill].filter((row) => row.executions > 0).sort((a, b) => b.failedExecutions - a.failedExecutions).slice(0, 5),
      slowestSkills: [...perSkill].filter((row) => row.executions > 0).sort((a, b) => b.avgLatencyMs - a.avgLatencyMs).slice(0, 5)
    };
  }

  async exportCsv(organizationId: string, filters: SkillAnalyticsFilters): Promise<string> {
    const report = await this.getAnalytics(organizationId, filters);
    const header = [
      "skillKey", "name", "category", "executions", "completedExecutions", "failedExecutions",
      "successRate", "failureRate", "avgLatencyMs", "creditsConsumed", "totalTokens", "employeesUsing", "installed"
    ];
    const lines = [header.join(",")];
    for (const row of report.perSkill) {
      lines.push(
        [
          csvCell(row.skillKey), csvCell(row.name), csvCell(row.category), row.executions, row.completedExecutions,
          row.failedExecutions, row.successRate, row.failureRate, row.avgLatencyMs, row.creditsConsumed,
          row.totalTokens, row.employeesUsing, row.installed
        ].join(",")
      );
    }
    return lines.join("\n");
  }
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
