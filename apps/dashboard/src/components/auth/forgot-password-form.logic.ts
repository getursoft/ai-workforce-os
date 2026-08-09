import type { ApiErrorKind } from "../../lib/api-error";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateForgotPasswordForm(email: string): { email?: string } {
  return EMAIL_PATTERN.test(email.trim()) ? {} : { email: "Enter a valid email address." };
}

export function validateResetPasswordForm(values: {
  token: string;
  newPassword: string;
  confirmPassword: string;
}): { token?: string; newPassword?: string; confirmPassword?: string } {
  const errors: { token?: string; newPassword?: string; confirmPassword?: string } = {};
  if (!/^\d{8}$/.test(values.token.trim())) {
    errors.token = "Enter the 8-digit code from your email.";
  }
  if (values.newPassword.length < 12) {
    errors.newPassword = "Password must be at least 12 characters.";
  } else if (
    !/[A-Z]/.test(values.newPassword) ||
    !/[a-z]/.test(values.newPassword) ||
    !/\d/.test(values.newPassword) ||
    !/[^A-Za-z0-9]/.test(values.newPassword)
  ) {
    errors.newPassword = "Include an uppercase letter, lowercase letter, number, and symbol.";
  }
  if (values.confirmPassword !== values.newPassword) {
    errors.confirmPassword = "Passwords do not match.";
  }
  return errors;
}

export function getForgotPasswordFailureMessage(kind: ApiErrorKind | null): string {
  if (kind === "rate_limit") return "Too many attempts. Try again later.";
  if (kind === "network" || kind === "timeout") return "Network unavailable. Check your connection and try again.";
  return "Unexpected error. Try again shortly.";
}

export function getResetPasswordFailureMessage(kind: ApiErrorKind | null): string {
  if (kind === "rate_limit") return "Too many attempts. Try again later.";
  if (kind === "network" || kind === "timeout") return "Network unavailable. Check your connection and try again.";
  return "That reset code is invalid or has expired. Request a new one.";
}
