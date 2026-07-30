/**
 * Stage 8 Feature Configuration: Authoritative Input Collection
 *
 * This controls whether Skill Runtime becomes authoritative for input collection.
 * Defaults to DISABLED for safety.
 */

export type PlanTripRuntimeMode = "SHADOW" | "AUTHORITATIVE_INPUT_COLLECTION";

export interface SkillRuntimeAuthoritativeConfig {
  /** Enable Skill Runtime as authoritative source for input collection */
  enableAuthoritativeInputCollection: boolean;

  /** Always have a legacy fallback available */
  fallbackToLegacy: boolean;

  /** Emit diagnostic logs when fallback is used */
  emitDiagnosticsOnFallback: boolean;

  /** Allow test code to enable authoritative mode */
  allowTestOverride: boolean;
}

export function loadSkillRuntimeAuthoritativeConfig(): SkillRuntimeAuthoritativeConfig {
  return {
    enableAuthoritativeInputCollection:
      process.env.FEATURE_SKILL_AUTHORITATIVE_INPUT_COLLECTION === "true" ? true : false,
    fallbackToLegacy: true, // Always available
    emitDiagnosticsOnFallback: true,
    allowTestOverride: process.env.NODE_ENV === "test"
  };
}

/**
 * Resolve the runtime mode for a specific tenant/plugin installation.
 *
 * This could be extended to support per-tenant rollout policies.
 * For now, uses the global feature flag.
 */
/* eslint-disable @typescript-eslint/no-unused-vars -- reserved for future per-tenant rollout policy lookup */
export function resolvePlanTripRuntimeMode(
  _organizationId: string,
  _pluginInstallationId: string
): PlanTripRuntimeMode {
  /* eslint-enable @typescript-eslint/no-unused-vars */
  // Future: Look up tenant-specific rollout policy from database
  // For now, use global feature flag
  const config = getSkillRuntimeAuthoritativeConfig();
  return config.enableAuthoritativeInputCollection ? "AUTHORITATIVE_INPUT_COLLECTION" : "SHADOW";
}

/**
 * Check if authoritative mode is enabled for a given mode.
 */
export function isAuthoritativeModeEnabled(mode: PlanTripRuntimeMode): boolean {
  return mode === "AUTHORITATIVE_INPUT_COLLECTION";
}

/**
 * Global configuration holder for easy access.
 * Loaded at application startup.
 */
let CONFIG: SkillRuntimeAuthoritativeConfig | null = null;

export function initializeSkillRuntimeConfig(config?: SkillRuntimeAuthoritativeConfig): void {
  CONFIG = config || loadSkillRuntimeAuthoritativeConfig();
}

export function getSkillRuntimeAuthoritativeConfig(): SkillRuntimeAuthoritativeConfig {
  if (!CONFIG) {
    CONFIG = loadSkillRuntimeAuthoritativeConfig();
  }
  return CONFIG;
}

/**
 * Test helper: Enable authoritative mode for a specific test.
 * Auto-restores after test.
 */
export function withAuthoritativeMode<T>(fn: () => T): T {
  const config = getSkillRuntimeAuthoritativeConfig();
  if (!config.allowTestOverride) {
    throw new Error(
      "TEST_OVERRIDE_NOT_ALLOWED: authoritativeMode can only be enabled in test environment"
    );
  }

  const previousValue = config.enableAuthoritativeInputCollection;
  try {
    config.enableAuthoritativeInputCollection = true;
    return fn();
  } finally {
    config.enableAuthoritativeInputCollection = previousValue;
  }
}

/**
 * Test helper: Disable authoritative mode for a specific test.
 */
export function withLegacyMode<T>(fn: () => T): T {
  const config = getSkillRuntimeAuthoritativeConfig();
  if (!config.allowTestOverride) {
    throw new Error(
      "TEST_OVERRIDE_NOT_ALLOWED: legacy mode can only be enforced in test environment"
    );
  }

  const previousValue = config.enableAuthoritativeInputCollection;
  try {
    config.enableAuthoritativeInputCollection = false;
    return fn();
  } finally {
    config.enableAuthoritativeInputCollection = previousValue;
  }
}
