import type { SkillExecutionContext } from "./context.js";
import type { SkillHealthResult } from "./result.js";

/**
 * Optional lifecycle hooks for a skill. Built-in skills are constructed by the platform and their
 * installer hooks run inside the installation transaction (for install/uninstall) or on lifecycle
 * transitions (enable/disable). Migration hooks are versioned and never execute arbitrary code from
 * untrusted packages.
 */
export interface SkillInstaller {
  install?(context: SkillExecutionContext): Promise<void>;
  uninstall?(context: SkillExecutionContext): Promise<void>;
  enable?(context: SkillExecutionContext): Promise<void>;
  disable?(context: SkillExecutionContext): Promise<void>;
  /**
   * Migrates a stored configuration when a skill upgrades to a new version. Returns the migrated
   * configuration. Called only for compatible upgrades; the runtime preserves configuration when no
   * hook exists.
   */
  migrate?(
    fromVersion: string,
    toVersion: string,
    configuration: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  health?(context: SkillExecutionContext): Promise<SkillHealthResult>;
}
