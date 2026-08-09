import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { SKILL_PACK_SEEDS } from "./built-in/skill-packs.seed";

/** Sprint 6.1B — idempotent publication of built-in Skill Packs, mirroring SkillPublisherService's
 *  pattern for individual skills: upsert by stable key, replace items wholesale (small, seed-owned
 *  lists), never create duplicates on repeated boots. */
@Injectable()
export class SkillPackPublisherService {
  private readonly logger = new Logger(SkillPackPublisherService.name);

  constructor(private readonly prisma: PrismaService) {}

  async sync(): Promise<{ packsCreated: number; packsUpdated: number }> {
    let packsCreated = 0;
    let packsUpdated = 0;
    for (const seed of SKILL_PACK_SEEDS) {
      const existing = await this.prisma.skillPack.findUnique({ where: { key: seed.key }, select: { id: true } });
      const pack = await this.prisma.skillPack.upsert({
        where: { key: seed.key },
        create: {
          key: seed.key,
          name: seed.name,
          description: seed.description,
          category: seed.category,
          industry: seed.industry,
          author: seed.author,
          version: seed.version
        },
        update: {
          name: seed.name,
          description: seed.description,
          category: seed.category,
          industry: seed.industry,
          author: seed.author,
          version: seed.version
        }
      });
      if (existing) packsUpdated += 1;
      else packsCreated += 1;

      await this.prisma.$transaction([
        this.prisma.skillPackItem.deleteMany({ where: { skillPackId: pack.id } }),
        this.prisma.skillPackItem.createMany({
          data: seed.items.map((item) => ({
            skillPackId: pack.id,
            skillKey: item.skillKey,
            versionConstraint: item.versionConstraint,
            required: item.required,
            order: item.order
          })) as Prisma.SkillPackItemCreateManyInput[]
        })
      ]);
    }
    this.logger.log({ event: "SKILL_PACKS_SYNCED", packsCreated, packsUpdated });
    return { packsCreated, packsUpdated };
  }
}
