import type { SkillExecutionContext } from "./context.js";
import type { SkillManifest } from "./manifest.js";
import type { SkillInstaller } from "./installer.js";
import type { SkillExecutionResult, SkillHealthResult } from "./result.js";

/**
 * The core skill contract. Every skill (built-in or future hosted) implements this interface.
 * The runtime resolves an adapter by key/version, validates input, checks installation + grant +
 * permission, executes, validates output, and records usage/billing/trace/audit around it.
 *
 * TInput and TOutput are TypeScript conveniences; the runtime validates against the manifest's
 * JSON schemas, not the types.
 */
export interface SkillAdapter<TInput = unknown, TOutput = unknown> {
  readonly manifest: SkillManifest;
  readonly installer?: SkillInstaller;

  /** Validates the input against the skill's domain rules (beyond JSON Schema). Must not mutate state. */
  validate(input: TInput, context: SkillExecutionContext): Promise<void>;

  /** Executes the skill and returns a normalized result. Must be idempotency-aware for replays. */
  execute(input: TInput, context: SkillExecutionContext): Promise<SkillExecutionResult<TOutput>>;

  /** Reports health: adapter registered, configuration valid, dependencies available, provider
   *  configured, storage reachable, recent success rate. */
  health(context: SkillExecutionContext): Promise<SkillHealthResult>;
}
