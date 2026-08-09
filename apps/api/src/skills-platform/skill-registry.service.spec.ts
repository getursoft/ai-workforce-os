import { describe, expect, it } from "vitest";
import type { SkillAdapter, SkillManifest } from "@ai-workforce-os/skill-sdk";
import { SkillRegistryService } from "./skill-registry.service";
import { SkillError } from "./skill-error";

function makeAdapter(overrides: Partial<SkillManifest> = {}): SkillAdapter {
  const manifest: SkillManifest = {
    key: "sample",
    name: "Sample",
    description: "Sample skill",
    category: "Testing",
    version: "1.0.0",
    author: "Krevia.ai",
    visibility: "PUBLIC",
    supportedMimeTypes: ["text/plain"],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    requiredPermissions: ["skill.execute"],
    requiredCapabilities: [],
    dependencies: [],
    billingCategory: "DETERMINISTIC",
    timeoutMs: 5000,
    statefulness: "STATELESS",
    capabilitySummary: ["Does a sample thing"],
    ...overrides
  };
  return {
    manifest,
    validate: async () => undefined,
    execute: async () => ({ data: {} }),
    health: async () => ({ status: "HEALTHY", checks: [], checkedAt: new Date().toISOString() })
  };
}

describe("SkillRegistryService", () => {
  it("registers a built-in adapter and resolves it by exact key@version", () => {
    const registry = new SkillRegistryService();
    const adapter = makeAdapter();
    registry.register(adapter);
    expect(registry.resolve("sample", "1.0.0")).toBe(adapter);
    expect(registry.all()).toContain(adapter);
  });

  it("rejects a duplicate key@version registration", () => {
    const registry = new SkillRegistryService();
    registry.register(makeAdapter());
    expect(() => registry.register(makeAdapter())).toThrow(SkillError);
  });

  it("resolves the latest registered version of a key", () => {
    const registry = new SkillRegistryService();
    const v1 = makeAdapter({ version: "1.0.0" });
    const v2 = makeAdapter({ version: "1.2.0" });
    registry.register(v1);
    registry.register(v2);
    expect(registry.latest("sample")).toBe(v2);
  });

  it("resolveByConstraint prefers a compatible constrained version over the latest", () => {
    const registry = new SkillRegistryService();
    const v1 = makeAdapter({ version: "1.0.0" });
    const v2 = makeAdapter({ version: "2.0.0" });
    registry.register(v1);
    registry.register(v2);
    expect(registry.resolveByConstraint("sample", "^1.0.0")).toBe(v1);
    expect(registry.resolveByConstraint("sample")).toBe(v2);
  });

  it("resolveByConstraint returns null for an unregistered key rather than throwing", () => {
    const registry = new SkillRegistryService();
    expect(registry.resolveByConstraint("does-not-exist")).toBeNull();
  });

  it("resolve throws SKILL_VERSION_NOT_FOUND for an unregistered key@version", () => {
    const registry = new SkillRegistryService();
    expect(() => registry.resolve("missing", "1.0.0")).toThrow(SkillError);
  });

  it("byMimeType returns only adapters that declare the MIME type", () => {
    const registry = new SkillRegistryService();
    const doc = makeAdapter({ key: "doc", supportedMimeTypes: ["application/pdf"] });
    const text = makeAdapter({ key: "text", supportedMimeTypes: ["text/plain"] });
    registry.register(doc);
    registry.register(text);
    expect(registry.byMimeType("application/pdf")).toEqual([doc]);
  });

  it("byCategory is case-insensitive and excludes non-matching categories", () => {
    const registry = new SkillRegistryService();
    const adapter = makeAdapter({ category: "Document Processing" });
    registry.register(adapter);
    expect(registry.byCategory("document processing")).toEqual([adapter]);
    expect(registry.byCategory("Text Processing")).toEqual([]);
  });

  it("hasVersion and satisfies reflect only what is actually registered", () => {
    const registry = new SkillRegistryService();
    registry.register(makeAdapter({ version: "1.0.0" }));
    expect(registry.hasVersion("sample", "1.0.0")).toBe(true);
    expect(registry.hasVersion("sample", "9.9.9")).toBe(false);
    expect(registry.satisfies("sample", "^1.0.0")).toBe(true);
    expect(registry.satisfies("sample", "^2.0.0")).toBe(false);
  });

  it("an adapter that was never registered is excluded from every lookup (no implicit/inactive entries)", () => {
    const registry = new SkillRegistryService();
    expect(registry.all()).toEqual([]);
    expect(registry.keys()).toEqual([]);
    expect(registry.manifest("anything")).toBeNull();
  });
});
