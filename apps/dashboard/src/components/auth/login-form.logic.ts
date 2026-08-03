import type { ApiErrorKind } from "../../lib/api-error";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateLoginForm(
  email: string,
  password: string,
  organizationName: string
): {
  email?: string;
  password?: string;
  organizationName?: string;
} {
  const errors: { email?: string; password?: string; organizationName?: string } = {};
  if (!EMAIL_PATTERN.test(email.trim())) {
    errors.email = "Enter a valid email address.";
  }
  if (password.trim().length === 0) {
    errors.password = "Password is required.";
  }
  if (organizationName.trim().length === 0) {
    errors.organizationName = "Organization ID is required.";
  }
  return errors;
}

export function getLoginFailureMessage(kind: ApiErrorKind | null, code?: string | null): string {
  if (code === "ORGANIZATION_NOT_FOUND") {
    return "That organization ID was not found.";
  }
  if (code === "ORGANIZATION_SWITCH_DENIED") {
    return "Your account does not have access to that organization.";
  }
  if (kind === "rate_limit") {
    return "Too many attempts. Try again later.";
  }
  if (kind === "network" || kind === "timeout") {
    return "Network unavailable. Check your connection and try again.";
  }
  if (kind === "server") {
    return "Unexpected server error. Try again shortly.";
  }
  return "Invalid email or password.";
}

export function resolveLoginRedirectTarget(
  isAuthenticated: boolean,
  returnUrl: string
): string | null {
  return isAuthenticated ? returnUrl : null;
}

export function isLoginSubmitDisabled(submitting: boolean): boolean {
  return submitting;
}

export function togglePasswordVisibility(current: boolean): boolean {
  return !current;
}
