import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api-error";
import {
  getSignupFailure,
  getSignupFailureMessage,
  getSignupSuccessRedirectTarget,
  isSignupSubmitDisabled,
  validateSignupForm
} from "./signup-form.logic";
import { SignupForm } from "./signup-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn()
  })
}));

vi.mock("../../features/auth/auth-provider", () => ({
  useAuth: () => ({
    state: {
      user: null,
      organization: null,
      accessToken: null,
      isAuthenticated: false,
      isInitializing: false
    }
  }),
  useRegister: () => vi.fn()
}));

describe("SignupForm", () => {
  it("renders the signup controls and navigation links", () => {
    const html = renderToStaticMarkup(createElement(SignupForm));

    expect(html).toContain("Create your workspace");
    expect(html).toContain("Organization Name");
    expect(html).toContain("First Name");
    expect(html).toContain("Last Name");
    expect(html).toContain("Email");
    expect(html).toContain("Password");
    expect(html).toContain("Confirm Password");
    expect(html).toContain("Create account");
    expect(html).toContain("Already have an account?");
    expect(html).toContain("Sign in");
    expect(html).toContain("/login");
  });

  it("validates required fields, email format, and password confirmation", () => {
    expect(
      validateSignupForm({
        organizationName: "",
        firstName: "",
        lastName: "",
        email: "invalid",
        password: "secret",
        confirmPassword: "different"
      })
    ).toEqual({
      organizationName: "Organization name is required.",
      firstName: "First name is required.",
      lastName: "Last name is required.",
      email: "Enter a valid email address.",
      password:
        "Password must contain at least 12 characters, one uppercase letter, one lowercase letter, one number, and one special character.",
      confirmPassword: "Passwords do not match."
    });
  });

  it("rejects invalid email and missing confirmation", () => {
    expect(
      validateSignupForm({
        organizationName: "Test Company",
        firstName: "Krishna",
        lastName: "Pandey",
        email: "krishna-at-example.com",
        password: "TestPassword@123",
        confirmPassword: ""
      })
    ).toMatchObject({
      email: "Enter a valid email address.",
      confirmPassword: "Confirm your password."
    });
  });

  it("maps backend signup failures to safe public messages", () => {
    expect(
      getSignupFailureMessage(
        new ApiError({
          kind: "conflict",
          code: "EMAIL_ALREADY_EXISTS",
          message: "Duplicate email."
        })
      )
    ).toBe("An account with this email already exists.");
    expect(
      getSignupFailureMessage(
        new ApiError({
          kind: "conflict",
          code: "CONFLICT",
          message: "Conflict."
        })
      )
    ).toContain("organization");
    expect(
      getSignupFailureMessage(
        new ApiError({ kind: "rate_limit", code: "RATE_LIMIT", message: "Too many attempts." })
      )
    ).toContain("Too many attempts");
    expect(
      getSignupFailureMessage(
        new ApiError({ kind: "server", code: "SERVER_ERROR", message: "Boom." })
      )
    ).toContain("Unexpected server error");
  });

  it("rejects a weak password before submission", () => {
    const errors = validateSignupForm({
      organizationName: "Acme",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      password: "alllowercase12",
      confirmPassword: "alllowercase12"
    });
    expect(errors.password).toContain("uppercase");
  });

  it("highlights email for a duplicate-email response", () => {
    const failure = getSignupFailure(
      new ApiError({ kind: "conflict", code: "EMAIL_ALREADY_EXISTS", message: "Duplicate" })
    );
    expect(failure).toEqual({
      message: "An account with this email already exists.",
      fieldErrors: { email: "An account with this email already exists." }
    });
  });

  it("reports password mismatch on the confirmation field", () => {
    const errors = validateSignupForm({
      organizationName: "Acme",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      password: "StrongPassword@123",
      confirmPassword: "StrongPassword@124"
    });
    expect(errors.confirmPassword).toBe("Passwords do not match.");
  });

  it("highlights organization name for an organization conflict", () => {
    const failure = getSignupFailure(
      new ApiError({
        kind: "conflict",
        code: "CONFLICT",
        message: "Organization slug already exists"
      })
    );
    expect(failure.message).toBe("An organization with this name already exists.");
    expect(failure.fieldErrors.organizationName).toBe(failure.message);
  });

  it("uses a safe message for an unknown backend validation error", () => {
    const failure = getSignupFailure(
      new ApiError({
        kind: "validation",
        code: "VALIDATION_ERROR",
        message: "Invalid request",
        details: ["unrecognized field"]
      })
    );
    expect(failure.message).toBe(
      "We could not validate your registration details. Review the form and try again."
    );
    expect(failure.fieldErrors).toEqual({});
  });

  it("tracks loading and redirect helpers", () => {
    expect(isSignupSubmitDisabled(true)).toBe(true);
    expect(isSignupSubmitDisabled(false)).toBe(false);
    expect(getSignupSuccessRedirectTarget()).toBe("/dashboard");
  });
});
