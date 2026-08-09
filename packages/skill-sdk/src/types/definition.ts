import type { SkillAdapter } from "./adapter.js";
import type { SkillInstaller } from "./installer.js";
import type { SkillManifest } from "./manifest.js";

/** A registered skill: manifest plus the adapter that implements it. */
export interface SkillDefinition<TInput = unknown, TOutput = unknown> {
  readonly adapter: SkillAdapter<TInput, TOutput>;
  readonly manifest: SkillManifest;
}

/** Builds a SkillDefinition from an adapter, sharing a single manifest reference. */
export function toSkillDefinition<TInput, TOutput>(
  adapter: SkillAdapter<TInput, TOutput>
): SkillDefinition<TInput, TOutput> {
  return { adapter, manifest: adapter.manifest };
}

export function installerOf(adapter: SkillAdapter): SkillInstaller | undefined {
  return adapter.installer;
}
