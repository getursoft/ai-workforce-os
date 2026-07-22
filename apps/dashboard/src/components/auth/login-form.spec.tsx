import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { resolveReturnUrl } from "../../lib/return-url";
import { LoginForm } from "./login-form";
import {
  getLoginFailureMessage,
  isLoginSubmitDisabled,
  resolveLoginRedirectTarget,
  togglePasswordVisibility,
  validateLoginForm
} from "./login-form.logic";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn()
  }),
  useSearchParams: () => new URLSearchParams("")
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
  useLogin: () => vi.fn()
}));

describe("LoginForm", () => {
  it("renders the core login controls", () => {
    const html = renderToStaticMarkup(createElement(LoginForm));

    expect(html).toContain("Sign in to your workspace");
    expect(html).toContain("Email");
    expect(html).toContain("Password");
    expect(html).toContain("Sign in");
    expect(html).toContain("Show");
    expect(html).toContain("Create account");
    expect(html).toContain("/signup");
  });

  it("rejects invalid email and missing password", () => {
    expect(validateLoginForm("not-an-email", "")).toEqual({
      email: "Enter a valid email address.",
      password: "Password is required."
    });
  });

  it("maps auth failures to safe public messages", () => {
    expect(getLoginFailureMessage("rate_limit")).toContain("Too many attempts");
    expect(getLoginFailureMessage("network")).toContain("Network unavailable");
    expect(getLoginFailureMessage("server")).toContain("Unexpected server error");
    expect(getLoginFailureMessage("authentication")).toBe("Invalid email or password.");
  });

  it("uses only internal return targets", () => {
    const safeTarget = resolveReturnUrl("/settings/sessions", "/dashboard");
    expect(resolveLoginRedirectTarget(true, safeTarget)).toBe("/settings/sessions");
    expect(resolveLoginRedirectTarget(false, safeTarget)).toBeNull();
    expect(resolveReturnUrl("https://evil.example.com")).toBe("/dashboard");
  });

  it("tracks loading and visibility helpers", () => {
    expect(isLoginSubmitDisabled(true)).toBe(true);
    expect(isLoginSubmitDisabled(false)).toBe(false);
    expect(togglePasswordVisibility(true)).toBe(false);
    expect(togglePasswordVisibility(false)).toBe(true);
  });
});
