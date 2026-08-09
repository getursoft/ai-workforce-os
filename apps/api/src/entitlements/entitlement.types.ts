/**
 * Sprint 5.0 — Phase 11: plan and feature entitlements.
 *
 * Stable feature keys, resolved with three layers of precedence (lowest to highest):
 *   1. DEFAULT_ENTITLEMENTS (hardcoded base-tier defaults — every org gets at least this)
 *   2. SubscriptionPlan.metadataJson.entitlements (plan-tier overrides — no schema migration needed,
 *      metadataJson already exists on SubscriptionPlan) + the existing dedicated
 *      SubscriptionPlan.activeEmployeeLimit column for MAX_EMPLOYEES specifically
 *   3. FeatureFlag rows scoped to the organization (org-specific overrides/negotiated deals — the
 *      FeatureFlag model already existed as a schema shell before this pass; this is its first consumer)
 */

export type FeatureKey =
  | "MAX_EMPLOYEES"
  | "MAX_USERS"
  | "MAX_WHATSAPP_CHANNELS"
  | "MAX_SCHEDULED_JOBS"
  | "WORKFORCE_COLLABORATION"
  | "OBSERVABILITY_RETENTION_DAYS"
  | "MAX_UPLOAD_BYTES"
  | "API_ACCESS"
  | "CUSTOM_BRANDING"
  | "SSO"
  | "AUDIT_EXPORT"
  | "SKILLS_MARKETPLACE"
  | "SKILLS_INSTALL"
  | "SKILLS_CUSTOM"
  | "SKILLS_MAX_INSTALLED"
  | "SKILLS_MAX_PER_EMPLOYEE"
  | "SKILLS_AI_BACKED"
  | "SKILLS_EXTERNAL_NETWORK"
  | "SKILLS_EXECUTION_MONTHLY_LIMIT";

export type EntitlementValue = number | boolean;

// Deliberately generous fallback floor — every org gets at least this, whether or not it has an
// OrganisationSubscription row (most dev/test/legacy orgs don't). A real paid-tier ceiling belongs in
// SubscriptionPlan.metadataJson.entitlements or activeEmployeeLimit, not here: tightening these defaults
// would retroactively cap every existing organization and dev/test setup, not just new signups.
export const DEFAULT_ENTITLEMENTS: Record<FeatureKey, EntitlementValue> = {
  MAX_EMPLOYEES: 10,
  MAX_USERS: 25,
  MAX_WHATSAPP_CHANNELS: 3,
  MAX_SCHEDULED_JOBS: 50,
  WORKFORCE_COLLABORATION: false,
  OBSERVABILITY_RETENTION_DAYS: 7,
  MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
  API_ACCESS: true,
  CUSTOM_BRANDING: false,
  SSO: false,
  AUDIT_EXPORT: false,
  SKILLS_MARKETPLACE: true,
  SKILLS_INSTALL: true,
  SKILLS_CUSTOM: false,
  SKILLS_MAX_INSTALLED: 20,
  SKILLS_MAX_PER_EMPLOYEE: 10,
  SKILLS_AI_BACKED: false,
  SKILLS_EXTERNAL_NETWORK: false,
  SKILLS_EXECUTION_MONTHLY_LIMIT: 2000
};

export type ResolvedEntitlements = Record<FeatureKey, EntitlementValue>;
