import { Injectable, Logger } from "@nestjs/common";
import { PluginAiService } from "../plugins/plugin-ai.service";
import type { ParsedResumeFields } from "./recruitment-parsing.service";

export interface ScoringWeights {
  mandatorySkillWeight: number;
  preferredSkillWeight: number;
  experienceWeight: number;
  projectExperienceWeight: number;
  certificationWeight: number;
}

export interface JobCriteria {
  mandatorySkills: string[];
  preferredSkills: string[];
  certifications: string[];
  educationRequirements: string[];
  domainKnowledge: string[];
}

export interface ScoringResult {
  matchScore: number;
  scoreBreakdown: Record<string, { weight: number; achieved: number }>;
  matchedSkills: string[];
  missingSkills: string[];
  evidence: Array<{ requirement: string; evidence: string }>;
  explanation: string;
  warnings: string[];
}

export const SCORING_VERSION = "recruitment-scoring-v1";

/** Small, explicit semantic-equivalence table for common abbreviation/tool pairs (Phase 5's own worked
 * examples) — checked before ever asking the LLM, so an obvious case never costs a model call or risks a
 * wrong LLM judgment. Deliberately narrow: "related experience should not automatically satisfy every
 * mandatory skill" — this table only ever encodes a genuine same-thing-different-name pair, never a
 * loose "similar technology" relationship. */
