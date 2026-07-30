import { Injectable } from "@nestjs/common";
import {
  ConversationStatus,
  Prisma,
  SkillExecutionStatus,
  type SkillExecution
} from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { PlanTripSkillState } from "./travel/plan-trip.skill";
import { PlanTripSkillExecutionMapper } from "./travel/plan-trip-skill-execution.mapper";

const ACTIVE_STATUSES: readonly SkillExecutionStatus[] = [
  SkillExecutionStatus.ACTIVE,
  SkillExecutionStatus.WAITING_FOR_INPUT,
  SkillExecutionStatus.READY
];
const MAX_PROCESSED_TURNS = 100;

export interface SkillExecutionScope {
  organizationId: string;
  pluginInstallationId: string;
  conversationId: string;
  skillId: string;
}

export interface SkillExecutionMutationResult {
  execution: SkillExecution;
  applied: boolean;
  idempotentReplay: boolean;
}

export class SkillExecutionRevisionConflictError extends Error {
  constructor() {
    super("SKILL_EXECUTION_REVISION_CONFLICT");
  }
}

@Injectable()
export class SkillExecutionService {
  constructor(private readonly prisma: PrismaService) {}

  async findActiveExecution(scope: SkillExecutionScope): Promise<SkillExecution | null> {
    return this.prisma.skillExecution.findFirst({
      where: {
        ...scope,
        conversation: { status: ConversationStatus.ACTIVE, deletedAt: null },
        status: { in: [...ACTIVE_STATUSES] },
        activeKey: { not: null }
      },
      orderBy: { updatedAt: "desc" }
    });
  }

  async loadExecution(organizationId: string, id: string): Promise<SkillExecution | null> {
    return this.prisma.skillExecution.findFirst({ where: { id, organizationId } });
  }

  async createExecution(input: {
    scope: SkillExecutionScope;
    skillVersion: string;
    schemaVersion: number;
    state: PlanTripSkillState;
    pendingInput: string | null;
    agentExecutionId: string;
    turnId: string;
  }): Promise<SkillExecutionMutationResult> {
    PlanTripSkillExecutionMapper.toJson(input.state);
    await this.assertReferences(input.scope, input.agentExecutionId);
    const activeKey = this.activeKey(input.scope);
    const data = {
      ...input.scope,
      skillVersion: input.skillVersion,
      schemaVersion: input.schemaVersion,
      status: statusForState(input.state),
      state: PlanTripSkillExecutionMapper.toJson(input.state),
      pendingInput: input.pendingInput,
      originatingAgentExecutionId: input.agentExecutionId,
      latestAgentExecutionId: input.agentExecutionId,
      revision: input.state.revision,
      processedTurnIds: [input.turnId],
      activeKey
    };
    try {
      const execution = await this.prisma.skillExecution.create({ data });
      return { execution, applied: true, idempotentReplay: false };
    } catch (error) {
      if (isUniqueConflict(error)) {
        const winner = await this.findActiveExecution(input.scope);
        if (winner)
          return {
            execution: winner,
            applied: false,
            idempotentReplay: hasTurn(winner, input.turnId)
          };
      }
      throw error;
    }
  }

