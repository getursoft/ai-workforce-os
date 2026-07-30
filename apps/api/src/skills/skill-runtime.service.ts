import { Injectable } from "@nestjs/common";
import { SkillRegistry } from "./skill-registry";
import type {
  SkillContext,
  SkillEvaluation,
  SkillInput,
  SkillState
} from "./skill-runtime.contracts";

@Injectable()
export class SkillRuntimeService {
  constructor(private readonly registry: SkillRegistry) {}

  evaluate<TState extends SkillState, TInput extends SkillInput<unknown>>(
    skillId: string,
    version: string,
    context: SkillContext<TState>,
    input: TInput
  ): SkillEvaluation<TState> {
    return this.registry.get<TState, TInput>(skillId, version).evaluate(context, input);
  }
}