const KNOWN_ALIASES: Record<string, string[]> = {
  "azure data factory": ["adf"],
  "azure databricks": ["adb"],
  "amazon web services": ["aws"],
  "google cloud platform": ["gcp"],
  "microsoft power bi": ["power bi", "powerbi"],
  "structured query language": ["sql"],
  javascript: ["js"],
  typescript: ["ts"],
  "node.js": ["node", "nodejs"],
  "representational state transfer": ["rest", "rest api", "restful"],
  "continuous integration/continuous deployment": ["ci/cd", "cicd"],
  "natural language processing": ["nlp"],
  "machine learning": ["ml"],
  "artificial intelligence": ["ai"]
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** True when `skill` appears, verbatim or via a known alias, in `haystackText` (resume text + extracted
 * skills list). Deterministic — no LLM involved. */
function deterministicMatch(skill: string, haystackText: string, resumeSkills: string[]): boolean {
  const normalizedSkill = normalize(skill);
  const normalizedSkills = resumeSkills.map(normalize);
  if (normalizedSkills.some((s) => s === normalizedSkill || s.includes(normalizedSkill))) return true;
  if (haystackText.includes(normalizedSkill)) return true;
  const aliases = KNOWN_ALIASES[normalizedSkill] ?? [];
  if (aliases.some((alias) => haystackText.includes(alias) || normalizedSkills.includes(alias))) return true;
  // Reverse lookup: the required skill IS itself a known alias of some canonical term already in the
  // resume (e.g. job asks for "ADF", resume says "Azure Data Factory").
  for (const [canonical, aliasList] of Object.entries(KNOWN_ALIASES)) {
    if (aliasList.includes(normalizedSkill) && haystackText.includes(canonical)) return true;
  }
  return false;
}

@Injectable()
export class RecruitmentScoringService {
  private readonly logger = new Logger(RecruitmentScoringService.name);

  constructor(private readonly pluginAi: PluginAiService) {}

  async score(
    organizationId: string,
    recruitmentPluginId: string,
    criteria: JobCriteria,
    weights: ScoringWeights,
    minExperienceYears: number | null,
    resumeText: string,
    fields: ParsedResumeFields
  ): Promise<ScoringResult> {
    const warnings: string[] = [];
    const haystack = normalize(resumeText);

    const mandatoryMatched: string[] = [];
    const mandatoryMissing: string[] = [];
    for (const skill of criteria.mandatorySkills) {
      (deterministicMatch(skill, haystack, fields.skills) ? mandatoryMatched : mandatoryMissing).push(skill);
    }
    const preferredMatched: string[] = [];
    const preferredMissing: string[] = [];
    for (const skill of criteria.preferredSkills) {
      (deterministicMatch(skill, haystack, fields.skills) ? preferredMatched : preferredMissing).push(skill);
    }
    const certMatched: string[] = [];
    const certMissing: string[] = [];
    for (const cert of criteria.certifications) {
      (deterministicMatch(cert, haystack, fields.certifications) ? certMatched : certMissing).push(cert);
    }

    // Experience: full credit at or above the job's minimum, linear partial credit below it, zero if no
    // experience was extractable at all (never assumed).
    const relevantYears = fields.relevantExperienceYears ?? fields.totalExperienceYears;
    let experienceRatio = 0;
    if (relevantYears !== null) {
      if (!minExperienceYears || minExperienceYears <= 0) experienceRatio = 1;
      else experienceRatio = Math.max(0, Math.min(1, relevantYears / minExperienceYears));
    } else {
      warnings.push("No experience duration could be extracted from this resume.");
    }

    // Project experience: credit for each MATCHED mandatory/preferred skill that also appears to be
    // backed by a project/employment-history entry, not just a bare listed skill — "related experience
    // should not automatically satisfy every mandatory skill" (Phase 5).
    const projectText = normalize([...fields.projects, ...fields.employmentHistory].join(" \n "));
    const matchedWithProjectEvidence = [...mandatoryMatched, ...preferredMatched].filter((skill) =>
      deterministicMatch(skill, projectText, [])
    );
    const totalMatchedSkills = mandatoryMatched.length + preferredMatched.length;
    const projectRatio = totalMatchedSkills > 0 ? matchedWithProjectEvidence.length / totalMatchedSkills : 0;

    const mandatoryRatio = criteria.mandatorySkills.length
      ? mandatoryMatched.length / criteria.mandatorySkills.length
      : 1;
    const preferredRatio = criteria.preferredSkills.length
      ? preferredMatched.length / criteria.preferredSkills.length
      : 1;
    const certRatio = criteria.certifications.length ? certMatched.length / criteria.certifications.length : 1;

    const scoreBreakdown: ScoringResult["scoreBreakdown"] = {
      mandatorySkills: { weight: weights.mandatorySkillWeight, achieved: round2(mandatoryRatio * weights.mandatorySkillWeight) },
      preferredSkills: { weight: weights.preferredSkillWeight, achieved: round2(preferredRatio * weights.preferredSkillWeight) },
      experience: { weight: weights.experienceWeight, achieved: round2(experienceRatio * weights.experienceWeight) },
      projectExperience: { weight: weights.projectExperienceWeight, achieved: round2(projectRatio * weights.projectExperienceWeight) },
      certifications: { weight: weights.certificationWeight, achieved: round2(certRatio * weights.certificationWeight) }
    };
    // A category the job never asked for (empty preferredSkills/certifications) must not silently hand
    // out its full weight as free credit — that let a completely unrelated candidate (0 mandatory skills
    // matched) still clear 45%+ purely from untested categories in testing. Re-normalize against only the
    // weight of categories that actually apply to THIS job, same idea as excluding an N/A exam question
    // from the denominator rather than marking it correct. Mandatory skills, experience, and project
    // experience are always "applicable" (project experience already resolves to a real 0, not a free
    // pass, when nothing matched) — only preferred/certifications can be genuinely not asked for.
    const applicableWeight =
      weights.mandatorySkillWeight +
      (criteria.preferredSkills.length ? weights.preferredSkillWeight : 0) +
      weights.experienceWeight +
      weights.projectExperienceWeight +
      (criteria.certifications.length ? weights.certificationWeight : 0);
    const achievedTotal = Object.entries(scoreBreakdown)
      .filter(([key]) => key !== "preferredSkills" || criteria.preferredSkills.length)
      .filter(([key]) => key !== "certifications" || criteria.certifications.length)
      .reduce((sum, [, entry]) => sum + entry.achieved, 0);
    const matchScore = applicableWeight > 0 ? round2((achievedTotal / applicableWeight) * 100) : 0;

    const matchedSkills = [...mandatoryMatched, ...preferredMatched, ...certMatched];
    const missingSkills = [...mandatoryMissing, ...preferredMissing, ...certMissing];

    const evidence: ScoringResult["evidence"] = matchedSkills.map((skill) => ({
      requirement: skill,
      evidence: findEvidenceSnippet(skill, resumeText)
    }));

    const explanation = await this.explain(
      organizationId,
      recruitmentPluginId,
      matchScore,
      mandatoryMatched,
      mandatoryMissing,
      preferredMatched,
      relevantYears,
      minExperienceYears
    );

    return { matchScore, scoreBreakdown, matchedSkills, missingSkills, evidence, explanation, warnings };
  }

  /** The LLM's ONLY role here is prose — summarizing the already-computed, deterministic match/miss
   * lists into a short human-readable explanation. It never sees or influences the numeric score. Falls
   * back to a template sentence if the call fails, so scoring never blocks on it. */
  private async explain(
    organizationId: string,
    recruitmentPluginId: string,
    matchScore: number,
    mandatoryMatched: string[],
    mandatoryMissing: string[],
    preferredMatched: string[],
    relevantYears: number | null,
    minExperienceYears: number | null
  ): Promise<string> {
    try {
      const { provider } = await this.pluginAi.resolveProvider(organizationId, recruitmentPluginId, "ROUTING");
      const result = await provider.complete({
        messages: [
          {
            role: "system",
            content:
              "Write a short (2-3 sentence), factual, neutral explanation of a candidate's job-match result, using only the facts given. Never invent facts, never mention demographic characteristics, never state the score is a certified or official ATS outcome — call it a match estimate."
          },
          {
            role: "user",
            content: JSON.stringify({
              matchScore,
              mandatoryMatched,
              mandatoryMissing,
              preferredMatched,
              relevantExperienceYears: relevantYears,
              minExperienceYearsRequired: minExperienceYears
            })
          }
        ],
        temperature: 0.2,
        maxOutputTokens: 220
      });
      return result.content.trim() || templateExplanation(matchScore, mandatoryMatched, mandatoryMissing);
    } catch (error) {
      this.logger.warn({ event: "RecruitmentExplanationFailed", error: String(error) });
      return templateExplanation(matchScore, mandatoryMatched, mandatoryMissing);
    }
  }
}

function templateExplanation(matchScore: number, matched: string[], missing: string[]): string {
  return `Estimated match: ${matchScore}%. Matched ${matched.length} mandatory skill(s)${matched.length ? ` (${matched.join(", ")})` : ""}; missing ${missing.length}${missing.length ? ` (${missing.join(", ")})` : ""}. This is a match estimate, not a certified ATS score.`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A short excerpt of the resume text around the first occurrence of `skill` — the "backed by extracted
 * resume evidence" requirement (Phase 5), kept deterministic rather than LLM-generated. */
function findEvidenceSnippet(skill: string, resumeText: string): string {
  const index = resumeText.toLowerCase().indexOf(skill.toLowerCase());
  if (index === -1) return "";
  const start = Math.max(0, index - 60);
  const end = Math.min(resumeText.length, index + skill.length + 60);
  return `…${resumeText.slice(start, end).trim()}…`;
}