  async updateExecutionState(input: {
    organizationId: string;
    id: string;
    expectedRevision: number;
    state: PlanTripSkillState;
    pendingInput: string | null;
    latestAgentExecutionId: string;
    turnId: string;
  }): Promise<SkillExecutionMutationResult> {
    const existing = await this.loadExecution(input.organizationId, input.id);
    if (!existing) throw new SkillExecutionRevisionConflictError();
    if (hasTurn(existing, input.turnId))
      return { execution: existing, applied: false, idempotentReplay: true };
    PlanTripSkillExecutionMapper.toJson(input.state);
    const processedTurnIds = [...readTurnIds(existing), input.turnId].slice(-MAX_PROCESSED_TURNS);
    const result = await this.prisma.skillExecution.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        revision: input.expectedRevision,
        activeKey: { not: null },
        status: { in: [...ACTIVE_STATUSES] }
      },
      data: {
        state: PlanTripSkillExecutionMapper.toJson(input.state),
        schemaVersion: input.state.schemaVersion,
        status: statusForState(input.state),
        pendingInput: input.pendingInput,
        latestAgentExecutionId: input.latestAgentExecutionId,
        revision: { increment: 1 },
        processedTurnIds
      }
    });
    if (result.count !== 1) throw new SkillExecutionRevisionConflictError();
    const execution = await this.loadExecution(input.organizationId, input.id);
    if (!execution) throw new SkillExecutionRevisionConflictError();
    return { execution, applied: true, idempotentReplay: false };
  }

  markReady(input: StatusStateInput): Promise<SkillExecutionMutationResult> {
    return this.updateExecutionState({
      ...input,
      state: { ...input.state, lifecycleStatus: "READY" },
      pendingInput: null
    });
  }

  markWaitingForInput(input: StatusStateInput): Promise<SkillExecutionMutationResult> {
    return this.updateExecutionState({
      ...input,
      state: { ...input.state, lifecycleStatus: "COLLECTING_INPUT" }
    });
  }

  markCompleted(input: TerminalInput): Promise<SkillExecution> {
    return this.markTerminal(input, SkillExecutionStatus.COMPLETED);
  }

  markFailed(input: TerminalInput): Promise<SkillExecution> {
    return this.markTerminal(input, SkillExecutionStatus.FAILED);
  }

  markCancelled(input: TerminalInput): Promise<SkillExecution> {
    return this.markTerminal(input, SkillExecutionStatus.CANCELLED);
  }

  private async markTerminal(
    input: TerminalInput,
    status: "COMPLETED" | "CANCELLED" | "FAILED"
  ): Promise<SkillExecution> {
    const result = await this.prisma.skillExecution.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        revision: input.expectedRevision,
        activeKey: { not: null }
      },
      data: {
        status,
        activeKey: null,
        completedAt: new Date(),
        completionReason: input.completionReason,
        latestAgentExecutionId: input.latestAgentExecutionId,
        revision: { increment: 1 }
      }
    });
    if (result.count !== 1) throw new SkillExecutionRevisionConflictError();
    const execution = await this.loadExecution(input.organizationId, input.id);
    if (!execution) throw new SkillExecutionRevisionConflictError();
    return execution;
  }

  private activeKey(scope: SkillExecutionScope): string {
    return `${scope.organizationId}:${scope.pluginInstallationId}:${scope.conversationId}:${scope.skillId}`;
  }

  private async assertReferences(
    scope: SkillExecutionScope,
    agentExecutionId: string
  ): Promise<void> {
    const [conversation, execution] = await Promise.all([
      this.prisma.conversation.count({
        where: {
          id: scope.conversationId,
          organizationId: scope.organizationId,
          pluginInstallationId: scope.pluginInstallationId,
          status: ConversationStatus.ACTIVE,
          deletedAt: null
        }
      }),
      this.prisma.agentExecution.count({
        where: {
          id: agentExecutionId,
          organizationId: scope.organizationId,
          conversationId: scope.conversationId,
          pluginInstallationId: scope.pluginInstallationId
        }
      })
    ]);
    if (conversation !== 1 || execution !== 1) throw new Error("SKILL_EXECUTION_SCOPE_INVALID");
  }
}

interface StatusStateInput {
  organizationId: string;
  id: string;
  expectedRevision: number;
  state: PlanTripSkillState;
  pendingInput: string | null;
  latestAgentExecutionId: string;
  turnId: string;
}

interface TerminalInput {
  organizationId: string;
  id: string;
  expectedRevision: number;
  latestAgentExecutionId: string;
  completionReason: string;
}

function statusForState(state: PlanTripSkillState): SkillExecutionStatus {
  return state.lifecycleStatus === "READY"
    ? SkillExecutionStatus.READY
    : SkillExecutionStatus.WAITING_FOR_INPUT;
}

function readTurnIds(execution: SkillExecution): string[] {
  return Array.isArray(execution.processedTurnIds)
    ? execution.processedTurnIds.filter((value): value is string => typeof value === "string")
    : [];
}

function hasTurn(execution: SkillExecution, turnId: string): boolean {
  return readTurnIds(execution).includes(turnId);
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
