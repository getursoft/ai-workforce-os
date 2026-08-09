import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { SKILL_TEMPLATE_SEEDS } from "./built-in/skill-templates.seed";

/** Sprint 6.1B — idempotent publication of built-in Skill Templates, mirroring SkillPublisherService
 *  and SkillPackPublisherService's pattern: upsert by stable key, replace items wholesale. */
@Injectable()
export class SkillTemplatePublisherService {
  private readonly logger = new Logger(SkillTemplatePublisherService.name);

  constructor(private readonly prisma: PrismaService) {}

  async sync(): Promise<{ templatesCreated: number; templatesUpdated: number }> {
    let templatesCreated = 0;
    let templatesUpdated = 0;
    for (const seed of SKILL_TEMPLATE_SEEDS) {
      const existing = await this.prisma.skillTemplate.findUnique({ where: { key: seed.key }, select: { id: true } });
      const template = await this.prisma.skillTemplate.upsert({
        where: { key: seed.key },
        create: {
          key: seed.key,
          name: seed.name,
          description: seed.description,
          category: seed.category,
          industry: seed.industry,
          author: seed.author,
          targetPluginId: seed.targetPluginId,
          workflowRef: seed.workflowRef ?? null,
          version: seed.version
        },
        update: {
          name: seed.name,
          description: seed.description,
          category: seed.category,
          industry: seed.industry,
          author: seed.author,
          targetPluginId: seed.targetPluginId,
          workflowRef: seed.workflowRef ?? null,
          version: seed.version
        }
      });
      if (existing) templatesUpdated += 1;
      else templatesCreated += 1;

      await this.prisma.$transaction([
        this.prisma.skillTemplateItem.deleteMany({ where: { skillTemplateId: template.id } }),
        this.prisma.skillTemplateItem.createMany({
          data: seed.items.map((item) => ({
            skillTemplateId: template.id,
            skillKey: item.skillKey,
            versionConstraint: item.versionConstraint,
            order: item.order,
            defaultConfigurationJson: item.defaultConfiguration as Prisma.InputJsonValue
          })) as Prisma.SkillTemplateItemCreateManyInput[]
        })
      ]);
    }
    this.logger.log({ event: "SKILL_TEMPLATES_SYNCED", templatesCreated, templatesUpdated });
    return { templatesCreated, templatesUpdated };
  }
}
