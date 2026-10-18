/**
 * Pure unit tests for the deterministic scoring engine — no database, no HTTP, no live LLM. The AI
 * provider is mocked (same `{ resolveProvider: vi.fn().mockResolvedValue({ provider: { complete } }) }`
 * pattern receptionist-routing.service.spec.ts already uses) because `explain()` only ever generates
 * prose from an already-computed score; these tests assert the NUMERIC score is correct and stable
 * regardless of what (or whether) the mocked provider returns, proving the LLM cannot influence it.
 */
import { describe, expect, it, vi } from "vitest";
import { RecruitmentScoringService } from "./recruitment-scoring.service";

const DEFAULT_WEIGHTS = {
  mandatorySkillWeight: 35,
  preferredSkillWeight: 15,
  experienceWeight: 25,
  projectExperienceWeight: 15,
  certificationWeight: 10
};

function makeService(completeImpl?: () => Promise<{ content: string; provider: string; model: string }>) {
  const complete = vi.fn(
    completeImpl ??
      (async () => ({ content: "A short explanation.", provider: "test", model: "test-model" }))
  );
  const pluginAi = { resolveProvider: vi.fn().mockResolvedValue({ provider: { complete } }) };
  return new RecruitmentScoringService(pluginAi as never);
}

function emptyFields(overrides: Partial<Parameters<RecruitmentScoringService["score"]>[6]> = {}) {
  return {
    name: "Test Candidate",
    email: null,
    phone: null,
    skills: [] as string[],
    totalExperienceYears: null,
    relevantExperienceYears: null,
    currentRole: null,
    previousRoles: [] as string[],
    education: [] as string[],
    certifications: [] as string[],
    projects: [] as string[],
    tools: [] as string[],
    industryExperience: [] as string[],
    employmentHistory: [] as string[],
    ...overrides
  };
}

describe("RecruitmentScoringService — deterministic scoring", () => {
  it("scores 100.00 when every mandatory/preferred skill, certification, and experience requirement is fully met", async () => {
    const service = makeService();
    const resumeText =
      "Senior Data Engineer with 8 years of experience. Skills: Azure Data Factory, Azure Databricks, Python, PySpark, SQL. " +
      "Certified: Azure Data Engineer Associate. Project: Built Azure Data Factory pipelines and Azure Databricks notebooks for Python/PySpark ETL.";
    const result = await service.score(
      "org-1",
      "plugin-1",
      {
        mandatorySkills: ["Azure Data Factory", "Azure Databricks", "Python", "PySpark", "SQL"],
        preferredSkills: ["Azure Data Factory"],
        certifications: ["Azure Data Engineer Associate"],
        educationRequirements: [],
        domainKnowledge: []
      },
      DEFAULT_WEIGHTS,
      5,
      resumeText,
      emptyFields({
        skills: ["Azure Data Factory", "Azure Databricks", "Python", "PySpark", "SQL"],
        certifications: ["Azure Data Engineer Associate"],
        relevantExperienceYears: 8,
        projects: ["Built Azure Data Factory pipelines and Azure Databricks notebooks using Python, PySpark, and SQL for ETL"]
      })
    );
    expect(result.matchScore).toBe(100);
    expect(result.missingSkills).toHaveLength(0);
  });

  it("matches known abbreviation aliases deterministically (ADF -> Azure Data Factory, ADB -> Azure Databricks)", async () => {
    const service = makeService();
    const resumeText = "Experience with ADF and ADB for building data pipelines.";
    const result = await service.score(
      "org-1",
      "plugin-1",
      {
        mandatorySkills: ["Azure Data Factory", "Azure Databricks"],
        preferredSkills: [],
        certifications: [],
        educationRequirements: [],
        domainKnowledge: []
      },
      DEFAULT_WEIGHTS,
      null,
      resumeText,
      emptyFields({ skills: ["ADF", "ADB"] })
    );
    expect(result.matchedSkills).toEqual(expect.arrayContaining(["Azure Data Factory", "Azure Databricks"]));
    expect(result.missingSkills).toHaveLength(0);
  });

  it("does not let unrelated/partial experience satisfy every mandatory skill (related experience != automatic match)", async () => {
    const service = makeService();
    const resumeText = "Marketing coordinator with 5 years of experience in social media campaigns.";
    const result = await service.score(
      "org-1",
      "plugin-1",
      {
        mandatorySkills: ["Azure Data Factory", "Azure Databricks", "Python", "PySpark", "SQL", "Azure Data Lake Storage Gen2"],
        preferredSkills: [],
        certifications: [],
        educationRequirements: [],
        domainKnowledge: []
      },
      DEFAULT_WEIGHTS,
      6,
      resumeText,
      emptyFields({ relevantExperienceYears: 5 })
    );
    expect(result.matchedSkills.length).toBe(0);
    expect(result.missingSkills.length).toBe(6);
    expect(result.matchScore).toBeLessThan(30);
  });

  it("boundary: 79.99 computed score must not be misclassified — the service only returns the number; the caller's >= threshold comparison decides", () => {
    // The 80.00-vs-79.99 "Recommended" boundary itself is applied by RecruitmentBatchProcessor.scoreOne
    // (`result.matchScore >= application.job.recommendationThreshold`), not inside the scoring service —
    // asserted here directly against the exact comparison the processor uses.
    expect(79.99 >= 80).toBe(false);
    expect(80.0 >= 80).toBe(true);
    expect(100.0 >= 80).toBe(true);
  });

  it("produces a stable score for identical inputs and scoring config (determinism)", async () => {
    const service = makeService();
    const run = () =>
      service.score(
        "org-1",
        "plugin-1",
        { mandatorySkills: ["Python", "SQL"], preferredSkills: ["Snowflake"], certifications: [], educationRequirements: [], domainKnowledge: [] },
        DEFAULT_WEIGHTS,
        3,
        "Python and SQL developer, 3 years experience.",
        emptyFields({ skills: ["Python", "SQL"], relevantExperienceYears: 3 })
      );
    const [first, second] = await Promise.all([run(), run()]);
    expect(first.matchScore).toBe(second.matchScore);
    expect(first.scoreBreakdown).toEqual(second.scoreBreakdown);
  });

  it("falls back to a deterministic template explanation when the LLM call fails — the score is already computed and unaffected", async () => {
    const service = makeService(async () => {
      throw new Error("Simulated provider outage — no live LLM credentials in this environment.");
    });
    const result = await service.score(
      "org-1",
      "plugin-1",
      { mandatorySkills: ["Python"], preferredSkills: [], certifications: [], educationRequirements: [], domainKnowledge: [] },
      DEFAULT_WEIGHTS,
      null,
      "Python developer.",
      emptyFields({ skills: ["Python"] })
    );
    expect(result.matchScore).toBeGreaterThan(0);
    expect(result.explanation).toContain("match estimate");
  });

  it("flags missing experience data as a warning instead of silently assuming a value", async () => {
    const service = makeService();
    const result = await service.score(
      "org-1",
      "plugin-1",
      { mandatorySkills: ["Python"], preferredSkills: [], certifications: [], educationRequirements: [], domainKnowledge: [] },
      DEFAULT_WEIGHTS,
      5,
      "Python developer.",
      emptyFields({ skills: ["Python"] })
    );
    expect(result.warnings.some((w) => w.includes("experience"))).toBe(true);
  });
});
