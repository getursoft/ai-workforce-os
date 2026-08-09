import type { SkillCapabilityKey, SkillPermissionKey } from "./permissions.js";

export type SkillVisibility = "PUBLIC" | "PRIVATE" | "ORG_ONLY";
export type SkillBillingCategory =
  | "DETERMINISTIC"
  | "CPU_INTENSIVE"
  | "AI_PROVIDER_BACKED"
  | "EXTERNAL_PROVIDER_BACKED"
  | "STORAGE_HEAVY";
export type SkillStatefulness = "STATELESS" | "STATEFUL";

export interface SkillDependencyDeclaration {
  /** Stable skill key of the dependency (e.g. "document-reader"). */
  skillKey: string;
  /** semver constraint the dependency installation must satisfy. */
  versionConstraint: string;
  /** True when the dependency must be installed before this skill can execute. */
  required: boolean;
}

export interface SkillRetryPolicy {
  /** Maximum number of automatic retries after a transient failure. */
  maxRetries: number;
  /** Base backoff in milliseconds between retries. */
  backoffMs: number;
}

/**
 * A skill manifest is the declarative contract published in the marketplace. It is validated
 * at build time (built-in adapters) and again whenever a skill is installed or updated.
 * Database records remain authoritative for marketplace/install state; the manifest is
 * authoritative for adapter behavior.
 */
export interface SkillManifest {
  /** Stable, slug-like skill key, e.g. "document-reader". Never changes across versions. */
  key: string;
  name: string;
  description: string;
  category: string;
  /** Semantic version of this manifest/implementation. */
  version: string;
  author: string;
  visibility: SkillVisibility;
  /** MIME types this skill accepts as its primary document input (empty for non-document skills). */
  supportedMimeTypes: string[];
  /** JSON Schema the runtime validates every input against before execution. */
  inputSchema: Record<string, unknown>;
  /** JSON Schema the runtime validates the normalized output against before returning it. */
  outputSchema: Record<string, unknown>;
  requiredPermissions: SkillPermissionKey[];
  requiredCapabilities: SkillCapabilityKey[];
  dependencies: SkillDependencyDeclaration[];
  billingCategory: SkillBillingCategory;
  timeoutMs: number;
  retryPolicy?: SkillRetryPolicy;
  statefulness: SkillStatefulness;
  /** Optional JSON Schema for organization-level configuration. */
  configurationSchema?: Record<string, unknown>;
  /** Human-readable summary of what this skill can do (shown on marketplace cards). */
  capabilitySummary: string[];
  releaseNotes?: string;
}
