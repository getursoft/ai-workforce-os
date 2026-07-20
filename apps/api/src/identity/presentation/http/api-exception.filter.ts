import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  ForbiddenException,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException
} from "@nestjs/common";
import {
  IdentityApplicationError,
  type IdentityErrorCode
} from "../../application/errors/identity.error";
import { PersistenceConflictError } from "../../application/ports/persistence-error";
import { InvalidSecurityConfigurationError } from "../../application/errors/security.error";
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
  INTERNAL_ERROR: HttpStatus.INTERNAL_SERVER_ERROR,
  PLUGIN_MANIFEST_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  PLUGIN_CONFIGURATION_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  PLUGIN_NOT_FOUND: HttpStatus.NOT_FOUND,
  AI_PROVIDER_CONFIGURATION_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  PLUGIN_SECRETS_KEY_INVALID: HttpStatus.SERVICE_UNAVAILABLE,
  DATABASE_SCHEMA_OUT_OF_DATE: HttpStatus.SERVICE_UNAVAILABLE,
  AI_PROVIDER_AUTHENTICATION_FAILED: HttpStatus.UNPROCESSABLE_ENTITY,
  AI_PROVIDER_MODEL_NOT_FOUND: HttpStatus.UNPROCESSABLE_ENTITY,
  AI_PROVIDER_QUOTA_EXCEEDED: HttpStatus.TOO_MANY_REQUESTS,
  AI_PROVIDER_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  AI_PROVIDER_TEST_FAILED: HttpStatus.BAD_GATEWAY,
  AI_PROVIDER_RESPONSE_INVALID: HttpStatus.BAD_GATEWAY,
  AGENT_EXECUTION_FAILED: HttpStatus.INTERNAL_SERVER_ERROR,
  CONNECTOR_NOT_FOUND: HttpStatus.NOT_FOUND,
  CONNECTOR_INSTALLATION_NOT_FOUND: HttpStatus.NOT_FOUND,
  CONNECTOR_ALREADY_INSTALLED: HttpStatus.CONFLICT,
  CONNECTOR_CONFIGURATION_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  CONNECTOR_CREDENTIALS_REQUIRED: HttpStatus.UNPROCESSABLE_ENTITY,
  CONNECTOR_CREDENTIALS_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  CONNECTOR_AUTHENTICATION_FAILED: HttpStatus.UNPROCESSABLE_ENTITY,
  CONNECTOR_AUTHENTICATION_EXPIRED: HttpStatus.UNPROCESSABLE_ENTITY,
  CONNECTOR_DISABLED: HttpStatus.CONFLICT,
  CONNECTOR_DISCONNECTED: HttpStatus.CONFLICT,
  CONNECTOR_CAPABILITY_NOT_GRANTED: HttpStatus.FORBIDDEN,
  CONNECTOR_TOOL_NOT_FOUND: HttpStatus.NOT_FOUND,
  CONNECTOR_TOOL_EXECUTION_FAILED: HttpStatus.BAD_GATEWAY,
  CONNECTOR_TOOL_TIMEOUT: HttpStatus.GATEWAY_TIMEOUT,
  CONNECTOR_RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  CONNECTOR_HEALTH_CHECK_FAILED: HttpStatus.BAD_GATEWAY,
  CONNECTOR_RESPONSE_INVALID: HttpStatus.BAD_GATEWAY
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
    if (
      exception instanceof InvalidSecurityConfigurationError &&
      exception.code === "PLUGIN_SECRETS_KEY_INVALID"
    ) {
      return new IdentityApplicationError(
        "PLUGIN_SECRETS_KEY_INVALID",
        "Plugin secret encryption is not configured."
      );
    }
    if (exception instanceof HttpException) {
      const code = connectorErrorCode(exception);
      if (code) return new IdentityApplicationError(code, connectorErrorMessage(code));
    }
    if (exception instanceof BadRequestException) {
      return new IdentityApplicationError(
        "VALIDATION_ERROR",
        "The request is invalid.",
        this.validationDetails(exception)
      );
    }
    if (exception instanceof UnprocessableEntityException) {
      const response = exception.getResponse();
      const details =
        typeof response === "object" && response !== null && "message" in response
          ? Array.isArray((response as { message?: unknown }).message)
            ? (response as { message: string[] }).message
            : [String((response as { message?: unknown }).message ?? "Plugin validation failed")]
          : [];
      return new IdentityApplicationError(
        "PLUGIN_MANIFEST_INVALID",
        "Plugin validation failed.",
        details
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

function connectorErrorCode(exception: HttpException): IdentityErrorCode | undefined {
  const response = exception.getResponse();
  const message =
    typeof response === "string"
      ? response
      : typeof response === "object" &&
          response !== null &&
          "message" in response &&
          typeof (response as { message?: unknown }).message === "string"
        ? (response as { message: string }).message
        : undefined;
  return message?.startsWith("CONNECTOR_") ? (message as IdentityErrorCode) : undefined;
}

function connectorErrorMessage(code: IdentityErrorCode): string {
  const messages: Partial<Record<IdentityErrorCode, string>> = {
    CONNECTOR_NOT_FOUND: "The connector was not found.",
    CONNECTOR_INSTALLATION_NOT_FOUND: "The connector installation was not found.",
    CONNECTOR_ALREADY_INSTALLED: "The connector is already installed.",
    CONNECTOR_CONFIGURATION_INVALID: "The connector configuration is invalid.",
    CONNECTOR_CREDENTIALS_REQUIRED: "Connector credentials are required.",
    CONNECTOR_CREDENTIALS_INVALID: "The connector credentials are invalid.",
    CONNECTOR_CAPABILITY_NOT_GRANTED: "The connector capability is not granted.",
    CONNECTOR_DISABLED: "The connector is disabled.",
    CONNECTOR_DISCONNECTED: "The connector is disconnected.",
    CONNECTOR_TOOL_TIMEOUT: "The connector tool timed out."
  };
  return messages[code] ?? "The connector operation could not be completed safely.";
}
