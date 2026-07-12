import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  ForbiddenException,
  type ExceptionFilter,
  HttpStatus,
  NotFoundException,
  UnauthorizedException
} from "@nestjs/common";
import {
  IdentityApplicationError,
  type IdentityErrorCode
} from "../../application/errors/identity.error";
import { PersistenceConflictError } from "../../application/ports/persistence-error";
import {
  InvalidDomainValueError,
  InvalidEntityStateError,
  InvalidStateTransitionError
} from "../../domain/shared/domain.error";
import type { IdentityRequest, IdentityResponse } from "./request-context";

interface ErrorBody {
  error: {
    code: IdentityErrorCode;
    message: string;
    details: readonly string[];
    requestId: string;
    timestamp: string;
  };
}

const STATUS: Record<IdentityErrorCode, number> = {
  VALIDATION_ERROR: HttpStatus.BAD_REQUEST,
  AUTHENTICATION_FAILED: HttpStatus.UNAUTHORIZED,
  AUTHORIZATION_FAILED: HttpStatus.FORBIDDEN,
  EMAIL_ALREADY_EXISTS: HttpStatus.CONFLICT,
  USER_NOT_FOUND: HttpStatus.NOT_FOUND,
  ORGANIZATION_NOT_FOUND: HttpStatus.NOT_FOUND,
  USER_INACTIVE: HttpStatus.FORBIDDEN,
  ORGANIZATION_INACTIVE: HttpStatus.FORBIDDEN,
  INVALID_REFRESH_TOKEN: HttpStatus.UNAUTHORIZED,
  REFRESH_TOKEN_EXPIRED: HttpStatus.UNAUTHORIZED,
  REFRESH_TOKEN_REUSED: HttpStatus.UNAUTHORIZED,
  CONFLICT: HttpStatus.CONFLICT,
  INTERNAL_ERROR: HttpStatus.INTERNAL_SERVER_ERROR
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<IdentityRequest>();
    const response = context.getResponse<IdentityResponse>();
    const mapped = this.map(exception);
    const body: ErrorBody = {
      error: {
        code: mapped.code,
        message: mapped.message,
        details: mapped.details,
        requestId: request.requestId,
        timestamp: new Date().toISOString()
      }
    };
    response.status(STATUS[mapped.code]).json(body);
  }

  private map(exception: unknown): IdentityApplicationError {
    if (exception instanceof IdentityApplicationError) {
      return exception;
    }
    if (exception instanceof BadRequestException) {
      return new IdentityApplicationError(
        "VALIDATION_ERROR",
        "The request is invalid.",
        this.validationDetails(exception)
      );
    }
    if (exception instanceof UnauthorizedException) {
      return new IdentityApplicationError("AUTHENTICATION_FAILED", "Authentication is required.");
    }
    if (exception instanceof ForbiddenException) {
      return new IdentityApplicationError(
        "AUTHORIZATION_FAILED",
        "You are not allowed to perform this action."
      );
    }
    if (exception instanceof NotFoundException) {
      return new IdentityApplicationError(
        "USER_NOT_FOUND",
        "The requested resource was not found."
      );
    }
    if (exception instanceof ConflictException) {
      return new IdentityApplicationError("CONFLICT", "The request conflicts with current state.");
    }
    if (
      exception instanceof InvalidDomainValueError ||
      exception instanceof InvalidEntityStateError ||
      exception instanceof InvalidStateTransitionError
    ) {
      return new IdentityApplicationError("VALIDATION_ERROR", "The request is invalid.");
    }
    if (exception instanceof PersistenceConflictError) {
      return new IdentityApplicationError("CONFLICT", "The request conflicts with current state.");
    }
    return new IdentityApplicationError("INTERNAL_ERROR", "An internal error occurred.");
  }

  private validationDetails(exception: BadRequestException): readonly string[] {
    const response: unknown = exception.getResponse();
    if (typeof response === "object" && response !== null && "message" in response) {
      const message = (response as { message?: unknown }).message;
      if (Array.isArray(message)) {
        return message.filter((item): item is string => typeof item === "string");
      }
    }
    return [];
  }
}
