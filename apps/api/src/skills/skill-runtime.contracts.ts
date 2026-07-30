export type SkillLifecycleStatus = "COLLECTING_INPUT" | "READY" | "COMPLETED" | "CANCELLED";

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  activeVersion: string;
}

export interface SkillVersion<TState extends SkillState = SkillState> {
  skillId: string;
  version: string;
  schemaVersion: number;
  initialState(): TState;
}

export interface SkillContext<TState extends SkillState = SkillState> {
  organizationId: string;
  pluginInstallationId: string;
  conversationId: string;
  requestId: string;
  currentState: TState;
}

export interface SkillState {
  schemaVersion: number;
  revision: number;
  lifecycleStatus: SkillLifecycleStatus;
}

export type SkillValueSource = "USER_EXPLICIT" | "DERIVED" | "MODEL_INFERRED" | "EXISTING_RUNTIME";

export interface SkillInput<TData = unknown> {
  data: TData;
}

export interface SkillTurnDecision<TState extends SkillState = SkillState> {
  skillId: string;
  skillVersion: string;
  action: "ASK_FOR_INPUT" | "READY";
  missingInput: string | null;
  capabilities?: Readonly<Record<string, boolean>>;
  blockers?: readonly string[];
  policyWarnings?: readonly string[];
  state: TState;
}

export interface SkillTransition<TState extends SkillState = SkillState> {
  previousRevision: number;
  nextRevision: number;
  previousStatus: SkillLifecycleStatus;
  nextStatus: SkillLifecycleStatus;
  state: TState;
}

export interface SkillValidationResult {
  valid: boolean;
  errors: Array<{ path: string; code: string }>;
}

export interface SkillEvaluation<TState extends SkillState = SkillState> {
  decision: SkillTurnDecision<TState>;
  transition: SkillTransition<TState>;
  validation: SkillValidationResult;
}

export interface SkillHandler<
  TState extends SkillState = SkillState,
  TInput extends SkillInput<unknown> = SkillInput
> {
  readonly definition: SkillDefinition;
  readonly version: SkillVersion<TState>;
  evaluate(context: SkillContext<TState>, input: TInput): SkillEvaluation<TState>;
}

// Stage 8: InputDecision - Skill Runtime becomes authoritative for input collection
// Re-exported for convenience; defined in input-decision.dto.ts
export type { InputDecision, InputDecisionType, PendingInputCode, ReadinessCapabilities, DecisionContext } from "./travel/input-decision.dto";
