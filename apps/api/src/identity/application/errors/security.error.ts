export class PasswordHashingError extends Error {
  readonly code = "PASSWORD_HASHING_FAILED";

  constructor() {
    super("Password hashing operation failed");
    this.name = "PasswordHashingError";
  }
}

export class InvalidAccessTokenError extends Error {
  readonly code = "INVALID_ACCESS_TOKEN";

  constructor() {
    super("Access token is invalid");
    this.name = "InvalidAccessTokenError";
  }
}

export class ExpiredAccessTokenError extends Error {
  readonly code = "EXPIRED_ACCESS_TOKEN";

  constructor() {
    super("Access token has expired");
    this.name = "ExpiredAccessTokenError";
  }
}

export class InvalidRefreshTokenFormatError extends Error {
  readonly code = "INVALID_REFRESH_TOKEN_FORMAT";

  constructor() {
    super("Refresh token format is invalid");
    this.name = "InvalidRefreshTokenFormatError";
  }
}

export class InvalidSecurityConfigurationError extends Error {
  readonly code: "INVALID_SECURITY_CONFIGURATION" | "PLUGIN_SECRETS_KEY_INVALID";

  constructor(readonly variable: string) {
    super(`Security configuration is invalid: ${variable}`);
    this.name = "InvalidSecurityConfigurationError";
    this.code =
      variable === "PLUGIN_SECRETS_ENCRYPTION_KEY"
        ? "PLUGIN_SECRETS_KEY_INVALID"
        : "INVALID_SECURITY_CONFIGURATION";
  }
}
