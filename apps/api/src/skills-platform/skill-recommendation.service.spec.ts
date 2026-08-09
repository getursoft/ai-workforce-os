import { describe, expect, it, vi } from "vitest";
import type { SkillAdapter, SkillManifest } from "@ai-workforce-os/skill-sdk";
import { SkillRegistryService } from "./skill-registry.service";
import { SkillRecommendationService } from "./skill-recommendation.service";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";

function manifest(overrides: Partial<SkillManifest>): SkillManifest {
  return {
    key: "sample",
    name: "Sample",
    description: "A sample skill",
    category: "Testing",
    version: "1.0.0",
    author: "Krevia.ai",
    visibility: "PUBLIC",
    supportedMimeTypes: [],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    requiredPermissions: [],
    requiredCapabilities: [],
    dependencies: [],
    billingCategory: "DETERMINISTIC",
    timeoutMs: 5000,
    statefulness: "STATELESS",
    capabilitySummary: [],
    ...overrides
  };
}

function adapter(m: SkillManifest): SkillAdapter {
  return { manifest: m, validate: vi.fn(), execute: vi.fn(), health: vi.fn() } as unknown as SkillAdapter;
}

function makeRegistry(manifests: SkillManifest[]): SkillRegistryService {
  const registry = new SkillRegistryService();
  for (const m of manifests) registry.register(adapter(m));
  return registry;
}

function makePrisma(options: { installations?: unknown[]; grants?: unknown[] } = {}): PrismaService {
  return {
    skillInstallation: { findMany: vi.fn().mockResolvedValue(options.installations ?? []) },
    employeeSkillGrant: { findMany: vi.fn().mockResolvedValue(options.grants ?? []) }
  } as unknown as PrismaService;
}

describe("SkillRecommendationService", () => {
  it("recommends a skill whose supportedMimeTypes matches an uploaded file", async () => {
    const registry = makeRegistry([
      manifest({ key: "document-reader", supportedMimeTypes: ["application/pdf", "text/plain"] }),
      manifest({ key: "unrelated-skill", supportedMimeTypes: ["image/png"] })
    ]);
    const service = new SkillRecommendationService(registry, makePrisma());

    const results = await service.recommend("org-1", { uploadedFiles: [{ fileName: "a.pdf", mimeType: "application/pdf" }] });

    const keys = results.map((r) => r.skillKey);
    expect(keys).toContain("document-reader");
    expect(keys).not.toContain("unrelated-skill");
  });

  it("recommends a skill by keyword overlap with its manifest capability summary, not by hardcoded identity", async () => {
    const registry = makeRegistry([
      manifest({ key: "translation", capabilitySummary: ["Translate text between languages"] }),
      manifest({ key: "file-validation", capabilitySummary: ["Validate uploaded files for safety"] })
    ]);
    const service = new SkillRecommendationService(registry, makePrisma());

    const results = await service.recommend("org-1", { message: "please translate this document into Spanish" });

    expect(results[0]?.skillKey).toBe("translation");
  });

  it("scores an already-installed-and-granted skill higher than an equally matching but unavailable one", async () => {
    const registry = makeRegistry([
      manifest({ key: "translation", capabilitySummary: ["Translate text"] }),
      manifest({ key: "another-translator", capabilitySummary: ["Translate text"] })
    ]);
    const service = new SkillRecommendationService(
      registry,
      makePrisma({
        installations: [{ id: "install-1", skillVersion: { skill: { key: "translation" } } }],
        grants: [{ skillInstallation: { skillVersion: { skill: { key: "translation" } } } }]
      })
    );

    const results = await service.recommend("org-1", { message: "translate text", pluginInstallationId: "emp-1" });

    const translation = results.find((r) => r.skillKey === "translation");
    const other = results.find((r) => r.skillKey === "another-translator");
    if (!translation || !other) throw new Error("expected both 'translation' and 'another-translator' in results");
    expect(translation.score).toBeGreaterThan(other.score);
    expect(translation.installed).toBe(true);
    expect(translation.granted).toBe(true);
    expect(other.installed).toBe(false);
  });

  it("returns no recommendations when nothing in the context matches any manifest", async () => {
    const registry = makeRegistry([manifest({ key: "document-reader", capabilitySummary: ["Read documents"] })]);
    const service = new SkillRecommendationService(registry, makePrisma());

    const results = await service.recommend("org-1", { message: "completely unrelated gibberish zzz" });
    expect(results).toHaveLength(0);
  });

  it("caps recommendations at 10 results, sorted by descending score", async () => {
    const manifests = Array.from({ length: 15 }, (_, i) =>
      manifest({ key: `skill-${i}`, capabilitySummary: ["process text documents"] })
    );
    const registry = makeRegistry(manifests);
    const service = new SkillRecommendationService(registry, makePrisma());

    const results = await service.recommend("org-1", { message: "process text documents" });
    expect(results.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < results.length; i += 1) {
      const previous = results[i - 1];
      const current = results[i];
      if (!previous || !current) throw new Error("expected a contiguous results array");
      expect(previous.score).toBeGreaterThanOrEqual(current.score);
    }
  });
});
