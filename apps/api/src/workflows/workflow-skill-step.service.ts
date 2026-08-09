import { Injectable, Optional } from "@nestjs/common";
import { SkillsRuntimeService } from "../skills-platform/skill-runtime.service";
import type { SkillExecuteResult } from "../skills-platform/skill-runtime.contracts";

export interface WorkflowSkillStepInput {
  organizationId: string;
  workflowExecutionId: string;
  skillKey: string;
  input: unknown;
  pluginInstallationId?: string;
  conversationId?: string;
  versionConstraint?: string;
  idempotencyKey?: string;
}

/**
 * Sprint 6.1 — Phase 13 workflow integration.
 *
 * The workflow engine has no generic, declarative step-type/DAG dispatcher (each `WorkflowType` —
 * CONTACT_CAPTURE, BOOKING_HANDOFF, TRIP_SUBMISSION, EMPLOYEE_DELEGATION — is its own hand-written
 * service reading/writing a free-form `state` JSON blob; see workflow-coordinator.ts). Building one
 * is a large, separable project and is explicitly out of scope here (Phase 26: workflow state
 * machines are not migrated). This service is instead the single additive choke point any current or
 * future workflow-type service can call to run a skill from within a step: it does nothing but
 * delegate to SkillsRuntimeService.execute() with `workflowExecutionId` attached, so the resulting
 * SkillRun is durably linked back to the workflow (`SkillRun.workflowExecutionId`) for billing,
 * tracing and audit — exactly like a workflow-type service's own state is persisted through
 * WorkflowExecutionService, without a second engine and without editing any state machine's
 * internals. Skill output does not get written into workflow `state` here; the calling workflow-type
 * service does that itself via its normal WorkflowExecutionService.updateWorkflowState call, the same
 * way it already merges any other step result — this method only returns the outcome.
 */
@Injectable()
export class WorkflowSkillStepService {
  constructor(@Optional() private readonly skillsRuntime?: SkillsRuntimeService) {}

  async invoke(request: WorkflowSkillStepInput): Promise<SkillExecuteResult> {
    if (!this.skillsRuntime) throw new Error("SKILL_PLATFORM_UNAVAILABLE");
    return this.skillsRuntime.execute({
      skillKey: request.skillKey,
      organizationId: request.organizationId,
      workflowExecutionId: request.workflowExecutionId,
      input: request.input,
      ...(request.pluginInstallationId ? { pluginInstallationId: request.pluginInstallationId } : {}),
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      ...(request.versionConstraint ? { versionConstraint: request.versionConstraint } : {}),
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {})
    });
  }
}
