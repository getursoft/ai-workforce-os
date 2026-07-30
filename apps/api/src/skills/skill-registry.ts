import { Injectable } from "@nestjs/common";
import type { SkillHandler, SkillInput, SkillState } from "./skill-runtime.contracts";

@Injectable()
export class SkillRegistry {
  private readonly handlers = new Map<string, SkillHandler>();

  register(handler: SkillHandler): void {
    const key = this.key(handler.definition.id, handler.version.version);
    if (this.handlers.has(key)) throw new Error("SKILL_REGISTRATION_COLLISION");
    this.handlers.set(key, handler);
  }

  get<TState extends SkillState = SkillState, TInput extends SkillInput<unknown> = SkillInput>(
    skillId: string,
    version: string
  ): SkillHandler<TState, TInput> {
    const handler = this.handlers.get(this.key(skillId, version));
    if (!handler) throw new Error("SKILL_NOT_FOUND");
    return handler as SkillHandler<TState, TInput>;
  }

  private key(skillId: string, version: string): string {
    return `${skillId}@${version}`;
  }
}
