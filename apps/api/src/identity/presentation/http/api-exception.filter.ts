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
  PayloadTooLargeException,
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
  SIGNUP_DISABLED: HttpStatus.FORBIDDEN,
  PLATFORM_OWNER_REQUIRED: HttpStatus.FORBIDDEN,
  ORGANIZATION_SWITCH_DENIED: HttpStatus.FORBIDDEN,
  EMAIL_ALREADY_EXISTS: HttpStatus.CONFLICT,
  USER_NOT_FOUND: HttpStatus.NOT_FOUND,
  RESOURCE_NOT_FOUND: HttpStatus.NOT_FOUND,
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
  EMAIL_CONFIGURATION_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  PLUGIN_SECRETS_KEY_INVALID: HttpStatus.SERVICE_UNAVAILABLE,
  DATABASE_SCHEMA_OUT_OF_DATE: HttpStatus.SERVICE_UNAVAILABLE,
  AI_PROVIDER_AUTHENTICATION_FAILED: HttpStatus.UNPROCESSABLE_ENTITY,
  AI_PROVIDER_MODEL_NOT_FOUND: HttpStatus.UNPROCESSABLE_ENTITY,
  AI_PROVIDER_QUOTA_EXCEEDED: HttpStatus.TOO_MANY_REQUESTS,
  AI_PROVIDER_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  AI_PROVIDER_TEST_FAILED: HttpStatus.BAD_GATEWAY,
  AI_PROVIDER_RESPONSE_INVALID: HttpStatus.BAD_GATEWAY,
  AGENT_EXECUTION_FAILED: HttpStatus.INTERNAL_SERVER_ERROR,
  DEVELOPMENT_PROVIDER_NOT_ALLOWED: HttpStatus.CONFLICT,
  DEVELOPMENT_PLUGIN_NOT_ALLOWED: HttpStatus.CONFLICT,
  DEVELOPMENT_CONNECTOR_NOT_ALLOWED: HttpStatus.CONFLICT,
  PRODUCTION_CONFIGURATION_INVALID: HttpStatus.SERVICE_UNAVAILABLE,
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
  CONNECTOR_RESPONSE_INVALID: HttpStatus.BAD_GATEWAY,
  KNOWLEDGE_DOCUMENT_NOT_FOUND: HttpStatus.NOT_FOUND,
  KNOWLEDGE_FILE_REQUIRED: HttpStatus.BAD_REQUEST,
  KNOWLEDGE_FILE_TOO_LARGE: HttpStatus.PAYLOAD_TOO_LARGE,
  KNOWLEDGE_FILE_TYPE_UNSUPPORTED: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  KNOWLEDGE_FILE_INVALID: HttpStatus.BAD_REQUEST,
  KNOWLEDGE_TEXT_NOT_EXTRACTABLE: HttpStatus.UNPROCESSABLE_ENTITY,
  KNOWLEDGE_INDEXING_FAILED: HttpStatus.UNPROCESSABLE_ENTITY,
  KNOWLEDGE_DOCUMENT_NOT_INDEXED: HttpStatus.CONFLICT,
  KNOWLEDGE_SEARCH_QUERY_REQUIRED: HttpStatus.BAD_REQUEST,
  EMBEDDING_PROVIDER_NOT_CONFIGURED: HttpStatus.UNPROCESSABLE_ENTITY,
  EMBEDDING_PROVIDER_REQUEST_FAILED: HttpStatus.BAD_GATEWAY,
  EMBEDDING_PROVIDER_RESPONSE_INVALID: HttpStatus.BAD_GATEWAY,
  PAYMENT_GATEWAY_NOT_CONFIGURED: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_CREDIT_PACKAGE: HttpStatus.BAD_REQUEST,
  CREDIT_PURCHASE_ORDER_NOT_FOUND: HttpStatus.NOT_FOUND,
  CREDIT_PURCHASE_ORDER_NOT_PENDING: HttpStatus.CONFLICT,
  CREDIT_PURCHASE_ORDER_MISMATCH: HttpStatus.BAD_REQUEST,
  PAYMENT_SIGNATURE_INVALID: HttpStatus.BAD_REQUEST,
  PAYMENT_SETTINGS_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  NO_ELIGIBLE_EMPLOYEE: HttpStatus.UNPROCESSABLE_ENTITY,
  DELEGATION_NOT_ALLOWED: HttpStatus.FORBIDDEN,
  DELEGATION_CYCLE_DETECTED: HttpStatus.CONFLICT,
  DELEGATION_DEPTH_EXCEEDED: HttpStatus.CONFLICT,
  TASK_SCHEMA_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  TARGET_EXECUTION_FAILED: HttpStatus.BAD_GATEWAY,
  TASK_TIMED_OUT: HttpStatus.GATEWAY_TIMEOUT,
  RESULT_SCHEMA_INVALID: HttpStatus.BAD_GATEWAY,
  PARENT_EXECUTION_CLOSED: HttpStatus.CONFLICT,
  WORKFORCE_TASK_NOT_FOUND: HttpStatus.NOT_FOUND,
  WORKFORCE_JOIN_NOT_FOUND: HttpStatus.NOT_FOUND,
  WORKFORCE_CAPABILITY_NOT_GRANTED: HttpStatus.FORBIDDEN,
  WORKFORCE_CROSS_TENANT_DENIED: HttpStatus.FORBIDDEN,
  WORKFORCE_DUPLICATE_COMPLETION: HttpStatus.CONFLICT,
  WORKFORCE_EMPLOYEE_NOT_INSTALLED: HttpStatus.UNPROCESSABLE_ENTITY,
  WORKFORCE_TARGET_DISABLED: HttpStatus.CONFLICT,
  BILLING_SUBSCRIPTION_INACTIVE: HttpStatus.PAYMENT_REQUIRED,
  BILLING_HARD_LIMIT_REACHED: HttpStatus.PAYMENT_REQUIRED,
  BILLING_SPENDING_CAP_REACHED: HttpStatus.PAYMENT_REQUIRED,
  RATE_LIMIT_EXCEEDED: HttpStatus.TOO_MANY_REQUESTS,
  ENTITLEMENT_LIMIT_REACHED: HttpStatus.FORBIDDEN,
  ENTITLEMENT_FEATURE_NOT_AVAILABLE: HttpStatus.FORBIDDEN,
  ACCOUNT_LOCKED: HttpStatus.TOO_MANY_REQUESTS
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
      const code = stableHttpErrorCode(exception);
      if (code) return new IdentityApplicationError(code, stableHttpErrorMessage(code));
    }
    if (exception instanceof PayloadTooLargeException) {
      return new IdentityApplicationError(
        "KNOWLEDGE_FILE_TOO_LARGE",
        "The document exceeds the configured file-size limit."
      );
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
        "RESOURCE_NOT_FOUND",
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

function stableHttpErrorCode(exception: HttpException): IdentityErrorCode | undefined {
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
  return message?.startsWith("CONNECTOR_") ||
    message?.startsWith("KNOWLEDGE_") ||
    message?.startsWith("EMBEDDING_") ||
    message?.startsWith("WORKFORCE_")
    ? (message as IdentityErrorCode)
    : undefined;
}

function stableHttpErrorMessage(code: IdentityErrorCode): string {
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
    CONNECTOR_TOOL_TIMEOUT: "The connector tool timed out.",
    KNOWLEDGE_DOCUMENT_NOT_FOUND: "The knowledge document was not found.",
    KNOWLEDGE_FILE_REQUIRED: "A document file is required.",
    KNOWLEDGE_FILE_TOO_LARGE: "The document exceeds the configured file-size limit.",
    KNOWLEDGE_FILE_TYPE_UNSUPPORTED: "The document type is not supported.",
    KNOWLEDGE_FILE_INVALID: "The document file is invalid.",
    KNOWLEDGE_TEXT_NOT_EXTRACTABLE: "No extractable text was found in the document.",
    KNOWLEDGE_INDEXING_FAILED: "The document could not be indexed safely.",
    KNOWLEDGE_SEARCH_QUERY_REQUIRED: "A knowledge search query is required.",
    EMBEDDING_PROVIDER_NOT_CONFIGURED: "An embedding provider is not configured.",
    EMBEDDING_PROVIDER_REQUEST_FAILED: "The embedding provider request failed.",
    EMBEDDING_PROVIDER_RESPONSE_INVALID: "The embedding provider returned an invalid response.",
    WORKFORCE_TASK_NOT_FOUND: "The delegated task was not found.",
    WORKFORCE_JOIN_NOT_FOUND: "The parallel delegation join was not found."
  };
  return messages[code] ?? "The connector operation could not be completed safely.";
}
