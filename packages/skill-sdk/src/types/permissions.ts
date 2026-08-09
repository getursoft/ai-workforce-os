/**
 * Sprint 6.1 — Skill SDK permission and capability contracts.
 *
 * A skill declares what it needs through its manifest. The runtime decides whether an
 * employee may execute a skill and which least-privilege capabilities the skill receives.
 * These stable string keys are the single source of truth for both the manifest schema and
 * the runtime's permission/capability checks.
 */

/** Stable platform permission keys a skill (or its installer) may require. */
export type SkillPermissionKey =
  | "skill.execute"
  | "skill.install"
  | "skill.update"
  | "skill.uninstall"
  | "skill.configure"
  | "skill.marketplace.read"
  | "skill.execution.read"
  | "skill.health.read"
  | "skill.grant.manage";

/** Stable platform capabilities a skill may request. A capability is a runtime-provided handle,
 *  not a blanket grant — the runtime builds a least-privilege handle from the manifest. */
export type SkillCapabilityKey =
  | "object.read"
  | "object.write"
  | "knowledge.read"
  | "knowledge.write"
  | "memory.read"
  | "email.send"
  | "channel.send"
  | "network.external"
  | "ai.provider.execute";

export const SKILL_PERMISSION_KEYS: readonly SkillPermissionKey[] = [
  "skill.execute",
  "skill.install",
  "skill.update",
  "skill.uninstall",
  "skill.configure",
  "skill.marketplace.read",
  "skill.execution.read",
  "skill.health.read",
  "skill.grant.manage"
];

export const SKILL_CAPABILITY_KEYS: readonly SkillCapabilityKey[] = [
  "object.read",
  "object.write",
  "knowledge.read",
  "knowledge.write",
  "memory.read",
  "email.send",
  "channel.send",
  "network.external",
  "ai.provider.execute"
];

/**
 * Capabilities that carry security, cost or cross-tenant risk and therefore require an
 * administrator's explicit acknowledgement during installation. Installation surface must
 * list these distinctly from ordinary capabilities.
 */
export const SENSITIVE_CAPABILITY_KEYS: ReadonlySet<SkillCapabilityKey> = new Set([
  "object.write",
  "knowledge.write",
  "memory.read",
  "email.send",
  "channel.send",
  "network.external"
]);

export interface SkillPermissionDefinition {
  key: SkillPermissionKey;
  label: string;
  description: string;
  /** True when this permission allows changes that affect other tenants or system state. */
  sensitive: boolean;
}

export const SKILL_PERMISSION_DEFINITIONS: readonly SkillPermissionDefinition[] = [
  { key: "skill.execute", label: "Execute skills", description: "Invoke an installed skill on behalf of an employee.", sensitive: false },
  { key: "skill.install", label: "Install skills", description: "Install a marketplace skill into this organization.", sensitive: false },
  { key: "skill.update", label: "Update skills", description: "Change skill lifecycle state and configuration.", sensitive: false },
  { key: "skill.uninstall", label: "Uninstall skills", description: "Remove a skill installation from this organization.", sensitive: true },
  { key: "skill.configure", label: "Configure skills", description: "Edit an organization skill configuration.", sensitive: false },
  { key: "skill.marketplace.read", label: "Browse the skill marketplace", description: "List published skills and their metadata.", sensitive: false },
  { key: "skill.execution.read", label: "Read skill executions", description: "View execution history, usage and health for skills.", sensitive: false },
  { key: "skill.health.read", label: "Read skill health", description: "Check the health of installed skills.", sensitive: false },
  { key: "skill.grant.manage", label: "Manage employee grants", description: "Grant or revoke skills to installed employees.", sensitive: false }
];
