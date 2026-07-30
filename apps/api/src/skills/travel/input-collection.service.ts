import { Injectable, Logger } from "@nestjs/common";
import type { PlanTripSkillState } from "./plan-trip.skill";
import { InputDecisionService } from "./input-decision.service";
import { PendingInputQuestionService } from "./pending-input-question.service";
import { SkillExecutionMirrorService } from "./skill-execution-mirror.service";
import type { InputDecision, PendingInputCode } from "./input-decision.dto";
import { SkillExecutionService } from "../skill-execution.service";
import { PLAN_TRIP_SKILL_ID } from "./plan-trip.skill";
import type { SkillExecutionScope } from "../skill-execution.service";
import type { TravelEntities } from "../../travel/travel.runtime";

export interface InputCollectionContext {
  organizationId: string;
  pluginInstallationId: string;
  conversationId: string;
  requestId: string;
  currentState: PlanTripSkillState;
  lastAssistantMessage: string | null;
  conversationLanguage: string;
}

export interface InputCollectionResult {
  decision: InputDecision;
  loadedExecution: {
    id: string;
    revision: number;
  } | null;
  migrationReason?: string;
}

/**
 * InputCollectionService orchestrates authoritative input collection in Stage 8B.
 *
 * Responsibilities:
 * - Load the active SkillExecution from canonical storage
 * - Merge canonical state with current user input
 * - Generate an InputDecision that controls what happens next
 * - Support graceful fallback to legacy Travel Runtime
 *
 * This service operates purely in the authoritative path. In SHADOW mode,
 * Travel Runtime remains completely unchanged.
 */
@Injectable()
export class InputCollectionService {
  private readonly logger = new Logger(InputCollectionService.name);

  constructor(
    private readonly inputDecisionService: InputDecisionService,
    private readonly pendingInputQuestionService: PendingInputQuestionService,
    private readonly mirrorService: SkillExecutionMirrorService,
    private readonly skillExecutions: SkillExecutionService
  ) {}

  /**
   * Generate an InputDecision for the current conversation state.
   *
   * This is the entry point for authoritative input collection.
   * - Loads active SkillExecution
   * - Generates InputDecision
   * - Returns decision for routing
   *
   * Never throws. Failures are wrapped as error decisions.
   */
  async collectInput(context: InputCollectionContext): Promise<InputCollectionResult> {
    const scope: SkillExecutionScope = {
      organizationId: context.organizationId,
      pluginInstallationId: context.pluginInstallationId,
      conversationId: context.conversationId,
      skillId: PLAN_TRIP_SKILL_ID
    };

    let loadedExecution = null as { id: string; revision: number } | null;

    try {
      // Load the authoritative SkillExecution
      const execution = await this.skillExecutions.findActiveExecution(scope);
      if (execution) {
        loadedExecution = {
          id: execution.id,
          revision: execution.revision
        };
      }
    } catch (error) {
      this.logger.error({
        event: "INPUT_COLLECTION_LOAD_FAILED",
        context: "skill_execution_load",
        error: error instanceof Error ? error.message : "unknown"
      });
      // Continue with empty state; fallback will handle the error
      return {
        decision: this.inputDecisionService.errorDecision({
          code: "STATE_LOAD_FAILED",
          message: "Could not load execution state; will use legacy fallback",
          severity: "WARNING"
        }),
        loadedExecution: null,
        migrationReason: "LOAD_ERROR"
      };
    }

    try {
      // Generate the input decision
      const decision = this.inputDecisionService.generate(context.currentState, {
        usedLegacyFallback: false,
        decisionTimeMs: 0
      });

      return {
        decision,
        loadedExecution
      };
    } catch (error) {
      this.logger.error({
        event: "INPUT_COLLECTION_DECISION_FAILED",
        context: "decision_generation",
        error: error instanceof Error ? error.message : "unknown"
      });
      return {
        decision: this.inputDecisionService.errorDecision({
          code: "DECISION_GENERATION_FAILED",
          message: "Could not generate decision; will use legacy fallback",
          severity: "WARNING"
        }),
        loadedExecution,
        migrationReason: "DECISION_ERROR"
      };
    }
  }

  /**
   * Get a natural language question prompt for a pending input code.
   *
   * Used when InputDecision.decision === ASK_FOR_INPUT to generate the next
   * question for the user.
   */
  getQuestionForPendingInput(
    pendingInputCode: PendingInputCode,
    language: string
  ): { brief: string; full: string } {
    if (!pendingInputCode) {
      return {
        brief: "What would you like to plan?",
        full: "I'm ready to help you plan your trip! What would you like to work on?"
      };
    }

    return {
      brief: this.pendingInputQuestionService.generateBriefPrompt(pendingInputCode),
      full: this.pendingInputQuestionService.generateQuestion(pendingInputCode, language)
    };
  }

  /**
   * Compute the travel.trip_state mirror for a Skill state, for backward compatibility.
   *
   * Called after SkillExecution is persisted in authoritative mode. The caller (AgentService)
   * is responsible for actually persisting the returned fields onto travel.trip_state; this
   * service only owns the mapping, never blocking the request on mirroring failures.
   */
  mirrorStateToTravelMemory(
    organizationId: string,
    conversationId: string,
    skillState: PlanTripSkillState
  ): Partial<TravelEntities> | null {
    try {
      return this.mirrorService.mirrorStateToTravelEntities(skillState);
    } catch (error) {
      // Mirroring failures do not block the request
      this.logger.warn({
        event: "MIRROR_STATE_FAILED",
        organizationId,
        conversationId,
        error: error instanceof Error ? error.message : "unknown"
      });
      return null;
    }
  }
}
