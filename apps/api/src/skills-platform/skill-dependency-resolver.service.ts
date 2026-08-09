import { Injectable } from "@nestjs/common";
import type { SkillManifest } from "@ai-workforce-os/skill-sdk";
import { versionSatisfies } from "@ai-workforce-os/skill-sdk";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { SkillRegistryService } from "./skill-registry.service";
import { SkillError } from "./skill-error";

export interface DependencyGraphNode {
  skillKey: string;
  dependsOn: string[];
}

export interface MissingDependencyReport {
  skillKey: string;
  versionConstraint: string;
  required: boolean;
  installed: boolean;
  satisfied: boolean;
}

/**
 * Sprint 6.1B Feature 3 — Dependency Resolver. Builds a dependency graph from registered skill
 * manifests (the same `dependencies[]` declarations SkillsRuntimeService/SkillInstallationService
 * already enforce at execution/install time), resolves a safe topological install order, and detects
 * circular or missing dependencies before a pack or multi-skill installation is attempted. This
 * service only ever reads manifests/installations; it never installs anything itself — callers
 * (SkillPackService, the marketplace controller) still install each skill through the existing
 * SkillInstallationService.install, in the order this resolver returns.
 */
@Injectable()
export class SkillDependencyResolverService {
  constructor(
    private readonly registry: SkillRegistryService,
    private readonly prisma: PrismaService
  ) {}

  /** Builds the dependency graph for a set of skill keys (transitively, following each dependency's
   *  own manifest) using the process-local registry's built-in manifests. */
  buildGraph(rootSkillKeys: string[]): Map<string, DependencyGraphNode> {
    const graph = new Map<string, DependencyGraphNode>();
    const visit = (skillKey: string) => {
      if (graph.has(skillKey)) return;
      const manifest = this.registry.manifest(skillKey);
      const dependsOn = (manifest?.dependencies ?? []).map((dependency) => dependency.skillKey);
      graph.set(skillKey, { skillKey, dependsOn });
      for (const dependency of dependsOn) visit(dependency);
    };
    for (const key of rootSkillKeys) visit(key);
    return graph;
  }

  /** Resolves a topological install order for `rootSkillKeys` and their transitive dependencies —
   *  dependencies always precede dependents. Throws SKILL_DEPENDENCY_CYCLE if the graph has a cycle,
   *  matching the same stable error code the runtime's error map already carries (Sprint 6.1A defined
   *  it but never had a path that could produce it; this resolver is that path). */
  resolveInstallOrder(rootSkillKeys: string[]): string[] {
    const graph = this.buildGraph(rootSkillKeys);
    const order: string[] = [];
    const state = new Map<string, "VISITING" | "DONE">();

    const visit = (skillKey: string, path: string[]) => {
      const status = state.get(skillKey);
      if (status === "DONE") return;
      if (status === "VISITING") {
        const cycle = [...path.slice(path.indexOf(skillKey)), skillKey].join(" -> ");
        throw new SkillError("SKILL_DEPENDENCY_CYCLE", `Circular skill dependency detected: ${cycle}`);
      }
      state.set(skillKey, "VISITING");
      const node = graph.get(skillKey);
      for (const dependency of node?.dependsOn ?? []) visit(dependency, [...path, skillKey]);
      state.set(skillKey, "DONE");
      order.push(skillKey);
    };

    for (const key of rootSkillKeys) visit(key, []);
    return order;
  }

  /** For a single manifest, reports each declared dependency's install/version status for an
   *  organization — the data the marketplace "Required Skills" panel renders before an install. */
  async missingDependencies(organizationId: string, manifest: SkillManifest): Promise<MissingDependencyReport[]> {
    const reports: MissingDependencyReport[] = [];
    for (const dependency of manifest.dependencies ?? []) {
      const installed = await this.prisma.skillInstallation.findFirst({
        where: {
          organizationId,
          deletedAt: null,
          skillVersion: { skill: { key: dependency.skillKey }, status: "PUBLISHED" }
        },
        include: { skillVersion: true }
      });
      reports.push({
        skillKey: dependency.skillKey,
        versionConstraint: dependency.versionConstraint,
        required: dependency.required,
        installed: Boolean(installed),
        satisfied: installed !== null && versionSatisfies(installed.skillVersion.version, dependency.versionConstraint)
      });
    }
    return reports;
  }

  /** True when every registered dependency of `skillKey` resolves to a known manifest — used to
   *  reject a manifest that declares a dependency on a skill key the registry has never heard of. */
  hasKnownDependencies(skillKey: string): boolean {
    const manifest = this.registry.manifest(skillKey);
    return (manifest?.dependencies ?? []).every((dependency) => this.registry.manifest(dependency.skillKey) !== null);
  }
}
