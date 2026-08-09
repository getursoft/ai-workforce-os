export type SkillHealthStatus = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";

export interface SkillHealthCheck {
  name: string;
  status: SkillHealthStatus;
  detail?: string;
}

export interface SkillHealthResult {
  status: SkillHealthStatus;
  checks: SkillHealthCheck[];
  checkedAt: string;
}

export interface SkillUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  provider?: string;
  model?: string;
  /** Provider cost in micros when a provider reported it. */
  providerCostMicros?: number;
}

export interface SkillExecutionResult<T = unknown> {
  data: T;
  usage?: SkillUsage;
  warnings?: string[];
}

/** Reusable healthy/unhealthy builders so adapters never hand-roll the envelope. */
export function healthySkillHealth(checks: SkillHealthCheck[] = [], checkedAt = new Date().toISOString()): SkillHealthResult {
  return { status: "HEALTHY", checks, checkedAt };
}

export function degradedSkillHealth(detail: string, checks: SkillHealthCheck[] = [], checkedAt = new Date().toISOString()): SkillHealthResult {
  return { status: "DEGRADED", checks: [{ name: "degraded", status: "DEGRADED", detail }, ...checks], checkedAt };
}

export function unhealthySkillHealth(detail: string, checks: SkillHealthCheck[] = [], checkedAt = new Date().toISOString()): SkillHealthResult {
  return { status: "UNHEALTHY", checks: [{ name: "unhealthy", status: "UNHEALTHY", detail }, ...checks], checkedAt };
}

export function unknownSkillHealth(checkedAt = new Date().toISOString()): SkillHealthResult {
  return { status: "UNKNOWN", checks: [], checkedAt };
}
