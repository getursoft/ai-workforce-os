import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  RequestTimeoutException,
  UnprocessableEntityException
} from "@nestjs/common";

/**
 * Stable error codes for the Skills platform, shared by the runtime, lifecycle and controllers.
 * Controllers map these to the codebase's standard exception shapes (safe message + stable code).
 */

export type SkillErrorCode =
  | "SKILL_NOT_FOUND"
  | "SKILL_VERSION_NOT_FOUND"
  | "SKILL_NOT_INSTALLED"
  | "SKILL_ALREADY_INSTALLED"
  | "SKILL_DISABLED"
  | "SKILL_EMPLOYEE_GRANT_DENIED"
  | "SKILL_EMPLOYEE_NOT_FOUND"
  | "SKILL_ORGANIZATION_DENIED"
  | "SKILL_ENTITLEMENT_DENIED"
  | "SKILL_LIMIT_REACHED"
  | "SKILL_DEPENDENCY_MISSING"
  | "SKILL_DEPENDENCY_VERSION_CONFLICT"
  | "SKILL_DEPENDENCY_CYCLE"
  | "SKILL_INPUT_INVALID"
  | "SKILL_OUTPUT_INVALID"
  | "SKILL_TIMEOUT"
  | "SKILL_PAYLOAD_TOO_LARGE"
  | "SKILL_INSTALLATION_STATE_CONFLICT"
  | "SKILL_INVALID_CONFIGURATION"
  | "SKILL_SENSITIVE_PERMISSION_REQUIRED"
  | "SKILL_RUN_REPLAY"
  | "SKILL_INTERNAL_ERROR"
  // Sprint 6.1B — Skills Platform Enterprise Completion. Additive only: new sibling error codes for
  // the pipeline/pack/template features, following the exact same stable-code convention as above.
  | "SKILL_PIPELINE_NOT_FOUND"
  | "SKILL_PIPELINE_NODE_INVALID"
  | "SKILL_PIPELINE_EXECUTION_NOT_FOUND"
  | "SKILL_PACK_NOT_FOUND"
  | "SKILL_PACK_ALREADY_INSTALLED"
  | "SKILL_TEMPLATE_NOT_FOUND";

export class SkillError extends Error {
  constructor(
    readonly code: SkillErrorCode,
    message?: string,
    readonly details?: unknown
  ) {
    super(message ?? code);
    this.name = "SkillError";
  }
}

/** Maps a SkillErrorCode (or any error) to the codebase's standard NestJS exception shape. */
export function toSkillHttpError(error: unknown): Error {
  if (error instanceof SkillError) {
    switch (error.code) {
      case "SKILL_NOT_FOUND":
      case "SKILL_VERSION_NOT_FOUND":
      case "SKILL_EMPLOYEE_NOT_FOUND":
      case "SKILL_PIPELINE_NOT_FOUND":
      case "SKILL_PIPELINE_EXECUTION_NOT_FOUND":
      case "SKILL_PACK_NOT_FOUND":
      case "SKILL_TEMPLATE_NOT_FOUND":
        return new NotFoundException(error.code);
      case "SKILL_NOT_INSTALLED":
      case "SKILL_EMPLOYEE_GRANT_DENIED":
      case "SKILL_ORGANIZATION_DENIED":
      case "SKILL_ENTITLEMENT_DENIED":
      case "SKILL_SENSITIVE_PERMISSION_REQUIRED":
        return new ForbiddenException(error.code);
      case "SKILL_INPUT_INVALID":
      case "SKILL_INVALID_CONFIGURATION":
      case "SKILL_PAYLOAD_TOO_LARGE":
      case "SKILL_PIPELINE_NODE_INVALID":
        return new BadRequestException(error.code);
      case "SKILL_TIMEOUT":
        return new RequestTimeoutException(error.code);
      case "SKILL_ALREADY_INSTALLED":
      case "SKILL_DISABLED":
      case "SKILL_DEPENDENCY_MISSING":
      case "SKILL_DEPENDENCY_VERSION_CONFLICT":
      case "SKILL_DEPENDENCY_CYCLE":
      case "SKILL_LIMIT_REACHED":
      case "SKILL_INSTALLATION_STATE_CONFLICT":
      case "SKILL_RUN_REPLAY":
      case "SKILL_PACK_ALREADY_INSTALLED":
        return new ConflictException(error.code);
      case "SKILL_OUTPUT_INVALID":
      case "SKILL_INTERNAL_ERROR":
        return new UnprocessableEntityException(error.code);
    }
  }
  return error instanceof Error ? error : new SkillError("SKILL_INTERNAL_ERROR", "Unexpected skill error");
}

/** Converts a raw adapter/parse failure into a stable, safe error code. */
export function safeSkillErrorCode(error: unknown): string {
  if (error instanceof SkillError) return error.code;
  if (error instanceof Error) {
    if (error.message.includes("TIMEOUT")) return "SKILL_TIMEOUT";
    if (error.message.startsWith("SKILL_")) return error.message;
    return "SKILL_INTERNAL_ERROR";
  }
  return "SKILL_INTERNAL_ERROR";
}

/** Safe, bounded error message suitable for persistence (never raw provider output or documents). */
export function safeSkillErrorMessage(error: unknown): string {
  if (error instanceof SkillError) return error.code;
  if (error instanceof Error) return error.message.slice(0, 300);
  return "Skill execution failed";
}
