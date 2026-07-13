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
  | "PLUGIN_CONFIGURATION_INVALID";

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
