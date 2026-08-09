import type { TraceContext } from "../observability/trace-context";

/** Identifiers of the surrounding platform activity a skill execution may be attributed to. */
export interface SkillExecutionReferences {
  organizationId: string;
  pluginInstallationId?: string | null;
  userId?: string | null;
  conversationId?: string | null;
  agentExecutionId?: string | null;
  workflowExecutionId?: string | null;
  traceContext?: TraceContext | null;
}

export interface SkillExecuteRequest extends SkillExecutionReferences {
  /** Stable skill key (e.g. "document-reader"). */
  skillKey: string;
  /** Optional semver constraint; resolves to a compatible installed version. */
  versionConstraint?: string;
  /** Skill input; validated against the resolved version's inputSchema. */
  input: unknown;
  /** Optional caller-provided idempotency key. Defaults to a fresh key per call. */
  idempotencyKey?: string;
  /** Process-context identifiers (background jobs, workflow steps) that are not part of an agent turn. */
  requestId?: string;
}

export interface SkillExecuteResult<T = unknown> {
  skillKey: string;
  skillVersion: string;
  runId: string;
  status: "COMPLETED" | "REPLAY";
  data: T;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    provider?: string | null;
    model?: string | null;
  };
  creditsConsumed: number;
  durationMs: number;
  warnings?: string[];
  retryCount: number;
}

/** A capability-discovery answer (Phase 11): which skills may this employee execute? */
export interface EmployeeSkillDiscoveryItem {
  skillKey: string;
  name: string;
  description: string;
  category: string;
  version: string;
  supportedMimeTypes: string[];
  capabilitySummary: string[];
  configuration: Record<string, unknown>;
  installationId: string;
  enabled: boolean;
}

export interface SkillRuntimeExecuteInput {
  skillKey: string;
  versionConstraint?: string;
  organizationId: string;
  pluginInstallationId?: string;
  conversationId?: string;
  agentExecutionId?: string;
  workflowExecutionId?: string;
  userId?: string;
  input: unknown;
  idempotencyKey?: string;
  requestId?: string;
  traceContext?: TraceContext | null;
}
