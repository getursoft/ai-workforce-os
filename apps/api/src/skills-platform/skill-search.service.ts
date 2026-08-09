import { Injectable } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { SkillRegistryService } from "./skill-registry.service";
import { fuzzyScore } from "./skill-fuzzy-search";

export interface SkillSearchFilters {
  query?: string;
  category?: string;
  capability?: string;
  mimeType?: string;
  industry?: string;
  tag?: string;
  author?: string;
  installed?: boolean;
}

export interface SkillSearchResult {
  key: string;
  name: string;
  description: string;
  category: string;
  author: string;
  industry: string[];
  tags: string[];
  supportedMimeTypes: string[];
  capabilitySummary: string[];
  installed: boolean;
  score: number;
}

/** Sprint 6.1B Feature 9 — Marketplace search across name/category/capability/MIME type/industry/
 *  tags/author, fuzzy-ranked, with an installed/not-installed filter. Reads the same Skill catalog
 *  rows the marketplace tab already lists (including the Feature 8 registry metadata merged into
 *  `metadataJson`) — no separate search index. */
@Injectable()
export class SkillSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SkillRegistryService
  ) {}

  async search(organizationId: string, filters: SkillSearchFilters): Promise<SkillSearchResult[]> {
    const skills = await this.prisma.skill.findMany({ where: { deletedAt: null, isActive: true } });
    const installed = new Set(
      (
        await this.prisma.skillInstallation.findMany({
          where: { organizationId, deletedAt: null },
          select: { skillVersion: { select: { skill: { select: { key: true } } } } }
        })
      ).map((row) => row.skillVersion.skill.key)
    );

    const results: SkillSearchResult[] = [];
    for (const skill of skills) {
      const metadata = readMetadata(skill.metadataJson);
      const manifest = this.registry.manifest(skill.key);
      const isInstalled = installed.has(skill.key);

      if (filters.installed !== undefined && filters.installed !== isInstalled) continue;
      if (filters.category && skill.category.toLowerCase() !== filters.category.toLowerCase()) continue;
      if (filters.author && skill.author.toLowerCase() !== filters.author.toLowerCase()) continue;
      const industryFilter = filters.industry;
      if (industryFilter && !metadata.industry.some((value) => value.toLowerCase() === industryFilter.toLowerCase())) continue;
      const tagFilter = filters.tag;
      if (tagFilter && !metadata.tags.some((value) => value.toLowerCase() === tagFilter.toLowerCase())) continue;
      if (filters.mimeType && !(manifest?.supportedMimeTypes ?? []).includes(filters.mimeType)) continue;
      const capabilityFilter = filters.capability;
      if (
        capabilityFilter &&
        !(manifest?.capabilitySummary ?? []).some((value) => value.toLowerCase().includes(capabilityFilter.toLowerCase()))
      )
        continue;

      const score = filters.query
        ? fuzzyScore(filters.query, [
            skill.name,
            skill.category,
            skill.author,
            skill.description,
            ...metadata.tags,
            ...metadata.industry,
            ...(manifest?.capabilitySummary ?? [])
          ])
        : 1;
      if (filters.query && score === 0) continue;

      results.push({
        key: skill.key,
        name: skill.name,
        description: skill.description,
        category: skill.category,
        author: skill.author,
        industry: metadata.industry,
        tags: metadata.tags,
        supportedMimeTypes: manifest?.supportedMimeTypes ?? [],
        capabilitySummary: manifest?.capabilitySummary ?? [],
        installed: isInstalled,
        score
      });
    }

    return results.sort((a, b) => b.score - a.score);
  }
}

function readMetadata(value: unknown): { tags: string[]; industry: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { tags: [], industry: [] };
  const record = value as Record<string, unknown>;
  return {
    tags: Array.isArray(record.tags) ? record.tags.filter((v): v is string => typeof v === "string") : [],
    industry: Array.isArray(record.industry) ? record.industry.filter((v): v is string => typeof v === "string") : []
  };
}
