/**
 * Sprint 4.7 Phase 0: a standalone DI token with zero other imports. agent.service.ts resolves
 * ChatDelegationTriggerService through this token via ModuleRef instead of a direct class import —
 * importing the class value directly would create a real circular ES-module import (agent.service.ts ->
 * chat-delegation-trigger.service.ts -> workforce-orchestrator.service.ts -> agent.service.ts) that
 * corrupts constructor decorator metadata (TypeScript emits `design:paramtypes` as `Object` instead of
 * the real class when a cycle leaves a binding not-yet-initialized at decoration time), which in turn
 * makes WorkforceOrchestratorService's own AgentService dependency fail to resolve at Nest bootstrap.
 * `import type` for the class (type-only, erased at compile time) plus this token (value-only, no
 * further imports) is enough to resolve it at runtime with zero runtime import edge back into agent code.
 */
export const CHAT_DELEGATION_TRIGGER = Symbol("CHAT_DELEGATION_TRIGGER");
