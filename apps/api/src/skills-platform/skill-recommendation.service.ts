import { Injectable } from "@nestjs/common";
import type { SkillManifest } from "@ai-workforce-os/skill-sdk";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { SkillRegistryService } from "./skill-registry.service";

export interface SkillRecommendationContext {
  pluginInstallationId?: string;
  message?: string;
  uploadedFiles?: Array<{ fileName: string; mimeType: string }>;
  intent?: string;
  contentType?: string;
}

export interface SkillRecommendation {
  skillKey: string;
  name: string;
  description: string;
  category: string;
  score: number;
  reasons: string[];
  supportedMimeTypes: string[];
  capabilitySummary: string[];
  installed: boolean;
  granted: boolean;
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "and", "or", "to", "in", "on", "with", "this", "that", "is", "are",
  "please", "can", "you", "i", "me", "my", "it", "from", "into", "as", "be", "will", "would"
]);

function tokenize(text: string | undefined | null): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

/** Bag-of-words drawn entirely from the manifest — never a hardcoded per-skill mapping. Any new
 *  skill automatically participates in recommendation scoring purely by virtue of its manifest. */
function manifestVocabulary(manifest: SkillManifest): Set<string> {
  const words = new Set<string>();
  for (const token of tokenize(manifest.name)) words.add(token);
  for (const token of tokenize(manifest.description)) words.add(token);
  for (const token of tokenize(manifest.category)) words.add(token);
  for (const summary of manifest.capabilitySummary ?? []) for (const token of tokenize(summary)) words.add(token);
  return words;
}

/**
 * Sprint 6.1B Feature 2 — Skill Recommendation Engine. Scores every registered skill manifest against
 * the calling employee's context (uploaded files' MIME types, free-text message/intent/content-type)
 * purely from manifest metadata: supportedMimeTypes for file matches, and a capability/description/
 * category keyword bag for text matches. No skill identity ever appears in an if/else branch here —
 * a new built-in skill is automatically recommendable the moment its manifest is registered.
 */
@Injectable()
export class SkillRecommendationService {
  constructor(
    private readonly registry: SkillRegistryService,
    private readonly prisma: PrismaService
  ) {}

  async recommend(organizationId: string, context: SkillRecommendationContext): Promise<SkillRecommendation[]> {
    const queryTokens = new Set([
      ...tokenize(context.message),
      ...tokenize(context.intent),
      ...tokenize(context.contentType)
    ]);
    const uploadedMimeTypes = new Set((context.uploadedFiles ?? []).map((file) => file.mimeType));

    const { installedByKey, grantedByKey } = await this.installationState(organizationId, context.pluginInstallationId);

    const recommendations: SkillRecommendation[] = [];
    for (const adapter of this.registry.all()) {
      const manifest = adapter.manifest;
      const reasons: string[] = [];
      let score = 0;

      const mimeMatches = manifest.supportedMimeTypes.filter((mimeType) => uploadedMimeTypes.has(mimeType));
      if (mimeMatches.length > 0) {
        score += mimeMatches.length * 10;
        reasons.push(`Supports uploaded file type${mimeMatches.length > 1 ? "s" : ""}: ${mimeMatches.join(", ")}`);
      }

      if (queryTokens.size > 0) {
        const vocabulary = manifestVocabulary(manifest);
        const overlap = [...queryTokens].filter((token) => vocabulary.has(token));
        if (overlap.length > 0) {
          score += overlap.length * 3;
          reasons.push(`Matches request keywords: ${overlap.join(", ")}`);
        }
      }

      if (score === 0) continue;

      const installed = installedByKey.has(manifest.key);
      const granted = grantedByKey.has(manifest.key);
      if (installed) score += 2;
      if (granted) score += 1;
      if (installed) reasons.push("Already installed for this organization");
      if (granted) reasons.push("Already granted to this employee");

      recommendations.push({
        skillKey: manifest.key,
        name: manifest.name,
        description: manifest.description,
        category: manifest.category,
        score,
        reasons,
        supportedMimeTypes: manifest.supportedMimeTypes,
        capabilitySummary: manifest.capabilitySummary,
        installed,
        granted
      });
    }

    return recommendations.sort((a, b) => b.score - a.score).slice(0, 10);
  }

  private async installationState(
    organizationId: string,
    pluginInstallationId?: string
  ): Promise<{ installedByKey: Set<string>; grantedByKey: Set<string> }> {
    const installations = await this.prisma.skillInstallation.findMany({
      where: { organizationId, deletedAt: null, enabled: true },
      select: { id: true, skillVersion: { select: { skill: { select: { key: true } } } } }
    });
    const installedByKey = new Set(installations.map((row) => row.skillVersion.skill.key));

    if (!pluginInstallationId) return { installedByKey, grantedByKey: new Set() };

    const grants = await this.prisma.employeeSkillGrant.findMany({
      where: { organizationId, pluginInstallationId, enabled: true },
      select: { skillInstallation: { select: { skillVersion: { select: { skill: { select: { key: true } } } } } } }
    });
    const grantedByKey = new Set(grants.map((row) => row.skillInstallation.skillVersion.skill.key));
    return { installedByKey, grantedByKey };
  }
}
