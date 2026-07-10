import type { ApiError } from "../../lib/api-error";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;

export interface SignupFormValues {
  organizationName: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export function validateSignupForm(values: SignupFormValues): Partial<Record<keyof SignupFormValues, string>> {
  const errors: Partial<Record<keyof SignupFormValues, string>> = {};

  if (values.organizationName.trim().length === 0) {
    errors.organizationName = "Organization name is required.";
  } else if (values.organizationName.trim().length < 2 || values.organizationName.trim().length > 120) {
    errors.organizationName = "Organization name must be between 2 and 120 characters.";
  }

  if (values.firstName.trim().length === 0) {
    errors.firstName = "First name is required.";
  } else if (values.firstName.trim().length > 120) {
    errors.firstName = "First name must be 120 characters or fewer.";
  }

  if (values.lastName.trim().length === 0) {
    errors.lastName = "Last name is required.";
  } else if (values.lastName.trim().length > 120) {
    errors.lastName = "Last name must be 120 characters or fewer.";
  }

  if (!EMAIL_PATTERN.test(values.email.trim())) {
    errors.email = "Enter a valid email address.";
  }

  if (values.password.trim().length === 0) {
    errors.password = "Password is required.";
  } else if (values.password.length < PASSWORD_MIN_LENGTH || values.password.length > PASSWORD_MAX_LENGTH) {
    errors.password = "Password must be between 12 and 128 characters.";
  }

  if (values.confirmPassword.trim().length === 0) {
    errors.confirmPassword = "Confirm your password.";
  } else if (values.password !== values.confirmPassword) {
    errors.confirmPassword = "Passwords do not match.";
  }

  return errors;
}

export function getSignupFailureMessage(error: ApiError | null): string {
  if (!error) {
    return "We could not create your account. Try again.";
  }
  if (error.kind === "validation") {
    return "Please check the highlighted fields and try again.";
  }
  if (error.kind === "rate_limit") {
    return "Too many attempts. Try again later.";
  }
  if (error.kind === "network" || error.kind === "timeout") {
    return "Network unavailable. Check your connection and try again.";
  }
  if (error.kind === "server") {
    return "Unexpected server error. Try again shortly.";
  }
  if (error.kind === "conflict" && error.code === "EMAIL_ALREADY_EXISTS") {
    return "An account with this email already exists.";
  }
  if (error.kind === "conflict") {
    return "That organization could not be created. Try a different name.";
  }
  return "We could not create your account. Try again.";
}

export function isSignupSubmitDisabled(submitting: boolean): boolean {
  return submitting;
}

export function getSignupSuccessRedirectTarget(): string {
  return "/dashboard";
}
