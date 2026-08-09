/** Least-privilege capability handles the runtime constructs from a skill's manifest. A skill only ever
 *  touches tenant state through these handles — never Prisma and never unrestricted tenant context. */
export interface ObjectReadInput {
  organizationId: string;
  key: string;
  maxBytes?: number;
}

export interface AiCapabilityInput {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface AiCapabilityResult {
  content: string;
  provider: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** The object `capabilities` field of SkillExecutionContext. A capability key is present on the handle
 *  only when the runtime decided the skill may receive it (manifest request + installation approval). */
export interface SkillCapabilities {
  object?: {
    read(input: ObjectReadInput): Promise<Buffer>;
  };
  ai?: {
    complete(input: AiCapabilityInput): Promise<AiCapabilityResult>;
  };
  knowledge?: {
    read(input: { collectionId: string }): Promise<unknown>;
  };
  /** Placeholder for future outbound-network capability (unimplemented in Sprint 6.1). */
  network?: {
    available: boolean;
  };
}

/**
 * The execution context a skill receives. It is deliberately minimal: only the identifiers
 * needed to operate within the tenant and the capabilities the manifest requested. Skills never
 * receive all organization memories, all knowledge collections, secrets, provider credentials,
 * unrelated conversations, or another employee's private state.
 */
export interface SkillExecutionContext {
  organizationId: string;
  pluginInstallationId?: string | null;
  userId?: string | null;
  conversationId?: string | null;
  agentExecutionId?: string | null;
  workflowExecutionId?: string | null;
  traceId?: string | null;
  /** Permission keys granted to this invocation (already intersected by the runtime). */
  grantedPermissions: ReadonlySet<string>;
  /** Capability keys the runtime chose to provide on `capabilities`. */
  grantedCapabilities: ReadonlySet<string>;
  /** Merged organization configuration + employee override for this installation. */
  configuration: Readonly<Record<string, unknown>>;
  locale?: string | null;
  timezone?: string | null;
  idempotencyKey: string;
  requestId?: string | null;
  /** Least-privilege capability handles. */
  capabilities: SkillCapabilities;
}
