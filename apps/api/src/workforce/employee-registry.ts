import { Injectable } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";

/**
 * Sprint 4.6 Phase 1/2 — a real-time view of one installed AI Employee, assembled entirely from the
 * existing Plugin installation row + its EmployeeRoutingProfile. Nothing here is hardcoded: the fields are
 * whatever the organization currently has installed and configured.
 */
export interface WorkforceEmployee {
  installationId: string;
  displayName: string;
  pluginSlug: string;
  status: string;
  employeeType: string | null;
  routingDomains: string[];
  aliases: string[];
  capabilities: string[];
  grantedPermissions: string[];
  availableTools: string[];
  supportedWorkflowTypes: string[];
  knowledgeScope: { collections: number; hasKnowledge: boolean };
  collaboration: {
    enabled: boolean;
    priority: number;
    supportsSynchronous: boolean;
    supportsAsynchronous: boolean;
    maximumExecutionTimeMs: number;
    supportedTaskTypes: string[];
    requiredCapabilities: string[];
    sensitiveActions: string[];
    defaultFailureBehaviour: string;
  };
}

@Injectable()
export class EmployeeRegistry {
  constructor(private readonly prisma: PrismaService) {}

  /** All installed, non-deleted employees for an organization — active or not (callers filter as needed). */
  async listInstalled(organizationId: string): Promise<WorkforceEmployee[]> {
    const plugins = await this.prisma.plugin.findMany({
      where: { organizationId, deletedAt: null },
      include: { employeeRoutingProfile: true },
      orderBy: { createdAt: "asc" }
    });
    const pluginIds = plugins.map((p) => p.id);
    const [workflowRows, knowledgeCounts] = await Promise.all([
      pluginIds.length
        ? this.prisma.workflowExecution.findMany({
            where: { pluginInstallationId: { in: pluginIds } },
            select: { pluginInstallationId: true, workflowType: true },
            distinct: ["pluginInstallationId", "workflowType"]
          })
        : Promise.resolve([]),
      pluginIds.length
        ? this.prisma.knowledgeCollection.groupBy({
            by: ["pluginInstallationId"],
            where: { pluginInstallationId: { in: pluginIds } },
            _count: { id: true }
          })
        : Promise.resolve([])
    ]);
    const workflowTypesByPlugin = new Map<string, Set<string>>();
    for (const row of workflowRows) {
      const set = workflowTypesByPlugin.get(row.pluginInstallationId) ?? new Set<string>();
      set.add(row.workflowType);
      workflowTypesByPlugin.set(row.pluginInstallationId, set);
    }
    const knowledgeByPlugin = new Map(knowledgeCounts.map((row) => [row.pluginInstallationId, row._count.id]));

    return plugins.map((plugin) => this.toWorkforceEmployee(plugin, workflowTypesByPlugin, knowledgeByPlugin));
  }

  async getInstalled(organizationId: string, installationId: string): Promise<WorkforceEmployee | null> {
    const plugin = await this.prisma.plugin.findFirst({
      where: { id: installationId, organizationId, deletedAt: null },
      include: { employeeRoutingProfile: true }
    });
    if (!plugin) return null;
    const [workflowRows, knowledgeCount] = await Promise.all([
      this.prisma.workflowExecution.findMany({
        where: { pluginInstallationId: plugin.id },
        select: { workflowType: true },
        distinct: ["workflowType"]
      }),
      this.prisma.knowledgeCollection.count({ where: { pluginInstallationId: plugin.id } })
    ]);
    const workflowTypesByPlugin = new Map([[plugin.id, new Set(workflowRows.map((r) => r.workflowType))]]);
    const knowledgeByPlugin = new Map([[plugin.id, knowledgeCount]]);
    return this.toWorkforceEmployee(plugin, workflowTypesByPlugin, knowledgeByPlugin);
  }

  private toWorkforceEmployee(
    plugin: {
      id: string;
      slug: string;
      displayName: string;
      status: string;
      manifest: unknown;
      grantedPermissions: unknown;
      employeeRoutingProfile: {
        employeeType: string | null;
        supportedDomains: unknown;
        routingKeywords: unknown;
        enabledForDelegation: boolean;
        delegationPriority: number;
        supportsSynchronousDelegation: boolean;
        supportsAsynchronousDelegation: boolean;
        maximumExecutionTimeMs: number;
        supportedTaskTypes: unknown;
        requiredCapabilities: unknown;
        sensitiveActions: unknown;
        defaultFailureBehaviour: string;
      } | null;
    },
    workflowTypesByPlugin: Map<string, Set<string>>,
    knowledgeByPlugin: Map<string, number>
  ): WorkforceEmployee {
    const manifest = (plugin.manifest as Record<string, unknown>) ?? {};
    const capabilities = asStringArray(manifest.capabilities);
    const tools = Array.isArray(manifest.tools)
      ? (manifest.tools as Array<{ name?: unknown }>)
          .map((tool) => (typeof tool?.name === "string" ? tool.name : null))
          .filter((name): name is string => name !== null)
      : [];
    const profile = plugin.employeeRoutingProfile;
    const collections = knowledgeByPlugin.get(plugin.id) ?? 0;
    return {
      installationId: plugin.id,
      displayName: plugin.displayName,
      pluginSlug: plugin.slug,
      status: plugin.status,
      employeeType: profile?.employeeType ?? null,
      routingDomains: asStringArray(profile?.supportedDomains),
      aliases: asStringArray(profile?.routingKeywords),
      capabilities,
      grantedPermissions: asStringArray(plugin.grantedPermissions),
      availableTools: tools,
      supportedWorkflowTypes: [...(workflowTypesByPlugin.get(plugin.id) ?? new Set<string>())],
      knowledgeScope: { collections, hasKnowledge: collections > 0 },
      collaboration: {
        enabled: profile?.enabledForDelegation ?? true,
        priority: profile?.delegationPriority ?? 0,
        supportsSynchronous: profile?.supportsSynchronousDelegation ?? true,
        supportsAsynchronous: profile?.supportsAsynchronousDelegation ?? false,
        maximumExecutionTimeMs: profile?.maximumExecutionTimeMs ?? 30_000,
        supportedTaskTypes: asStringArray(profile?.supportedTaskTypes),
        requiredCapabilities: asStringArray(profile?.requiredCapabilities),
        sensitiveActions: asStringArray(profile?.sensitiveActions),
        defaultFailureBehaviour: profile?.defaultFailureBehaviour ?? "FAIL_PARENT"
      }
    };
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
