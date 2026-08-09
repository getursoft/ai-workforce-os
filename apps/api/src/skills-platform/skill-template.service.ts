import { Injectable, Optional } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { SkillInstallationService } from "./skill-installation.service";
import { SkillDependencyResolverService } from "./skill-dependency-resolver.service";
import { PluginService } from "../plugins/plugin.service";
import { SkillError } from "./skill-error";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";

export interface InstallTemplateInput {
  /** Grant the template's skills to this existing employee instead of creating a new one. */
  pluginInstallationId?: string;
  approveSensitivePermissions?: boolean;
}

/**
 * Sprint 6.1B Feature 6 — Skill Templates. Installing a template never re-implements employee
 * creation: it calls the existing PluginService.install exactly as the dashboard's "Install Employee"
 * flow does. It never re-implements the workflow engine either — `workflowRef` is informational only.
 * What it adds is purely the skills+configuration+grant bundle on top of an employee.
 */
@Injectable()
export class SkillTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly installations: SkillInstallationService,
    private readonly resolver: SkillDependencyResolverService,
    private readonly plugins: PluginService,
    @Optional() private readonly audit?: AuditEventLogger
  ) {}

  async listTemplates(organizationId: string) {
    const templates = await this.prisma.skillTemplate.findMany({
      where: { deletedAt: null, isActive: true },
      include: { items: { orderBy: { order: "asc" } } },
      orderBy: { createdAt: "asc" }
    });
    const installations = await this.prisma.skillTemplateInstallation.findMany({ where: { organizationId } });
    const countByTemplate = new Map<string, number>();
    for (const row of installations) countByTemplate.set(row.skillTemplateId, (countByTemplate.get(row.skillTemplateId) ?? 0) + 1);
    return templates.map((template) => ({ ...template, installationCount: countByTemplate.get(template.id) ?? 0 }));
  }

  async installTemplate(organizationId: string, userId: string, templateKey: string, input: InstallTemplateInput, requestId?: string) {
    const template = await this.prisma.skillTemplate.findFirst({
      where: { key: templateKey, deletedAt: null, isActive: true },
      include: { items: { orderBy: { order: "asc" } } }
    });
    if (!template) throw new SkillError("SKILL_TEMPLATE_NOT_FOUND");

    const pluginInstallationId = input.pluginInstallationId
      ? await this.resolveExistingEmployee(organizationId, input.pluginInstallationId)
      : await this.createEmployee(organizationId, userId, template.targetPluginId);

    const order = this.resolver.resolveInstallOrder(template.items.map((item) => item.skillKey));
    const itemByKey = new Map(template.items.map((item) => [item.skillKey, item]));
    const installedSkills: string[] = [];

    for (const skillKey of order) {
      const item = itemByKey.get(skillKey);
      const existingInstallation = await this.prisma.skillInstallation.findFirst({
        where: { organizationId, deletedAt: null, skillVersion: { skill: { key: skillKey } } },
        select: { id: true }
      });
      let installationId = existingInstallation?.id;
      if (!installationId) {
        const defaultConfiguration = item?.defaultConfigurationJson as Record<string, unknown> | undefined;
        const created = await this.installations.install(
          organizationId,
          userId,
          {
            skillKey,
            ...(item?.versionConstraint ? { versionConstraint: item.versionConstraint } : {}),
            ...(defaultConfiguration ? { configuration: defaultConfiguration } : {}),
            enabled: true,
            ...(input.approveSensitivePermissions !== undefined
              ? { approveSensitivePermissions: input.approveSensitivePermissions }
              : {})
          },
          requestId
        );
        installationId = (created as { id: string }).id;
      }
      await this.installations.grantToEmployee(organizationId, userId, pluginInstallationId, installationId, undefined, requestId);
      installedSkills.push(skillKey);
    }

    const record = await this.prisma.skillTemplateInstallation.create({
      data: {
        organizationId,
        skillTemplateId: template.id,
        pluginInstallationId,
        installedByUserId: userId
      }
    });

    this.audit?.record("SKILL_TEMPLATE_INSTALLED", requestId ?? "skill-template-install", {
      organizationId,
      userId,
      templateKey,
      pluginInstallationId,
      installedSkills: installedSkills.length
    });

    return { installation: record, pluginInstallationId, installedSkills };
  }

  private async resolveExistingEmployee(organizationId: string, pluginInstallationId: string): Promise<string> {
    const plugin = await this.prisma.plugin.findFirst({ where: { id: pluginInstallationId, organizationId, deletedAt: null } });
    if (!plugin) throw new SkillError("SKILL_EMPLOYEE_NOT_FOUND");
    return plugin.id;
  }

  private async createEmployee(organizationId: string, userId: string, targetPluginId: string): Promise<string> {
    const created = await this.plugins.install(organizationId, userId, { pluginId: targetPluginId, enable: true });
    return (created as { id: string }).id;
  }
}
