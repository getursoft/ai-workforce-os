import { describe, expect, it, vi } from "vitest";
import type { SkillAdapter, SkillManifest } from "@ai-workforce-os/skill-sdk";
import { SkillRegistryService } from "./skill-registry.service";
import { SkillDependencyResolverService } from "./skill-dependency-resolver.service";
import { SkillError } from "./skill-error";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";

function manifest(key: string, dependencies: SkillManifest["dependencies"] = []): SkillManifest {
  return {
    key,
    name: key,
    description: key,
    category: "Testing",
    version: "1.0.0",
    author: "Krevia.ai",
    visibility: "PUBLIC",
    supportedMimeTypes: [],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    requiredPermissions: [],
    requiredCapabilities: [],
    dependencies,
    billingCategory: "DETERMINISTIC",
    timeoutMs: 5000,
    statefulness: "STATELESS",
    capabilitySummary: []
  };
}

function adapter(m: SkillManifest): SkillAdapter {
  return {
    manifest: m,
    validate: vi.fn(),
    execute: vi.fn(),
    health: vi.fn()
  } as unknown as SkillAdapter;
}

function makeRegistry(manifests: SkillManifest[]): SkillRegistryService {
  const registry = new SkillRegistryService();
  for (const m of manifests) registry.register(adapter(m));
  return registry;
}

function makePrisma(installed: unknown | null = null): PrismaService {
  return {
    skillInstallation: { findFirst: vi.fn().mockResolvedValue(installed) }
  } as unknown as PrismaService;
}

describe("SkillDependencyResolverService", () => {
  it("returns a topological order where dependencies precede dependents", () => {
    const a = manifest("a", [{ skillKey: "b", versionConstraint: "^1.0.0", required: true }]);
    const b = manifest("b", [{ skillKey: "c", versionConstraint: "^1.0.0", required: true }]);
    const c = manifest("c");
    const resolver = new SkillDependencyResolverService(makeRegistry([a, b, c]), makePrisma());

    const order = resolver.resolveInstallOrder(["a"]);
    expect(order).toEqual(["c", "b", "a"]);
  });

  it("de-duplicates a diamond dependency graph", () => {
    // a depends on b and c; both b and c depend on d.
    const a = manifest("a", [
      { skillKey: "b", versionConstraint: "*", required: true },
      { skillKey: "c", versionConstraint: "*", required: true }
    ]);
    const b = manifest("b", [{ skillKey: "d", versionConstraint: "*", required: true }]);
    const c = manifest("c", [{ skillKey: "d", versionConstraint: "*", required: true }]);
    const d = manifest("d");
    const resolver = new SkillDependencyResolverService(makeRegistry([a, b, c, d]), makePrisma());

    const order = resolver.resolveInstallOrder(["a"]);
    expect(order.filter((key) => key === "d")).toHaveLength(1);
    expect(order.indexOf("d")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("d")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("a"));
  });

  it("throws SKILL_DEPENDENCY_CYCLE for a circular dependency", () => {
    const a = manifest("a", [{ skillKey: "b", versionConstraint: "*", required: true }]);
    const b = manifest("b", [{ skillKey: "a", versionConstraint: "*", required: true }]);
    const resolver = new SkillDependencyResolverService(makeRegistry([a, b]), makePrisma());

    expect(() => resolver.resolveInstallOrder(["a"])).toThrow(SkillError);
    try {
      resolver.resolveInstallOrder(["a"]);
      expect.fail("expected SkillError");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillError);
      expect((error as SkillError).code).toBe("SKILL_DEPENDENCY_CYCLE");
    }
  });

  it("handles a skill with no dependencies as a single-node order", () => {
    const resolver = new SkillDependencyResolverService(makeRegistry([manifest("solo")]), makePrisma());
    expect(resolver.resolveInstallOrder(["solo"])).toEqual(["solo"]);
  });

  it("reports a missing required dependency as unsatisfied", async () => {
    const target = manifest("needs-doc", [{ skillKey: "document-reader", versionConstraint: "^1.0.0", required: true }]);
    const resolver = new SkillDependencyResolverService(makeRegistry([target]), makePrisma(null));

    const report = await resolver.missingDependencies("org-1", target);
    expect(report).toEqual([
      { skillKey: "document-reader", versionConstraint: "^1.0.0", required: true, installed: false, satisfied: false }
    ]);
  });

  it("reports an installed, version-satisfying dependency as satisfied", async () => {
    const target = manifest("needs-doc", [{ skillKey: "document-reader", versionConstraint: "^1.0.0", required: true }]);
    const resolver = new SkillDependencyResolverService(
      makeRegistry([target]),
      makePrisma({ skillVersion: { version: "1.2.0" } })
    );

    const report = await resolver.missingDependencies("org-1", target);
    expect(report[0]).toMatchObject({ installed: true, satisfied: true });
  });

  it("hasKnownDependencies is false when a dependency references an unregistered skill key", () => {
    const target = manifest("orphan", [{ skillKey: "does-not-exist", versionConstraint: "*", required: true }]);
    const resolver = new SkillDependencyResolverService(makeRegistry([target]), makePrisma());
    expect(resolver.hasKnownDependencies("orphan")).toBe(false);
  });

  it("hasKnownDependencies is true when every dependency resolves to a known manifest", () => {
    const dep = manifest("dep");
    const target = manifest("has-dep", [{ skillKey: "dep", versionConstraint: "*", required: true }]);
    const resolver = new SkillDependencyResolverService(makeRegistry([target, dep]), makePrisma());
    expect(resolver.hasKnownDependencies("has-dep")).toBe(true);
  });
});
