import type { ApiError } from "../../lib/api-error";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_REQUIREMENTS = [
  {
    key: "length",
    label: "12 characters",
    test: (value: string) =>
      value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH
  },
  { key: "uppercase", label: "one uppercase letter", test: (value: string) => /[A-Z]/.test(value) },
  { key: "lowercase", label: "one lowercase letter", test: (value: string) => /[a-z]/.test(value) },
  { key: "number", label: "one number", test: (value: string) => /\d/.test(value) },
  {
    key: "special",
    label: "one special character",
    test: (value: string) => /[^A-Za-z0-9]/.test(value)
  }
] as const;

export const PASSWORD_POLICY_MESSAGE =
  "Password must contain at least 12 characters, one uppercase letter, one lowercase letter, one number, and one special character.";

export interface SignupFormValues {
  organizationName: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export function validateSignupForm(
  values: SignupFormValues
): Partial<Record<keyof SignupFormValues, string>> {
  const errors: Partial<Record<keyof SignupFormValues, string>> = {};

  if (values.organizationName.trim().length === 0) {
    errors.organizationName = "Organization name is required.";
  } else if (
    values.organizationName.trim().length < 2 ||
    values.organizationName.trim().length > 120
  ) {
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
  } else if (!PASSWORD_REQUIREMENTS.every((requirement) => requirement.test(values.password))) {
    errors.password = PASSWORD_POLICY_MESSAGE;
  }

  if (values.confirmPassword.trim().length === 0) {
    errors.confirmPassword = "Confirm your password.";
  } else if (values.password !== values.confirmPassword) {
    errors.confirmPassword = "Passwords do not match.";
  }

  return errors;
}

export interface SignupFailure {
  message: string;
  fieldErrors: Partial<Record<keyof SignupFormValues, string>>;
}

export function getSignupFailure(error: ApiError | null): SignupFailure {
  if (!error) {
    return { message: "We could not create your account. Try again.", fieldErrors: {} };
  }
  if (error.kind === "conflict" && error.code === "EMAIL_ALREADY_EXISTS") {
    const message = "An account with this email already exists.";
    return { message, fieldErrors: { email: message } };
  }
  const combined = [error.message, ...error.details].join(" ").toLowerCase();
  if (error.kind === "conflict" && /(organization|slug|name)/.test(combined)) {
    const message = "An organization with this name already exists.";
    return { message, fieldErrors: { organizationName: message } };
  }
  if (error.kind === "validation") {
    if (/(password|security policy)/.test(combined)) {
      return {
        message: PASSWORD_POLICY_MESSAGE,
        fieldErrors: { password: PASSWORD_POLICY_MESSAGE }
      };
    }
    if (/email/.test(combined)) {
      const message = "Enter a valid email address.";
      return { message, fieldErrors: { email: message } };
    }
    if (/(organization|organizationname)/.test(combined)) {
      const message = "Enter a valid organization name.";
      return { message, fieldErrors: { organizationName: message } };
    }
    return {
      message: "We could not validate your registration details. Review the form and try again.",
      fieldErrors: {}
    };
  }
  if (error.kind === "rate_limit") {
    return { message: "Too many attempts. Try again later.", fieldErrors: {} };
  }
  if (error.kind === "network" || error.kind === "timeout") {
    return {
      message: "Network unavailable. Check your connection and try again.",
      fieldErrors: {}
    };
  }
  if (error.kind === "server") {
    return { message: "Unexpected server error. Try again shortly.", fieldErrors: {} };
  }
  if (error.kind === "conflict") {
    const message = "An organization with this name already exists.";
    return { message, fieldErrors: { organizationName: message } };
  }
  return { message: "We could not create your account. Try again.", fieldErrors: {} };
}

export function getSignupFailureMessage(error: ApiError | null): string {
  return getSignupFailure(error).message;
}

export function isSignupSubmitDisabled(submitting: boolean): boolean {
  return submitting;
}

export function getSignupSuccessRedirectTarget(): string {
  return "/dashboard";
}
