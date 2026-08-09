export interface SkillPipelineNodeInput {
  order: number;
  skillKey: string;
  versionConstraint?: string;
  conditionExpression?: string;
  onFailure?: "STOP" | "CONTINUE";
  timeoutMs?: number;
  maxRetries?: number;
  /** When true, this node receives the pipeline's original trigger input instead of the previous
   *  node's output — otherwise nodes chain sequentially (previous output -> next input). */
  useTriggerInput?: boolean;
  /** Fixed parameters merged into this node's input on every run (e.g. entity-extraction's
   *  `entitySchema`, translation's `targetLanguage`) — values a prior node's output can never supply,
   *  since they express what THIS node should do, not what the previous node produced. */
  staticInput?: Record<string, unknown>;
}

export interface CreateSkillPipelineInput {
  name: string;
  description: string;
  nodes: SkillPipelineNodeInput[];
}

export interface ExecuteSkillPipelineInput {
  input: unknown;
  pluginInstallationId?: string;
  conversationId?: string;
  workflowExecutionId?: string;
  idempotencyKeyPrefix?: string;
}
