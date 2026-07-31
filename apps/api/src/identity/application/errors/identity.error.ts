export type IdentityErrorCode =
  | "VALIDATION_ERROR"
  | "AUTHENTICATION_FAILED"
  | "AUTHORIZATION_FAILED"
  | "EMAIL_ALREADY_EXISTS"
  | "USER_NOT_FOUND"
  | "ORGANIZATION_NOT_FOUND"
  | "USER_INACTIVE"
  | "ORGANIZATION_INACTIVE"
  | "INVALID_REFRESH_TOKEN"
  | "REFRESH_TOKEN_EXPIRED"
  | "REFRESH_TOKEN_REUSED"
  | "CONFLICT"
  | "INTERNAL_ERROR"
  | "PLUGIN_MANIFEST_INVALID"
  | "PLUGIN_CONFIGURATION_INVALID"
  | "PLUGIN_NOT_FOUND"
  | "AI_PROVIDER_CONFIGURATION_INVALID"
  | "EMAIL_CONFIGURATION_INVALID"
  | "PLUGIN_SECRETS_KEY_INVALID"
  | "DATABASE_SCHEMA_OUT_OF_DATE"
  | "AI_PROVIDER_AUTHENTICATION_FAILED"
  | "AI_PROVIDER_MODEL_NOT_FOUND"
  | "AI_PROVIDER_QUOTA_EXCEEDED"
  | "AI_PROVIDER_UNAVAILABLE"
  | "AI_PROVIDER_TEST_FAILED"
  | "AI_PROVIDER_RESPONSE_INVALID"
  | "AGENT_EXECUTION_FAILED"
  | "DEVELOPMENT_PROVIDER_NOT_ALLOWED"
  | "DEVELOPMENT_PLUGIN_NOT_ALLOWED"
  | "DEVELOPMENT_CONNECTOR_NOT_ALLOWED"
  | "PRODUCTION_CONFIGURATION_INVALID"
  | "CONNECTOR_NOT_FOUND"
  | "CONNECTOR_INSTALLATION_NOT_FOUND"
  | "CONNECTOR_ALREADY_INSTALLED"
  | "CONNECTOR_CONFIGURATION_INVALID"
  | "CONNECTOR_CREDENTIALS_REQUIRED"
  | "CONNECTOR_CREDENTIALS_INVALID"
  | "CONNECTOR_AUTHENTICATION_FAILED"
  | "CONNECTOR_AUTHENTICATION_EXPIRED"
  | "CONNECTOR_DISABLED"
  | "CONNECTOR_DISCONNECTED"
  | "CONNECTOR_CAPABILITY_NOT_GRANTED"
  | "CONNECTOR_TOOL_NOT_FOUND"
  | "CONNECTOR_TOOL_EXECUTION_FAILED"
  | "CONNECTOR_TOOL_TIMEOUT"
  | "CONNECTOR_RATE_LIMITED"
  | "CONNECTOR_HEALTH_CHECK_FAILED"
  | "CONNECTOR_RESPONSE_INVALID"
  | "KNOWLEDGE_DOCUMENT_NOT_FOUND"
  | "KNOWLEDGE_FILE_REQUIRED"
  | "KNOWLEDGE_FILE_TOO_LARGE"
  | "KNOWLEDGE_FILE_TYPE_UNSUPPORTED"
  | "KNOWLEDGE_FILE_INVALID"
  | "KNOWLEDGE_TEXT_NOT_EXTRACTABLE"
  | "KNOWLEDGE_INDEXING_FAILED"
  | "KNOWLEDGE_DOCUMENT_NOT_INDEXED"
  | "KNOWLEDGE_SEARCH_QUERY_REQUIRED"
  | "EMBEDDING_PROVIDER_NOT_CONFIGURED"
  | "EMBEDDING_PROVIDER_REQUEST_FAILED"
  | "EMBEDDING_PROVIDER_RESPONSE_INVALID"
  | "PAYMENT_GATEWAY_NOT_CONFIGURED"
  | "INVALID_CREDIT_PACKAGE"
  | "CREDIT_PURCHASE_ORDER_NOT_FOUND"
  | "CREDIT_PURCHASE_ORDER_NOT_PENDING"
  | "CREDIT_PURCHASE_ORDER_MISMATCH"
  | "PAYMENT_SIGNATURE_INVALID";

export class IdentityApplicationError extends Error {
  constructor(
    readonly code: IdentityErrorCode,
    message: string,
    readonly details: readonly string[] = []
  ) {
    super(message);
    this.name = "IdentityApplicationError";
  }
}

export const identityError = {
  validation: (details: readonly string[] = []) =>
    new IdentityApplicationError("VALIDATION_ERROR", "The request is invalid.", details),
  authenticationFailed: () =>
    new IdentityApplicationError("AUTHENTICATION_FAILED", "Invalid email or password."),
  authorizationFailed: () =>
    new IdentityApplicationError("AUTHORIZATION_FAILED", "Access is denied."),
  emailAlreadyExists: () =>
    new IdentityApplicationError("EMAIL_ALREADY_EXISTS", "An account with this email exists."),
  userNotFound: () => new IdentityApplicationError("USER_NOT_FOUND", "User was not found."),
  organizationNotFound: () =>
    new IdentityApplicationError("ORGANIZATION_NOT_FOUND", "Organization was not found."),
  userInactive: () => new IdentityApplicationError("USER_INACTIVE", "User is inactive."),
  organizationInactive: () =>
    new IdentityApplicationError("ORGANIZATION_INACTIVE", "Organization is inactive."),
  invalidRefreshToken: () =>
    new IdentityApplicationError("INVALID_REFRESH_TOKEN", "Refresh token is invalid."),
  refreshTokenExpired: () =>
    new IdentityApplicationError("REFRESH_TOKEN_EXPIRED", "Refresh token has expired."),
  refreshTokenReused: () =>
    new IdentityApplicationError("REFRESH_TOKEN_REUSED", "Refresh token reuse was detected."),
  conflict: () =>
    new IdentityApplicationError("CONFLICT", "The request conflicts with current state."),
  internal: () => new IdentityApplicationError("INTERNAL_ERROR", "An internal error occurred.")
} as const;
