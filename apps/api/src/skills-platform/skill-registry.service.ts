import { Injectable, Logger } from "@nestjs/common";
import type { SkillAdapter, SkillManifest } from "@ai-workforce-os/skill-sdk";
import {
  latestVersion,
  resolveCompatibleVersion,
  versionSatisfies,
  isValidSemver
} from "@ai-workforce-os/skill-sdk";
import { SkillError } from "./skill-error";

/**
 * Process-local registry of registered skill adapters, keyed by `key@version`. Database records
 * remain authoritative for marketplace metadata and installations; this registry is only the
 * in-process adapter resolution layer. Because it is rebuilt from DI at startup it can never drift
 * out of sync with the built-in adapters registered in this process.
 *
 * Built-in adapters register through NestJS dependency injection (see SkillPlatformModule). A global
 * mutable registry that silently diverges across processes is deliberately avoided.
 */
@Injectable()
export class SkillRegistryService {
  private readonly logger = new Logger(SkillRegistryService.name);
  private readonly byKeyVersion = new Map<string, SkillAdapter>();
  private readonly byKey = new Map<string, Map<string, SkillAdapter>>();

  register(adapter: SkillAdapter): void {
    const key = adapter.manifest.key;
    const version = adapter.manifest.version;
    const composite = `${key}@${version}`;
    if (this.byKeyVersion.has(composite)) {
      this.logger.warn({ event: "SKILL_REGISTRATION_COLLISION", key, version });
      throw new SkillError("SKILL_INTERNAL_ERROR", `SKILL_REGISTRATION_COLLISION:${composite}`);
    }
    this.byKeyVersion.set(composite, adapter);
    const versions = this.byKey.get(key) ?? new Map<string, SkillAdapter>();
    versions.set(version, adapter);
    this.byKey.set(key, versions);
  }

  /** All registered adapters (built-in platform skills). */
  all(): SkillAdapter[] {
    return [...this.byKeyVersion.values()];
  }

  /** Exact key@version resolution; throws when absent. */
  resolve(key: string, version: string): SkillAdapter {
    const adapter = this.byKeyVersion.get(`${key}@${version}`);
    if (!adapter) throw new SkillError("SKILL_VERSION_NOT_FOUND");
    return adapter;
  }

  /** Latest registered version of a key, or null when the skill isn't registered in-process. */
  latest(key: string): SkillAdapter | null {
    const versions = this.byKey.get(key);
    if (!versions) return null;
    const best = latestVersion([...versions.keys()]);
    return best ? versions.get(best) ?? null : null;
  }

  /** Resolves an adapter by key and an optional version constraint. Prefers an exact/constraint match,
   *  else the latest registered version. */
  resolveByConstraint(key: string, versionConstraint?: string): SkillAdapter | null {
    const versions = this.byKey.get(key);
    if (!versions) return null;
    if (versionConstraint && isValidSemver(versionConstraint)) {
      const exact = versions.get(versionConstraint);
      if (exact) return exact;
    }
    if (versionConstraint) {
      const compatible = resolveCompatibleVersion([...versions.keys()], versionConstraint);
      if (compatible) return versions.get(compatible) ?? null;
    }
    return this.latest(key);
  }

  /** True when the registered versions include one satisfying the constraint. */
  hasVersion(key: string, version: string): boolean {
    return this.byKeyVersion.has(`${key}@${version}`);
  }

  /** True when any registered version of `key` satisfies `constraint`. */
  satisfies(key: string, constraint: string): boolean {
    const versions = this.byKey.get(key);
    if (!versions) return false;
    return [...versions.keys()].some((version) => versionSatisfies(version, constraint));
  }

  /** Adapters whose manifest lists `mimeType` in supportedMimeTypes. */
  byMimeType(mimeType: string): SkillAdapter[] {
    return [...this.byKeyVersion.values()].filter((adapter) =>
      (adapter.manifest.supportedMimeTypes ?? []).includes(mimeType)
    );
  }

  /** Adapters in a category. */
  byCategory(category: string): SkillAdapter[] {
    return this.byKeyVersion.size
      ? [...this.byKeyVersion.values()].filter(
          (adapter) => adapter.manifest.category.toLowerCase() === category.toLowerCase()
        )
      : [];
  }

  /** Adapter that declares `capability` in capabilitySummary or requiredCapabilities. */
  byCapability(capability: string): SkillAdapter[] {
    const needle = capability.toLowerCase();
    return [...this.byKeyVersion.values()].filter((adapter) =>
      [...adapter.manifest.capabilitySummary, ...adapter.manifest.requiredCapabilities].some((value) =>
        value.toLowerCase().includes(needle)
      )
    );
  }

  /** All unique skill keys registered. */
  keys(): string[] {
    return [...this.byKey.keys()];
  }

  manifest(key: string, version?: string): SkillManifest | null {
    const adapter = version
      ? this.resolve(key, version)
      : this.latest(key);
    return adapter ? adapter.manifest : null;
  }
}
